import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareDecisionProviderReload } from "../../../decisions/runtime.js";
import { runPluginRegisterSyncInRegistry } from "../../../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../../../plugins/loader-records.js";
import { getPluginInstance } from "../../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { Agent } from "../../runtime/index.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { installAttemptNextTurnPreparation } from "./attempt-session-next-turn.js";
import { createSemanticStallReplanState } from "./semantic-stall-replan.js";
import { createRunToolOutcomeState } from "./tool-outcome-state.js";

function installDecisionFixture(config: OpenClawConfig) {
  const requests: string[] = [];
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "semantic-fixture-owner",
    source: "/synthetic/provider.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["semantic-fixture"] },
  });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerDecisionProvider({
        id: "semantic-fixture",
        contractVersion: 1,
        async evaluate(_batch, context) {
          requests.push(context.model);
          return {
            status: "ok",
            result: {
              model: context.model,
              answers: {
                verdict: {
                  type: "choice",
                  choice: "stalled",
                  probabilities: { progress: 0, stalled: 1, regressing: 0, uncertain: 0 },
                },
              },
            },
          };
        },
      }),
    builder.createApi(record, { config }),
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
  return { requests };
}

// Real run-owned observer, Decision registry/runtime and next-turn composition.
// Only the provider is an in-process fixture; no hosted inference is performed.
describe("semantic replan eligibility at next-turn composition", () => {
  it.each([
    { name: "absent Labs", labs: undefined, model: "semantic-fixture/default-v1", enabled: false },
    { name: "Labs off", labs: false, model: "semantic-fixture/default-v1", enabled: false },
    { name: "options only", labs: undefined, model: undefined, enabled: false },
    { name: "Labs on without model", labs: true, model: undefined, enabled: false },
    {
      name: "empty agent override",
      labs: true,
      model: "semantic-fixture/default-v1",
      override: "",
      enabled: false,
    },
    { name: "Labs on with model", labs: true, model: "semantic-fixture/default-v1", enabled: true },
  ])("$name", async ({ labs, model, override, enabled }) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { experimental: { decisionAssistance: labs }, decisionModel: model },
        entries: { main: override !== undefined ? { decisionModel: override } : {} },
      },
      tools: { loopDetection: { enabled: true, semanticNoProgress: "replan" } },
    };
    const { requests } = installDecisionFixture(config);
    const controller = new AbortController();
    const assertActive = vi.fn();
    const outcomes = createRunToolOutcomeState({
      config,
      agentId: "main",
      signal: controller.signal,
      laneTaskAbortController: new AbortController(),
      assertAdmittedActive: assertActive,
      goal: "Finish the synthetic task",
    });
    const replan = createSemanticStallReplanState({
      observer: outcomes.semanticNoProgressObserver,
      mode: outcomes.resolvedLoopDetectionConfig?.semanticNoProgress,
      assertActive,
    });
    const context = { systemPrompt: "unchanged prompt", messages: [], tools: [] };
    const agent = new Agent({ initialState: context });
    agent.prepareNextTurnWithContext = async (turn) => ({ context: turn.context });
    installAttemptNextTurnPreparation({
      agent,
      refreshPermissionPrompt: async (prompt) => prompt,
      semanticStallReplanState: replan,
    });
    await outcomes.semanticNoProgressObserver?.observeOutcome({
      toolName: "read",
      toolParams: { path: "/synthetic/unchanged" },
      result: "same",
      evidence: { detector: "generic_repeat", level: "warning", count: 10 },
    });
    const update = await agent.prepareNextTurnWithContext?.(
      {
        message: makeAssistantMessageFixture({
          content: [{ type: "text", text: "Continue" }],
          stopReason: "stop",
          errorMessage: undefined,
        }),
        toolResults: [],
        newMessages: [],
        context,
      },
      controller.signal,
    );
    expect(requests).toHaveLength(enabled ? 1 : 0);
    expect(replan?.used ?? false).toBe(enabled);
    expect(update?.context?.messages).toBe(context.messages);
    expect(update?.context?.tools).toBe(context.tools);
    expect(update?.context?.systemPrompt === context.systemPrompt).toBe(!enabled);
    expect(context.systemPrompt).toBe("unchanged prompt");
    await outcomes.semanticNoProgressObserver?.close();
  });
  it.each([
    "Labs opt-out",
    "brief Labs opt-out",
    "shadow downgrade",
    "mode off",
    "model switch",
  ] as const)("does not spend the replan budget after published %s", async (revocation) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: { decisionAssistance: true },
          decisionModel: "semantic-fixture/default-v1",
        },
      },
      tools: { loopDetection: { enabled: true, semanticNoProgress: "replan" } },
    };
    const { requests } = installDecisionFixture(config);
    const controller = new AbortController();
    const assertActive = vi.fn();
    const outcomes = createRunToolOutcomeState({
      config,
      agentId: "main",
      signal: controller.signal,
      laneTaskAbortController: new AbortController(),
      assertAdmittedActive: assertActive,
      goal: "Finish",
    });
    const replan = createSemanticStallReplanState({
      observer: outcomes.semanticNoProgressObserver,
      mode: outcomes.resolvedLoopDetectionConfig?.semanticNoProgress,
      assertActive,
    });
    await outcomes.semanticNoProgressObserver?.observeOutcome({
      toolName: "read",
      toolParams: {},
      result: "same",
      evidence: { detector: "generic_repeat", level: "warning", count: 10 },
    });
    expect(requests).toHaveLength(1);
    expect(outcomes.semanticNoProgressObserver?.snapshot().latestJudgment?.verdict).toBe("stalled");
    setRuntimeConfigSnapshot(
      revocation === "Labs opt-out" || revocation === "brief Labs opt-out"
        ? {
            ...config,
            agents: {
              defaults: {
                ...config.agents?.defaults,
                experimental: { decisionAssistance: false },
              },
            },
          }
        : revocation === "model switch"
          ? {
              ...config,
              agents: {
                defaults: {
                  ...config.agents?.defaults,
                  decisionModel: "semantic-fixture/other-v1",
                },
              },
            }
          : {
              ...config,
              tools: {
                loopDetection: {
                  enabled: true,
                  semanticNoProgress: revocation === "shadow downgrade" ? "shadow" : "off",
                },
              },
            },
    );
    if (revocation === "brief Labs opt-out") {
      setRuntimeConfigSnapshot(config);
    }
    expect(outcomes.semanticNoProgressObserver?.snapshot().latestJudgment).toBeUndefined();
    const context = { systemPrompt: "original", messages: [], tools: [] };
    const agent = new Agent({ initialState: context });
    agent.prepareNextTurnWithContext = async (turn) => ({ context: turn.context });
    installAttemptNextTurnPreparation({
      agent,
      refreshPermissionPrompt: async (prompt) => prompt,
      semanticStallReplanState: replan,
    });
    const result = await agent.prepareNextTurnWithContext?.(
      {
        message: makeAssistantMessageFixture({
          content: [{ type: "text", text: "Continue" }],
          stopReason: "stop",
          errorMessage: undefined,
        }),
        toolResults: [],
        newMessages: [],
        context,
      },
      controller.signal,
    );
    expect(result?.context).toBe(context);
    expect(replan?.used).toBe(false);
    await outcomes.semanticNoProgressObserver?.close();
  });
});
