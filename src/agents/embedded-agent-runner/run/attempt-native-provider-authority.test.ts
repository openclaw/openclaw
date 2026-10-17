import { createRequire } from "node:module";
import path from "node:path";
import { defaultLlmRuntime } from "@openclaw/ai/internal/runtime";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as sessions from "../../../config/sessions/session-accessor.js";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import { attachModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import * as bundled from "../../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import * as loop from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-settle.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

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
      const { default: plugin } = await bundled.loadBundledPluginFacade<{
        default: OpenClawPluginDefinition;
      }>(artifact);
      if (!plugin.register) {
        throw new Error("expected Bedrock provider registration");
      }
      const provider = await registerSingleProviderPlugin({ ...plugin, register: plugin.register });
      const providerRuntimeHandle = { provider: "amazon-bedrock", plugin: provider };
      const model = attachModelProviderRuntimePluginHandle(
        {
          ...loop.testModel,
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          id: "amazon.nova-micro-v1:0",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        },
        providerRuntimeHandle,
      );
      const sdk: {
        BedrockRuntimeClient: {
          prototype: {
            send(command: unknown, options: { abortSignal?: AbortSignal }): Promise<unknown>;
          };
        };
      } = createRequire(bundled.resolveBundledPluginPublicModulePath(artifact))(
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
        const { attempt, runAbortController } = fixture.input;
        const target = {
          agentId: "main",
          sessionKey: key,
          sessionId: "native-run-1",
          storePath: path.join(testState.agentDir(), "openclaw-agent.sqlite"),
        };
        const replaceGeneration = (generation: number) =>
          sessions.replaceSessionEntrySync(target, {
            sessionId: `native-run-${generation}`,
            lifecycleRevision: `native-generation-${generation}`,
            updatedAt: 1,
          });
        replaceGeneration(1);
        Object.assign(attempt, {
          ...target,
          config: {},
          model,
          modelId: model.id,
          provider: model.provider,
          resolvedApiKey: "synthetic-bedrock-key",
          sessionFile: target.sessionKey,
          workspaceDir: testState.workspaceDir,
          runtimePlan: { auth: {}, transport: { resolveExtraParams: () => ({}) } },
        });
        const writer = await claimAgentSessionWriter({
          ...target,
          sessionTarget: target,
          runId: attempt.runId,
          workspaceDir: testState.workspaceDir,
          prompt: "reply",
          timeoutMs: 30_000,
        });
        attempt.sessionTarget = { ...target, ...writer };
        const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
          attempt,
          runAbortController,
          externalAbortController: { arm: () => {}, throwIfFiredAfterPrepCleanup: async () => {} },
        });
        const manager = SessionManager.open({ ...target, ...writer });
        const session = fixture.input.prepared.sessionRuntime.agentSession.activeSession;
        bindStreamLlmRuntime(session.agent.streamFn!, defaultLlmRuntime);
        try {
          await prepareEmbeddedAttemptTransport({
            attempt,
            session,
            settingsManager: loop.createAutoCompactionSettings(),
            providerThinkingLevel: undefined,
            sessionAgentId: target.agentId,
            workspaceDir: testState.workspaceDir,
            workspaceOnly: true,
            agentDir: testState.agentDir(),
            abortSignal: runAbortController.signal,
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
            replaceGeneration(2);
          }
          releasePayload.resolve();
          const result = await response.result();
          if (rotate) {
            expect(send).not.toHaveBeenCalled();
            expect(runAbortController.signal.aborted).toBe(true);
            expect(result.stopReason).toBe("aborted");
            expect(result.errorMessage).toContain("original session generation no longer accepts");
            await expect(
              transcript.withOwnedTranscriptWrite(() => manager.appendMessage(result)),
            ).rejects.toThrow();
            expect(sessions.loadTranscriptEventsSync(target)).toEqual([]);
          } else {
            expect(result.stopReason).toBe("stop");
            expect(result.content).toEqual([{ type: "text", text: "NATIVE_OK" }]);
            expect(send).toHaveBeenCalledOnce();
            expect(send.mock.calls[0]?.[1].abortSignal?.aborted).toBe(false);
            await transcript.withOwnedTranscriptWrite(() => manager.appendMessage(result));
            expect(sessions.loadTranscriptEventsSync(target)).toMatchObject([
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
