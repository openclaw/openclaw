import type { Session } from "@muse-code/sdk";
import { expect, it } from "vitest";
import { projectMuseAttemptUsage } from "./usage.js";

/** A fold whose only readable family is the session occupancy MSP emits per change. */
function sessionReporting(usedTokens: number | null | undefined): Pick<Session, "fold"> {
  const family = typeof usedTokens === "number" ? { usedTokens } : usedTokens;
  return {
    fold: { sessionState: { get: () => family } },
  } as unknown as Pick<Session, "fold">;
}

it("subtracts the explicit cache splits from the reported input tokens", () => {
  const usage = projectMuseAttemptUsage(
    {
      inputTokens: 1_200,
      outputTokens: 34,
      cachedTokens: 200,
      cacheReadTokens: 180,
      cacheWriteTokens: 20,
      reasoningTokens: 10,
    },
    undefined,
  );

  expect(usage).toEqual(
    expect.objectContaining({
      input: 1_000,
      output: 34,
      cacheRead: 180,
      cacheWrite: 20,
      reasoningTokens: 10,
      total: 1_234,
    }),
  );
});

it("keeps the reported input when the provider reports no cache split", () => {
  const usage = projectMuseAttemptUsage(
    // `cachedTokens` is convention-dependent (inside or beside inputTokens), so it is
    // never folded into cacheRead on its own.
    { inputTokens: 1_200, outputTokens: 34, cachedTokens: 200, reasoningTokens: 0 },
    undefined,
  );

  expect(usage).toEqual(expect.objectContaining({ input: 1_200, output: 34, total: 1_234 }));
  expect(usage?.cacheRead).toBeUndefined();
});

it("never reports a negative uncached input", () => {
  const usage = projectMuseAttemptUsage(
    {
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 0,
      cacheReadTokens: 200,
      reasoningTokens: 0,
    },
    undefined,
  );

  expect(usage?.input).toBeUndefined();
  expect(usage?.cacheRead).toBe(200);
});

it("forwards the measured context occupancy without re-deriving pressure", () => {
  const usage = projectMuseAttemptUsage(undefined, sessionReporting(42_000));

  expect(usage?.contextUsage).toEqual({
    state: "available",
    promptTokens: 42_000,
    totalTokens: 42_000,
  });
});

it("reports nothing when Muse measured nothing", () => {
  expect(projectMuseAttemptUsage(undefined, undefined)).toBeUndefined();
  expect(projectMuseAttemptUsage(undefined, sessionReporting(null))).toBeUndefined();
  expect(projectMuseAttemptUsage(undefined, sessionReporting(0))).toBeUndefined();
});
