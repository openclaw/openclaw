import { describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "../usage-accumulator.js";
import {
  assistantMessage,
  attemptResult,
  createTerminalPreparationInput,
  type OuterContextTokenMeta,
  type TerminalStatsInput,
} from "./terminal-preparation.test-support.js";

// Run stats do not depend on rendered payloads.
vi.mock("./payloads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./payloads.js")>()),
  buildEmbeddedRunPayloads: () => [],
}));

describe("prepareEmbeddedRunTerminal run stats", () => {
  async function prepareStats(statsInput: TerminalStatsInput = {}) {
    const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
    const provider = statsInput.provider ?? "cost-test-provider";
    const model = statsInput.model ?? "cost-model";
    const assistant = {
      ...assistantMessage("stop"),
      provider: statsInput.assistantProvider ?? provider,
      model,
      ...(statsInput.responseModel ? { responseModel: statsInput.responseModel } : {}),
    };
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, statsInput.usage);
    for (const attempt of statsInput.attempts ?? []) {
      mergeUsageIntoAccumulator(usageAccumulator, attempt);
    }
    usageAccumulator.assistantTurns = statsInput.assistantTurns ?? 0;
    usageAccumulator.bridgeCalls = statsInput.bridgeCalls;
    return prepareEmbeddedRunTerminal(
      createTerminalPreparationInput({
        admittedRunContext: createTestAdmittedRunContext("run-1"),
        runParams: {
          sessionId: "session-1",
          runId: "run-1",
          ...(statsInput.config ? { config: statsInput.config as never } : {}),
        },
        attempt: attemptResult({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
          ...statsInput.attempt,
        }),
        currentAttemptCompletedAssistant: assistant,
        provider,
        model,
        activeErrorContext: { provider, model },
        outerContextTokenMeta: statsInput.outerContextTokenMeta ?? {},
        usageAccumulator,
      }),
    );
  }

  const COST_CONFIG = {
    models: {
      providers: {
        "cost-test-provider": {
          models: [
            {
              id: "cost-model",
              cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 },
            },
          ],
        },
      },
    },
  };

  it.each([
    { name: "engaged", codeModeEngaged: true, expected: true },
    { name: "not engaged", codeModeEngaged: false, expected: false },
    { name: "unreported (harness route)", codeModeEngaged: undefined, expected: false },
  ])("stamps codeModeEngaged when $name", async ({ codeModeEngaged, expected }) => {
    const prepared = await prepareStats({ attempt: { codeModeEngaged } });
    expect(prepared.agentMeta.codeModeEngaged).toBe(expected);
  });

  it("records whether the context window came from the harness or prepared resolution", async () => {
    const observed = await prepareStats({
      attempt: { contextTokens: 1_000_000, contextTokensSource: "runtime" },
      outerContextTokenMeta: { contextTokens: 272_000 },
    });
    expect(observed.agentMeta).toMatchObject({
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });

    const configured = await prepareStats({
      attempt: { contextTokens: 272_000, contextTokensSource: "runtime-configured" },
      outerContextTokenMeta: { contextTokens: 1_000_000 },
    });
    expect(configured.agentMeta).toMatchObject({
      contextTokens: 272_000,
      contextTokensSource: "runtime-configured",
    });

    const resolved = await prepareStats({
      outerContextTokenMeta: { contextTokens: 272_000 },
    });
    expect(resolved.agentMeta).toMatchObject({
      contextTokens: 272_000,
      contextTokensSource: "resolved",
    });

    const verified = await prepareStats({
      outerContextTokenMeta: { contextTokens: 1_000_000, contextTokensSource: "resolved-v1" },
    });
    expect(verified.agentMeta).toMatchObject({
      contextTokens: 1_000_000,
      contextTokensSource: "resolved-v1",
    });
  });

  it("keeps a prepared trusted window legacy when another model identity is reported", async () => {
    const outerContextTokenMeta: OuterContextTokenMeta = {
      contextTokens: 1_000_000,
      contextTokensSource: "resolved-v1",
    };
    const routed = await prepareStats({
      assistantProvider: "routed-provider",
      outerContextTokenMeta,
    });
    expect(routed.agentMeta).toMatchObject({
      provider: "routed-provider",
      model: "cost-model",
      contextTokens: 1_000_000,
      contextTokensSource: "resolved",
    });

    const selected = await prepareStats({
      attempt: { runtimeModelSelection: { provider: "native-provider", model: "native-model" } },
      assistantProvider: "openclaw",
      outerContextTokenMeta,
    });
    expect(selected.agentMeta).toMatchObject({
      provider: "native-provider",
      model: "native-model",
      contextTokensSource: "resolved",
    });

    const attemptOwned = await prepareStats({
      assistantProvider: "routed-provider",
      attempt: { contextTokens: 400_000, contextTokensSource: "runtime" },
      outerContextTokenMeta,
    });
    expect(attemptOwned.agentMeta).toMatchObject({
      contextTokens: 400_000,
      contextTokensSource: "runtime",
    });
  });

  it("reports the terminal physical attempt's redacted credential source", async () => {
    const prepared = await prepareStats({
      attempt: {
        modelAttempt: {
          provider: "openai",
          model: "gpt-5.6-luna",
          credentialSource: {
            kind: "direct",
            evidence: "environment",
            authorization: "declared",
          },
        },
      },
    });

    expect(prepared.agentMeta.credentialSource).toEqual({
      kind: "direct",
      evidence: "environment",
      authorization: "declared",
    });
  });

  it("stamps assistantTurns from the run accumulator and omits zero", async () => {
    const counted = await prepareStats({ assistantTurns: 3 });
    expect(counted.agentMeta.assistantTurns).toBe(3);

    const empty = await prepareStats({ assistantTurns: 0 });
    expect(empty.agentMeta).not.toHaveProperty("assistantTurns");
  });

  it("stamps run-accumulated bridge call counts and omits them when absent", async () => {
    const withBridge = await prepareStats({
      bridgeCalls: { search: 2, describe: 1, call: 5 },
    });
    expect(withBridge.agentMeta.bridgeCalls).toEqual({ search: 2, describe: 1, call: 5 });

    const withoutBridge = await prepareStats({});
    expect(withoutBridge.agentMeta).not.toHaveProperty("bridgeCalls");
  });

  it("computes costUsd from accumulated usage including cache pricing", async () => {
    const prepared = await prepareStats({
      config: COST_CONFIG,
      usage: {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 2_000_000,
        cacheWrite: 250_000,
        total: 3_750_000,
      },
    });
    // (1M*$1 + 0.5M*$2 + 2M*$0.5 + 0.25M*$4) per million tokens.
    expect(prepared.agentMeta.costUsd).toBeCloseTo(4, 10);
  });

  it.each([
    { firstCost: 0, tokens: { input: 150_000, output: 100 } },
    { firstCost: 0.125, tokens: { input: 150_000, output: 100 } },
    { firstCost: 0, tokens: {} },
    { firstCost: 0.125, tokens: {} },
  ])(
    "preserves carried per-attempt cost $firstCost with tokens $tokens instead of repricing",
    async ({ firstCost, tokens }) => {
      const prepared = await prepareStats({
        config: COST_CONFIG,
        attempts: [
          { ...tokens, cost: { total: firstCost } },
          { ...tokens, cost: { total: 0 } },
        ],
      });
      expect(prepared.agentMeta.costUsd).toBe(firstCost);
    },
  );

  it("omits tiered aggregate cost when an observed call has no price", async () => {
    const prepared = await prepareStats({
      config: {
        models: {
          providers: {
            "cost-test-provider": {
              models: [
                {
                  id: "cost-model",
                  cost: {
                    input: 1,
                    output: 2,
                    cacheRead: 0.5,
                    cacheWrite: 4,
                    tieredPricing: [
                      { range: [200_000], input: 2, output: 4, cacheRead: 1, cacheWrite: 8 },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
      attempts: [
        { input: 150_000, output: 100, cost: { total: 0.125 } },
        { input: 150_000, output: 100 },
      ],
    });
    expect(prepared.agentMeta).not.toHaveProperty("costUsd");
  });

  it("omits costUsd when the model has no cost data", async () => {
    const prepared = await prepareStats({
      provider: "no-cost-provider",
      model: "uncosted-model",
      config: COST_CONFIG,
      usage: { input: 1_000_000, output: 500_000, total: 1_500_000 },
    });
    expect(prepared.agentMeta).not.toHaveProperty("costUsd");
  });

  it("omits costUsd when the run reported no usage", async () => {
    const prepared = await prepareStats({ config: COST_CONFIG });
    expect(prepared.agentMeta).not.toHaveProperty("costUsd");
  });

  it("keeps response identity in the terminal receipt without replacing the run model", async () => {
    const prepared = await prepareStats({
      responseModel: "cost-model-rerouted",
      attempt: {
        terminalTurnId: "turn-7",
        toolMetas: [
          { toolName: "exec", isError: false },
          { toolName: "unknown" },
          { toolName: "write", isError: true },
          { toolName: "read", isError: false },
          { toolName: "exec", isError: false },
        ],
        successfulNestedToolNames: ["read", "zeta", "alpha", "Zeta", " exec ", "alpha", " "],
      },
    });

    expect(prepared.agentMeta.terminalReceipt).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      turnId: "turn-7",
      requested: { provider: "cost-test-provider", model: "cost-model" },
      effective: {
        provider: "cost-test-provider",
        model: "cost-model",
        responseModel: "cost-model-rerouted",
      },
      successfulToolNames: ["exec", "read", "Zeta", "alpha", "zeta"],
      rerouted: true,
    });
    expect(prepared.agentMeta.terminalReceipt).not.toHaveProperty("terminalDisposition");
    expect(prepared.agentMeta.model).toBe("cost-model");
    expect(prepared.reportedModelRef.model).toBe("cost-model");
  });

  it("keeps a configured row's declared response model out of the reroute fact", async () => {
    const prepared = await prepareStats({
      responseModel: "upstream-model",
      config: {
        models: {
          providers: {
            "cost-test-provider": {
              models: [{ id: "cost-model", responseModelEquivalent: true }],
            },
          },
        },
      },
    });

    expect(prepared.agentMeta.terminalReceipt).toMatchObject({
      effective: {
        provider: "cost-test-provider",
        model: "cost-model",
        responseModel: "upstream-model",
      },
      rerouted: false,
    });
  });

  it("marks a provider-only response route as rerouted", async () => {
    const prepared = await prepareStats({ assistantProvider: "routed-provider" });

    expect(prepared.agentMeta.terminalReceipt).toMatchObject({
      requested: { provider: "cost-test-provider", model: "cost-model" },
      effective: {
        provider: "routed-provider",
        model: "cost-model",
        responseModel: "cost-model",
      },
      rerouted: true,
    });
  });
});
