export function resolveUpdatedNodeRuntime(
  homeDir: string,
  options?: { allowInstall?: boolean; env?: NodeJS.ProcessEnv },
): Promise<string | null>;
