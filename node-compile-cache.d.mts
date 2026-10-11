export function enableOpenClawCompileCache(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): void;
export function resolveOpenClawCompileCacheRespawnEnv(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv | undefined;
export function resolveOpenClawCompileCacheDirectory(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined;
export function resolveSafeNodeCompileCacheDirectory(directory: string): string | undefined;
export function maintainOpenClawCompileCache(directory: string): Promise<void>;
