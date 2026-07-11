export function resolvePositiveInteger(value: unknown, fallback: unknown): unknown;
export function createIncrementalLineReader(
  filePath: unknown,
  options?: Record<string, unknown>,
): {
  readLines(): {
    lines: string[];
    reset: boolean;
  };
};
