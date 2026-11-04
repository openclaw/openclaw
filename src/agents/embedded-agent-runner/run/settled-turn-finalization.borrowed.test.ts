import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../../plugin-sdk/session-transcript-runtime.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../prepared-model-runtime.test-support.js";
import type { StreamFn } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { completionModelDefinition } from "../../simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { runEmbeddedAgent } from "../run.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";

it.each([false, true])(
  "keeps borrowed finalization custody after private replacement (revoked=%s)",
  async (revoked) => {
    await withOpenClawTestState({ label: "borrowed-finalization" }, async (state) => {
      const pluginId = "borrowed-finalization-provider";
      const bundled = state.path("bundled");
      const rootDir = path.join(bundled, pluginId);
      await fs.mkdir(rootDir, { recursive: true });
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId,
        providerId: "anthropic",
        manifest: { channels: [], channelConfigs: {}, providerAuthChoices: [] },
      });
      const target = {
        agentId: "main",
        sessionId: "private-review",
        sessionKey: "agent:main:private-review",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const manager = SessionManager.inMemory(state.workspaceDir);
      const answer = "The review evidence has been saved.";
      const requests: string[] = [];
      let revoke = () => {};
      const stream: StreamFn = async (model, context) => {
        const finalizing = !context.tools?.length;
        if (finalizing && revoked) {
          revoke();
        }
        const writeComplete = context.messages.some((message) => message.role === "toolResult");
        if (!finalizing && writeComplete) {
          await replaceSessionEntry(target, {
            sessionId: "successor-review",
            updatedAt: 2,
            lifecycleRevision: "successor",
            activeWriterRunId: "next-review",
          });
        }
        requests.push(finalizing ? "summary" : writeComplete ? "empty" : "write");
        const message = makeAgentAssistantMessage({
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: !finalizing && !writeComplete ? "toolUse" : "stop",
          content: finalizing
            ? [{ type: "text", text: answer }]
            : writeComplete
              ? []
              : [
                  {
                    type: "toolCall",
                    id: "write-note",
                    name: "write",
                    arguments: { path: "note.txt", content: "Review evidence\n" },
                  },
                ],
        });
        return createQueuedAssistantStream((push) => {
          push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        });
      };
      const bridgeKey = `__borrowed_finalization_${path.basename(state.root)}`;
      Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { stream } });
      await fs.writeFile(
        fixture.runtimeSource,
        `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
  api.registerProvider({ id: "anthropic", label: "Fixture", auth: [],
    wrapStreamFn: () => globalThis[${JSON.stringify(bridgeKey)}].stream });
} };`,
      );
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: { workspace: state.workspaceDir, model: "anthropic/fixture-model" },
        },
        models: {
          mode: "replace",
          providers: {
            anthropic: {
              api: "anthropic-messages",
              apiKey: "synthetic-fixture-key",
              baseUrl: "https://provider.invalid",
              models: [completionModelDefinition({ id: "fixture-model", contextWindow: 200_000 })],
            },
          },
        },
        plugins: {
          allow: [pluginId],
          slots: { memory: "none" },
          entries: { [pluginId]: { enabled: true } },
        },
        skills: { load: { watch: false } },
      };
      await state.writeConfig(config);
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network"));
      try {
        await withEnvAsync(
          { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
          async () => {
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            setRuntimeConfigSnapshot(config);
            await replaceSessionEntry(target, {
              sessionId: target.sessionId,
              updatedAt: 1,
              lifecycleRevision: "original",
              activeWriterRunId: "original-review",
            });
            const admission = prepareSystemAgentRunAdmission(
              config,
              "review-run",
              "main",
              "review",
            );
            revoke = () => admission.close();
            try {
              const pending = runEmbeddedAgent({
                preparedRunAdmission: admission,
                config,
                agentId: "main",
                runId: "review-run",
                sessionId: target.sessionId,
                sessionKey: target.sessionKey,
                sessionTarget: target,
                sessionManager: manager,
                sessionPersistence: "detached",
                workspaceDir: state.workspaceDir,
                agentDir: state.agentDir(),
                provider: "anthropic",
                model: "fixture-model",
                prompt: "Write note.txt with the review evidence, then summarize.",
                toolsAllow: ["write"],
                cleanupBundleMcpOnRunEnd: true,
                timeoutMs: 30_000,
              });
              const result = revoked
                ? await expect(pending)
                    .rejects.toThrow("admitted run authority is no longer active")
                    .then(() => undefined)
                : await pending;
              expect(await fs.readFile(path.join(state.workspaceDir, "note.txt"), "utf8")).toBe(
                "Review evidence\n",
              );
              if (!revoked) {
                expect(result?.payloads).toEqual([expect.objectContaining({ text: answer })]);
              }
              expect(requests).toEqual(["write", "empty", "summary"]);
              const messages = manager.buildSessionContext().messages;
              expect(messages).toContainEqual(
                expect.objectContaining({
                  role: "toolResult",
                  toolCallId: "write-note",
                  isError: false,
                }),
              );
              const answerMessage = expect.objectContaining({
                role: "assistant",
                content: [{ type: "text", text: answer }],
              });
              if (revoked) {
                expect(messages).not.toContainEqual(answerMessage);
              } else {
                expect(messages.at(-1)).toEqual(answerMessage);
              }
              expect(await readVisibleSessionTranscriptMessageEntries(target)).toEqual([]);
              expect(network).not.toHaveBeenCalled();
            } finally {
              admission.close();
              await resetPreparedModelRuntimeSnapshotsForTest();
              resetPluginLoaderTestStateForTest();
              cleanupPluginLoaderFixturesForTest();
              clearPluginMetadataLifecycleCaches();
            }
          },
        );
      } finally {
        network.mockRestore();
        clearEmbeddedSessionPromptStates([target.sessionId]);
        Reflect.deleteProperty(globalThis, bridgeKey);
      }
    });
  },
);
