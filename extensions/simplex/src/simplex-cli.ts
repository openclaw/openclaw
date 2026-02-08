import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type SimplexCliHandle = {
  proc: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  stop: (options?: { sigintTimeoutMs?: number; sigtermTimeoutMs?: number }) => Promise<void>;
};

export function startSimplexCli(params: {
  cliPath: string;
  wsPort: number;
  dataDir?: string;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): SimplexCliHandle {
  const args = ["-p", String(params.wsPort)];
  if (params.dataDir) {
    args.push("-d", params.dataDir);
  }

  const proc = spawn(params.cliPath, args, {
    // Keep stdin open so simplex-chat doesn't exit on immediate EOF.
    stdio: ["pipe", "pipe", "pipe"],
  });
  let exited = false;
  let exitResolver:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      exitResolver = resolve;
    },
  );

  const ready = new Promise<void>((resolve, reject) => {
    proc.once("spawn", () => resolve());
    proc.once("error", (err) => reject(err));
  });

  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      params.log?.info?.(`[simplex] ${text}`);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      params.log?.warn?.(`[simplex] ${text}`);
    }
  });

  proc.on("error", (err) => {
    params.log?.error?.(`SimpleX CLI error: ${String(err)}`);
    if (!exited && exitResolver) {
      exited = true;
      exitResolver({ code: null, signal: null });
    }
  });

  proc.on("exit", (code, signal) => {
    exited = true;
    exitResolver?.({ code, signal });
    params.log?.warn?.(`SimpleX CLI exited (code=${code ?? "?"} signal=${signal ?? "?"})`);
  });

  const waitForExit = async (): Promise<void> => {
    if (exited) {
      return;
    }
    await exitPromise;
  };

  const waitWithTimeout = (timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void waitForExit().then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const isNoSuchProcess = (err: unknown): boolean =>
    typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ESRCH";

  let stoppingPromise: Promise<void> | null = null;

  return {
    proc,
    ready,
    stop: async (options) => {
      if (stoppingPromise) {
        return await stoppingPromise;
      }

      stoppingPromise = (async () => {
        if (exited || proc.killed) {
          return;
        }
        const sigintTimeoutMs = options?.sigintTimeoutMs ?? 3_000;
        const sigtermTimeoutMs = options?.sigtermTimeoutMs ?? 2_000;

        // Give simplex-chat EOF so it can exit cleanly if blocked on stdin.
        if (!proc.stdin.destroyed) {
          proc.stdin.end();
        }

        const sendSignal = async (signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> => {
          if (exited) {
            return true;
          }
          try {
            proc.kill(signal);
          } catch (err) {
            if (isNoSuchProcess(err)) {
              return true;
            }
            params.log?.warn?.(`SimpleX CLI stop (${signal}) failed: ${String(err)}`);
            return false;
          }
          return await waitWithTimeout(timeoutMs);
        };

        const exitedAfterSigint = await sendSignal("SIGINT", sigintTimeoutMs);
        if (!exitedAfterSigint && !proc.killed) {
          const exitedAfterSigterm = await sendSignal("SIGTERM", sigtermTimeoutMs);
          if (!exitedAfterSigterm && !proc.killed) {
            try {
              proc.kill("SIGKILL");
            } catch (err) {
              if (!isNoSuchProcess(err)) {
                params.log?.warn?.(`SimpleX CLI SIGKILL failed: ${String(err)}`);
              }
            }
          }
        }

        await waitForExit();
      })();

      return await stoppingPromise;
    },
  };
}
