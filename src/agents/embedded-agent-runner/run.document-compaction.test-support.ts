import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { MsgContext } from "../../auto-reply/templating.js";
import { toInboundMediaFacts } from "../../channels/inbound-event/media.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { saveMediaBuffer } from "../../media/store.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { readModelPromptProjection } from "../../sessions/user-turn-transcript.message.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import type { StreamFn } from "../runtime/index.js";
import { completionModelDefinition } from "../simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { runEmbeddedAgent } from "./run.js";
import { clearEmbeddedSessionPromptStates } from "./session-prompt-state.js";

// Real embedded owner, admission, document producer, transcript
// recorder and default compaction. A plugin supplies bounded synthetic model I/O;
// this is neither a hosted-tokenizer nor a semantic summary-quality claim.
async function exerciseDocumentCompaction() {
  await withOpenClawTestState({ label: "embedded-document-compaction" }, async (state) => {
    const sessionId = "embedded-document-compaction";
    const pluginId = "document-audit-provider";
    const bundled = state.path("bundled");
    const rootDir = path.join(bundled, pluginId);
    await fs.mkdir(rootDir, { recursive: true });
    const requests: Array<{
      turn: number;
      tokens: number;
      output: number;
      accepted: boolean;
      documents: number[];
      summary: boolean;
    }> = [];
    let activeTurn = 0;
    const stream: StreamFn = (model, context, options) => {
      const serialized = JSON.stringify({
        system: context.systemPrompt,
        tools: context.tools ?? [],
        messages: context.messages.map(({ role, content }) => ({ role, content })),
      });
      const tokens = Math.ceil(serialized.length / 4);
      const output = options?.maxTokens ?? model.maxTokens;
      const accepted = tokens + output <= 32768;
      const summary =
        context.systemPrompt?.startsWith("You are a context summarization assistant.") === true;
      const documents = [1, 2, 3].filter((turn) =>
        serialized.includes(`DOCUMENT_REQUIREMENT_${turn}_Q7`),
      );
      requests.push({
        turn: activeTurn,
        tokens,
        output,
        accepted,
        documents,
        summary,
      });
      const message = makeAgentAssistantMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        // A fixed external-I/O fixture, not a semantic model-quality assertion:
        // carry a document marker forward only if the real summary request supplied it.
        content: accepted
          ? [
              {
                type: "text",
                text: summary
                  ? `Document requirements: ${documents.map((turn) => `DOCUMENT_REQUIREMENT_${turn}_Q7`).join(", ")}`
                  : "Diagnostic response.",
              },
            ]
          : [],
        stopReason: accepted ? "stop" : "error",
        ...(accepted
          ? {}
          : {
              errorMessage:
                "Context length exceeded: request and output limit exceed the model context window.",
            }),
      });
      message.usage = {
        ...message.usage,
        input: tokens,
        output: accepted ? 1 : 0,
        totalTokens: tokens + (accepted ? 1 : 0),
        contextUsage: {
          state: "available",
          promptTokens: tokens,
          totalTokens: tokens + (accepted ? 1 : 0),
        },
      };
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (accepted) {
          events.push({ type: "done", reason: "stop", message });
        } else {
          events.push({ type: "error", reason: "error", error: message });
        }
        events.end();
      });
      return events;
    };
    const bridgeKey = `__document_audit_${path.basename(state.root)}`;
    Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { stream } });
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    globalThis.fetch = async () => {
      networkRequests += 1;
      throw new Error("No live network");
    };
    try {
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId,
        providerId: "anthropic",
        manifest: { channels: [], channelConfigs: {}, providerAuthChoices: [] },
      });
      await fs.writeFile(
        fixture.runtimeSource,
        `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
          const bridge = globalThis[${JSON.stringify(bridgeKey)}];
          api.registerProvider({ id: "anthropic", label: "Synthetic document provider", auth: [],
            wrapStreamFn: () => (model, context, options) => bridge.stream(model, context, options) });
        } };`,
      );
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: { workspace: state.workspaceDir, model: "anthropic/document-audit-model" },
        },
        models: {
          mode: "replace",
          providers: {
            anthropic: {
              api: "anthropic-messages",
              auth: "api-key",
              apiKey: "synthetic-document-key",
              baseUrl: "https://fixture.invalid",
              models: [
                completionModelDefinition({ id: "document-audit-model", contextWindow: 32768 }),
              ],
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
      await withEnvAsync(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          setRuntimeConfigSnapshot(config);
          const target = {
            agentId: "main",
            sessionId,
            sessionKey: `agent:main:${sessionId}`,
            storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          };
          await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
          const results: Array<Awaited<ReturnType<typeof runEmbeddedAgent>>> = [];
          try {
            for (const turn of [1, 2, 3, 4]) {
              activeTurn = turn;
              const caption = turn === 4 ? "Continue the analysis." : `Analyze document ${turn}.`;
              const ctx: MsgContext = { Body: caption };
              if (turn < 4) {
                const document = `DOCUMENT_REQUIREMENT_${turn}_Q7\n${"Production reliability record: retain each original requirement.\n".repeat(800)}`;
                const saved = await saveMediaBuffer(Buffer.from(document), "text/plain", "inbound");
                ctx.media = toInboundMediaFacts([
                  {
                    url: `media://inbound/${saved.id}`,
                    contentType: "text/plain",
                    kind: "document",
                  },
                ]);
                await applyMediaUnderstanding({ ctx, cfg: config, processingMode: "files-only" });
                assert.ok(ctx.agentText?.includes(`DOCUMENT_REQUIREMENT_${turn}_Q7`));
              }
              const prompt = ctx.agentText ?? caption;
              const recorder = createUserTurnTranscriptRecorder({
                input: {
                  text: caption,
                  media: ctx.media,
                  timestamp: turn,
                  idempotencyKey: `doc:${turn}`,
                },
                target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
              });
              const runId = `${sessionId}-${turn}`;
              const admission = prepareSystemAgentRunAdmission(
                config,
                runId,
                "main",
                "document-audit",
              );
              try {
                const result = await runEmbeddedAgent({
                  preparedRunAdmission: admission,
                  config,
                  runId,
                  sessionId,
                  sessionKey: target.sessionKey,
                  agentDir: state.agentDir(),
                  workspaceDir: state.workspaceDir,
                  sessionTarget: target,
                  provider: "anthropic",
                  model: "document-audit-model",
                  prompt,
                  transcriptPrompt: prompt,
                  media: ctx.media,
                  userTurnTranscriptRecorder: recorder,
                  disableTools: true,
                  cleanupBundleMcpOnRunEnd: true,
                  timeoutMs: 30_000,
                });
                results.push(result);
                assert.equal(result.meta.error, undefined, JSON.stringify(requests));
                assert.equal(recorder.getPersistedMessage?.()?.content, caption);
                if (turn < 3) {
                  assert.ok(
                    readModelPromptProjection(recorder.getPersistedMessage?.())?.includes(
                      `DOCUMENT_REQUIREMENT_${turn}_Q7`,
                    ),
                  );
                }
              } finally {
                admission.close();
              }
            }
            assert.equal(results.length, 4);
            assert.equal(requests.at(-1)?.accepted, true);
            assert.ok(requests.some((request) => request.summary && request.documents.includes(1)));
            assert.deepEqual(requests.at(-1)?.documents, [1, 2, 3]);
            assert.equal(networkRequests, 0);
          } finally {
            await resetPreparedModelRuntimeSnapshotsForTest();
            resetPluginLoaderTestStateForTest();
            cleanupPluginLoaderFixturesForTest();
            clearPluginMetadataLifecycleCaches();
          }
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearEmbeddedSessionPromptStates([sessionId]);
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  });
}

await exerciseDocumentCompaction();
console.log("document compaction continuation ok");
