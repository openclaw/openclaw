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

  const modelConfig = <T extends object>(fields: T) => ({
    models: { providers: { "cost-test-provider": { models: [{ id: "cost-model", ...fields }] } } },
  });
  const cost = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 4 };
  const COST_CONFIG = modelConfig({ cost });
  const trustedWindow: OuterContextTokenMeta = {
    contextTokens: 1_000_000,
    contextTokensSource: "resolved-v1",
  };

  it.each`
    name               | input                                                                                                                                                                  | expected
    ${"runtime"}       | ${{ attempt: { contextTokens: 1_000_000, contextTokensSource: "runtime" }, outerContextTokenMeta: { contextTokens: 272_000 } }}                                        | ${{ contextTokens: 1_000_000, contextTokensSource: "runtime" }}
    ${"configured"}    | ${{ attempt: { contextTokens: 272_000, contextTokensSource: "runtime-configured" }, outerContextTokenMeta: { contextTokens: 1_000_000 } }}                             | ${{ contextTokens: 272_000, contextTokensSource: "runtime-configured" }}
    ${"resolved"}      | ${{ outerContextTokenMeta: { contextTokens: 272_000 } }}                                                                                                               | ${{ contextTokens: 272_000, contextTokensSource: "resolved" }}
    ${"trusted"}       | ${{ outerContextTokenMeta: trustedWindow }}                                                                                                                            | ${trustedWindow}
    ${"routed"}        | ${{ assistantProvider: "routed-provider", outerContextTokenMeta: trustedWindow }}                                                                                      | ${{ provider: "routed-provider", model: "cost-model", contextTokens: 1_000_000, contextTokensSource: "resolved" }}
    ${"selected"}      | ${{ attempt: { runtimeModelSelection: { provider: "native-provider", model: "native-model" } }, assistantProvider: "openclaw", outerContextTokenMeta: trustedWindow }} | ${{ provider: "native-provider", model: "native-model", contextTokensSource: "resolved" }}
    ${"attempt owned"} | ${{ assistantProvider: "routed-provider", attempt: { contextTokens: 400_000, contextTokensSource: "runtime" }, outerContextTokenMeta: trustedWindow }}                 | ${{ contextTokens: 400_000, contextTokensSource: "runtime" }}
  `(
    "attributes the context window for $name",
    async ({ input, expected }: { input: TerminalStatsInput; expected: object }) => {
      expect((await prepareStats(input)).agentMeta).toMatchObject(expected);
    },
  );

  it.each`
    name                     | input                                                                                                                                                                     | expected                                                                                          | absent
    ${"engaged counters"}    | ${{ attempt: { codeModeEngaged: true }, assistantTurns: 3, bridgeCalls: { search: 2, describe: 1, call: 5 } }}                                                            | ${{ codeModeEngaged: true, assistantTurns: 3, bridgeCalls: { search: 2, describe: 1, call: 5 } }} | ${[]}
    ${"disabled code mode"}  | ${{ attempt: { codeModeEngaged: false } }}                                                                                                                                | ${{ codeModeEngaged: false }}                                                                     | ${[]}
    ${"unreported counters"} | ${{ assistantTurns: 0 }}                                                                                                                                                  | ${{ codeModeEngaged: false }}                                                                     | ${["assistantTurns", "bridgeCalls"]}
    ${"credential source"}   | ${{ attempt: { modelAttempt: { provider: "openai", model: "gpt-5.6-luna", credentialSource: { kind: "direct", evidence: "environment", authorization: "declared" } } } }} | ${{ credentialSource: { kind: "direct", evidence: "environment", authorization: "declared" } }}   | ${[]}
  `(
    "$name",
    async ({
      input,
      expected,
      absent,
    }: {
      input: TerminalStatsInput;
      expected: object;
      absent: string[];
    }) => {
      const { agentMeta } = await prepareStats(input);
      for (const [field, value] of Object.entries(expected)) {
        expect(agentMeta).toHaveProperty(field, value);
      }
      for (const field of absent) {
        expect(agentMeta).not.toHaveProperty(field);
      }
    },
  );

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

  it.each`
    name                               | input
    ${"partially priced tiered calls"} | ${{ config: modelConfig({ cost: { ...cost, tieredPricing: [{ range: [200_000], input: 2, output: 4, cacheRead: 1, cacheWrite: 8 }] } }), attempts: [{ input: 150_000, output: 100, cost: { total: 0.125 } }, { input: 150_000, output: 100 }] }}
    ${"unpriced model"}                | ${{ provider: "no-cost-provider", model: "uncosted-model", config: COST_CONFIG, usage: { input: 1_000_000, output: 500_000, total: 1_500_000 } }}
    ${"no usage"}                      | ${{ config: COST_CONFIG }}
  `("omits costUsd for $name", async ({ input }: { input: TerminalStatsInput }) => {
    expect((await prepareStats(input)).agentMeta).not.toHaveProperty("costUsd");
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
      config: modelConfig({ responseModelEquivalent: true }),
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
