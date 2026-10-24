import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionRuntimeV2 } from "../decisions/types-v2.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const traceKey = Symbol.for("openclaw.test.cloudflare-decision-path");
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
  vi.restoreAllMocks();
});

it.each([
  "gateway-only",
  "workers",
  "pinned-workers",
  "pinned-gateway",
  "configured-model",
] as const)("runs the actual Clef plugin with isolated credentials (%s)", async (auth) => {
  const state = await createOpenClawTestState({ applyEnv: false });
  onTestFinished(async () => {
    await resetPreparedModelRuntimeSnapshotsForTest();
    await state.cleanup();
  });
  const consumerRoot = path.join(state.root, "consumer");
  const emptyBundled = path.join(state.root, "bundled");
  fs.mkdirSync(consumerRoot);
  fs.mkdirSync(emptyBundled);
  const consumerId = "cloudflare-decision-consumer";
  const consumer = createColdPluginFixture({ rootDir: consumerRoot, pluginId: consumerId });
  fs.writeFileSync(
    consumer.runtimeSource,
    'const trace=globalThis[Symbol.for("openclaw.test.cloudflare-decision-path")]; module.exports={id:"cloudflare-decision-consumer",register(api){trace.runtime=api.runtime.decisions;}};',
  );
  const trace: { runtime?: DecisionRuntimeV2 } = {};
  Reflect.set(globalThis, traceKey, trace);
  let arrivals = 0;
  const received: Array<{
    url?: string;
    authorization?: string;
    gatewayAuth?: string;
    body: unknown;
  }> = [];
  await withServer(
    (request, response) => {
      arrivals += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          url: request.url,
          authorization: request.headers.authorization,
          gatewayAuth: request.headers["cf-aig-authorization"]?.toString(),
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: true,
            result: {
              model: "clef",
              answers: { urgent: { type: "noul", noul: 0.37 } },
              usage: { input_tokens: 14, output_tokens: 2 },
            },
          }),
        );
      });
    },
    async (origin) => {
      const ref = "cloudflare-workers-ai/@cf/cloudflare/clef";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "unrelated/not-configured",
            decisionModel:
              ref +
              (auth === "pinned-gateway"
                ? "@cloudflare-ai-gateway:default"
                : auth === "pinned-workers"
                  ? "@cloudflare-workers-ai:default"
                  : ""),
            workspace: path.join(state.root, "workspace"),
          },
        },
        models: {
          providers: {
            "cloudflare-ai-gateway": {
              baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
              apiKey: "synthetic-gateway-config-key",
              headers: { "cf-aig-authorization": "Bearer synthetic-gateway-routing-key" },
              models: [],
            },
            "cloudflare-workers-ai": {
              baseUrl:
                origin +
                (auth === "configured-model"
                  ? "/unused-provider-route"
                  : "/client/v4/accounts/synthetic-account/ai"),
              models:
                auth === "configured-model"
                  ? [
                      modelDefinition("@cf/cloudflare/clef", {
                        baseUrl: origin + "/client/v4/accounts/synthetic-account/ai",
                      }),
                    ]
                  : [],
              request: { allowPrivateNetwork: true },
            },
          },
        },
        plugins: {
          load: {
            paths: [
              fileURLToPath(new URL("../../extensions/cloudflare-ai-gateway", import.meta.url)),
              consumerRoot,
            ],
          },
          slots: { memory: "none" },
          entries: {
            "cloudflare-ai-gateway": { enabled: true },
            [consumerId]: {
              enabled: true,
              llm: {
                allowedCompletionModels: [ref],
                allowAgentIdOverride: false,
                allowModelOverride: false,
                allowAuthProfileOverride: false,
              },
            },
          },
        },
      };
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(state.root, { bundledPluginsDir: emptyBundled }),
          ...state.envVars,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          CLOUDFLARE_WORKERS_AI_API_TOKEN: undefined,
          CLOUDFLARE_AI_GATEWAY_API_KEY: "synthetic-gateway-env-key",
        },
        async () => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "cloudflare-ai-gateway:default": {
                type: "api_key",
                provider: "cloudflare-ai-gateway",
                key: "synthetic-gateway-profile-key",
              },
              ...(auth === "gateway-only"
                ? {}
                : {
                    "cloudflare-workers-ai:default": {
                      type: "api_key" as const,
                      provider: "cloudflare-workers-ai",
                      key: "synthetic-workers-profile-key",
                    },
                  }),
            },
          });
          setRuntimeConfigSnapshot(cfg);
          const registry = await loadAndActivateRootPluginRegistry({
            config: cfg,
            workspaceDir: path.join(state.root, "workspace"),
          });
          expect(registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
          const provider = registry.decisionProviders.find(
            (entry) => entry.host.provider.id === "cloudflare-workers-ai",
          )?.host.provider;
          if (!provider || provider.contractVersion !== 2) {
            throw new Error("Missing registered Clef Decision provider");
          }
          const dispatch = provider.evaluate.bind(provider);
          const evaluate = vi.spyOn(provider, "evaluate");
          const runtime = trace.runtime;
          if (!runtime) {
            throw new Error("Missing registered Decision SDK");
          }
          // Compile the source-only prepared runtime before its operation deadline starts.
          await import("./decision-inference.js");
          const evaluateFixture = () =>
            runtime.evaluateV2(
              {
                state: { type: "text", text: "Synthetic evidence" },
                questions: { urgent: { type: "boolean", instructions: "Is it urgent?" } },
              },
              {
                agentId: "main",
                purpose: "cloudflare-native-fixture",
                rubricVersion: "1",
                timeoutMs: 5_000,
                signal: new AbortController().signal,
              },
            );
          const outcome = await evaluateFixture();
          if (auth === "workers" || auth === "pinned-workers" || auth === "configured-model") {
            expect(outcome, JSON.stringify({ outcome, received })).toMatchObject({
              status: "ok",
              result: {
                model: "clef",
                answers: { urgent: { probabilityTrue: 0.37 } },
                usage: { inputTokens: 14, outputTokens: 2 },
              },
              provenance: { providerId: "cloudflare-workers-ai" },
            });
            const prepared = evaluate.mock.calls[0]?.[1].model;
            expect(prepared?.baseUrl).toBe(origin + "/client/v4/accounts/synthetic-account/ai");
            expect(prepared?.inference?.decision?.billing).toBeUndefined();
            expect(received).toEqual([
              {
                url: "/client/v4/accounts/synthetic-account/ai/run/@cf/cloudflare/clef",
                authorization: "Bearer synthetic-workers-profile-key",
                gatewayAuth: undefined,
                body: {
                  model: "clef",
                  state: "Synthetic evidence",
                  questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
                },
              },
            ]);
            expect(arrivals).toBe(1);

            const denied = structuredClone(cfg);
            denied.plugins!.entries![consumerId]!.llm!.allowedCompletionModels = [
              "cloudflare-workers-ai/unrelated-fixture",
            ];
            setRuntimeConfigSnapshot(denied);
            await expect(evaluateFixture()).rejects.toMatchObject({
              code: "LLM_COMPLETION_NOT_AUTHORIZED",
            });
            expect(evaluate).toHaveBeenCalledOnce();
            expect(arrivals).toBe(1);
            setRuntimeConfigSnapshot(cfg);

            let revokedDuringPreparation = false;
            evaluate.mockImplementationOnce((batch, context) => {
              // Guarded transport yields before dispatch. Revoke the selected-model
              // authority before its final physical-dispatch check.
              queueMicrotask(() => {
                revokedDuringPreparation = true;
                setRuntimeConfigSnapshot({
                  ...cfg,
                  agents: { defaults: { ...cfg.agents?.defaults, decisionModel: "" } },
                });
              });
              return dispatch(batch, context);
            });
            expect(await evaluateFixture()).toMatchObject({
              status: "unavailable",
              reason: "retiring",
            });
            expect(revokedDuringPreparation).toBe(true);
            expect(arrivals).toBe(1);
            expect(received).toHaveLength(1);
          } else {
            expect(outcome).toMatchObject({
              status: "unavailable",
              reason: "credentials-unavailable",
            });
            expect(received).toEqual([]);
            expect(arrivals).toBe(0);
          }
          expect(cfg.agents?.defaults?.model).toBe("unrelated/not-configured");
          await resetPreparedModelRuntimeSnapshotsForTest();
        },
      );
    },
  );
});
