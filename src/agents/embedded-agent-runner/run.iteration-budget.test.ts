import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent iteration budget", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("returns budget_exhausted after configured tool-calling rounds", async () => {
    const budgetDecisions: boolean[] = [];
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams) => {
      const attemptParams = rawParams as Pick<EmbeddedRunAttemptParams, "onBeforeToolCallingRound">;
      if (!attemptParams.onBeforeToolCallingRound) {
        throw new Error("Expected iteration budget callback");
      }
      budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(1));
      budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(2));
      budgetDecisions.push(await attemptParams.onBeforeToolCallingRound(3));
      return makeAttemptResult({
        assistantTexts: ["I will keep calling the tool."],
        messagesSnapshot: [],
        promptError: null,
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      config: {
        agents: {
          defaults: {
            iterationBudget: {
              enabled: true,
              maxIterations: 2,
              forceSummaryOnExhaustion: false,
            },
          },
        },
      },
    });

    expect(budgetDecisions).toEqual([true, true, false]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("2/2");
  });
});
