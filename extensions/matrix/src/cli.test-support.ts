import { vi } from "vitest";

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const resolvedIndex = callIndex < 0 ? mock.mock.calls.length + callIndex : callIndex;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}
