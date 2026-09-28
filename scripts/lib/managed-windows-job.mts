import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createWindowsJobBindings } from "../../src/process/supervisor/service-child-windows-job-native.ts";
import { createDeferredCore, type Deferred } from "../../src/shared/deferred.ts";
import { resolveManagedWindowsJobEntrypointUrl } from "./managed-windows-job-entrypoint.mts";

export type WindowsJobSetupFailureReason =
  | "job-create-failed"
  | "job-configuration-failed"
  | "job-admission-failed";

export class WindowsJobSetupError extends Error {
  readonly reason: WindowsJobSetupFailureReason;

  constructor(reason: WindowsJobSetupFailureReason, cause: unknown) {
    super(reason, { cause });
    this.reason = reason;
  }
}

export type WindowsJobExtinction =
  | { status: "confirmed" }
  | { status: "uncertain"; reason: "job-unavailable" }
  | {
      status: "uncertain";
      reason: WindowsJobSetupFailureReason;
      cause: unknown;
    }
  | { status: "uncertain"; reason: "job-observation-failed"; cause: Error };

export type ManagedWindowsJob = {
  inspect: () => number[];
  beginStop: () => void;
  stop: () => void;
  close: () => void;
  readonly admission: Promise<void>;
  readonly ready: Promise<void>;
  readonly commandPid: number | undefined;
  isControlMessage: (message: unknown) => boolean;
  certify: () => Promise<WindowsJobExtinction>;
};

export type WindowsJobLaunch = {
  command: string;
  args: string[];
  options: Omit<SpawnOptions, "stdio" | "signal">;
  stdio: Array<number | "ignore" | "ipc">;
};

let native: ReturnType<typeof createWindowsJobBindings> | undefined;
function bindings() {
  if (!native) {
    const require = createRequire(import.meta.url);
    const koffi: typeof import("koffi").default = require("koffi");
    const candidate = createWindowsJobBindings(koffi);
    candidate.assertLayouts();
    native = candidate;
  }
  return native;
}

/** One retained kernel Job owns the launcher and every command descendant. */
export function spawnWindowsJobChild(
  command: string,
  args: string[],
  options: SpawnOptions,
  admitCommand?: (launch: () => void) => void | Promise<void>,
): { child: ChildProcess; job: ManagedWindowsJob } | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  const launcher = resolveManagedWindowsJobEntrypointUrl();
  if (!existsSync(launcher)) {
    return undefined;
  }
  let api: ReturnType<typeof bindings>;
  try {
    api = bindings();
  } catch {
    // Portable archives and installations without the native module still spawn normally.
    return undefined;
  }
  const configuredStdio = options.stdio;
  const stdio: Exclude<StdioOptions, string> = Array.isArray(configuredStdio)
    ? [...configuredStdio]
    : Array.from({ length: 3 }, () => configuredStdio ?? "pipe");
  while (stdio.length < 3) {
    stdio.push("pipe");
  }
  const name = `Local\\OpenClawTooling-${randomUUID()}`;
  let handle: ReturnType<typeof api.requireHandle>;
  try {
    handle = api.requireHandle(api.CreateJobObjectW(null, name), "CreateJobObjectW(tooling)");
  } catch (error) {
    throw new WindowsJobSetupError("job-create-failed", error);
  }
  const admission = createDeferredCore();
  void admission.promise.catch(() => {});
  const ready = createDeferredCore();
  void ready.promise.catch(() => {});
  let child: ChildProcess | undefined;
  let admitted = false;
  let exited = false;
  let stopped = false;
  let closed = false;
  let commandPid: number | undefined;
  let stopDeadline: number | undefined;
  let certification: Deferred<WindowsJobExtinction> | undefined;
  let extinctionSettled = false;
  let observationTimer: NodeJS.Timeout | undefined;
  const job: ManagedWindowsJob = {
    admission: admission.promise,
    ready: ready.promise,
    get commandPid() {
      return commandPid;
    },
    isControlMessage: (message) =>
      Boolean(message && typeof message === "object" && "job" in message && message.job === name),
    beginStop: () => {
      stopped = true;
    },
    inspect: () => {
      if (closed) {
        throw new Error("Windows command Job is closed");
      }
      return api.readJobProcessIds(handle);
    },
    stop: () => {
      stopped = true;
      stopDeadline ??= performance.now() + 4_000;
      try {
        if (closed) {
          return;
        }
        if (!api.TerminateJobObject(handle, 1)) {
          throw api.lastError("TerminateJobObject(tooling)");
        }
        // The helper may still be starting outside the Job, but has not received user code.
        if (!admitted) {
          child?.kill("SIGKILL");
        }
      } finally {
        observeExtinction();
      }
    },
    close: () => {
      stopped = true;
      if (!closed) {
        if (!api.CloseHandle(handle)) {
          throw api.lastError("CloseHandle(tooling Job)");
        }
        closed = true;
      }
    },
    certify: () => {
      if (!certification) {
        certification = createDeferredCore<WindowsJobExtinction>();
        observeExtinction();
      }
      return certification.promise;
    },
  };
  function observeExtinction(): void {
    if (!certification || extinctionSettled) {
      return;
    }
    clearTimeout(observationTimer);
    let outcome: WindowsJobExtinction;
    try {
      // An empty Job before launcher admission is not proof of completed ownership.
      if (!exited || job.inspect().length !== 0) {
        if (stopDeadline !== undefined && performance.now() >= stopDeadline) {
          throw new Error("Windows Job descendant extinction deadline expired");
        }
        // Exit/close wake the observer immediately; only surviving members or cancellation poll.
        if (exited || stopDeadline !== undefined) {
          observationTimer = setTimeout(observeExtinction, 25);
        }
        return;
      }
      job.close();
      outcome = { status: "confirmed" };
    } catch (error) {
      try {
        job.close();
      } catch {
        // Preserve the observation failure; never certify a failed native close.
      }
      outcome = {
        status: "uncertain",
        reason: "job-observation-failed",
        cause: error instanceof Error ? error : new Error(String(error)),
      };
    }
    extinctionSettled = true;
    certification.resolve(outcome);
  }
  try {
    try {
      if (!api.SetExtendedLimits(handle, 9, api.extendedLimits, api.extendedLimitsSize)) {
        throw api.lastError("SetInformationJobObject(tooling)");
      }
    } catch (error) {
      throw new WindowsJobSetupError("job-configuration-failed", error);
    }
    const { stdio: _stdio, signal: _signal, ...commandOptions } = options;
    // Match spawn's synchronous input snapshot across the asynchronous Job admission.
    const commandEnv = { ...(options.env ?? process.env) };
    const launch: WindowsJobLaunch = {
      command,
      args: [...args],
      options: {
        ...commandOptions,
        cwd: options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd,
        env: commandEnv,
      },
      stdio: stdio.map((entry, fd) => (entry === "ipc" || entry === "ignore" ? entry : fd)),
    };
    if (!stdio.includes("ipc")) {
      stdio.push("ipc");
    }
    const launched = spawn(process.execPath, [fileURLToPath(launcher), name], {
      cwd: launch.options.cwd,
      // Windows environment keys are case-insensitive. Preloads belong inside the Job.
      env: Object.fromEntries(
        Object.entries(commandEnv).filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS"),
      ),
      stdio,
      windowsHide: options.windowsHide,
      signal: options.signal,
    });
    child = launched;
    const fail = (error: Error) => {
      admission.reject(error);
      ready.reject(error);
      try {
        job.stop();
      } catch {
        // Certification retains the deadline and reports native cleanup failure as uncertainty.
      }
    };
    launched.on("error", fail);
    launched.once("exit", () => {
      exited = true;
      observeExtinction();
      const error = new Error("Windows Job launcher exited before command startup");
      admission.reject(new WindowsJobSetupError("job-admission-failed", error));
      ready.reject(error);
    });
    launched.once("close", () => {
      exited = true;
      observeExtinction();
      const error = new Error("Windows Job launcher closed before command startup");
      admission.reject(new WindowsJobSetupError("job-admission-failed", error));
      ready.reject(error);
    });
    launched.on("message", (message: unknown) => {
      if (!job.isControlMessage(message)) {
        return;
      }
      // SAFETY: only our launcher writes control messages carrying this private Job token.
      const control = message as { type: string; pid: number; error: string; code?: string };
      if (control.type === "ready" && !admitted && !stopped) {
        try {
          admission.resolve();
          const launchCommand = () => {
            if (!stopped) {
              admitted = true;
              launched.send(launch, (error) => error && launched.emit("error", error));
            }
          };
          if (admitCommand) {
            void admitCommand(launchCommand)?.catch((error: unknown) =>
              launched.emit("error", error),
            );
          } else {
            launchCommand();
          }
        } catch (error) {
          launched.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      } else if (control.type === "spawned") {
        commandPid = control.pid;
        ready.resolve();
      } else if (control.type === "job-error" && !admitted) {
        launched.emit(
          "error",
          new WindowsJobSetupError("job-admission-failed", new Error(control.error)),
        );
      } else if (control.type === "error") {
        launched.emit("error", Object.assign(new Error(control.error), { code: control.code }));
      }
    });
    return { child: launched, job };
  } catch (error) {
    try {
      job.close();
    } catch {
      // Preserve the setup failure so optional containment cannot block the command.
    }
    throw error;
  }
}
