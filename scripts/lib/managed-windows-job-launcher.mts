import { spawn } from "node:child_process";
import { WindowsJob } from "@openclaw/proc-safe/windows-job";
import { isDirectRunUrl } from "./direct-run.mjs";
import type { WindowsJobControlMessage, WindowsJobLaunch } from "./managed-windows-job.mts";

const name = process.argv[2];
const fail = (error: unknown, type: "error" | "job-error" = "error") => {
  const failure: NodeJS.ErrnoException = error instanceof Error ? error : new Error(String(error));
  process.exitCode = 1;
  if (process.connected) {
    process.send?.(
      {
        job: name,
        type,
        error: failure.message,
        code: failure.code,
        errno: failure.errno,
        syscall: failure.syscall,
        path: failure.path,
      } satisfies WindowsJobControlMessage,
      () => process.disconnect?.(),
    );
  }
};

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    if (!name || !process.connected) {
      throw new Error("Windows command Job handoff is missing");
    }
    const job = WindowsJob.open(name);
    if (!job) {
      throw new Error("Windows command Job owner is gone");
    }
    try {
      job.assignCurrentProcess();
    } finally {
      // The host is the sole handle owner; host death terminates this whole Job.
      job.close();
    }
    process.once("message", (launch: WindowsJobLaunch) => {
      try {
        // The target inherits membership at creation, before any of its code can fork.
        const child = spawn(launch.command, launch.args, {
          ...launch.options,
          stdio: launch.stdio,
        });
        child.once("error", fail);
        child.once("spawn", () => {
          process.send?.(
            { job: name, type: "spawned", pid: child.pid } satisfies WindowsJobControlMessage,
            (error) => {
              if (error) {
                fail(error);
              } else if (!launch.stdio.includes("ipc")) {
                process.disconnect?.();
              }
            },
          );
        });
        child.once("exit", (code) => {
          process.exitCode = code ?? 1;
        });
        if (launch.stdio.includes("ipc")) {
          process.on("message", (message) => {
            if (message !== null && child.connected) {
              child.send(message, (error) => error && fail(error));
            }
          });
          child.on("message", (message) => {
            if (process.connected) {
              process.send?.(message, (error) => error && fail(error));
            }
          });
          process.once("disconnect", () => child.connected && child.disconnect());
          child.once("disconnect", () => process.connected && process.disconnect?.());
        }
      } catch (error) {
        fail(error);
      }
    });
    process.send?.({ job: name, type: "ready" } satisfies WindowsJobControlMessage);
  } catch (error) {
    fail(error, "job-error");
  }
}
