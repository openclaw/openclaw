type MockWithCalls = {
  mock: { calls: unknown[][] };
};

export function firstMockCall(mock: MockWithCalls, label: string): unknown[] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

export function firstMockArg(mock: MockWithCalls, label: string) {
  return firstMockCall(mock, label)[0];
}

export function objectArgAt(
  mock: MockWithCalls,
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  const value = mock.mock.calls[callIndex]?.[argIndex];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

export function argAt(mock: MockWithCalls, callIndex: number, argIndex: number): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call || !(argIndex in call)) {
    throw new Error(`expected call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

export function recordField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}
