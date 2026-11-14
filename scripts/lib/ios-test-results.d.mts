export function requireExactTestResults(
  value: unknown,
  expectedIds: readonly string[],
): { testIdentifier: string; testResult: "Passed" }[];

export function findUnmatchedSelectors(value: unknown, selectors: readonly string[]): string[];
