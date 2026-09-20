import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createWindowsJobBindings } from "../../src/process/supervisor/service-child-windows-job-native.ts";
import { isDirectRunUrl } from "./direct-run.mjs";
import type { WindowsJobLaunch } from "./managed-windows-job.mts";

const name = process.argv[2];
const send = (message: object) => process.send?.({ job: name, ...message });
const fail = (error: unknown, type = "error") => {
  process.exitCode = 1;
  if (process.connected) {
    process.send?.(
      {
        job: name,
        type,
        error: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === "object" && "code" in error ? { code: error.code } : {}),
      },
      () => process.disconnect?.(),
    );
  }
};

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    if (!name || !process.connected) {
      throw new Error("Windows command Job handoff is missing");
    }
    const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
    const api = createWindowsJobBindings(koffi);
    api.assertLayouts();
    const job = api.requireHandle(api.OpenJobObjectW(1, 0, name), "OpenJobObjectW(tooling)");
    const assigned = api.AssignProcessToJobObject(job, api.GetCurrentProcess());
    const assignmentError = assigned
      ? undefined
      : api.lastError("AssignProcessToJobObject(tooling launcher)");
    // The host is the sole handle owner; host death terminates this whole Job.
    const closed = api.CloseHandle(job);
    if (assignmentError) {
      throw assignmentError;
    }
    if (!closed) {
      throw api.lastError("CloseHandle(launcher Job copy)");
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
          process.send?.({ job: name, type: "spawned", pid: child.pid }, (error) => {
            if (error) {
              fail(error);
            } else if (!launch.stdio.includes("ipc")) {
              process.disconnect?.();
            }
          });
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
    send({ type: "ready" });
  } catch (error) {
    fail(error, "job-error");
  }
}
