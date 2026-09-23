import { expect, type vi } from "vitest";

export function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

export function firstCall(mock: ReturnType<typeof vi.fn>): ReadonlyArray<unknown> {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected first mock call");
  }
  return call;
}

export function firstCallArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [arg] = firstCall(mock);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first call argument object");
  }
  return arg as Record<string, unknown>;
}

export function findCallArg(
  mock: ReturnType<typeof vi.fn>,
  predicate: (arg: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const [arg] of mock.mock.calls) {
    if (arg && typeof arg === "object" && predicate(arg as Record<string, unknown>)) {
      return arg as Record<string, unknown>;
    }
  }
  throw new Error("expected matching mock call");
}

export function findRecordCallArg(
  mock: ReturnType<typeof vi.fn>,
  argIndex: number,
  label: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const call of mock.mock.calls as unknown[][]) {
    const value = call[argIndex];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (predicate(record)) {
      return record;
    }
  }
  throw new Error(`expected ${label}`);
}
