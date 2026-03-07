export const runNodeWatchedPaths: string[];

export function runNodeMain(params?: {
  spawn?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => {
    on: (
      event: "exit",
      cb: (code: number | null, signal: string | null) => void,
    ) => void | undefined;
  };
  spawnSync?: unknown;
  fs?: unknown;
  stderr?: { write: (value: string) => void };
  execPath?: string;
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<number>;
