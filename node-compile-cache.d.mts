export function resolveOpenClawCompileCacheDirectory(params: {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
}): string;
export function maintainOpenClawCompileCache(directory: string): Promise<void>;
