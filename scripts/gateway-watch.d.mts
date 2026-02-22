export function buildGatewayWatchArgs(params?: {
  platform?: NodeJS.Platform;
  args?: string[];
}): string[];

export function runGatewayWatchMain(params?: {
  platform?: NodeJS.Platform;
  spawnSync?: (
    cmd: string,
    args: string[],
    options?: unknown,
  ) => {
    status?: number | null;
  };
  execPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  process?: NodeJS.Process;
  spawn?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => {
    on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void;
  };
  now?: () => number;
}): Promise<number>;
