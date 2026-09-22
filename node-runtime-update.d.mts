export function resolveUpdatedNodeRuntime(
  recoveryRoot: string,
  options?: { allowInstall?: boolean; env?: NodeJS.ProcessEnv },
): Promise<string | null>;
