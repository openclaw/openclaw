export type PreservedControlUiAssets = {
  sourcePath: string;
  targetPath: string;
};

export function preserveControlUiAssets(params?: {
  cwd?: string;
  fs?: typeof import("node:fs");
}): PreservedControlUiAssets | null;

export function restorePreservedControlUiAssets(
  preserved: PreservedControlUiAssets | null,
  params?: {
    fs?: typeof import("node:fs");
  },
): boolean;

export function cleanTsdownOutputRoots(params?: {
  cwd?: string;
  fs?: typeof import("node:fs");
}): void;

export function pruneStaleRootChunkFiles(params?: {
  cwd?: string;
  fs?: typeof import("node:fs");
}): void;

export function pruneSourceCheckoutBundledPluginNodeModules(params?: {
  cwd?: string;
  logger?: Pick<Console, "warn">;
}): void;

export function createTsdownOutputScanner(params?: { maxCaptureBytes?: number }): {
  append(chunk: Buffer | string): void;
  finish(): {
    captured: string;
    hasIneffectiveDynamicImport: boolean;
    fatalUnresolvedImport: string | null;
  };
};

export function resolveTsdownBuildInvocation(params?: {
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  npmExecPath?: string;
  comSpec?: string;
  platform?: NodeJS.Platform;
}): {
  command: string;
  args: string[];
  options: {
    stdio: Array<"ignore" | "pipe">;
    shell: boolean;
    windowsVerbatimArguments?: boolean;
    env: NodeJS.ProcessEnv;
  };
};

export function runTsdownBuildInvocation(
  invocation: ReturnType<typeof resolveTsdownBuildInvocation>,
  params?: {
    stdout?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
    env?: NodeJS.ProcessEnv;
    scanner?: ReturnType<typeof createTsdownOutputScanner>;
  },
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error: Error | null;
  captured: string;
  hasIneffectiveDynamicImport: boolean;
  fatalUnresolvedImport: string | null;
}>;
