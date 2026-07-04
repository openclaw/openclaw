/**
 * Checks whether the current build output is ready for a hot-reload restart.
 * The build is considered ready when:
 *   1. dist/entry.js exists, AND
 *   2. The build stamp's git HEAD matches the current checkout HEAD.
 *
 * Falls back to entry-only check when git or the stamp file is unavailable.
 */
export function isBuildReadyForRestart(
  cwd: string,
  fsModule: { existsSync: (p: string) => boolean; readFileSync?: (p: string, encoding?: string) => string },
  resolveHead?: (opts: { cwd: string }) => string | null,
): boolean;

export function runWatchMain(params?: {
  spawn?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => {
    kill?: (signal?: NodeJS.Signals | number) => void;
    on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void;
  };
  createWatcher?: (
    paths: string[],
    options: {
      ignoreInitial: boolean;
      ignored: (watchPath: string) => boolean;
    },
  ) => {
    on: (event: "add" | "change" | "unlink" | "error", cb: (arg?: unknown) => void) => void;
    close?: () => Promise<void> | void;
  };
  loadChokidar?: () => Promise<{
    watch: (
      paths: string[],
      options: {
        ignoreInitial: boolean;
        ignored: (watchPath: string) => boolean;
      },
    ) => {
      on: (event: "add" | "change" | "unlink" | "error", cb: (arg?: unknown) => void) => void;
      close?: () => Promise<void> | void;
    };
  }>;
  watchPaths?: string[];
  process?: NodeJS.Process;
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<number>;
