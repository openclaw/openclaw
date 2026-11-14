import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Context } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
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
import { completionModelDefinition } from "../../simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { ZERO_USAGE_FIXTURE } from "../../test-helpers/usage-fixtures.js";
import { runEmbeddedAgent } from "../run.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";

const providerPluginId = "scripted-finalization-provider";
const modelId = "fixture-model";
const summary = "Both files are written: a.txt contains alpha and b.txt contains beta.";
const cutoffNotice =
  "The model was cut off at its output token limit, so the summary above was written afterwards without tools.";
const prompt =
  "Create a.txt containing alpha, then b.txt containing beta. Tell me when both are written.";

// An incompressible 160x120 PNG: large in bytes, a flat 2,000 tokens to the estimator.
function screenshotPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(160, 0);
  header.writeUInt32BE(120, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Array.from({ length: 120 }, () =>
    Buffer.concat([Buffer.alloc(1), randomBytes(480)]),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Adapted from @ablake4427's #178300 reproduction: real writes and finalization,
// with only provider I/O scripted. A summary cannot finish interrupted work.
it.each([
  {
    interrupted: true,
    screenshots: 0,
    label: "preserves a length failure after recovering a summary",
  },
  {
    interrupted: false,
    screenshots: 0,
    label: "keeps genuinely completed work successful after summary recovery",
  },
  // The summary reopens the session within contextWindow * 8 bytes; screenshots
  // fill those bytes long before the token budget, so the request must survive.
  {
    interrupted: true,
    screenshots: 10,
    label: "keeps the user's request in view after a screenshot-heavy cut-off",
  },
])("$label", async ({ interrupted, screenshots }) => {
  const sessionId = screenshots
    ? "screenshot-finalization"
    : interrupted
      ? "interrupted-finalization"
      : "completed-finalization";
  await withOpenClawTestState({ label: sessionId }, async (state) => {
    const bundled = state.path("bundled");
    await fs.mkdir(bundled);
    await fs.writeFile(path.join(state.workspaceDir, "shot.png"), screenshotPng());
    const requests: string[] = [];
    let summaryRequestHasPrompt: boolean | undefined;
    let summaryRequestBytes = 0;
    const stream: StreamFn = (model, context: Context) => {
      const hasTools = Boolean(context.tools?.length);
      const toolResults = context.messages.filter(
        (message) => message.role === "toolResult",
      ).length;
      if (!hasTools) {
        const view = JSON.stringify(context.messages);
        summaryRequestHasPrompt = view.includes(prompt);
        summaryRequestBytes = Buffer.byteLength(view);
      }
      if (hasTools && toolResults > 0 && toolResults <= screenshots) {
        requests.push("read");
        const read = makeAgentAssistantMessage({
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: `read-${toolResults}`,
              name: "read",
              arguments: { path: "shot.png" },
            },
          ],
        });
        return createQueuedAssistantStream((push) => {
          push({ type: "done", reason: "toolUse", message: read });
        });
      }
      const file = toolResults === 0 ? "a" : !interrupted && toolResults === 1 ? "b" : undefined;
      const message = makeAgentAssistantMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        ...(hasTools && file
          ? {
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: `write-${file}`,
                  name: "write",
                  arguments: {
                    path: `${file}.txt`,
                    content: file === "a" ? "alpha\n" : "beta\n",
                  },
                },
              ],
            }
          : hasTools
            ? {
                stopReason: interrupted ? "length" : "stop",
                usage: { ...ZERO_USAGE_FIXTURE, output: 1, totalTokens: 1 },
                content: [
                  {
                    type: "thinking",
                    thinking: interrupted ? "Next I need to write b.txt" : "Both files are written",
                    thinkingSignature: "opaque-signature",
                  },
                ],
              }
            : { stopReason: "stop", content: [{ type: "text", text: summary }] }),
      });
      requests.push(hasTools ? (file ? `write-${file}` : message.stopReason) : "summary");
      return createQueuedAssistantStream((push) => {
        push({
          type: "done",
          reason: message.stopReason as "stop" | "length" | "toolUse",
          message,
        });
      });
    };
    const bridgeKey = `__finalization_fixture_${path.basename(state.root)}`;
    Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { stream } });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Scripted provider fixture must not perform network I/O");
    });
    try {
      const rootDir = path.join(bundled, providerPluginId);
      await fs.mkdir(rootDir);
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: providerPluginId,
        providerId: "anthropic",
        manifest: {
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          providers: ["anthropic"],
        },
      });
      await fs.writeFile(
        fixture.runtimeSource,
        `module.exports = { id: ${JSON.stringify(providerPluginId)}, register(api) {
  const bridge = globalThis[${JSON.stringify(bridgeKey)}];
  api.registerProvider({ id: "anthropic", label: "Scripted provider", auth: [], wrapStreamFn: () => bridge.stream });
} };`,
      );
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: { workspace: state.workspaceDir, model: `anthropic/${modelId}` },
        },
        models: {
          mode: "replace",
          providers: {
            anthropic: {
              api: "anthropic-messages",
              auth: "api-key",
              apiKey: "synthetic-finalization-key",
              baseUrl: "https://provider.invalid",
              models: [
                completionModelDefinition({
                  id: modelId,
                  ...(screenshots
                    ? { contextWindow: 65_536, input: ["text", "image"] }
                    : { contextWindow: 200_000 }),
                }),
              ],
            },
          },
        },
        plugins: {
          allow: [providerPluginId],
          slots: { memory: "none" },
          entries: { [providerPluginId]: { enabled: true } },
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
          const runId = `${sessionId}-run`;
          const admission = prepareSystemAgentRunAdmission(config, runId, "main", sessionId);
          const lifecycle: Array<Record<string, unknown>> = [];
          try {
            const result = await runEmbeddedAgent({
              preparedRunAdmission: admission,
              config,
              runId,
              sessionId,
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              sessionTarget: {
                agentId: "main",
                sessionId,
                sessionKey: `agent:main:${sessionId}`,
                storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
              },
              provider: "anthropic",
              model: modelId,
              prompt,
              toolsAllow: ["read", "write"],
              cleanupBundleMcpOnRunEnd: true,
              timeoutMs: 60_000,
              onAgentEvent: (event) => {
                if (event.stream === "lifecycle") {
                  lifecycle.push({ ...event.data });
                }
              },
            });
            expect(network).not.toHaveBeenCalled();
            expect(requests).toEqual(
              interrupted
                ? ["write-a", ...Array<string>(screenshots).fill("read"), "length", "summary"]
                : ["write-a", "write-b", "stop", "summary"],
            );
            expect(summaryRequestHasPrompt).toBe(true);
            if (screenshots) {
              // The request survives inside the replay byte bound, not by loading everything.
              expect(summaryRequestBytes).toBeLessThan(65_536 * 8);
            }
            expect(await fs.readFile(path.join(state.workspaceDir, "a.txt"), "utf8")).toBe(
              "alpha\n",
            );
            const bContent = await fs
              .readFile(path.join(state.workspaceDir, "b.txt"), "utf8")
              .catch(() => undefined);
            expect(bContent).toBe(interrupted ? undefined : "beta\n");
            const deliveredText = result.payloads?.map((payload) => payload.text ?? "").join("\n");
            expect(deliveredText).toContain(summary);
            if (interrupted) {
              expect(deliveredText).toContain(cutoffNotice);
              expect.soft(result.meta.error).toMatchObject({
                kind: "incomplete_turn",
                fallbackSafe: false,
              });
              expect.soft(result.meta.stopReason).toBe("length");
              expect.soft(result.meta.completion).toMatchObject({
                stopReason: "length",
                finishReason: "length",
              });
              expect.soft(lifecycle.filter((event) => event.phase === "end")).toEqual([]);
              expect.soft(lifecycle).toContainEqual(expect.objectContaining({ phase: "error" }));
            } else {
              expect(deliveredText).not.toContain(cutoffNotice);
              expect(result.meta.error).toBeUndefined();
              expect(result.meta.stopReason).toBe("stop");
              expect(result.meta.completion).toMatchObject({
                stopReason: "stop",
                finishReason: "stop",
              });
              expect(lifecycle.filter((event) => event.phase === "error")).toEqual([]);
              expect(lifecycle).toContainEqual(expect.objectContaining({ phase: "end" }));
            }
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
      clearEmbeddedSessionPromptStates([sessionId]);
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  });
});
