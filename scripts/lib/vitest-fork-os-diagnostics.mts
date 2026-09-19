import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Inspect an owned fork without depending on its event loop or IPC channel. */
export function collectVitestForkOsDiagnostics(childPid: number): Promise<string> {
  if (!Number.isSafeInteger(childPid) || childPid <= 0) {
    return Promise.resolve("[vitest] fork OS diagnostics: invalid pid");
  }
  if (process.platform !== "linux") {
    return Promise.resolve(
      `[vitest] fork OS diagnostics: platform=${process.platform} unavailable`,
    );
  }
  return new Promise((resolve) => {
    // A separate observer bounds synchronous procfs reads even if a target thread is stuck.
    try {
      execFile(
        process.execPath,
        [
          fileURLToPath(new URL("./vitest-fork-os-observer.mjs", import.meta.url)),
          String(childPid),
        ],
        {
          env: {},
          encoding: "utf8",
          timeout: 1_500,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          const outcome = error
            ? `[vitest] fork OS diagnostics: observer ${error.killed ? "deadline reached" : "failed"}\n`
            : "";
          resolve((outcome + stdout).slice(0, 16 * 1024));
        },
      );
    } catch {
      resolve("[vitest] fork OS diagnostics: observer unavailable");
    }
  });
}
