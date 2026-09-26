import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { normalizeModelCatalogProviderRows } from "../../packages/model-catalog-core/src/model-catalog-normalize.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionRuntimeV2 } from "../decisions/types-v2.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticUsageEvent,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { modelCatalogEntryMatchesTask } from "../model-catalog/decision-compatibility.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { normalizeManifestModelCatalog } from "../plugins/manifest-decision-catalog.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { modelFromStaticCatalogRow } from "./embedded-agent-runner/model.static-catalog-row.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
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

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.openrouter-decision-path");
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
  vi.unstubAllGlobals();
});

it.each(["canonical", "declared-proxy"] as const)(
  "runs the actual OpenRouter plugin through prepared auth and native HTTP (%s)",
  async (route) => {
    const root = roots.make("openrouter-decision-host-");
    const consumerRoot = path.join(root, "consumer");
    const emptyBundled = path.join(root, "bundled");
    fs.mkdirSync(consumerRoot);
    fs.mkdirSync(emptyBundled);
    const consumerId = "openrouter-decision-consumer";
    const consumer = createColdPluginFixture({ rootDir: consumerRoot, pluginId: consumerId });
    fs.writeFileSync(
      consumer.runtimeSource,
      'const trace=globalThis[Symbol.for("openclaw.test.openrouter-decision-path")]; module.exports={id:"openrouter-decision-consumer",register(api){trace.runtime=api.runtime.decisions;}};',
    );
    const trace: { runtime?: DecisionRuntimeV2 } = {};
    Reflect.set(globalThis, traceKey, trace);
    const received: Array<{
      url?: string;
      authorization?: string;
      tenant?: string;
      customAuth?: string;
      body: unknown;
    }> = [];
    let cost: number | undefined = 0.000019992;
    let upstreamProvider: string | undefined = "TypeSafe";
    let status = 200;
    await withServer(
      (request, response) => {
        if (request.url?.endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data: [{ id: "typesafe/jev-1.13", architecture: { modality: "text->decisions" } }],
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push({
            url: request.url,
            authorization: request.headers.authorization,
            tenant: String(request.headers["x-fixture-tenant"] ?? ""),
            customAuth: request.headers["x-fixture-auth"]?.toString(),
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            status === 200
              ? JSON.stringify({
                  model: "typesafe/jev-1.13-20260917",
                  provider: upstreamProvider,
                  answers: { q: { type: "noul", noul: 0.37 } },
                  usage: { input_tokens: 476, output_tokens: 70, cost },
                })
              : "synthetic-private-error",
          );
        });
      },
      async (origin) => {
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
          // This is an owning-plugin declaration for the synthetic served route, not a
          // config grant or an inference made from upstream modalities. Runtime is unchanged.
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
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (url, init) => {
              const target =
                typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
              if (target.endsWith("/models")) {
                return Response.json({ data: [] });
              }
              expect(target).toBe(baseUrl + "/systemone");
              if (typeof init?.body !== "string") {
                throw new Error("Expected a JSON string request body");
              }
              const headers = new Headers(init.headers);
              received.push({
                url: new URL(target).pathname,
                authorization: headers.get("authorization") ?? undefined,
                tenant: headers.get("x-fixture-tenant") ?? "",
                body: JSON.parse(init.body),
              });
              return Response.json(
                status === 200
                  ? {
                      model: "typesafe/jev-1.13-20260917",
                      provider: upstreamProvider,
                      answers: { q: { type: "noul", noul: 0.37 } },
                      usage: { input_tokens: 476, output_tokens: 70, cost },
                    }
                  : { error: "synthetic-private-error" },
                { status },
              );
            }),
          );
        }
        const cfg: OpenClawConfig = {
          diagnostics: { enabled: true },
          agents: {
            defaults: {
              model: "unrelated/not-configured",
              decisionModel: "openrouter/typesafe/jev-1.13",
              workspace: path.join(root, "workspace"),
              models: {
                "openrouter/typesafe/jev-1.13": {
                  params: { provider: { order: ["typesafe"], require_parameters: true } },
                },
              },
            },
          },
          models: {
            providers: {
              openrouter: {
                baseUrl,
                apiKey: "synthetic-openrouter-credential",
                models: [],
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
          },
          plugins: {
            load: {
              paths: [pluginRoot, consumerRoot],
            },
            slots: { memory: "none" },
            entries: { openrouter: { enabled: true }, [consumerId]: { enabled: true } },
          },
        };
        await withEnvAsync(
          {
            ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENROUTER_API_KEY: undefined,
          },
          async () => {
            setRuntimeConfigSnapshot(cfg);
            const registry = loadAndActivateRootPluginRegistry({
              config: cfg,
              workspaceDir: path.join(root, "workspace"),
            });
            expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
            expect(
              registry.providers.filter((entry) => entry.provider.id === "openrouter"),
            ).toHaveLength(1);
            expect(
              registry.decisionProviders.filter((entry) => entry.host.provider.id === "openrouter"),
            ).toHaveLength(1);
            const events: DiagnosticUsageEvent[] = [];
            onTestFinished(
              onTrustedInternalDiagnosticEvent(
                markTrustedOtelDiagnosticListener((event) => {
                  if (event.type === "model.usage") {
                    events.push(event);
                  }
                }),
              ),
            );
            const runtime = trace.runtime;
            if (!runtime) {
              throw new Error("Missing registered decision SDK");
            }
            const options = () => ({
              purpose: "openrouter-native-fixture",
              rubricVersion: "1",
              timeoutMs: 5000,
              signal: new AbortController().signal,
            });
            const batch = {
              state: { type: "text" as const, text: "Synthetic evidence" },
              questions: { q: { type: "boolean" as const, instructions: "Is it urgent?" } },
            };
            const outcome = await runtime.evaluateV2(batch, options());
            expect(outcome, JSON.stringify({ outcome, received })).toMatchObject({
              status: "ok",
              result: {
                model: "typesafe/jev-1.13-20260917",
                metadata: { provider: "TypeSafe" },
                answers: { q: { probabilityTrue: 0.37 } },
                usage: { inputTokens: 476, outputTokens: 70, costUsd: cost },
              },
              provenance: { providerId: "openrouter" },
            });
            expect(received[0]).toEqual({
              url: new URL(baseUrl).pathname + "/systemone",
              authorization:
                route === "canonical" ? "Bearer synthetic-openrouter-credential" : undefined,
              ...(route === "declared-proxy" ? { customAuth: "synthetic-prepared-custom" } : {}),
              tenant: "fixture-tenant",
              body: {
                model: "typesafe/jev-1.13",
                state: "Synthetic evidence",
                questions: { q: { type: "noul", instructions: "Is it urgent?" } },
                provider: {
                  data_collection: "deny",
                  only: ["typesafe"],
                  allow_fallbacks: false,
                  order: ["typesafe"],
                  require_parameters: true,
                },
              },
            });
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
              provider: "openrouter",
              model: "typesafe/jev-1.13",
              usage: { input: 476, output: 70 },
              costUsd: cost,
            });
            cost = 0;
            expect(await runtime.evaluateV2(batch, options())).toMatchObject({
              result: { usage: { costUsd: 0 } },
            });
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
            expect(
              await runtime.evaluateV2(batch, { ...options(), reasoning: "on" }),
            ).toMatchObject({
              reason: "unsupported-input",
            });
            expect(received).toHaveLength(calls);
            for (const code of [413, 401]) {
              status = code;
              expect(await runtime.evaluateV2(batch, options())).toMatchObject({
                reason: code === 401 ? "authentication" : "unsupported-input",
              });
            }
            const foreign = structuredClone(cfg);
            foreign.models!.providers!.openrouter!.baseUrl = origin + "/undeclared";
            setRuntimeConfigSnapshot(foreign);
            expect(await runtime.evaluateV2(batch, options())).toMatchObject({
              reason: "unsupported-input",
            });
            expect(received).toHaveLength(calls + 2);
            setRuntimeConfigSnapshot({
              ...cfg,
              agents: {
                defaults: {
                  ...cfg.agents?.defaults,
                  decisionModel: "openrouter/typesafe/jev-1.13@missing-fixture-profile",
                },
              },
            });
            expect(await runtime.evaluateV2(batch, options())).toMatchObject({
              reason: "credentials-unavailable",
            });
            expect(received).toHaveLength(calls + 2);
            await resetPreparedModelRuntimeSnapshotsForTest();
          },
        );
      },
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
  expect(rows.map((row) => row.id)).toEqual(["~typesafe/jev-latest", "typesafe/jev-1.13"]);
  for (const row of rows) {
    expect(row.maxTokens).toBeUndefined();
    expect(row.cost).toBeUndefined();
    expect(row.inference?.decision?.limits?.maxStateAndQuestionTokens).toBe(32000);
    expect(modelCatalogEntryMatchesTask(modelCatalogRowToEntry(row), "decision")).toBe(true);
    expect(modelCatalogEntryMatchesTask(modelCatalogRowToEntry(row))).toBe(false);
    expect(() => modelFromStaticCatalogRow(row)).toThrow("does not support chat");
  }
});
