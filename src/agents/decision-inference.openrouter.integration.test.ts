import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { normalizeModelCatalogProviderRows } from "../../packages/model-catalog-core/src/model-catalog-normalize.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { normalizeManifestModelCatalog } from "../plugins/manifest-decision-catalog.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as harness from "./decision-inference.test-support.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { buildAllowedModelSet } from "./model-selection-shared.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

function readOpenRouterManifest() {
  const result = loadPluginManifest(
    fileURLToPath(new URL("../../extensions/openrouter", import.meta.url)),
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return structuredClone(result.manifest);
}

const traceKey = Symbol.for("openclaw.test.openrouter-decision-path");
const modelId = "typesafe/jev-1.13";
const modelRef = `openrouter/${modelId}`;
const resolvedModel = "typesafe/jev-1.13-20260917";
afterEach(async () => {
  await harness.resetDecisionTestRuntime(traceKey);
});

it.each([
  { route: "canonical", auth: "api-key" },
  { route: "canonical", auth: "oauth-key" },
  { route: "declared-proxy", auth: "api-key" },
] as const)(
  "runs the actual OpenRouter plugin through prepared auth and native HTTP ($route, $auth)",
  async ({ route, auth }) => {
    const state = await createOpenClawTestState({ applyEnv: false });
    onTestFinished(async () => {
      await resetPreparedModelRuntimeSnapshotsForTest();
      await state.cleanup();
    });
    const root = state.root;
    const consumerId = "openrouter-decision-consumer";
    const { consumerRoot, trace } = harness.createDecisionConsumer(root, consumerId, traceKey);
    let cost: number | undefined = 0.000019992;
    let upstreamProvider: string | undefined = "TypeSafe";
    let status = 200;
    const responseBody = () => ({
      model: resolvedModel,
      provider: upstreamProvider,
      answers: {
        q: { type: "noul", noul: 0.37 },
        c: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.8, technical: 0.2 },
          confidence: 0.6,
        },
        s: {
          type: "score",
          score: 0.25,
          probabilities: { "0": 0.75, "1": 0.25 },
          confidence: 0.5,
        },
      },
      usage: { input_tokens: 476, output_tokens: 70, cost },
    });
    await harness.withDecisionServer(
      (transport) => ({
        status,
        body:
          status === 200
            ? responseBody()
            : transport === "http"
              ? "synthetic-private-error"
              : { error: "synthetic-private-error" },
      }),
      async ({ origin, requests: received, mockFetch }) => {
        const baseUrl =
          route === "canonical" ? "https://openrouter.ai/api/v1" : origin + "/tenant/api/v1";
        let pluginRoot = fileURLToPath(new URL("../../extensions/openrouter", import.meta.url));
        if (route === "declared-proxy") {
          const fixtureRoot = path.join(root, "openrouter");
          fs.mkdirSync(fixtureRoot);
          for (const file of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
            if (file.isFile() && !file.name.includes(".test.")) {
              fs.copyFileSync(path.join(pluginRoot, file.name), path.join(fixtureRoot, file.name));
            }
          }
          // The owning plugin, not config or upstream modalities, declares this route.
          const declared = readOpenRouterManifest();
          const models = declared.modelCatalog?.providers?.openrouter?.models;
          if (!models) {
            throw new Error("Missing fixture route declarations");
          }
          for (const model of models) {
            model.baseUrl = baseUrl;
          }
          fs.writeFileSync(
            path.join(fixtureRoot, "openclaw.plugin.json"),
            JSON.stringify(declared),
          );
          pluginRoot = fixtureRoot;
        } else {
          // Keep the shipped manifest and actual SSRF/host boundary. Only HTTP I/O is synthetic.
          mockFetch(baseUrl + "/systemone");
        }
        const credential =
          auth === "oauth-key" ? "synthetic-oauth-issued-key" : "synthetic-openrouter-credential";
        const cfg = harness.decisionConfig(
          root,
          modelRef + (auth === "oauth-key" ? "@openrouter:oauth-fixture" : ""),
          {
            load: { paths: [pluginRoot, consumerRoot] },
            entries: {
              openrouter: { enabled: true },
              [consumerId]: {
                enabled: true,
                llm: {
                  allowedCompletionModels: [modelRef],
                  allowAgentIdOverride: false,
                  allowModelOverride: false,
                  allowAuthProfileOverride: false,
                },
              },
            },
          },
        );
        cfg.diagnostics = { enabled: true };
        cfg.agents!.defaults!.models = {
          [modelRef]: { params: { provider: { order: ["typesafe"], require_parameters: true } } },
        };
        cfg.models = {
          providers: {
            openrouter: {
              baseUrl,
              apiKey: auth === "oauth-key" ? "synthetic-not-selected" : credential,
              models: [],
              headers: {
                "X-Fixture-Tenant": "synthetic-replaced-tenant",
                ...(route === "declared-proxy"
                  ? { Authorization: "Bearer synthetic-replaced-auth" }
                  : {}),
              },
              params: {
                provider: { data_collection: "deny", only: ["typesafe"], allow_fallbacks: false },
              },
              request: {
                allowPrivateNetwork: true,
                headers: { "x-fixture-tenant": "fixture-tenant" },
                ...(route === "declared-proxy"
                  ? {
                      auth: {
                        mode: "header" as const,
                        headerName: "x-fixture-auth",
                        value: "synthetic-prepared-custom",
                      },
                    }
                  : {}),
              },
            },
          },
        };
        const sourceConfig = structuredClone(cfg);
        const sourceProvider = sourceConfig.models!.providers!.openrouter!;
        sourceProvider.request!.headers = {
          "x-fixture-tenant": { source: "env", provider: "default", id: "FIXTURE_TENANT" },
        };
        if (sourceProvider.request!.auth?.mode === "header") {
          sourceProvider.request!.auth.value = {
            source: "env",
            provider: "default",
            id: "FIXTURE_AUTH",
          };
        }
        await withEnvAsync(
          harness.decisionEnv(root, {
            ...state.envVars,
            OPENROUTER_API_KEY: undefined,
          }),
          async () => {
            if (auth === "oauth-key") {
              // PKCE persists an API key selected through the normal profile owner.
              await state.writeAuthProfiles({
                version: 1,
                profiles: {
                  "openrouter:oauth-fixture": {
                    type: "api_key",
                    provider: "openrouter",
                    key: credential,
                    metadata: { authFlow: "oauth-pkce" },
                  },
                },
              });
            }
            const registry = await harness.activateDecisionRegistry(cfg, {}, sourceConfig);
            expect({
              providers: registry.providers.filter((entry) => entry.provider.id === "openrouter")
                .length,
              decisions: registry.decisionProviders.filter(
                (entry) => entry.host.provider.id === "openrouter",
              ).length,
            }).toEqual({ providers: 1, decisions: 1 });
            const events = harness.trackDecisionUsage();
            const runtime = trace.runtime;
            if (!runtime) {
              throw new Error("Missing registered decision SDK");
            }
            // Warm the lazy import before ProviderHost starts its operation deadline.
            await import("./decision-inference.js");
            const options = () =>
              harness.decisionOptions({
                agentId: "main",
                purpose: "openrouter-native-fixture",
                rubricVersion: "1",
              });
            const batch = {
              state: { type: "text" as const, text: "Synthetic evidence" },
              questions: {
                q: { type: "boolean" as const, instructions: "Is it urgent?" },
                c: {
                  type: "choice" as const,
                  instructions: "Which team?",
                  criteria: { billing: "Invoices", technical: "Software" },
                },
                s: {
                  type: "score" as const,
                  instructions: "How urgent?",
                  criteria: ["Low", "High"],
                },
              },
            };
            const evaluate = (overrides: Parameters<typeof harness.decisionOptions>[0] = {}) =>
              runtime.evaluateV2(batch, { ...options(), ...overrides });
            const selectModel = (decisionModel: string) =>
              setRuntimeConfigSnapshot({
                ...cfg,
                agents: { defaults: { ...cfg.agents?.defaults, decisionModel } },
              });
            const denied = structuredClone(cfg);
            denied.plugins!.entries![consumerId]!.llm!.allowedCompletionModels = [
              "openrouter/unrelated-fixture",
            ];
            setRuntimeConfigSnapshot(denied);
            await expect(evaluate()).rejects.toMatchObject({
              code: "LLM_COMPLETION_NOT_AUTHORIZED",
            });
            expect({ received, events }).toEqual({ received: [], events: [] });
            setRuntimeConfigSnapshot(cfg, sourceConfig);
            const outcome = await evaluate();
            expect(outcome, JSON.stringify({ outcome, received })).toMatchObject({
              status: "ok",
              result: {
                model: resolvedModel,
                metadata: { provider: "TypeSafe" },
                answers: {
                  q: { type: "boolean", probabilityTrue: 0.37 },
                  c: { type: "choice", choice: "billing" },
                  s: { type: "score", score: 0.25, probabilities: [0.75, 0.25] },
                },
                usage: { inputTokens: 476, outputTokens: 70, costUsd: cost },
              },
              provenance: { providerId: "openrouter" },
            });
            expect(received[0]?.url).toBe(baseUrl + "/systemone");
            expect(
              ["authorization", "x-fixture-auth", "x-fixture-tenant"].map((name) =>
                received[0]?.headers.get(name),
              ),
            ).toEqual([
              route === "canonical" ? `Bearer ${credential}` : null,
              route === "declared-proxy" ? "synthetic-prepared-custom" : null,
              "fixture-tenant",
            ]);
            expect(received[0]?.body).toEqual({
              model: modelId,
              state: "Synthetic evidence",
              questions: {
                ...batch.questions,
                q: { type: "noul", instructions: "Is it urgent?" },
              },
              provider: {
                data_collection: "deny",
                only: ["typesafe"],
                allow_fallbacks: false,
                order: ["typesafe"],
                require_parameters: true,
              },
            });
            expect(events).toMatchObject([
              {
                provider: "openrouter",
                model: modelId,
                usage: { input: 476, output: 70 },
                costUsd: cost,
              },
            ]);
            if (auth === "oauth-key") {
              await resetPreparedModelRuntimeSnapshotsForTest();
              return;
            }
            cost = 0;
            expect(await evaluate()).toMatchObject({ result: { usage: { costUsd: 0 } } });
            expect(events).toHaveLength(2);
            expect(events[1]?.costUsd).toBe(0);
            const legacy = { state: "Synthetic evidence", questions: batch.questions };
            expect(await runtime.evaluate(legacy, options())).toMatchObject({
              status: "unavailable",
              reason: "unsupported-input",
            });
            cost = undefined;
            upstreamProvider = undefined;
            expect(await runtime.evaluate(legacy, options())).toMatchObject({
              status: "ok",
              result: { answers: { q: { probabilityTrue: 0.37 } } },
            });
            const calls = received.length;
            const expectNoDispatch = async (
              reason: string,
              overrides: Parameters<typeof evaluate>[0] = {},
            ) => {
              expect(await evaluate(overrides)).toMatchObject({ status: "unavailable", reason });
              expect(received).toHaveLength(calls);
            };
            await expectNoDispatch("unsupported-input", { reasoning: "on" });
            const foreign = structuredClone(cfg);
            foreign.models!.providers!.openrouter!.baseUrl = origin + "/undeclared";
            setRuntimeConfigSnapshot(foreign);
            await expectNoDispatch("unsupported-input");
            selectModel(`${modelRef}@missing-fixture-profile`);
            await expectNoDispatch("credentials-unavailable");
            setRuntimeConfigSnapshot(cfg, sourceConfig);
            if (route === "declared-proxy") {
              const provider = registry.decisionProviders.find(
                (entry) => entry.host.provider.id === "openrouter",
              )?.host.provider;
              if (provider?.contractVersion !== 2) {
                throw new Error("Missing registered OpenRouter V2 provider");
              }
              const providerEvaluate = provider.evaluate.bind(provider);
              let closedDuringPreparation = false;
              vi.spyOn(provider, "evaluate").mockImplementationOnce((offered, context) => {
                // Revoke authority after preparation yields, before physical dispatch.
                queueMicrotask(() => {
                  closedDuringPreparation = true;
                  selectModel("");
                });
                return providerEvaluate(offered, context);
              });
              await expectNoDispatch("retiring");
              expect(closedDuringPreparation).toBe(true);
              setRuntimeConfigSnapshot(cfg, sourceConfig);
            }
            // Authentication latches the generation; test it last so other errors prove recovery.
            for (const code of [413, 401]) {
              status = code;
              expect(await evaluate()).toMatchObject({
                reason: code === 401 ? "authentication" : "unsupported-input",
              });
            }
            expect(received).toHaveLength(calls + 2);
            await resetPreparedModelRuntimeSnapshotsForTest();
          },
        );
      },
      { data: [{ id: modelId, architecture: { modality: "text->decisions" } }] },
    );
  },
);

it("projects the declared Jev routes as decision-only without fabricated chat fields", () => {
  const manifest = readOpenRouterManifest();
  const catalog = normalizeManifestModelCatalog({
    providers: manifest.providers ?? [],
    cliBackends: [],
    decisionProviders: manifest.contracts?.decisionProviders,
    decisionModels: undefined,
    modelCatalog: manifest.modelCatalog,
  });
  const providerCatalog = catalog?.providers?.openrouter;
  if (!providerCatalog) {
    throw new Error("Missing canonical OpenRouter model catalog");
  }
  const rows = normalizeModelCatalogProviderRows({
    provider: "openrouter",
    providerCatalog,
    source: "manifest",
  });
  expect(rows.map((row) => row.id)).toEqual([
    "~typesafe/jev-latest",
    "typesafe/jev-1.13",
    "typesafe/jev-1.14",
  ]);
  for (const row of rows) {
    expect({ maxTokens: row.maxTokens, cost: row.cost }).toEqual({
      maxTokens: undefined,
      cost: undefined,
    });
    expect(row.inference?.decision).toMatchObject({
      input: ["text", "image"],
      limits: {
        maxStateAndQuestionTokens: 262144,
        image: { maxBytes: 4194304, mimeTypes: ["image/png", "image/jpeg"], remoteUrls: false },
      },
    });
    expect(Boolean(row.inference?.decision?.questions?.box)).toBe(row.id !== "typesafe/jev-1.13");
  }
  const conversational = buildAllowedModelSet({
    cfg: {},
    catalog: rows.map(modelCatalogRowToEntry),
    defaultProvider: "openrouter",
  });
  expect(conversational.allowedCatalog).toEqual([]);
  expect(conversational.allowedKeys.size).toBe(0);
});
