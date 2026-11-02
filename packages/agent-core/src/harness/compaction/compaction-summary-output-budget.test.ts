import { describe, expect, it } from "vitest";
import type { StreamFn } from "../../llm.js";
import { createCompactionModel } from "./compaction.test-support.js";
import {
  assistant,
  compactWith,
  responseStream,
  summarize,
  user,
} from "./shard-fixtures.test-support.js";
import { createFileOps } from "./utils.js";

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
      {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [user("history")],
        turnPrefixMessages: [user("prefix", 2)],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens, keepRecentTokens: 100 },
      },
      model,
      { streamFn },
    );
    expect(result.ok).toBe(true);
    return observed;
  }

  it("keeps raised-reserve authorization caller-owned", async () => {
    const observed = await captureMaxTokens(80_000);

    expect(observed).toEqual([64_000]);
  });

  it("leaves the agent runtime's default reserve path unchanged", async () => {
    // The agent layer floors the reserve at 20_000, so this is the value ordinary
    // compaction actually runs with. Its authorization must not move.
    const observed = await captureMaxTokens(20_000);

    expect(observed).toEqual([16_000]);
  });

  it("leaves the harness default reserve path unchanged", async () => {
    // The harness default sits below the floor and must be equally untouched.
    const observed = await captureMaxTokens(16_384);

    expect(observed).toEqual([13_107]);
  });

  it("keeps split-turn authorization caller-owned", async () => {
    const raised = await captureMaxTokens(80_000, true);

    expect(raised).toEqual([64_000, 40_000]);
  });
});
