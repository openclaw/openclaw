export function enableOpenClawCompileCache(params: {
  directory: string | undefined;
  env?: NodeJS.ProcessEnv;
  foregroundGateway?: boolean;
}): void;
export function scheduleOpenClawCompileCacheFlush(): void;
export function resolveOpenClawCompileCacheRespawnEnv(params: {
  directory: string | undefined;
  env?: NodeJS.ProcessEnv;
  foregroundGateway?: boolean;
}): NodeJS.ProcessEnv | undefined;
export function resolveOpenClawCompileCacheDirectory(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
  foregroundGateway?: boolean;
  prewarm?: boolean;
}): string | undefined;
export function resolveSafeNodeCompileCacheDirectory(directory: string): string | undefined;
