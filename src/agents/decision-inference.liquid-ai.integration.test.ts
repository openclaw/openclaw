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
import { loadPluginManifest } from "../plugins/manifest.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { ProviderPrepareRuntimeAuthContextV2 } from "../plugins/provider-runtime.types.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const traceKey = Symbol.for("openclaw.test.liquid-ai-decision-path");
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
  vi.restoreAllMocks();
});

it.each(["profile", "environment", "missing-native", "exchange"] as const)(
  "keeps Liquid AI %s auth isolated while dispatch authority changes",
  async (authSource) => {
    const state = await createOpenClawTestState({ applyEnv: false });
    onTestFinished(async () => {
      await resetPreparedModelRuntimeSnapshotsForTest();
      await state.cleanup();
    });
    const consumerRoot = path.join(state.root, "consumer");
    const emptyBundled = path.join(state.root, "bundled");
    fs.mkdirSync(consumerRoot);
    fs.mkdirSync(emptyBundled);
    const consumerId = "liquid-decision-consumer";
    const consumer = createColdPluginFixture({ rootDir: consumerRoot, pluginId: consumerId });
    fs.writeFileSync(
      consumer.runtimeSource,
      'const trace=globalThis[Symbol.for("openclaw.test.liquid-ai-decision-path")]; module.exports={id:"liquid-decision-consumer",register(api){trace.runtime=api.runtime.decisions;}};',
    );
    let exchangeGate: (() => Promise<void>) | undefined;
    const exchange = vi.fn(async (context: ProviderPrepareRuntimeAuthContextV2) => {
      expect(context.capability).toBe("decision");
      expect(context.model).not.toHaveProperty("contextWindow");
      await exchangeGate?.();
      return {
        apiKey: "synthetic-exchanged-token",
        request: { headers: { "x-fixture-exchanged": "true" } },
      };
    });
    const trace: { runtime?: DecisionRuntimeV2; exchange: typeof exchange } = { exchange };
    Reflect.set(globalThis, traceKey, trace);
    let arrivals = 0;
    const received: Array<{
      url?: string;
      authorization?: string;
      exchanged?: string | string[];
      body: unknown;
    }> = [];
    // The fixture replaces only Liquid's HTTP service, not the guarded transport.
    // Hosted entitlement and model quality still require separate live proof.
    await withServer(
      (request, response) => {
        arrivals += 1;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push({
            url: request.url,
            authorization: request.headers.authorization,
            exchanged: request.headers["x-fixture-exchanged"],
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              model: "d1-ultra",
              answers: { urgent: { type: "noul", noul: 0.37 } },
              usage: { input_tokens: 14, output_tokens: 0 },
            }),
          );
        });
      },
      async (origin) => {
        const baseUrl = origin + "/tenant/decisions/v1";
        const sourceRoot = fileURLToPath(new URL("../../extensions/liquid-ai", import.meta.url));
        const pluginRoot = path.join(state.root, "liquid-ai");
        fs.mkdirSync(pluginRoot);
        for (const file of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
          if (file.isFile() && !file.name.includes(".test.")) {
            fs.copyFileSync(path.join(sourceRoot, file.name), path.join(pluginRoot, file.name));
          }
        }
        if (authSource === "exchange") {
          // Capture the synthetic hook in every prepared registry generation;
          // the real native plugin, auth owner and guarded transport remain intact.
          fs.renameSync(
            path.join(pluginRoot, "index.ts"),
            path.join(pluginRoot, "provider-entry.ts"),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "index.ts"),
            `import plugin from "./provider-entry.js";
const trace = globalThis[Symbol.for("openclaw.test.liquid-ai-decision-path")];
export default {
  ...plugin,
  register(api) {
    plugin.register({
      ...api,
      registerProvider(provider) {
        api.registerProvider({ ...provider, prepareRuntimeAuthV2: trace.exchange });
      },
    });
  },
};`,
          );
        }
        const manifest = loadPluginManifest(sourceRoot);
        if (!manifest.ok) {
          throw new Error(manifest.error);
        }
        const declared = structuredClone(manifest.manifest);
        const catalog = declared.modelCatalog?.providers?.["liquid-ai"];
        if (!catalog) {
          throw new Error("Missing Liquid model catalog");
        }
        // Native Decision capabilities are route-bound. Declare only the fixture
        // endpoint; the registered plugin code and guarded transport stay unchanged.
        catalog.baseUrl = baseUrl;
        fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify(declared));
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              model: "liquid/liquid.auto",
              decisionModel:
                authSource === "profile" || authSource === "exchange"
                  ? "liquid-ai/d1-ultra@liquid-ai:fixture"
                  : "liquid-ai/d1-ultra",
              workspace: path.join(state.root, "workspace"),
            },
          },
          models: {
            providers: {
              liquid: {
                baseUrl: origin + "/exchange/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "liquid.auto",
                    name: "Liquid Inference",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 8192,
                  },
                ],
              },
              "liquid-ai": {
                baseUrl,
                models: [],
                request: { allowPrivateNetwork: true },
              },
            },
          },
          plugins: {
            load: {
              paths: [pluginRoot, consumerRoot],
            },
            slots: { memory: "none" },
            entries: {
              "liquid-ai": { enabled: true },
              [consumerId]: {
                enabled: true,
                llm: {
                  allowedCompletionModels: ["liquid-ai/d1-ultra"],
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
            LIQUID_API_KEY: "synthetic-exchange-env-key",
            LIQUIDAI_API_KEY: authSource === "environment" ? "synthetic-native-env-key" : undefined,
          },
          async () => {
            await state.writeAuthProfiles({
              version: 1,
              profiles: {
                "liquid:default": {
                  type: "api_key",
                  provider: "liquid",
                  key: "synthetic-exchange-profile-key",
                },
                ...(authSource === "profile" || authSource === "exchange"
                  ? {
                      "liquid-ai:fixture": {
                        type: "api_key",
                        provider: "liquid-ai",
                        key: "synthetic-liquid-profile-key",
                      },
                    }
                  : {}),
              },
            });
            setRuntimeConfigSnapshot(cfg);
            const registry = await loadAndActivateRootPluginRegistry({
              config: cfg,
              workspaceDir: path.join(state.root, "workspace"),
            });
            expect(registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
            const runtime = trace.runtime;
            const provider = registry.decisionProviders.find(
              (entry) => entry.host.provider.id === "liquid-ai",
            )?.host.provider;
            if (!runtime || provider?.contractVersion !== 2) {
              throw new Error("Missing registered Liquid Decision provider");
            }
            // Compile source-only preparation before the caller's operation deadline starts.
            await import("./decision-inference.js");
            const batch = {
              state: { type: "text" as const, text: "Synthetic evidence" },
              questions: { urgent: { type: "boolean" as const, instructions: "Is it urgent?" } },
            };
            const options = () => ({
              agentId: "main",
              purpose: "liquid-ai-native-fixture",
              rubricVersion: "1",
              timeoutMs: 5_000,
              signal: new AbortController().signal,
            });
            // The exchange key and profile must never authenticate a native Decision call.
            if (authSource === "missing-native") {
              expect(await runtime.evaluateV2(batch, options())).toMatchObject({
                status: "unavailable",
                reason: "credentials-unavailable",
              });
              expect(received).toHaveLength(0);
              expect(arrivals).toBe(0);
              expect(exchange).not.toHaveBeenCalled();
              expect(cfg.agents?.defaults?.model).toBe("liquid/liquid.auto");
              return;
            }
            const denied = structuredClone(cfg);
            denied.plugins!.entries![consumerId]!.llm!.allowedCompletionModels = [
              "liquid-ai/unrelated-fixture",
            ];
            setRuntimeConfigSnapshot(denied);
            await expect(runtime.evaluateV2(batch, options())).rejects.toMatchObject({
              code: "LLM_COMPLETION_NOT_AUTHORIZED",
            });
            expect(received).toHaveLength(0);
            expect(arrivals).toBe(0);
            expect(exchange).not.toHaveBeenCalled();

            setRuntimeConfigSnapshot(cfg);
            const outcome = await runtime.evaluateV2(batch, options());
            expect(outcome, JSON.stringify({ outcome, received })).toMatchObject({
              status: "ok",
              result: {
                model: "d1-ultra",
                answers: { urgent: { probabilityTrue: 0.37 } },
                usage: { inputTokens: 14, outputTokens: 0 },
              },
              provenance: { providerId: "liquid-ai" },
            });
            expect(received).toEqual([
              {
                url: "/tenant/decisions/v1/systemone",
                authorization:
                  authSource === "exchange"
                    ? "Bearer synthetic-exchanged-token"
                    : authSource === "profile"
                      ? "Bearer synthetic-liquid-profile-key"
                      : "Bearer synthetic-native-env-key",
                exchanged: authSource === "exchange" ? "true" : undefined,
                body: {
                  model: "d1-ultra",
                  state: "Synthetic evidence",
                  questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
                },
              },
            ]);
            expect(arrivals).toBe(1);
            if (authSource === "exchange") {
              expect(exchange).toHaveBeenCalledOnce();
              const entered = createDeferredCore();
              const release = createDeferredCore();
              exchangeGate = async () => {
                entered.resolve();
                await release.promise;
              };
              const pending = runtime.evaluateV2(batch, options());
              let settled = false;
              const settlement = pending.then(
                (exchangeOutcome) => {
                  settled = true;
                  return { outcome: exchangeOutcome };
                },
                (error: unknown) => {
                  settled = true;
                  return { error };
                },
              );
              try {
                await Promise.race([entered.promise, settlement]);
                expect(settled).toBe(false);
                setRuntimeConfigSnapshot({
                  ...cfg,
                  agents: { defaults: { ...cfg.agents?.defaults, decisionModel: "" } },
                });
                release.resolve();
                expect(await settlement).toMatchObject({
                  outcome: { status: "unavailable", reason: "retiring" },
                });
                expect(exchange).toHaveBeenCalledTimes(2);
                expect(received).toHaveLength(1);
                expect(arrivals).toBe(1);
              } finally {
                release.resolve();
                await settlement;
                exchangeGate = undefined;
                setRuntimeConfigSnapshot(cfg);
              }
            } else {
              expect(exchange).not.toHaveBeenCalled();
            }

            const foreign = structuredClone(cfg);
            foreign.models!.providers!["liquid-ai"]!.baseUrl = origin + "/undeclared";
            setRuntimeConfigSnapshot(foreign);
            expect(await runtime.evaluateV2(batch, options())).toMatchObject({
              status: "unavailable",
              reason: "unsupported-input",
            });
            expect(received).toHaveLength(1);
            expect(arrivals).toBe(1);
            setRuntimeConfigSnapshot(cfg);

            const evaluate = provider.evaluate.bind(provider);
            let revokedDuringPreparation = false;
            vi.spyOn(provider, "evaluate").mockImplementationOnce((offered, context) => {
              // Guarded fetch yields while preparing its dispatcher. Revoke the real
              // selected-model authority before its final physical-dispatch check.
              queueMicrotask(() => {
                revokedDuringPreparation = true;
                setRuntimeConfigSnapshot({
                  ...cfg,
                  agents: { defaults: { ...cfg.agents?.defaults, decisionModel: "" } },
                });
              });
              return evaluate(offered, context);
            });
            expect(await runtime.evaluateV2(batch, options())).toMatchObject({
              status: "unavailable",
              reason: "retiring",
            });
            expect(revokedDuringPreparation).toBe(true);
            expect(received).toHaveLength(1);
            expect(arrivals).toBe(1);
            expect(cfg.agents?.defaults?.model).toBe("liquid/liquid.auto");
            await resetPreparedModelRuntimeSnapshotsForTest();
          },
        );
      },
    );
  },
);
