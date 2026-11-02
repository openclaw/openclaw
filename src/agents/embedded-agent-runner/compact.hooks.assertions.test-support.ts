import { vi } from "vitest";

/** Asserts selected fields on a captured compaction record. */
export { expectObjectFields as expectRecordFields } from "../../test-utils/mock-call-assertions.js";

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
