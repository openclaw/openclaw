export function plainGhEnv(env?: NodeJS.ProcessEnv): {
  [key: string]: string | undefined;
};
export function resolvePlainGhBin(env?: NodeJS.ProcessEnv, systemCandidates?: string[]): string;
export function execPlainGh(args: unknown, options?: Record<string, unknown>): NonSharedBuffer;
export function spawnPlainGh(
  args: unknown,
  options?: Record<string, unknown>,
): import("node:child_process").SpawnSyncReturns<NonSharedBuffer>;
export const PLAIN_GH_SYSTEM_CANDIDATES: string[];
