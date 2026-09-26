import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHostDecisionEvaluator } from "../decisions/runtime.js";
import type { DecisionBatchResultV2, DecisionRuntimeV2 } from "../decisions/types-v2.js";
import type { DecisionRuntimeV1 } from "../decisions/types.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticUsageEvent,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveModelCostConfig } from "../utils/usage-format.js";
import { VERSION } from "../version.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.decision-prepared-path");
type Trace = {
  calls: number;
  onDispatch?: () => void;
  work?: Promise<void>;
  authenticated: boolean;
  modelKeys?: string[];
  resultReads?: number;
  modelBilling?: unknown;
  usage?: DecisionBatchResultV2["usage"];
  mutateBilling?: boolean;
  unavailable?: boolean;
  modelBaseUrl?: string;
  modelHeaders?: Record<string, string>;
  modelApi?: string;
  preparedApi?: string;
  rewriteBaseUrl?: string;
  evaluate?: DecisionRuntimeV2["evaluateV2"];
  evaluateV1?: DecisionRuntimeV1["evaluate"];
};
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  setRemoteModelCatalogOverlaySourcesForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
});

it.each(["plugin", "agent", "exchange", "headers", "dual-headers"] as const)(
  "runs the retained decision SDK through real preparation without primary fallback or fabricated chat fields (%s auth)",
  async (authScope) => {
    const root = roots.make("decision-prepared-integration-");
    const pluginRoot = path.join(root, "plugin");
    const emptyBundled = path.join(root, "bundled");
    fs.mkdirSync(pluginRoot);
    fs.mkdirSync(emptyBundled);
    const id = "decision-prepared-fixture";
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: id,
      providerId: id,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { decisionProviders: [id] },
        modelCatalog: {
          providers: {
            [id]: {
              authScope: authScope === "plugin" ? "plugin" : "agent",
              ...(authScope === "headers"
                ? { headers: { "X-Manifest": "provider", "X-Precedence": "manifest" } }
                : {}),
              models: [
                {
                  id: "native",
                  name: "Native fixture",
                  ...(authScope === "headers"
                    ? {
                        baseUrl: "https://catalog.fixture.invalid/v1",
                        headers: { "X-Manifest": "model", "X-Manifest-Model": "model" },
                      }
                    : {}),
                  ...(authScope === "exchange" || authScope === "dual-headers"
                    ? {
                        api: "openai-completions",
                        baseUrl: "https://catalog.fixture.invalid/v1",
                        contextWindow: 4096,
                        maxTokens: 256,
                      }
                    : {}),
                  inference: {
                    chat: authScope === "exchange" || authScope === "dual-headers",
                    decision: {
                      protocol: "fixture",
                      ...(authScope === "exchange"
                        ? { billing: { unit: "requests", source: "provider-catalog" } }
                        : {}),
                      input: ["text"],
                      questions: { boolean: { probabilities: "none", abstention: true } },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      [
        'const trace = globalThis[Symbol.for("openclaw.test.decision-prepared-path")];',
        "module.exports = { id: " + JSON.stringify(id) + ", register(api) {",
        "api.registerDecisionProvider({ id: " + JSON.stringify(id) + ", contractVersion: 2,",
        'provider: { label: "Synthetic", auth: [], authScope: ' +
          JSON.stringify(authScope === "plugin" ? "plugin" : "agent") +
          ', resolveSyntheticAuth() { return {apiKey: "synthetic-prepared-token", mode: "api-key", source: "synthetic fixture"}; },' +
          (authScope === "agent"
            ? 'normalizeTransport() { return { api: "openai-responses" }; },'
            : authScope === "headers"
              ? "normalizeTransport() { return trace.rewriteBaseUrl ? { baseUrl: trace.rewriteBaseUrl } : undefined; },"
              : "") +
          (authScope === "exchange"
            ? 'normalizeResolvedModel(context) { return { ...context.model, api: "openai-responses" }; }, prepareRuntimeAuth(context) { trace.preparedApi=context.model.api; return { apiKey: context.apiKey, baseUrl: "https://entitlement.fixture.invalid/v1", request: { headers: { "x-fixture-entitlement": "synthetic-entitlement" }, auth: { mode: "header", headerName: "x-fixture-auth", value: "synthetic-exchanged-header" } } }; },'
            : "") +
          "} ,",
        'async evaluate(batch, context) { trace.calls++; trace.onDispatch?.(); await trace.work; trace.authenticated = context.auth.apiKey === "synthetic-prepared-token"; trace.modelKeys = Object.keys(context.model); trace.modelBilling=context.model.inference?.decision?.billing; trace.modelBaseUrl=context.model.baseUrl; trace.modelHeaders=context.model.headers; trace.modelApi=context.model.api; let reads = 0; return { status: "ok", get result() { trace.resultReads = ++reads; return { model: context.model.id, answers: { q: reads === 1 ? { type: "boolean", answer: null } : { type: "boolean", probabilityTrue: 0.75 } }, usage: { inputTokens: 1, costUsd: 0.002 } }; } }; }',
        "}); trace.evaluate = api.runtime.decisions.evaluateV2; } };",
      ].join("\n"),
    );
    const trace: Trace = { calls: 0, authenticated: false };
    Reflect.set(globalThis, traceKey, trace);
    const cfg: OpenClawConfig = {
      ...(authScope === "exchange" || authScope === "dual-headers"
        ? {
            models: {
              providers: {
                [id]: {
                  api: "openai-completions",
                  baseUrl: "https://catalog.fixture.invalid/v1",
                  apiKey: "synthetic-prepared-token",
                  models: [
                    {
                      id: "native",
                      name: "Native fixture",
                      contextWindow: 4096,
                      maxTokens: 256,
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      headers: {
                        "X-Model": "model",
                        "X-Precedence": "model",
                        "X-Model-Wins": "model",
                      },
                    },
                  ],
                },
              },
            },
          }
        : {}),
      agents: {
        defaults: {
          model: "unrelated/not-configured",
          decisionModel: id + "/native",
          workspace: path.join(root, "workspace"),
        },
      },
      plugins: {
        load: { paths: [pluginRoot] },
        slots: { memory: "none" },
        entries: { [id]: { enabled: true } },
      },
    };
    if (authScope === "headers") {
      cfg.models = {
        providers: {
          [id]: {
            baseUrl: "https://catalog.fixture.invalid/v1",
            headers: {
              "X-Provider": "provider",
              "X-Precedence": "provider",
              "X-Managed": "resolved-header",
            },
            request: {
              headers: { "x-precedence": "request", "X-Request": "request" },
              auth: {
                mode: "header",
                headerName: "X-Auth",
                value: "resolved-auth",
                prefix: "Fixture ",
              },
            },
            models: [],
          },
        },
      };
    }
    if (authScope === "dual-headers") {
      const provider = cfg.models!.providers![id]!;
      provider.headers = {
        "X-Provider": "provider",
        "X-Precedence": "provider",
        "X-Model-Wins": "provider",
      };
      provider.request = { headers: { "x-precedence": "request" } };
    }
    const sourceConfig = structuredClone(cfg);
    if (authScope === "headers") {
      const provider = sourceConfig.models!.providers![id]!;
      provider.headers!["X-Managed"] = { source: "env", provider: "default", id: "FIXTURE_HEADER" };
      provider.request!.auth = {
        mode: "header",
        headerName: "X-Auth",
        value: { source: "env", provider: "default", id: "FIXTURE_AUTH" },
        prefix: "Fixture ",
      };
    }
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      setRuntimeConfigSnapshot(cfg, sourceConfig);
      const registry = loadAndActivateRootPluginRegistry({
        config: cfg,
        env,
        workspaceDir: path.join(root, "workspace"),
      });
      expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
      expect(registry.providers.map((entry) => entry.provider.id)).toContain(id);
      const evaluate = trace.evaluate;
      expect(evaluate).toBeTypeOf("function");
      if (!evaluate) {
        throw new Error("Decision registration omitted its runtime capability");
      }
      if (authScope === "headers") {
        expect(isSecretValueRegisteredForRedaction("resolved-header")).toBe(false);
        expect(isSecretValueRegisteredForRedaction("resolved-auth")).toBe(false);
      }
      const outcome = await evaluate(
        {
          state: { type: "text", text: "synthetic evidence" },
          questions: { q: { type: "boolean" } },
        },
        {
          purpose: "fixture",
          rubricVersion: "v2",
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
      );
      expect(
        outcome,
        JSON.stringify({
          outcome,
          providerCalls: trace.calls,
        }),
      ).toMatchObject({
        status: "ok",
        result: { answers: { q: { answer: null } }, usage: { costUsd: 0.002 } },
      });
      expect(trace.calls).toBe(1);
      expect(trace.resultReads).toBe(1);
      expect(trace.authenticated).toBe(true);
      if (authScope === "exchange") {
        expect(trace.modelBaseUrl).toBe("https://entitlement.fixture.invalid/v1");
        expect(trace.modelBilling).toBeUndefined();
        expect(trace.preparedApi).toBe("openai-responses");
        expect(trace.modelApi).toBe(trace.preparedApi);
        expect(trace.modelHeaders).toMatchObject({
          "x-fixture-entitlement": "synthetic-entitlement",
          "x-fixture-auth": "synthetic-exchanged-header",
        });
      } else if (authScope !== "dual-headers") {
        expect(trace.modelKeys).not.toContain("cost");
        expect(trace.modelKeys).not.toContain("maxTokens");
        expect(trace.modelKeys).not.toContain("contextWindow");
      }
      if (authScope === "dual-headers") {
        expect(trace.modelHeaders).toEqual({
          "X-Provider": "provider",
          "X-Model": "model",
          "X-Model-Wins": "model",
          "x-precedence": "request",
        });
      }
      if (authScope === "headers") {
        expect(isSecretValueRegisteredForRedaction("resolved-header")).toBe(true);
        expect(isSecretValueRegisteredForRedaction("resolved-auth")).toBe(true);
        expect(trace.modelHeaders).toEqual({
          "X-Provider": "provider",
          "x-precedence": "request",
          "X-Managed": "resolved-header",
          "X-Manifest": "model",
          "X-Manifest-Model": "model",
          "X-Request": "request",
          "X-Auth": "Fixtureresolved-auth",
        });
        const customRoute = structuredClone(cfg);
        customRoute.models!.providers![id]!.baseUrl = "https://tenant.fixture.invalid/v1";
        setRuntimeConfigSnapshot(customRoute);
        await expect(
          evaluate(
            {
              state: { type: "text", text: "unrelated endpoint" },
              questions: { q: { type: "boolean" } },
            },
            {
              purpose: "fixture",
              rubricVersion: "v2",
              timeoutMs: 5000,
              signal: new AbortController().signal,
            },
          ),
        ).resolves.toMatchObject({ status: "unavailable", reason: "unsupported-input" });
        expect(trace.calls).toBe(1);
        setRuntimeConfigSnapshot(cfg, sourceConfig);
      }
      if (authScope === "agent") {
        expect(trace.modelApi).toBe("openai-responses");
        setRuntimeConfigSnapshot({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              decisionModel: id + "/native@missing-fixture-profile",
            },
          },
        });
        await expect(
          evaluate(
            {
              state: { type: "text", text: "explicit profile" },
              questions: { q: { type: "boolean" } },
            },
            {
              purpose: "fixture",
              rubricVersion: "v2",
              timeoutMs: 5000,
              signal: new AbortController().signal,
            },
          ),
        ).resolves.toMatchObject({ status: "unavailable", reason: "credentials-unavailable" });
        expect(trace.calls).toBe(1);
        setRuntimeConfigSnapshot(cfg);
      }

      let started!: () => void;
      let finish!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        started = resolve;
      });
      trace.work = new Promise<void>((resolve) => {
        finish = resolve;
      });
      trace.onDispatch = started;
      const controller = new AbortController();
      const pending = evaluate(
        {
          state: { type: "text", text: "synthetic cancellation" },
          questions: { q: { type: "boolean" } },
        },
        { purpose: "fixture", rubricVersion: "v2", timeoutMs: 5000, signal: controller.signal },
      );
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      await dispatched;
      if (authScope === "headers") {
        const replacement = structuredClone(cfg);
        replacement.models!.providers![id]!.headers!["X-Managed"] = "replacement-header";
        setRuntimeConfigSnapshot(replacement);
        const pause = registry.decisionProviders[0]!.host.pauseForReload();
        finish();
        await expect(pending).resolves.toMatchObject({ status: "unavailable", reason: "retiring" });
        await pause.settled;
        expect(trace.modelHeaders?.["X-Managed"]).toBe("resolved-header");
        expect(registry.decisionProviders[0]!.host.inspect(replacement).activeRequests).toBe(0);
        pause.resume();
        setRuntimeConfigSnapshot(cfg, sourceConfig);
        trace.rewriteBaseUrl = "https://rewritten.fixture.invalid/v1";
        await expect(
          evaluate(
            {
              state: { type: "text", text: "rewritten route" },
              questions: { q: { type: "boolean" } },
            },
            {
              purpose: "fixture",
              rubricVersion: "v2",
              timeoutMs: 5000,
              signal: new AbortController().signal,
            },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        expect(trace.modelHeaders).not.toHaveProperty("X-Manifest");
        expect(trace.modelHeaders).not.toHaveProperty("X-Manifest-Model");
        expect(trace.modelHeaders?.["X-Provider"]).toBe("provider");
        return;
      }
      controller.abort(new Error("fixture cancelled"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(1);
      finish();
      await expect(pending).rejects.toThrow("fixture cancelled");
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(0);
      await resetPreparedModelRuntimeSnapshotsForTest();
    });
  },
);

it("runs both SDK versions through the compatible TypeSafe plugin, prepared auth, and loopback transport", async () => {
  const root = roots.make("decision-typesafe-host-");
  const consumerRoot = path.join(root, "consumer");
  const emptyBundled = path.join(root, "bundled");
  fs.mkdirSync(consumerRoot);
  fs.mkdirSync(emptyBundled);
  const consumerId = "decision-consumer-fixture";
  const consumer = createColdPluginFixture({ rootDir: consumerRoot, pluginId: consumerId });
  fs.writeFileSync(
    consumer.runtimeSource,
    'const trace=globalThis[Symbol.for("openclaw.test.decision-prepared-path")]; module.exports={id:"decision-consumer-fixture",register(api){trace.evaluate=api.runtime.decisions.evaluateV2;trace.evaluateV1=api.runtime.decisions.evaluate;}};',
  );
  const trace: Trace = { calls: 0, authenticated: false };
  Reflect.set(globalThis, traceKey, trace);
  let status = 200;
  const received: Array<{ url?: string; authorization?: string; body: unknown }> = [];
  await withServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          status === 200
            ? JSON.stringify({
                model: "kev-latest",
                answers: { q: { type: "noul", noul: 0.37 } },
                usage: { input_tokens: 3, output_tokens: 1 },
              })
            : "synthetic-private-provider-body",
        );
      });
    },
    async (baseUrl) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "unrelated/not-configured",
            decisionModel: "typesafe/kev-latest",
            workspace: path.join(root, "workspace"),
          },
        },
        plugins: {
          load: {
            paths: [
              fileURLToPath(new URL("../../extensions/typesafe", import.meta.url)),
              consumerRoot,
            ],
          },
          slots: { memory: "none" },
          entries: {
            typesafe: { enabled: true, config: { baseUrl } },
            [consumerId]: { enabled: true },
          },
        },
      };
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
          // The package declares API >=2026.9.6; keep that release gate intact.
          OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.6",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          setRuntimeConfigSnapshot(cfg);
          const registry = loadAndActivateRootPluginRegistry({
            config: cfg,
            workspaceDir: path.join(root, "workspace"),
          });
          expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
          expect(
            registry.providers.map((entry) => entry.provider.id),
            JSON.stringify({
              plugins: registry.plugins.map((p) => ({
                id: p.id,
                status: p.status,
                error: p.error,
              })),
              diagnostics: registry.diagnostics,
              paths: cfg.plugins?.load?.paths,
            }),
          ).toContain("typesafe");
          const evaluate = trace.evaluate,
            legacy = trace.evaluateV1;
          if (!evaluate || !legacy) {
            throw new Error("Missing registered decision SDK");
          }
          const options = () => ({
            purpose: "actual-engine-fixture",
            rubricVersion: "1",
            timeoutMs: 5000,
            signal: new AbortController().signal,
          });
          const batch = {
            state: { type: "text" as const, text: "synthetic evidence" },
            questions: { q: { type: "boolean" as const } },
          };
          expect(await evaluate(batch, { ...options(), reasoning: "auto" })).toMatchObject({
            status: "ok",
            result: {
              answers: { q: { type: "boolean", probabilityTrue: 0.37 } },
              usage: { inputTokens: 3, outputTokens: 1 },
            },
          });
          expect(
            await legacy({ state: "synthetic evidence", questions: batch.questions }, options()),
          ).toMatchObject({ status: "ok", result: { answers: { q: { probabilityTrue: 0.37 } } } });
          for (const rejection of [413, 422]) {
            status = rejection;
            expect(await evaluate(batch, options())).toMatchObject({
              status: "unavailable",
              reason: "unsupported-input",
            });
          }
          expect(received).toHaveLength(4);
          for (const request of received) {
            expect(request.authorization).toBeUndefined();
            expect(request.url).toBe("/v1/systemone");
            expect(request.body).toMatchObject({
              model: "kev-latest",
              questions: { q: { type: "noul" } },
            });
          }
          await resetPreparedModelRuntimeSnapshotsForTest();
        },
      );
    },
  );
});

it("accounts registered decisions once from prepared route prices, preserving sparse usage and SDK versions", async () => {
  const root = roots.make("decision-usage-integration-");
  const pluginRoot = path.join(root, "plugin");
  const emptyBundled = path.join(root, "bundled");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(emptyBundled);
  const id = "decision-usage-fixture";
  const nativeBilling = {
    unit: "tokens",
    source: "provider-catalog",
    usdPerMillion: { input: 0.042, output: 0 },
  } satisfies ModelDecisionCapabilities["billing"];
  const billings: Record<string, ModelDecisionCapabilities["billing"]> = {
    native: nativeBilling,
    "rewrite-api": nativeBilling,
    "rewrite-url": nativeBilling,
    equivalent: nativeBilling,
    effective: { ...nativeBilling, source: "configured", usdPerMillion: { input: 2, output: 0 } },
    "paid-output": { ...nativeBilling, usdPerMillion: { input: 2, output: 3 } },
    "partial-price": { ...nativeBilling, usdPerMillion: { input: 2 } },
    "unknown-price": { unit: "tokens", source: "provider-catalog" },
    requests: { unit: "requests", source: "provider-catalog" },
    undeclared: undefined,
  };
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: id,
    providerId: id,
    manifest: {
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
      contracts: { decisionProviders: [id] },
      modelCatalog: {
        providers: {
          [id]: {
            authScope: "plugin",
            api: "openai-completions",
            baseUrl: "https://catalog.fixture.invalid/v1",
            models: Object.entries(billings).map(([model, billing]) => ({
              id: model,
              name: model,
              baseUrl: model === "effective" ? "https://effective.fixture.invalid/v1" : undefined,
              inference: {
                chat: false,
                decision: {
                  protocol: "fixture",
                  input: ["text"],
                  questions: { boolean: { probabilities: "independent", abstention: false } },
                  ...(billing ? { billing } : {}),
                },
              },
            })),
          },
        },
      },
    },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `
    const trace = globalThis[Symbol.for("openclaw.test.decision-prepared-path")];
    module.exports = { id: ${JSON.stringify(id)}, register(api) {
      api.registerDecisionProvider({ id: ${JSON.stringify(id)}, contractVersion: 2,
        provider: { label: "Synthetic", auth: [], authScope: "plugin",
          resolveSyntheticAuth() { return { apiKey: "synthetic-usage-token", mode: "api-key", source: "fixture" }; },
          normalizeTransport(context) {
            if (context.modelId === "rewrite-api") return { api: "openai-responses" };
            if (context.modelId === "rewrite-url") return { baseUrl: "https://rewritten.fixture.invalid/v1" };
            if (context.modelId === "equivalent") return { baseUrl: context.baseUrl + "/" };
          }
        },
        async evaluate(batch, context) {
          trace.calls++;
          trace.modelBilling = structuredClone(context.model.inference?.decision?.billing);
          trace.modelBaseUrl = context.model.baseUrl;
          if (trace.mutateBilling && context.model.inference?.decision?.billing?.usdPerMillion) {
            context.model.inference.decision.billing.usdPerMillion.input = 999;
          }
          return trace.unavailable ? { status: "unavailable", reason: "transport" } : {
            status: "ok", result: { model: context.model.id,
              answers: { q: { type: "boolean", probabilityTrue: 0.75 } },
              ...(trace.usage ? { usage: trace.usage } : {})
            }
          };
        }
      });
      trace.evaluate = api.runtime.decisions.evaluateV2;
      trace.evaluateV1 = api.runtime.decisions.evaluate;
    } };
  `,
  );
  const trace: Trace = { calls: 0, authenticated: false };
  Reflect.set(globalThis, traceKey, trace);
  const env = {
    ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
  };
  let cfg: OpenClawConfig = {
    diagnostics: { enabled: true },
    agents: {
      defaults: { decisionModel: id + "/native", workspace: path.join(root, "workspace") },
    },
    plugins: {
      load: { paths: [pluginRoot] },
      slots: { memory: "none" },
      entries: { [id]: { enabled: true } },
    },
  };
  // Deliberately make ID-only hosted prices available: none can restore invalidated route facts.
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 100,
    readStoredCatalog: () => ({
      id: 1,
      generated_at: 200,
      min_version: VERSION,
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
      etag: null,
      last_modified: null,
      checked_at: 200,
      bundle_json: JSON.stringify({
        schemaVersion: 1,
        generatedAt: 200,
        minVersion: VERSION,
        sourceCommit: "fixture",
        providers: {},
        pricing: Object.fromEntries(
          Object.keys(billings).map((model) => [id + "/" + model, { input: 10, output: 20 }]),
        ),
      }),
    }),
  });
  await withEnvAsync(env, async () => {
    setRuntimeConfigSnapshot(cfg);
    const registry = loadAndActivateRootPluginRegistry({
      config: cfg,
      env,
      workspaceDir: path.join(root, "workspace"),
    });
    expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
    const evaluate = trace.evaluate,
      legacy = trace.evaluateV1;
    if (!evaluate || !legacy) {
      throw new Error("Missing registered decision SDK");
    }
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
    const select = (model: string) => {
      cfg = {
        ...cfg,
        agents: { defaults: { ...cfg.agents?.defaults, decisionModel: id + "/" + model } },
      };
      setRuntimeConfigSnapshot(cfg);
    };
    const batch = {
      state: { type: "text" as const, text: "synthetic evidence" },
      questions: { q: { type: "boolean" as const } },
    };
    const options = () => ({
      purpose: "usage-fixture",
      rubricVersion: "v2",
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });
    const cases: Array<{
      label: string;
      model: string;
      usage?: DecisionBatchResultV2["usage"];
      expectedCost?: number;
    }> = [
      {
        label: "known input and free unreported output",
        model: "native",
        usage: { inputTokens: 100 },
        expectedCost: 0.0000042,
      },
      {
        label: "actual USD wins",
        model: "native",
        usage: { inputTokens: 100, costUsd: 0.02 },
        expectedCost: 0.02,
      },
      {
        label: "actual zero wins",
        model: "native",
        usage: { inputTokens: 100, costUsd: 0 },
        expectedCost: 0,
      },
      {
        label: "observed zero tokens",
        model: "native",
        usage: { inputTokens: 0 },
        expectedCost: 0,
      },
      { label: "cost only", model: "native", usage: { costUsd: 0.02 }, expectedCost: 0.02 },
      {
        label: "billed zero without token counts",
        model: "native",
        usage: { costUsd: 0 },
        expectedCost: 0,
      },
      { label: "no usage is not free", model: "native" },
      { label: "empty usage is not free", model: "native", usage: {} },
      { label: "unknown paid output count", model: "paid-output", usage: { inputTokens: 100 } },
      {
        label: "missing rate for used output",
        model: "partial-price",
        usage: { inputTokens: 100, outputTokens: 4 },
      },
      {
        label: "observed unused output needs no rate",
        model: "partial-price",
        usage: { inputTokens: 100, outputTokens: 0 },
        expectedCost: 0.0002,
      },
      { label: "unknown input count is not zero", model: "native", usage: { outputTokens: 4 } },
      {
        label: "unknown rates ignore ID-only prices",
        model: "unknown-price",
        usage: { inputTokens: 100, outputTokens: 4 },
      },
      {
        label: "no billing ignores ID-only prices",
        model: "undeclared",
        usage: { inputTokens: 100, outputTokens: 4 },
      },
      {
        label: "native units alone are not token counters",
        model: "requests",
        usage: { units: { unit: "requests", amount: 1 } },
      },
      {
        label: "requests are not tokens",
        model: "requests",
        usage: { inputTokens: 100, units: { unit: "requests", amount: 1 } },
      },
      {
        label: "mixed billing cannot price just the tokens",
        model: "native",
        usage: { inputTokens: 100, units: { unit: "decision-units", amount: 3 } },
      },
      {
        label: "actual USD survives mixed units",
        model: "requests",
        usage: { costUsd: 0.03, units: { unit: "requests", amount: 1 } },
        expectedCost: 0.03,
      },
      {
        label: "API rewrite cannot regain hosted price",
        model: "rewrite-api",
        usage: { inputTokens: 100, outputTokens: 4 },
      },
      {
        label: "URL rewrite cannot regain hosted price",
        model: "rewrite-url",
        usage: { inputTokens: 100, outputTokens: 4 },
      },
      {
        label: "actual cost survives rewrite",
        model: "rewrite-url",
        usage: { costUsd: 0.04 },
        expectedCost: 0.04,
      },
      {
        label: "declared effective route tariff",
        model: "effective",
        usage: { inputTokens: 100 },
        expectedCost: 0.0002,
      },
      {
        label: "equivalent URL keeps route tariff",
        model: "equivalent",
        usage: { inputTokens: 100 },
        expectedCost: 0.0000042,
      },
    ];
    for (const entry of cases) {
      select(entry.model);
      trace.usage = entry.usage;
      trace.mutateBilling = entry.model === "native";
      const before = events.length,
        calls = trace.calls;
      expect(resolveModelCostConfig({ config: cfg, provider: id, model: entry.model })?.input).toBe(
        10,
      );
      const outcome = await evaluate(batch, options());
      expect(outcome.status, entry.label).toBe("ok");
      if (outcome.status !== "ok") {
        throw new Error(entry.label);
      }
      expect
        .soft(outcome.result.usage, entry.label)
        .toEqual(
          entry.expectedCost !== undefined
            ? { ...entry.usage, costUsd: expect.closeTo(entry.expectedCost, 12) }
            : entry.usage,
        );
      expect(trace.calls, entry.label).toBe(calls + 1);
      const observed = [
        entry.usage?.inputTokens,
        entry.usage?.outputTokens,
        entry.usage?.costUsd,
      ].some((value) => value !== undefined);
      expect.soft(events.length - before, entry.label).toBe(observed ? 1 : 0);
      if (observed) {
        const event = events[before];
        expect.soft(event?.usage, entry.label).toEqual({
          ...(entry.usage?.inputTokens !== undefined ? { input: entry.usage.inputTokens } : {}),
          ...(entry.usage?.outputTokens !== undefined ? { output: entry.usage.outputTokens } : {}),
        });
        if (entry.expectedCost !== undefined) {
          expect.soft(event?.costUsd, entry.label).toBeCloseTo(entry.expectedCost, 12);
        } else {
          expect.soft(event, entry.label).not.toHaveProperty("costUsd");
        }
        if (event) {
          expect.soft(event, entry.label).not.toHaveProperty("sessionKey");
        }
      }
      if (entry.model.startsWith("rewrite-")) {
        expect(trace.modelBilling).toBeUndefined();
      }
      if (entry.model === "effective") {
        expect(trace.modelBaseUrl).toBe("https://effective.fixture.invalid/v1");
      }
    }
    select("native");
    trace.usage = { inputTokens: 100, outputTokens: 0 };
    const beforeLegacy = events.length;
    expect(
      await legacy({ state: "synthetic evidence", questions: batch.questions }, options()),
    ).toMatchObject({
      status: "ok",
      result: { usage: { inputTokens: 100, outputTokens: 0 } },
    });
    expect(events).toHaveLength(beforeLegacy + 1);
    expect(events[beforeLegacy]?.costUsd).toBeCloseTo(0.0000042, 12);
    const bound = createHostDecisionEvaluator({
      getConfig: () => cfg,
      getRegistry: () => registry,
      authority: {
        caller: { kind: "plugin", id },
        pluginIdForPolicy: id,
        sessionKey: "agent:fixture:host-session",
      },
    });
    const beforeBound = events.length;
    await bound(batch, options());
    expect(events).toHaveLength(beforeBound + 1);
    expect(events[beforeBound]?.sessionKey).toBe("agent:fixture:host-session");
    trace.unavailable = true;
    expect(await evaluate(batch, options())).toMatchObject({
      status: "unavailable",
      reason: "transport",
    });
    expect(events).toHaveLength(beforeBound + 1);
    await resetPreparedModelRuntimeSnapshotsForTest();
  });
});
