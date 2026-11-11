import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import { openWarmImageStore } from "./crabbox-state.test-support.js";
import { stopCrabboxLease, type CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { CRABBOX_STOP_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import {
  checkpointResult,
  createWarmProvider,
  LEASE_ID,
  PROFILE,
  provisionWarmProfile,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

// Only the parent clock is virtual: the real SDK owns a child that exits when released.
// Poll inside the child: filesystem notifications can miss the atomic release rename.
const HELD_STOP = `
  const fs = require("node:fs");
  const marker = process.argv[1];
  const watcher = setInterval(() => {
    if (fs.existsSync(marker)) {
      clearInterval(watcher);
      process.exit(Number(fs.readFileSync(marker, "utf8")));
    }
  }, 10);
  process.stdout.write("ready");
`;

const azureStop = { binary: "crabbox", id: LEASE_ID, provider: "azure", warn: vi.fn() };
const azureStopArgs = ["crabbox", "stop", "--provider", "azure", "--id", LEASE_ID];

it.each(["capture", "stop", "retirement"] as const)(
  "interrupts destroy during %s after child settlement and preserves restart cleanup",
  async (phase) => {
    const marker = path.join(tempDirs.make("openclaw-crabbox-interrupt-"), "release");
    const started = createDeferred<void>();
    const controller = new AbortController();
    const interrupted = new Error("Worker reconciliation interrupted by shutdown");
    let commandSignal: AbortSignal | undefined;
    let childResult: SpawnResult | undefined;
    let armed = false;
    let captures = 0;
    const { provider, calls } = createWarmProvider(async ({ argv, options }) => {
      if (phase === "retirement" && argv[1] === "checkpoint" && argv[2] === "create") {
        return checkpointResult(
          `chk_cleanup_${++captures}`,
          argv[argv.indexOf("--id") + 1]!,
          "completed",
        );
      }
      const matches =
        phase === "stop"
          ? argv[1] === "stop"
          : argv[1] === "checkpoint" && argv[2] === (phase === "capture" ? "create" : "delete");
      if (!armed || !matches) {
        return undefined;
      }
      commandSignal = options.signal;
      childResult = await runCommandWithTimeout([process.execPath, "-e", HELD_STOP, marker], {
        ...options,
        onOutputChunk: (chunk, stream) => {
          if (stream === "stdout" && chunk.toString() === "ready") {
            started.resolve();
          }
        },
      });
      return childResult;
    });
    let lease = await provisionWarmProfile(provider);
    if (phase === "retirement") {
      await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
      lease = await provisionWarmProfile(provider, PROFILE, "shutdown-retirement");
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
    }
    const store = openWarmImageStore();
    const owner = store.entries()[0]!;
    armed = true;
    const operation = provider
      .destroy({
        leaseId: lease.leaseId,
        profile: { ...PROFILE, warmImage: phase !== "stop" },
        signal: controller.signal,
      })
      .then(
        () => ({ success: true }),
        (error: unknown) => ({ error }),
      );
    try {
      await Promise.race([
        started.promise,
        operation.then(() => {
          throw new Error("destroy exited before child readiness");
        }),
      ]);
      controller.abort(interrupted);
      expect(commandSignal?.aborted).toBe(true);
      expect(await operation).toEqual({ error: interrupted });
      expect(childResult?.termination).toBe("signal");
      if (phase === "retirement") {
        expect(store.lookup(owner.key)?.allocations[lease.leaseId]).toBeUndefined();
        expect(store.lookup(owner.key)?.operation).toEqual({
          type: "retire",
          checkpointId: "chk_cleanup_1",
        });
        expect(calls.findLastIndex(({ argv }) => argv[2] === "delete")).toBeGreaterThan(
          calls.findLastIndex(({ argv }) => argv[1] === "stop"),
        );
      } else {
        expect(store.lookup(owner.key)?.allocations[lease.leaseId]).toBeDefined();
      }
      if (phase === "capture") {
        expect(store.lookup(owner.key)?.operation).toMatchObject({
          type: "capture",
          phase: "uncertain",
        });
        expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
      }
    } finally {
      fs.writeFileSync(`${marker}.tmp`, "0");
      fs.renameSync(`${marker}.tmp`, marker);
      await operation;
    }
    armed = false;
    if (phase === "retirement") {
      await provider.maintain!({
        profiles: [PROFILE],
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      expect(store.lookup(owner.key)?.operation).toBeUndefined();
    } else {
      await provider.destroy({ leaseId: lease.leaseId, profile: { ...PROFILE, warmImage: false } });
    }
    expect(store.lookup(owner.key)?.allocations[lease.leaseId]).toBeUndefined();
  },
);

it.each(
  [60_000, CRABBOX_STOP_TIMEOUT_MS].flatMap((elapsedMs) =>
    [-90_000, 90_000].map((clockStepMs) => ({ elapsedMs, clockStepMs })),
  ),
)(
  "keeps Azure recovery within the original deadline after $elapsedMs ms and a $clockStepMs ms wall step",
  async ({ elapsedMs, clockStepMs }) => {
    let now = 0;
    let wallStep = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => now + wallStep);
    const runCommand = vi
      .fn<CrabboxCommandRunner>()
      .mockImplementationOnce(async () => {
        now = elapsedMs;
        wallStep = clockStepMs;
        return commandResult({
          code: 4,
          stderr: "Azure fixed lease cannot be adopted without its create intent",
        });
      })
      .mockResolvedValue(commandResult());
    vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(runCommand);
    try {
      const stopped = stopCrabboxLease(azureStop);
      if (elapsedMs < CRABBOX_STOP_TIMEOUT_MS) {
        await expect(stopped).resolves.toBeUndefined();
        expect(runCommand).toHaveBeenCalledTimes(2);
        expect(runCommand.mock.calls[1]?.[1].timeoutMs).toBe(CRABBOX_STOP_TIMEOUT_MS - elapsedMs);
        expect(runCommand.mock.calls[1]?.[0]).toEqual([...azureStopArgs, "--force"]);
      } else {
        await expect(stopped).rejects.toThrow("timed out before Azure fixed-lease recovery");
        expect(runCommand).toHaveBeenCalledOnce();
      }
      expect(runCommand.mock.calls[0]?.[0]).toEqual(azureStopArgs);
      expect(runCommand.mock.calls[0]?.[1].timeoutMs).toBe(CRABBOX_STOP_TIMEOUT_MS);
    } finally {
      wallClock.mockRestore();
      clock.mockRestore();
    }
  },
);

it.each(["destroy", "dispose", "inspection loss"] as const)(
  "retains heartbeat custody through %s and later disposal",
  async (entrance) => {
    vi.useFakeTimers();
    const heartbeatStarted = createDeferred<void>();
    const finishHeartbeat = createDeferred<void>();
    let heartbeatSignal: AbortSignal | undefined;
    let recognized = true;
    const { provider, calls } = createWarmProvider(({ argv, options }) => {
      if (argv[1] === "heartbeat") {
        heartbeatSignal = options.signal;
        heartbeatStarted.resolve();
        // Abort requests termination; the command runner still owns child settlement.
        return finishHeartbeat.promise.then(() => commandResult());
      }
      if (argv[1] === "inspect" && !recognized) {
        return commandResult({ code: 4, stderr: `${LEASE_ID} was not found` });
      }
      return undefined;
    });
    const lease = { leaseId: LEASE_ID, profile: { ...PROFILE, warmImage: false } };
    const operations: Promise<unknown>[] = [];
    let completed = 0;
    const track = (operation: Promise<unknown>) =>
      operations.push(
        operation.finally(() => {
          completed++;
        }),
      );
    const count = (command: string) => calls.filter(({ argv }) => argv[1] === command).length;
    try {
      await provider.inspect(lease);
      await vi.advanceTimersByTimeAsync(0);
      await heartbeatStarted.promise;

      recognized = entrance !== "inspection loss";
      track(
        entrance === "destroy"
          ? provider.destroy(lease)
          : entrance === "dispose"
            ? provider.dispose()
            : provider.inspect(lease),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeatSignal?.aborted).toBe(true);

      recognized = true;
      await provider.inspect(lease);
      await vi.advanceTimersByTimeAsync(0);
      track(provider.dispose());
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(0);
      expect(count("heartbeat")).toBe(1);
      expect(count("stop")).toBe(0);

      finishHeartbeat.resolve();
      await Promise.all(operations);
      expect(count("stop")).toBe(entrance === "destroy" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(count("heartbeat")).toBe(1);
    } finally {
      finishHeartbeat.resolve();
      await Promise.allSettled(operations);
      await provider.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([
  { exitCode: 0, elapsedMs: 6 * 60_000, outcome: "success" },
  { exitCode: 5, elapsedMs: 6 * 60_000, outcome: "failure" },
  { exitCode: 0, elapsedMs: 18 * 60_000, outcome: "timeout" },
])("preserves destroy custody through late $outcome", async ({ exitCode, elapsedMs, outcome }) => {
  const marker = path.join(tempDirs.make("openclaw-crabbox-stop-"), "release");
  const started = createDeferred<void>();
  let childResult: SpawnResult | undefined;
  let armed = false;
  const { provider } = createWarmProvider(async ({ argv, options }) => {
    if (!armed || argv[1] !== "stop") {
      return undefined;
    }
    const result = await runCommandWithTimeout([process.execPath, "-e", HELD_STOP, marker], {
      ...options,
      onOutputChunk: (chunk, stream) => {
        if (stream === "stdout" && chunk.toString() === "ready") {
          started.resolve();
        }
      },
    });
    childResult = result;
    return result;
  });
  await provisionWarmProfile(provider);
  const store = openWarmImageStore();
  const owner = store.entries()[0]!;
  armed = true;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let settled = false;
  const operation = provider
    .destroy({ leaseId: LEASE_ID, profile: { ...PROFILE, warmImage: false } })
    .then(
      () => ({ success: true }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await Promise.race([
      started.promise,
      operation.then(() => {
        throw new Error("stop exited before readiness");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(elapsedMs);
    expect(store.lookup(owner.key)?.allocations[LEASE_ID]).toBeDefined();
    if (outcome !== "timeout") {
      expect(settled).toBe(false);
    }
  } finally {
    fs.writeFileSync(`${marker}.tmp`, String(exitCode));
    fs.renameSync(`${marker}.tmp`, marker);
    // Drain the SDK's process-tree settlement even when the baseline killed the child.
    await vi.advanceTimersByTimeAsync(10_000);
    await operation;
    vi.useRealTimers();
  }
  if (outcome === "success") {
    expect(await operation).toEqual({ success: true });
    expect(childResult).toMatchObject({ termination: "exit", code: 0 });
    expect(store.lookup(owner.key)?.allocations[LEASE_ID]).toBeUndefined();
  } else {
    const message =
      outcome === "failure"
        ? "Crabbox stop failed with exit code 5: ready"
        : "Crabbox stop did not exit normally (timeout): ready";
    expect(await operation).toMatchObject({ error: { message } });
    expect(childResult).toMatchObject(
      outcome === "failure" ? { termination: "exit", code: 5 } : { termination: "timeout" },
    );
    expect(store.lookup(owner.key)?.allocations[LEASE_ID]).toBeDefined();
  }
});
