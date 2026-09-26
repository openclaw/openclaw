import { onTestFinished } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { prepareDecisionProviderReload } from "../../decisions/runtime.js";
import type { DecisionBatch, DecisionProviderV1 } from "../../decisions/types.js";
import { runPluginRegisterSyncInRegistry } from "../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";

export function installDecisionFixture(
  fidelity = "preserved",
  onEvaluate?: (
    batch: DecisionBatch,
    context: Parameters<DecisionProviderV1["evaluate"]>[1],
  ) => void | Promise<void>,
) {
  const config: OpenClawConfig = {
    agents: {
      defaults: { decisionModel: "semantic-fixture/default-v1" },
      entries: {
        specialist: { decisionModel: "semantic-fixture/owner-v1" },
        disabled: { decisionModel: "" },
      },
    },
  };
  const requests: Array<{ agentId?: string; model: string }> = [];
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "semantic-fixture-owner",
    source: "/synthetic/semantic-fixture.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["semantic-fixture"] },
  });
  const api = builder.createApi(record, { config });
  runPluginRegisterSyncInRegistry(
    (registration) => {
      registration.registerDecisionProvider({
        id: "semantic-fixture",
        contractVersion: 1,
        async evaluate(batch, context) {
          requests.push({ agentId: context.agentId, model: context.model });
          await onEvaluate?.(batch, context);
          return {
            status: "ok",
            result: {
              model: context.model,
              answers: Object.fromEntries(
                Object.entries(batch.questions).map(([id, question]) => {
                  if (question.type !== "choice") {
                    throw new Error("Expected choice question");
                  }
                  const choice = "drop" in question.criteria ? "drop" : fidelity;
                  return [
                    id,
                    {
                      type: "choice",
                      choice,
                      probabilities: Object.fromEntries(
                        Object.keys(question.criteria).map((label) => [
                          label,
                          label === choice ? 1 : 0,
                        ]),
                      ),
                    },
                  ];
                }),
              ),
            },
          };
        },
      });
    },
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  setRuntimeConfigSnapshot(config);
  onTestFinished(async () => {
    clearRuntimeConfigSnapshot();
    prepareDecisionProviderReload(builder.registry, new Set([record.id]));
    await getPluginInstance(record)?.dispose();
  });
  return { config, builder, requests };
}
