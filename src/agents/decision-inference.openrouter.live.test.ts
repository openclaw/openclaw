import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionBatchV2, DecisionRuntimeV2 } from "../decisions/types-v2.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const live =
  process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.OPENROUTER_API_KEY?.trim());

it.skipIf(!live)(
  "evaluates one mixed Jev batch through the registered OpenClaw provider",
  { timeout: 60_000, retry: 0 },
  async () => {
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      const consumerId = "openrouter-live-decision-consumer";
      const consumerRoot = state.path("consumer");
      const bundledPluginsDir = state.path("bundled");
      fs.mkdirSync(consumerRoot);
      fs.mkdirSync(bundledPluginsDir);
      const fixture = createColdPluginFixture({ rootDir: consumerRoot, pluginId: consumerId });
      const traceKey = Symbol.for("openclaw.test.openrouter-live-decision");
      const trace: { runtime?: DecisionRuntimeV2 } = {};
      Reflect.set(globalThis, traceKey, trace);
      fs.writeFileSync(
        fixture.runtimeSource,
        'module.exports={id:"openrouter-live-decision-consumer",register(api){globalThis[Symbol.for("openclaw.test.openrouter-live-decision")].runtime=api.runtime.decisions;}};',
      );
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "unrelated/not-configured",
            decisionModel: "openrouter/typesafe/jev-1.13",
            workspace: state.workspaceDir,
          },
        },
        plugins: {
          load: {
            paths: [
              fileURLToPath(new URL("../../extensions/openrouter", import.meta.url)),
              consumerRoot,
            ],
          },
          slots: { memory: "none" },
          entries: {
            openrouter: { enabled: true },
            [consumerId]: {
              enabled: true,
              llm: {
                allowedCompletionModels: ["openrouter/unrelated-fixture"],
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
          ...createColdPluginHermeticEnv(state.root, { bundledPluginsDir }),
          ...state.envVars,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        async () => {
          try {
            setRuntimeConfigSnapshot(cfg);
            const registry = await loadAndActivateRootPluginRegistry({
              config: cfg,
              workspaceDir: state.workspaceDir,
            });
            expect(registry.diagnostics.some((entry) => entry.level === "error")).toBe(false);
            expect(
              registry.decisionProviders.filter((entry) => entry.host.provider.id === "openrouter"),
            ).toHaveLength(1);
            const runtime = trace.runtime;
            if (!runtime) {
              throw new Error("Missing registered decision SDK");
            }
            const batch: DecisionBatchV2 = {
              state: {
                type: "text",
                text: "A customer asks for a duplicate invoice. There is no outage or deadline.",
              },
              questions: {
                urgent: { type: "boolean", instructions: "Does this require urgent action?" },
                team: {
                  type: "choice",
                  instructions: "Which team should handle this?",
                  criteria: { billing: "Invoices and payments", technical: "Software faults" },
                },
                severity: {
                  type: "score",
                  instructions: "Rate the severity.",
                  criteria: ["Routine request", "Service affected", "Critical outage"],
                },
              },
            };
            const options = () => ({
              agentId: "main",
              purpose: "openrouter-native-live",
              rubricVersion: "1",
              timeoutMs: 30_000,
              signal: new AbortController().signal,
            });
            // The registered consumer supplies its identity. Its completion policy
            // denies before transport, as the companion hermetic test verifies.
            await expect(runtime.evaluateV2(batch, options())).rejects.toMatchObject({
              code: "LLM_COMPLETION_NOT_AUTHORIZED",
            });
            const allowed = structuredClone(cfg);
            allowed.plugins!.entries![consumerId]!.llm!.allowedCompletionModels = [
              "openrouter/typesafe/jev-1.13",
            ];
            setRuntimeConfigSnapshot(allowed);
            // No direct vendor client, retries or alternate credentials. The normal
            // prepared auth owner reads only the injected OpenRouter key in this isolated state.
            const outcome = await runtime.evaluateV2(batch, options());
            if (outcome.status !== "ok") {
              throw new Error(`OpenRouter registered decision unavailable: ${outcome.reason}`);
            }
            expect(outcome.provenance.providerId).toBe("openrouter");
            expect(outcome.result.model).toMatch(/^typesafe\/jev-1\.13(?:-|$)/);
            expect(outcome.result.answers.urgent?.type).toBe("boolean");
            expect(outcome.result.answers.team?.type).toBe("choice");
            expect(outcome.result.answers.severity?.type).toBe("score");
            expect(outcome.result.usage?.inputTokens).toBeGreaterThan(0);
            expect(outcome.result.usage?.outputTokens).toBeGreaterThanOrEqual(0);
            expect(outcome.result.usage?.costUsd).toBeGreaterThanOrEqual(0);
            // Only public result/accounting facts; never serialize the private context or key.
            console.log(
              JSON.stringify({
                status: outcome.status,
                model: outcome.result.model,
                answers: outcome.result.answers,
                usage: {
                  inputTokens: outcome.result.usage?.inputTokens,
                  outputTokens: outcome.result.usage?.outputTokens,
                  costUsd: outcome.result.usage?.costUsd,
                },
              }),
            );
          } finally {
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearRuntimeConfigSnapshot();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
            Reflect.deleteProperty(globalThis, traceKey);
          }
        },
      );
    });
  },
);
