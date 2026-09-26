import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import typesafe from "../../extensions/typesafe/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type { DecisionRuntimeV2 } from "../decisions/types-v2.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { mockPinnedHostnameResolution } from "../test-helpers/ssrf.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.typesafe-hosted-billing");
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, traceKey);
});

it("prices actual TypeSafe declarations through registered preparation, without pricing aliases or local rewrites", async () => {
  const root = roots.make("typesafe-hosted-pricing-");
  const pluginRoot = path.join(root, "typesafe"),
    consumerRoot = path.join(root, "consumer"),
    bundled = path.join(root, "bundled");
  for (const dir of [pluginRoot, consumerRoot, bundled]) {
    fs.mkdirSync(dir);
  }
  const pluginDir = fileURLToPath(new URL("../../extensions/typesafe", import.meta.url));
  fs.copyFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    path.join(pluginRoot, "openclaw.plugin.json"),
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  metadata.openclaw.extensions = ["./index.cjs"];
  fs.mkdirSync(path.join(pluginRoot, "node_modules"));
  fs.symlinkSync(
    fs.realpathSync(path.join(pluginDir, "node_modules", "typebox")),
    path.join(pluginRoot, "node_modules", "typebox"),
    "junction",
  );
  fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify(metadata));
  const trace: {
    plugin: typeof typesafe;
    evaluate?: DecisionRuntimeV2["evaluateV2"];
    context?: DecisionProviderContextV2;
    reportedUsd?: number;
    rewriteApi?: string;
  } = { plugin: typesafe };
  Reflect.set(globalThis, traceKey, trace);
  // Load the real entrypoint through a cold fixture bridge in the same SDK module graph.
  // Only credential availability and the external HTTP response are synthetic; all
  // manifest, registration, normalization, native execution and accounting are real.
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    'const trace=globalThis[Symbol.for("openclaw.test.typesafe-hosted-billing")]; module.exports={...trace.plugin,register(api){trace.plugin.register({...api,registerDecisionProvider(definition){api.registerDecisionProvider({...definition,provider:{...definition.provider,normalizeTransport(context){const route=definition.provider.normalizeTransport?.(context);return trace.rewriteApi?{...route,api:trace.rewriteApi}:route;},resolveSyntheticAuth(){return {apiKey:"synthetic-typesafe-proof",mode:"api-key",source:"test-credential"};}},async evaluate(batch,context){trace.context=context;const result=await definition.evaluate(batch,context);return result.status==="ok"&&trace.reportedUsd!==undefined?{...result,result:{...result.result,usage:{...result.result.usage,costUsd:trace.reportedUsd}}}:result;}});}});}};',
  );
  const consumer = createColdPluginFixture({
    rootDir: consumerRoot,
    pluginId: "typesafe-pricing-consumer",
  });
  fs.writeFileSync(
    consumer.runtimeSource,
    'module.exports={id:"typesafe-pricing-consumer",register(api){globalThis[Symbol.for("openclaw.test.typesafe-hosted-billing")].evaluate=api.runtime.decisions.evaluateV2;}};',
  );
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { decisionModel: "typesafe/jev-1.13.0", workspace: path.join(root, "workspace") },
    },
    plugins: {
      load: { paths: [pluginRoot, consumerRoot] },
      slots: { memory: "none" },
      entries: { typesafe: { enabled: true }, "typesafe-pricing-consumer": { enabled: true } },
    },
  };
  const fetched: Array<{ url: string; authorization: string | null; model: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect([
        "https://api.typesafe.ai/v1/systemone",
        "http://127.0.0.1:8009/v1/systemone",
      ]).toContain(target);
      if (typeof init?.body !== "string" || !trace.context) {
        throw new Error("Expected a prepared native JSON request");
      }
      const model = trace.context.model.id;
      expect(JSON.parse(init.body)).toMatchObject({ model });
      fetched.push({
        url: target,
        authorization: new Headers(init?.headers).get("authorization"),
        model,
      });
      return Response.json({
        model,
        answers: { q: { type: "noul", noul: 0.75 } },
        usage: { input_tokens: 100, output_tokens: 12 },
      });
    }),
  );
  const dns = mockPinnedHostnameResolution();
  await withEnvAsync(
    {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: bundled }),
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
      expect(registry.diagnostics.filter((x) => x.level === "error")).toEqual([]);
      expect(registry.providers.find((x) => x.provider.id === "typesafe")?.provider.authScope).toBe(
        "plugin",
      );
      if (!trace.evaluate) {
        throw new Error("Missing registered Decision SDK");
      }
      const evaluate = trace.evaluate;
      const call = () =>
        evaluate(
          { state: { type: "text", text: "synthetic" }, questions: { q: { type: "boolean" } } },
          {
            purpose: "pricing-proof",
            rubricVersion: "1",
            timeoutMs: 5000,
            signal: new AbortController().signal,
          },
        );
      const result = await call();
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "ok",
        result: { usage: { inputTokens: 100, outputTokens: 12 } },
      });
      if (result.status !== "ok") {
        throw new Error("Missing successful hosted result");
      }
      expect(result.result.usage?.costUsd).toBeCloseTo(0.0000042, 12);
      expect(trace.context?.model).toMatchObject({
        id: "jev-1.13.0",
        baseUrl: "https://api.typesafe.ai/v1/systemone",
        inference: {
          chat: false,
          decision: {
            limits: { maxRequestTokens: 64000, maxStateAndQuestionTokens: 32000 },
            billing: {
              unit: "tokens",
              source: "provider-docs",
              usdPerMillion: { input: 0.042, output: 0 },
            },
          },
        },
      });
      for (const key of ["cost", "contextWindow", "maxTokens"]) {
        expect(trace.context?.model).not.toHaveProperty(key);
      }
      // Explicit USD at the existing provider-result seam wins; no undocumented HTTP
      // field is added to TypeSafe's token-only response schema.
      for (const cost of [0, 0.25]) {
        trace.reportedUsd = cost;
        expect(await call()).toMatchObject({ status: "ok", result: { usage: { costUsd: cost } } });
      }
      trace.reportedUsd = undefined;
      const alias = structuredClone(cfg);
      alias.agents!.defaults!.decisionModel = "typesafe/jev-latest";
      setRuntimeConfigSnapshot(alias);
      const unpriced = await call();
      expect(unpriced.status).toBe("ok");
      if (unpriced.status === "ok") {
        expect(unpriced.result.usage).not.toHaveProperty("costUsd");
      }
      const local = structuredClone(cfg);
      local.plugins!.entries!.typesafe!.config = { baseUrl: "http://127.0.0.1:8009" };
      setRuntimeConfigSnapshot(local);
      const localResult = await call();
      expect(localResult.status).toBe("ok");
      if (localResult.status === "ok") {
        expect(localResult.result.usage).not.toHaveProperty("costUsd");
      }
      expect(trace.context?.model.baseUrl).toBe("http://127.0.0.1:8009/v1/systemone");
      expect(trace.context?.model.inference?.decision?.billing).toBeUndefined();
      expect(fetched.at(-1)?.authorization).toBeNull();
      const custom = structuredClone(cfg);
      custom.models = {
        providers: { typesafe: { baseUrl: "https://custom.invalid/v1", models: [] } },
      };
      setRuntimeConfigSnapshot(custom);
      const count = fetched.length;
      expect(await call()).toMatchObject({ status: "unavailable", reason: "unsupported-input" });
      expect(fetched).toHaveLength(count);
      // Generic chat API config does not rewrite this native endpoint. Exercise the
      // existing normalization seam to invalidate an actual changed API identity.
      trace.rewriteApi = "openai-responses";
      setRuntimeConfigSnapshot(cfg);
      const rewritten = await call();
      expect(rewritten.status).toBe("ok");
      if (rewritten.status === "ok") {
        expect(rewritten.result.usage).not.toHaveProperty("costUsd");
      }
      expect(trace.context?.model.api).toBe("openai-responses");
      expect(trace.context?.model.inference?.decision?.billing).toBeUndefined();
      trace.rewriteApi = undefined;
      local.agents!.defaults!.decisionModel = "typesafe/kev-latest";
      setRuntimeConfigSnapshot(local);
      const kev = await call();
      expect(kev.status).toBe("ok");
      if (kev.status === "ok") {
        expect(kev.result.usage).not.toHaveProperty("costUsd");
      }
      expect(fetched.at(-1)?.authorization).toBeNull();
      expect(fetched[0]).toMatchObject({
        url: "https://api.typesafe.ai/v1/systemone",
        authorization: "Bearer synthetic-typesafe-proof",
        model: "jev-1.13.0",
      });
      await resetPreparedModelRuntimeSnapshotsForTest();
    },
  );
  dns.mockRestore();
});
