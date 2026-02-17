export function runWatchMain(params?: {
  spawn?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => {
    on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void;
  };
  process?: NodeJS.Process;
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<number>;
