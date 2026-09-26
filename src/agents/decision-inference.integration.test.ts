import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionRuntimeV2 } from "../decisions/types-v2.js";
import type { DecisionRuntimeV1 } from "../decisions/types.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
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
  modelBaseUrl?: string;
  modelHeaders?: Record<string, string>;
  modelApi?: string;
  preparedApi?: string;
  evaluate?: DecisionRuntimeV2["evaluateV2"];
  evaluateV1?: DecisionRuntimeV1["evaluate"];
};
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
});

it.each(["plugin", "agent", "exchange"] as const)(
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
              authScope: authScope === "exchange" ? "agent" : authScope,
              models: [
                {
                  id: "native",
                  name: "Native fixture",
                  ...(authScope === "exchange"
                    ? {
                        api: "openai-completions",
                        baseUrl: "https://catalog.fixture.invalid/v1",
                        contextWindow: 4096,
                        maxTokens: 256,
                      }
                    : {}),
                  inference: {
                    chat: authScope === "exchange",
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
          JSON.stringify(authScope === "exchange" ? "agent" : authScope) +
          ', resolveSyntheticAuth() { return {apiKey: "synthetic-prepared-token", mode: "api-key", source: "synthetic fixture"}; },' +
          (authScope === "agent"
            ? 'normalizeTransport() { return { api: "openai-responses" }; },'
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
      ...(authScope === "exchange"
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
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      setRuntimeConfigSnapshot(cfg);
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
      } else {
        expect(trace.modelKeys).not.toContain("cost");
        expect(trace.modelKeys).not.toContain("maxTokens");
        expect(trace.modelKeys).not.toContain("contextWindow");
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
