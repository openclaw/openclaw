// Codex tests cover computer tool duration parsing edge cases.
import { describe, expect, it } from "vitest";
import { resolveDynamicToolCallTimeoutMs } from "./dynamic-tool-execution.js";

describe("computer tool duration parsing", () => {
  it.each([
    // Malformed string forms fall to zero-duration baseline
    ["wait", "0x10", 120_000],
    ["hold_key", "1e2", 150_000],
    // Decimal strings are honored
    ["wait", "100", 220_000],
    // Fractional numeric values preserve sub-second precision
    ["wait", 0.5, 120_500],
    // Fractional string forms are rejected
    ["wait", "0.5", 120_000],
    // Negative values → 0 via Math.max / parseStrictNonNegativeInteger
    ["wait", -5, 120_000],
    ["wait", "-5", 120_000],
    // Zero duration → unchanged baseline
    ["wait", 0, 120_000],
    ["wait", "0", 120_000],
    // Non-wait/hold_key actions do not consume duration
    ["screenshot", "0x10", 120_000],
    ["type", "0x10", 150_000],
  ] as const)(
    "maps computer %s duration %j to a %d ms deadline",
    (action, duration, expectedMs) => {
      expect(
        resolveDynamicToolCallTimeoutMs({
          call: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: `call-computer-${action}-${duration}`,
            namespace: null,
            tool: "computer",
            arguments: { action, duration },
          },
          config: undefined,
        }),
      ).toBe(expectedMs);
    },
  );

  it("rejects NaN and Infinity duration via Number.isFinite guard", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-computer-wait-nan",
          namespace: null,
          tool: "computer",
          arguments: { action: "wait", duration: Number.NaN },
        },
        config: undefined,
      }),
    ).toBe(120_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-computer-wait-inf",
          namespace: null,
          tool: "computer",
          arguments: { action: "wait", duration: Infinity },
        },
        config: undefined,
      }),
    ).toBe(120_000);
  });

  it("rejects non-numeric scalars (null, bool) via typeof guard", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-computer-wait-null",
          namespace: null,
          tool: "computer",
          arguments: { action: "wait", duration: null },
        },
        config: undefined,
      }),
    ).toBe(120_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-computer-wait-bool",
          namespace: null,
          tool: "computer",
          arguments: { action: "wait", duration: true },
        },
        config: undefined,
      }),
    ).toBe(120_000);
  });

  it("treats missing duration key as zero-duration baseline", () => {
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-computer-wait-no-dur",
          namespace: null,
          tool: "computer",
          arguments: { action: "wait" },
        },
        config: undefined,
      }),
    ).toBe(120_000);
  });
});
