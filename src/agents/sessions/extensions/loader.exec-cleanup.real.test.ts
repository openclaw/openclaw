import "../../../test-utils/prepare-compiled-subprocesses.js";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { isChildProcessTreeAlive } from "../../../process/child-process-tree.js";
import { hasCommandProcessCleanupError } from "../../../process/exec-result.js";
import { COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS } from "../../../process/exec-spawn.js";
import { createCommandTerminationController } from "../../../process/exec-termination.js";
import * as commands from "../../../process/exec.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createEventBus } from "../event-bus.js";
import type { ExecResult } from "../exec.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "./loader.js";

const nativeKill = process.kill.bind(process);

test.skipIf(process.platform !== "linux").for([false, true])(
  "extension exec preserves real cleanup classification with denied forced stop=%s",
  async (denyStop, { signal }) => {
    const forcedStop = createDeferredCore();
    let apiResult: ExecResult | undefined;
    let denied = 0;
    const spawn = vi.spyOn(commands, "spawnCommand");
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
    const outcome = loadExtensionFromFactory(
      async (api) => {
        apiResult = await api.exec(process.execPath, ["-e", source], { signal: controller.signal });
      },
      process.cwd(),
      createEventBus(),
      createExtensionRuntime(),
    ).then(
      () => apiResult,
      (error: unknown) => error,
    );
    const spawned = expectDefined(
      spawn.mock.results.find((call) => call.type === "return"),
      "spawned command",
    );
    const child = spawned.value.nodeChildProcess;
    const lines = createInterface({ input: expectDefined(child.stdout, "command stdout") });
    const ready = once(lines, "line");
    try {
      const [line]: string[] = await withinTest(ready, signal);
      const descendantPid = Number(
        expectDefined(line?.match(/^NATIVE_EXEC_READY:(\d+)$/), "ready descendant PID")[1],
      );
      const rootPid = expectDefined(child.pid, "command PID");
      expect(nativeKill(descendantPid, 0)).toBe(true);
      expect(isChildProcessTreeAlive(child)).toBe(true);
      vi.spyOn(process, "kill").mockImplementation((pid, requestedSignal) => {
        if (pid === -rootPid && requestedSignal === "SIGKILL") {
          forcedStop.resolve();
          if (denyStop) {
            denied++;
            throw Object.assign(new Error("fixture denies forced stop"), { code: "EPERM" });
          }
        }
        return nativeKill(pid, requestedSignal);
      });
      const exited = once(child, "exit");
      vi.useFakeTimers({ toFake: ["Date"] });
      controller.abort();
      await withinTest(exited, signal);
      vi.setSystemTime(Date.now() + 5_000);
      await withinTest(forcedStop.promise, signal);
      vi.setSystemTime(Date.now() + COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS);
      const observed = await withinTest(outcome, signal);
      expect(denied).toBe(denyStop ? 1 : 0);
      if (denyStop) {
        expect(nativeKill(descendantPid, 0)).toBe(true);
      }
      expect(isChildProcessTreeAlive(child)).toBe(denyStop);
      const result = {
        stdout: expect.stringContaining("NATIVE_EXEC_READY:"),
        stderr: "",
        code: 0,
        killed: true,
      };
      expect(observed).toMatchObject(
        denyStop ? { code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN", cause: result } : result,
      );
      expect(hasCommandProcessCleanupError(observed)).toBe(denyStop);
    } finally {
      lines.close();
      vi.restoreAllMocks();
      vi.useRealTimers();
      const cleanup = createCommandTerminationController({
        child,
        cancelController: new AbortController(),
        processTree: { mode: "force" },
        killGraceMs: 0,
        isChildExited: () => child.exitCode != null || child.signalCode != null,
        isCommandSettled: () => true,
      });
      cleanup.terminate();
      expect(await cleanup.settle()).not.toBe("uncertain");
      expect(isChildProcessTreeAlive(child)).toBe(false);
      await withinTest(outcome, signal);
    }
  },
);
