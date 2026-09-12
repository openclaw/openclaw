import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createWorkerInferenceExecutor,
  type WorkerInferenceExecutionParams,
} from "../gateway/worker-environments/inference-runtime.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  acquireSimpleCompletionModel,
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.restoreAllMocks();
});

describe.each([undefined, "openai-completions"] as const)(
  "initial simple completion with provider API %s",
  (api) => {
    it.each(["agent", "worker", "raw"] as const)(
      "normalizes %s input once without an ambient prepared runtime",
      async (mode) => {
        await withOpenClawTestState({ label: "selected-completion" }, async (state) => {
          const requests: string[] = [];
          const server = createServer((request, response) => {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
              body += chunk;
            });
            request.on("end", () => {
              const { model } = JSON.parse(body) as { model: string };
              requests.push(model);
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(
                `data: ${JSON.stringify({
                  id: "selected-completion-response",
                  object: "chat.completion.chunk",
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: `materialized:${model}` },
                      finish_reason: "stop",
                    },
                  ],
                })}\n\ndata: [DONE]\n\n`,
              );
            });
          });
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              server.removeListener("error", reject);
              resolve();
            });
          });
          try {
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("Completion fixture did not expose a TCP port");
            }
            const baseUrl = `http://127.0.0.1:${address.port}/v1`;
            const nativeFetch = globalThis.fetch;
            vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
              const url = new URL(input instanceof Request ? input.url : input);
              expect(url.origin).toBe(new URL(baseUrl).origin);
              return nativeFetch(input, init);
            });
            const provider = "selected-completion";
            const models = ["middle", "final", "plain"].map((id) => ({
              id,
              name: id,
              provider,
              api: "openai-completions",
              baseUrl,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 4_096,
            }));
            await state.writeJson("provider/openclaw.plugin.json", {
              id: provider,
              providers: [provider],
              configSchema: { type: "object", properties: {}, additionalProperties: false },
              modelIdNormalization: {
                providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
              },
              modelCatalog: {
                discovery: { [provider]: "static" },
                providers: { [provider]: { api: "openai-completions", baseUrl, models } },
              },
            });
            const runtimePath = await state.writeText(
              "provider/index.cjs",
              `const models = ${JSON.stringify(models)};
module.exports = {
  id: ${JSON.stringify(provider)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Selected completion", auth: [],
      resolveDynamicModel({ modelId }) { return models.find(model => model.id === modelId); },
    });
  },
};
`,
            );
            const cfg: OpenClawConfig = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  model: {
                    primary: `${provider}/plain`,
                    fallbacks: [`${provider}/entry`, `${provider}/middle`],
                  },
                },
              },
              models: {
                providers: {
                  [provider]: { api, baseUrl, apiKey: "synthetic-fixture", models: [] },
                },
              },
              plugins: {
                allow: [provider],
                entries: { [provider]: { enabled: true } },
                load: { paths: [runtimePath] },
                slots: { memory: "none" },
              },
            };
            await state.writeConfig(cfg);
            const executeWorker = createWorkerInferenceExecutor({
              resolveSessionTarget: () => ({
                agentId: "main",
                sessionEntry: { sessionId: "selected-test", updatedAt: 0 },
                sessionKey: "agent:main:main",
                sessionStore: {},
                storePath: state.path("unused-session-store.sqlite"),
              }),
              resolveSessionAuthSelection: async () => undefined,
              recordUsage: () => {},
            });

            for (const [raw, expected] of [
              ["entry", "middle"],
              ["middle", "final"],
              ["plain", "plain"],
            ] as const) {
              if (mode === "worker") {
                const result = await executeWorker(workerRequest(cfg, provider, raw));
                expect(result).toMatchObject({
                  type: "done",
                  message: {
                    provider,
                    model: expected,
                    content: [{ type: "text", text: `materialized:${expected}` }],
                  },
                });
              } else {
                const prepared =
                  mode === "agent"
                    ? await acquireSimpleCompletionModelForAgent({
                        cfg,
                        agentId: "main",
                        modelRef: `${provider}/${raw}`,
                        allowBundledStaticCatalogFallback: true,
                      })
                    : await acquireSimpleCompletionModel({
                        cfg,
                        provider,
                        modelId: raw,
                        allowBundledStaticCatalogFallback: true,
                      });
                if ("error" in prepared) {
                  throw new Error(prepared.error);
                }
                try {
                  expect(prepared.model.id).toBe(expected);
                  const result = await completeWithPreparedSimpleCompletionModel({
                    cfg,
                    model: prepared.model,
                    auth: prepared.auth,
                    context: {
                      messages: [{ role: "user", content: "Synthetic input.", timestamp: 0 }],
                    },
                    options: { maxTokens: 64 },
                  });
                  expect(result).toMatchObject({
                    content: [{ type: "text", text: `materialized:${expected}` }],
                  });
                } finally {
                  await prepared[Symbol.asyncDispose]();
                }
              }
            }
            expect(requests).toEqual(["middle", "final", "plain"]);
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        });
      },
    );
  },
);

function workerRequest(
  config: OpenClawConfig,
  provider: string,
  model: string,
): WorkerInferenceExecutionParams {
  return {
    config,
    identity: {
      environmentId: "selected-test",
      credentialHash: "synthetic-fixture",
      bundleHash: "synthetic-fixture",
      sessionId: "selected-test",
      runId: "selected-test",
      ownerEpoch: 1,
      turnClaim: {
        sessionId: "selected-test",
        claimId: "selected-test",
        runId: "selected-test",
        placementGeneration: 1,
        owner: { kind: "worker", environmentId: "selected-test", ownerEpoch: 1 },
      },
      rpcSetVersion: 1,
      protocolFeatures: ["worker-inference-v1"],
      credentialExpiresAtMs: Number.MAX_SAFE_INTEGER,
    },
    request: {
      runEpoch: 1,
      sessionId: "selected-test",
      runId: "selected-test",
      turnId: "selected-test",
      modelRef: { provider, model },
      context: { messages: [{ role: "user", content: "Synthetic input.", timestamp: 0 }] },
      options: { maxTokens: 64 },
    },
    signal: new AbortController().signal,
    isCurrent: () => true,
    emit: () => {},
  };
}
