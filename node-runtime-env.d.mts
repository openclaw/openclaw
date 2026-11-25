export function parseNodeOptionsEnvVar(value: string | undefined): string[] | null;
export function stripNodeStartupHooks(value: string | undefined): string | undefined;
export function hasNodeStartupHooks(
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): boolean;

export function nodeRuntimePathEntries(value: string | undefined): string[];

export function withNodeRuntimePath(
  env: NodeJS.ProcessEnv,
  nodePath: string,
  platform?: NodeJS.Platform,
): NodeJS.ProcessEnv;
