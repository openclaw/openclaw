import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { hasUnjoinedWork, type RunManagedCommandOptions } from "./managed-child-process.mts";
import { resolveManagedMemoryEntrypointUrl } from "./managed-memory-entrypoint.mts";

/** systemd owns the cgroup; the managed child owner still owns signals and output. */
export async function runLinuxMemoryCommand(
  options: RunManagedCommandOptions,
  run: (options: RunManagedCommandOptions) => Promise<number>,
) {
  const {
    memoryLimitBytes,
    memoryScope: unit = "openclaw-check-" + randomUUID() + ".scope",
    ...command
  } = options;
  if (!/^openclaw-check-[a-f0-9-]+\.scope$/u.test(unit)) {
    throw new Error("Invalid managed memory scope");
  }
  options.signal?.throwIfAborted();
  const control = (args: string[]) =>
    spawnSync("systemctl", ["--user", ...args, unit], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  // Qualification precedes creation: unavailable backends must not strand admission.
  const initial = control(["show", "--property=LoadState"]);
  if (initial.error || !initial.stdout?.includes("LoadState=not-found")) {
    throw new Error(
      "[memory] A cgroup-v2 systemd user manager is required. Use a bounded Crabbox worker.",
    );
  }
  const env = { ...(options.env ?? process.env) };
  // The trusted launcher verifies kernel limits before restoring workload preloads.
  env.OPENCLAW_MANAGED_NODE_OPTIONS = env.NODE_OPTIONS ?? "";
  delete env.NODE_OPTIONS;
  const cleanupScope = async (failure: unknown) => {
    // Inner cleanup has finished its grace period. A stop-client timeout does not
    // escalate systemd's longer stop timer, so kill any remaining owned descendants.
    control(["kill", "--kill-whom=all", "--signal=SIGKILL"]);
    control(["stop"]);
    const deadline = Date.now() + 5_000;
    let empty: boolean;
    do {
      const state = control([
        "show",
        "--property=LoadState",
        "--property=ActiveState",
        "--property=ControlGroup",
      ]);
      const fields = Object.fromEntries(
        (state.stdout ?? "")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      empty = !state.error && fields.LoadState === "not-found";
      if (!state.error && fields.ControlGroup?.endsWith("/" + unit)) {
        try {
          empty = /^populated 0$/mu.test(
            fs.readFileSync(
              path.join("/sys/fs/cgroup", fields.ControlGroup, "cgroup.events"),
              "utf8",
            ),
          );
        } catch (error) {
          empty = Boolean(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT" &&
            fields.ActiveState === "inactive",
          );
        }
      }
      if (empty) {
        break;
      }
      await delay(50);
    } while (Date.now() < deadline);
    // A failed scope can still contain descendants after a SIGKILL timeout.
    // Only kernel extinction or manager-confirmed removal releases admission.
    if (!empty) {
      throw Object.assign(
        new Error("Memory scope cleanup could not be verified: " + unit, { cause: failure }),
        {
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "indeterminate",
        },
      );
    }
    if (hasUnjoinedWork(failure)) {
      // The cgroup includes detached descendants that escaped the inner process group.
      // Preserve failure, but replace its superseded cleanup receipt after extinction.
      throw Object.assign(new Error(failure instanceof Error ? failure.message : String(failure)), {
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState: "terminated",
      });
    }
  };
  let failure: unknown;
  try {
    return await run({
      ...command,
      bin: "systemd-run",
      shell: false,
      env,
      args: [
        "--user",
        "--scope",
        "--collect",
        "--quiet",
        "--expand-environment=no",
        "--unit=" + unit,
        "--property=MemoryMax=" + memoryLimitBytes,
        "--property=MemorySwapMax=0",
        "--property=OOMPolicy=kill",
        "--",
        process.execPath,
        fileURLToPath(resolveManagedMemoryEntrypointUrl()),
        String(memoryLimitBytes),
        unit,
        String(options.shell ?? false),
        options.bin,
        ...(options.args ?? []),
      ],
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupScope(failure);
  }
}
