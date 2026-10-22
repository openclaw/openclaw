import { describe, expect, it } from "vitest";
import type { StreamFn } from "../../llm.js";
import { createCompactionModel } from "./compaction.test-support.js";
import {
  assistant,
  compactWith,
  makePreparation,
  responseStream,
  summarize,
  user,
} from "./shard-fixtures.test-support.js";

describe("generateSummary output budget", () => {
  function createBudgetModel() {
    return {
      ...createCompactionModel({ contextWindow: 1_000_000, maxTokens: 128_000 }),
      id: "budget-model",
      name: "Budget Model",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      params: {},
    };
  }

  async function captureMaxTokens(reserveTokens: number, splitTurn = false) {
    const model = createBudgetModel();
    const observed: (number | undefined)[] = [];
    const streamFn: StreamFn = (_model, _context, options) => {
      observed.push(options?.maxTokens);
      return responseStream(
        assistant(splitTurn ? `summary-${observed.length}` : "summary", {
          api: model.api,
          provider: model.provider,
          model: model.id,
        }),
      );
    };
    if (!splitTurn) {
      const result = await summarize([user("hello")], model, { reserveTokens, streamFn });
      expect(result).toEqual({ ok: true, value: "summary" });
      return observed;
    }
    const result = await compactWith(
      makePreparation({
        messagesToSummarize: [user("history")],
        turnPrefixMessages: [user("prefix", 2)],
        settings: { enabled: true, reserveTokens, keepRecentTokens: 100 },
      }),
      model,
      { streamFn },
    );
    expect(result.ok).toBe(true);
    return observed;
  }

  it.each([
    [80_000, false, [64_000]],
    [20_000, false, [16_000]], // Agent runtime floor.
    [16_384, false, [13_107]], // Harness default.
    [80_000, true, [64_000, 40_000]],
  ] as const)("preserves caller-owned reserve %i (split: %s)", async (reserve, split, expected) => {
    expect(await captureMaxTokens(reserve, split)).toEqual(expected);
  });
});
