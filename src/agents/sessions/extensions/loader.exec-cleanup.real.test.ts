import "../../../test-utils/prepare-compiled-subprocesses.js";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { isChildProcessTreeAlive } from "../../../process/child-process-tree.js";
import { hasCommandProcessCleanupError } from "../../../process/exec-result.js";
import { createCommandTerminationController } from "../../../process/exec-termination.js";
import * as commands from "../../../process/exec.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createEventBus } from "../event-bus.js";
import type { ExecResult } from "../exec.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "./loader.js";

const spawnCommand = commands.spawnCommand;
const nativeKill = process.kill.bind(process);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.skipIf(process.platform !== "linux").for([false, true])(
  "extension exec preserves real cleanup classification with denied forced stop=%s",
  async (denyStop, { signal }) => {
    const ready = createDeferredCore<{ rootPid: number; descendantPid: number }>();
    const forcedStop = createDeferredCore();
    let child: ChildProcess | undefined;
    let apiResult: ExecResult | undefined;
    let denied = 0;
    vi.spyOn(commands, "spawnCommand").mockImplementation((argv, options) => {
      const spawned = spawnCommand(argv, options);
      child = spawned.nodeChildProcess;
      let output = "";
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString("utf8");
        const match = output.match(/NATIVE_EXEC_READY:(\d+)\n/);
        if (match && child?.pid) {
          ready.resolve({ rootPid: child.pid, descendantPid: Number(match[1]) });
        }
      });
      return spawned;
    });
    const descendant =
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);';
    const source = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "pipe", "ignore"] });`,
      'child.stdout.once("data", () => process.stdout.write("NATIVE_EXEC_READY:" + child.pid + "\\n"));',
      'process.on("SIGTERM", () => process.exit(0));',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const controller = new AbortController();
    const loading = loadExtensionFromFactory(
      async (api) => {
        apiResult = await api.exec(process.execPath, ["-e", source], { signal: controller.signal });
      },
      process.cwd(),
      createEventBus(),
      createExtensionRuntime(),
    );
    const outcome = loading.then(
      () => ({ ok: true as const, result: apiResult }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let observed: Awaited<typeof outcome> | undefined;
    try {
      const identity = await withinTest(ready.promise, signal);
      const command = expectDefined(child, "real command child");
      expect(nativeKill(identity.descendantPid, 0)).toBe(true);
      expect(isChildProcessTreeAlive(command)).toBe(true);
      vi.spyOn(process, "kill").mockImplementation((pid, requestedSignal) => {
        if (pid === -identity.rootPid && requestedSignal === "SIGKILL") {
          forcedStop.resolve();
          if (denyStop) {
            denied++;
            throw Object.assign(new Error("fixture denies exact owned-group forced stop"), {
              code: "EPERM",
            });
          }
        }
        return nativeKill(pid, requestedSignal);
      });
      const exited = once(command, "exit");
      vi.useFakeTimers({ toFake: ["Date"] });
      controller.abort();
      await withinTest(exited, signal);
      vi.setSystemTime(Date.now() + 5_000);
      await withinTest(forcedStop.promise, signal);
      vi.setSystemTime(Date.now() + 300);
      observed = await withinTest(outcome, signal);
      expect(denied).toBe(denyStop ? 1 : 0);
      if (denyStop) {
        expect(nativeKill(identity.descendantPid, 0)).toBe(true);
      }
      expect(isChildProcessTreeAlive(command)).toBe(denyStop);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      if (child?.pid) {
        const cleanup = createCommandTerminationController({
          child,
          cancelController: new AbortController(),
          processTree: { mode: "force" },
          killGraceMs: 0,
          isChildExited: () => child?.exitCode != null || child?.signalCode != null,
          isCommandSettled: () => true,
        });
        cleanup.terminate();
        expect(await cleanup.settle()).not.toBe("uncertain");
        expect(isChildProcessTreeAlive(child)).toBe(false);
      }
      await withinTest(outcome, signal);
    }
    if (denyStop) {
      expect(observed).toMatchObject({
        ok: false,
        error: {
          code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
          cause: {
            stdout: expect.stringContaining("NATIVE_EXEC_READY:"),
            stderr: "",
            code: 0,
            killed: true,
          },
        },
      });
      if (observed && !observed.ok) {
        expect(hasCommandProcessCleanupError(observed.error)).toBe(true);
      }
    } else {
      expect(observed).toMatchObject({
        ok: true,
        result: {
          stdout: expect.stringContaining("NATIVE_EXEC_READY:"),
          stderr: "",
          code: 0,
          killed: true,
        },
      });
    }
  },
);
