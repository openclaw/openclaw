export function stripNodeStartupHooks(value: string | undefined): string | undefined;

export function nodeRuntimePathEntries(value: string | undefined): string[];

export function withNodeRuntimePath(
  env: NodeJS.ProcessEnv,
  nodePath: string,
  platform?: NodeJS.Platform,
): NodeJS.ProcessEnv;
