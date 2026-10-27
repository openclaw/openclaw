import { createRequire } from "node:module";
import path from "node:path";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import { attachModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  createAutoCompactionSettings,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-settle.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture } = await vi.hoisted(
  async () => await import("./attempt-execution-phase.test-support.js"),
);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("embedded native provider authority", () => {
  it.each([
    { kind: "cron root", key: "agent:main:cron:native-fence", rotate: false },
    { kind: "cron root", key: "agent:main:cron:native-fence", rotate: true },
    { kind: "ordinary", key: "agent:main:dashboard:native-fence", rotate: false },
  ])(
    "fences native Bedrock dispatch after payload preparation ($kind, rotate=$rotate)",
    async ({ key, rotate }) => {
      const artifact = { pluginId: "amazon-bedrock", artifactBasename: "index.ts" };
      const { default: plugin } = await loadBundledPluginFacade<{
        default: OpenClawPluginDefinition;
      }>(artifact);
      if (!plugin.register) {
        throw new Error("expected Bedrock provider registration");
      }
      const provider = await registerSingleProviderPlugin({ ...plugin, register: plugin.register });
      const providerRuntimeHandle = { provider: "amazon-bedrock", plugin: provider };
      const model = attachModelProviderRuntimePluginHandle(
        {
          ...testModel,
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          id: "amazon.nova-micro-v1:0",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        },
        providerRuntimeHandle,
      );
      // Resolve the native SDK from its owning plugin, not the core package.
      const sdk: {
        BedrockRuntimeClient: {
          prototype: {
            send: (command: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
          };
        };
      } = createRequire(resolveBundledPluginPublicModulePath(artifact))(
        "@aws-sdk/client-bedrock-runtime",
      );
      const send = vi.spyOn(sdk.BedrockRuntimeClient.prototype, "send").mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
        stream: (async function* () {
          yield { messageStart: { role: "assistant" } };
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "NATIVE_OK" } } };
          yield { messageStop: { stopReason: "end_turn" } };
        })(),
      });
      await withOpenClawTestState({ label: "cron-root-native-fence" }, async (testState) => {
        const fixture = await createFixture({ exerciseTerminalMerges: false });
        const target = {
          agentId: "main",
          sessionKey: key,
          sessionId: "native-run-1",
          storePath: path.join(testState.agentDir(), "openclaw-agent.sqlite"),
        };
        const original = {
          sessionId: target.sessionId,
          lifecycleRevision: "native-generation-1",
          updatedAt: 1,
        };
        replaceSessionEntrySync(target, original);
        Object.assign(fixture.input.attempt, {
          ...target,
          config: {},
          model,
          modelId: model.id,
          provider: model.provider,
          resolvedApiKey: "synthetic-bedrock-key",
          sessionTarget: target,
          sessionFile: target.sessionKey,
          workspaceDir: testState.workspaceDir,
          runtimePlan: {
            auth: {},
            transport: { resolveExtraParams: () => ({}) },
          },
        });
        const writer = await claimAgentSessionWriter({
          ...target,
          sessionTarget: target,
          runId: fixture.input.attempt.runId,
          workspaceDir: testState.workspaceDir,
          prompt: "reply",
          timeoutMs: 30_000,
        });
        fixture.input.attempt.sessionTarget = { ...target, ...writer };
        const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
          attempt: fixture.input.attempt,
          runAbortController: fixture.input.runAbortController,
          externalAbortController: { arm: () => {}, throwIfFiredAfterPrepCleanup: async () => {} },
        });
        fixture.input.sessionLock = transcript;
        const manager = SessionManager.open({ ...target, ...writer });
        const session = fixture.input.prepared.sessionRuntime.agentSession.activeSession;
        bindStreamLlmRuntime(session.agent.streamFn!, defaultLlmRuntime);
        try {
          await prepareEmbeddedAttemptTransport({
            attempt: fixture.input.attempt,
            session,
            settingsManager: createAutoCompactionSettings(),
            providerThinkingLevel: undefined,
            sessionAgentId: target.agentId,
            workspaceDir: testState.workspaceDir,
            workspaceOnly: true,
            agentDir: testState.agentDir(),
            abortSignal: fixture.input.runAbortController.signal,
            assertCronRootCurrent: transcript.assertCronRootCurrent,
            getProviderRuntimeHandle: () => providerRuntimeHandle,
            sandboxSessionKey: key,
            codeModeControlsEnabled: false,
            providerPromptState: { state: {}, effectiveContextTokenBudget: 32_768 },
          });
          const payloadEntered = createDeferred();
          const releasePayload = createDeferred();
          const response = await session.agent.streamFn!(
            model,
            { messages: [{ role: "user", content: "Reply NATIVE_OK", timestamp: 1 }] },
            {
              onPayload: async () => {
                payloadEntered.resolve();
                await releasePayload.promise;
              },
            },
          );
          await Promise.race([
            payloadEntered.promise,
            response.result().then((result) => {
              throw new Error(
                `Bedrock ended before payload: ${result.stopReason}: ${result.errorMessage ?? ""}`,
              );
            }),
          ]);
          expect(send).not.toHaveBeenCalled();
          if (rotate) {
            replaceSessionEntrySync(target, {
              ...original,
              sessionId: "native-run-2",
              lifecycleRevision: "native-generation-2",
            });
          }
          releasePayload.resolve();
          const result = await response.result();
          if (rotate) {
            expect(send).not.toHaveBeenCalled();
            expect(fixture.input.runAbortController.signal.aborted).toBe(true);
            expect(result.stopReason).toBe("aborted");
            expect(result.errorMessage).toContain("original session generation no longer accepts");
            await expect(
              transcript.withOwnedTranscriptWrite(() => manager.appendMessage(result)),
            ).rejects.toThrow();
            expect(loadTranscriptEventsSync(target)).toEqual([]);
          } else {
            expect(result.stopReason).toBe("stop");
            expect(result.content).toEqual([{ type: "text", text: "NATIVE_OK" }]);
            expect(send).toHaveBeenCalledOnce();
            expect(send.mock.calls[0]?.[1].abortSignal?.aborted).toBe(false);
            await transcript.withOwnedTranscriptWrite(() => manager.appendMessage(result));
            expect(loadTranscriptEventsSync(target)).toMatchObject([
              { type: "session" },
              { type: "message", message: { role: "assistant", content: result.content } },
            ]);
          }
        } finally {
          await transcript.transcriptLifecycle.dispose();
        }
      });
    },
  );
});
