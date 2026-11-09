export function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown>;
export function parseStrictJsonObject(text: string): Record<string, unknown> | null;
