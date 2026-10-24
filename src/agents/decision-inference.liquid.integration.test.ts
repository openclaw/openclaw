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
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const traceKey = Symbol.for("openclaw.test.liquid-decision-path");
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
  vi.restoreAllMocks();
});

it("dispatches registered Liquid requests only while the caller remains authorized", async () => {
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
    'const trace=globalThis[Symbol.for("openclaw.test.liquid-decision-path")]; module.exports={id:"liquid-decision-consumer",register(api){trace.runtime=api.runtime.decisions;}};',
  );
  const trace: { runtime?: DecisionRuntimeV2 } = {};
  Reflect.set(globalThis, traceKey, trace);
  const received: Array<{ url?: string; authorization?: string; body: unknown }> = [];
  // The fixture replaces only Liquid's HTTP service, not the guarded transport.
  // Hosted entitlement and model quality still require separate live proof.
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
      const sourceRoot = fileURLToPath(new URL("../../extensions/liquid", import.meta.url));
      const pluginRoot = path.join(state.root, "liquid");
      fs.mkdirSync(pluginRoot);
      for (const file of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
        if (file.isFile() && !file.name.includes(".test.")) {
          fs.copyFileSync(path.join(sourceRoot, file.name), path.join(pluginRoot, file.name));
        }
      }
      const manifest = loadPluginManifest(sourceRoot);
      if (!manifest.ok) {
        throw new Error(manifest.error);
      }
      const declared = structuredClone(manifest.manifest);
      const catalog = declared.modelCatalog?.providers?.liquid;
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
            model: "unrelated/not-configured",
            decisionModel: "liquid/d1-ultra@liquid:fixture",
            workspace: path.join(state.root, "workspace"),
          },
        },
        models: {
          providers: {
            liquid: {
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
            liquid: { enabled: true },
            [consumerId]: {
              enabled: true,
              llm: {
                allowedCompletionModels: ["liquid/d1-ultra"],
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
          LIQUID_API_KEY: undefined,
        },
        async () => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "liquid:fixture": {
                type: "api_key",
                provider: "liquid",
                key: "synthetic-liquid-profile-key",
              },
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
            (entry) => entry.host.provider.id === "liquid",
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
            purpose: "liquid-native-fixture",
            rubricVersion: "1",
            timeoutMs: 5_000,
            signal: new AbortController().signal,
          });
          const denied = structuredClone(cfg);
          denied.plugins!.entries![consumerId]!.llm!.allowedCompletionModels = [
            "liquid/unrelated-fixture",
          ];
          setRuntimeConfigSnapshot(denied);
          await expect(runtime.evaluateV2(batch, options())).rejects.toMatchObject({
            code: "LLM_COMPLETION_NOT_AUTHORIZED",
          });
          expect(received).toHaveLength(0);

          setRuntimeConfigSnapshot(cfg);
          const outcome = await runtime.evaluateV2(batch, options());
          expect(outcome, JSON.stringify({ outcome, received })).toMatchObject({
            status: "ok",
            result: {
              model: "d1-ultra",
              answers: { urgent: { probabilityTrue: 0.37 } },
              usage: { inputTokens: 14, outputTokens: 0 },
            },
            provenance: { providerId: "liquid" },
          });
          expect(received).toEqual([
            {
              url: "/tenant/decisions/v1/systemone",
              authorization: "Bearer synthetic-liquid-profile-key",
              body: {
                model: "d1-ultra",
                state: "Synthetic evidence",
                questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
              },
            },
          ]);

          const foreign = structuredClone(cfg);
          foreign.models!.providers!.liquid!.baseUrl = origin + "/undeclared";
          setRuntimeConfigSnapshot(foreign);
          expect(await runtime.evaluateV2(batch, options())).toMatchObject({
            status: "unavailable",
            reason: "unsupported-input",
          });
          expect(received).toHaveLength(1);
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
          expect(cfg.agents?.defaults?.model).toBe("unrelated/not-configured");
          await resetPreparedModelRuntimeSnapshotsForTest();
        },
      );
    },
  );
});
