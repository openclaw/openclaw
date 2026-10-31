import { expect, it } from "vitest";
import {
  complete,
  notify,
  observe,
  result,
  start,
} from "./event-projector.compact.test-support.js";
import { registerCodexEventProjectorTestLifecycle } from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

const responseUsage = {
  inputTokens: 1000,
  cachedInputTokens: 0,
  outputTokens: 10,
  reasoningOutputTokens: 0,
  totalTokens: 1010,
};

it.each([321, 0, undefined])(
  "replaces context after compaction with %s while preserving billing",
  async (tokensAfter) => {
    const { projector } = await observe();
    await notify(projector, "rawResponse/completed", {
      responseId: "before",
      usage: responseUsage,
    });
    const item = { type: "contextCompaction", id: "compact-1" };
    await start(projector, item);
    if (tokensAfter !== undefined) {
      await notify(projector, "thread/tokenUsage/updated", {
        tokenUsage: {
          last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: tokensAfter },
        },
      });
    }
    await complete(projector, item);
    expect(result(projector).attemptUsage).toMatchObject({
      input: 1000,
      output: 10,
      total: 1010,
      contextUsage:
        tokensAfter === undefined
          ? { state: "unavailable" }
          : { state: "available", promptTokens: tokensAfter, totalTokens: tokensAfter },
    });
    await notify(projector, "rawResponse/completed", {
      responseId: "after",
      usage: { ...responseUsage, inputTokens: 400, totalTokens: 410 },
    });
    expect(result(projector).attemptUsage).toMatchObject({
      input: 1400,
      output: 20,
      total: 1420,
      contextUsage: { state: "available", promptTokens: 400, totalTokens: 410 },
    });
    const next = { type: "contextCompaction", id: "compact-2" };
    await start(projector, next);
    await complete(projector, next);
    expect(result(projector).attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
  },
);

it.each([false, true])(
  "keeps compaction context separate from thread billing (prior usage=%s)",
  async (hasPriorUsage) => {
    const { projector } = await observe();
    if (hasPriorUsage) {
      await notify(projector, "thread/tokenUsage/updated", { tokenUsage: { last: responseUsage } });
    }
    const item = { type: "contextCompaction", id: "compact-1" };
    await start(projector, item);
    const historySnapshot = {
      tokenUsage: {
        last: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 321 },
      },
    };
    await notify(projector, "thread/tokenUsage/updated", historySnapshot);
    await complete(projector, item);
    await notify(projector, "thread/tokenUsage/updated", historySnapshot);
    expect(result(projector).attemptUsage).toMatchObject({
      contextUsage: { state: "available", promptTokens: 321, totalTokens: 321 },
    });
    expect(result(projector).attemptUsage?.input).toBe(hasPriorUsage ? 1000 : undefined);
    expect(result(projector).attemptUsage?.output).toBe(hasPriorUsage ? 10 : undefined);
    expect(result(projector).attemptUsage?.total).toBe(hasPriorUsage ? 1010 : undefined);
  },
);
