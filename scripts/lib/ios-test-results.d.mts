export function requireExactTestResults(
  value: unknown,
  expectedIds: readonly string[],
): { testIdentifier: string; testResult: "Passed" }[];
