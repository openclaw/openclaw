import { expect, vi } from "vitest";

/** Asserts selected fields on a captured compaction record. */
export function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

/** Returns one argument from a recorded compaction mock call. */
export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

/** Finds the first compaction mock call matching a predicate. */
export function findMockCall(
  mock: ReturnType<typeof vi.fn>,
  predicate: (args: unknown[]) => boolean,
): unknown[] {
  const call = mock.mock.calls.find((entry) => predicate(entry));
  if (!call) {
    throw new Error("Expected matching mock call");
  }
  return call;
}
