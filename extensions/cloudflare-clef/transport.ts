import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** No shell; physical settlement includes terminating the isolated child group. */
export function runCli(
  binary: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<{ code: number | null; stdout: string; stderr: string; stopped: boolean }> {
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      size = 0,
      stopped = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        return;
      }
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          child.kill(signal);
        }
      }
    };
    const stop = () => {
      if (stopped || !child.pid) {
        return;
      }
      stopped = true;
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 250);
    };
    const timer = setTimeout(stop, options.timeoutMs);
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) {
      stop();
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (text: string, isError: boolean) => {
      size += Buffer.byteLength(text);
      if (size > MAX_OUTPUT_BYTES) {
        stop();
        return;
      }
      if (isError) {
        stderr += text;
      } else {
        stdout += text;
      }
    };
    child.stdout.on("data", (text: string) => collect(text, false));
    child.stderr.on("data", (text: string) => collect(text, true));
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      if (stopped) {
        kill("SIGKILL");
      }
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal.removeEventListener("abort", stop);
      if (options.signal.aborted) {
        const reason: unknown = options.signal.reason;
        reject(reason instanceof Error ? reason : new Error("Clef evaluation aborted"));
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({ code, stdout, stderr, stopped });
    });
  });
}
