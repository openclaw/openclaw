export function getPrWorktreePaths(
  root: string,
  pr: string,
): {
  legacy: string;
  isolated: string;
};
export function requireIsolatedPrWorktreeParent(
  root: string,
  options?: { writableFor?: string },
): string;
