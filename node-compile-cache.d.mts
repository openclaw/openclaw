export function enableOpenClawCompileCache(params: {
  directory: string | undefined;
  env?: NodeJS.ProcessEnv;
}): void;
export function resolveOpenClawCompileCacheRespawnEnv(params: {
  directory: string | undefined;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv | undefined;
export function resolveOpenClawCompileCacheDirectory(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined;
export function resolveSafeNodeCompileCacheDirectory(directory: string): string | undefined;
