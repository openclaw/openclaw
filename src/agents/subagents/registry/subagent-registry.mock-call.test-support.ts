import type { vi } from "vitest";

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
