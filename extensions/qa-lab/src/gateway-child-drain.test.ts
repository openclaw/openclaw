import { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackPromiseFulfillment as tracked } from "../../test-support/async-gate.test-support.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";

const teardown = vi.hoisted(() => ({
  stopTree: vi.fn<() => Promise<void>>(),
  preserve: vi.fn<() => Promise<void>>(),
  remove: vi.fn<() => Promise<void>>(),
}));
vi.mock("./gateway-child-process.js", async (original) => ({
  ...(await original<typeof import("./gateway-child-process.js")>()),
  stopQaGatewayChildProcessTree: teardown.stopTree,
}));
vi.mock("./gateway-child-artifacts.js", () => ({
  preserveQaGatewayDebugArtifacts: teardown.preserve,
  cleanupQaGatewayTempRoots: teardown.remove,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_QA_KEEP_TEMP", undefined);
  teardown.stopTree.mockReset().mockResolvedValue(undefined);
  teardown.preserve.mockReset().mockResolvedValue(undefined);
  teardown.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  const timers = vi.getTimerCount();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  expect(timers).toBe(0);
});

function fixture() {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  Object.defineProperties(child, {
    pid: { value: 42, configurable: true },
    stdout: { value: stdout, configurable: true },
  });
  const log = new PassThrough();
  const output: Buffer[] = [];
  log.on("data", (chunk: Buffer) => output.push(chunk));
  stdout.on("data", (chunk: Buffer) => log.write(chunk));
  const lifetime = new QaGatewayChildLifecycle();
  lifetime.register(child, null);
  lifetime.tempRoot = "/fixture/qa-gateway";
  // The fixture uses an in-memory sink with the same writable close boundary.
  lifetime.logStreams.push(["stdout", log as unknown as WriteStream]);
  return {
    child,
    lifetime,
    log,
    output: () => Buffer.concat(output).toString(),
    close() {
      if (child.exitCode === null && child.signalCode === null) {
        Object.defineProperty(child, "exitCode", { value: 0 });
        child.emit("exit", 0, null);
      }
      stdout.end();
      child.emit("close", 0, null);
    },
  };
}

const stoppedResult = { process: "confirmed-stopped", errors: [] };
async function beforeClose(
  f: ReturnType<typeof fixture>,
  pending: Promise<unknown>,
  inspect: () => Promise<void>,
) {
  try {
    await inspect();
  } finally {
    f.close();
    await pending;
    await f.lifetime.stop();
  }
}

describe("QA Gateway owned child drain", () => {
  it.each([false, true])(
    "drains buffered output before finalizing (already exited: %s)",
    async (exited) => {
      const f = fixture();
      if (exited) {
        Object.defineProperty(f.child, "exitCode", { value: 0 });
        f.child.emit("exit", 0, null);
      }
      let archived = "";
      teardown.preserve.mockImplementation(async () => {
        archived = f.output();
      });
      const stopping = tracked(f.lifetime.stop({ preserveToDir: "/fixture/proof" }));
      await beforeClose(f, stopping.promise, async () => {
        await vi.advanceTimersByTimeAsync(0);
        expect(stopping.settled).toBe(false);
        expect(f.log.writableEnded).toBe(false);
        expect(teardown.remove).not.toHaveBeenCalled();
        f.child.stdout?.emit("data", Buffer.from("QA_FINAL_BUFFERED_TAIL\n"));
      });
      f.log.destroy();
      expect(archived).toBe("QA_FINAL_BUFFERED_TAIL\n");
      expect(teardown.stopTree).toHaveBeenCalledOnce();
      expect(teardown.remove).toHaveBeenCalledOnce();
    },
  );

  it("remembers close that arrives before a stop request", async () => {
    const f = fixture();
    f.close();
    await expect(f.lifetime.stop()).resolves.toEqual(stoppedResult);
  });

  it("waits for a failed spawn's close without requiring an exit event", async () => {
    const child = new ChildProcess();
    child.on("error", () => {});
    const lifetime = new QaGatewayChildLifecycle();
    lifetime.register(child, null);
    child.emit("error", new Error("synthetic spawn failure"));
    const stopping = tracked(lifetime.stop());
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopping.settled).toBe(false);
    } finally {
      child.emit("close", -1, null);
      await stopping.promise;
    }
    expect(await stopping.promise).toEqual({ process: "never-spawned", errors: [] });
  });

  it.each(["drain timeout", "group shutdown failure"])(
    "retains logs and state after %s",
    async (reason) => {
      const f = fixture();
      const failure = new Error("synthetic process group still alive");
      const timeout = reason === "drain timeout";
      if (!timeout) {
        teardown.stopTree.mockRejectedValue(failure);
      }
      const stopping = tracked(f.lifetime.stop());
      try {
        if (timeout) {
          await vi.advanceTimersByTimeAsync(999);
          expect(stopping.settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
        }
        await expect(stopping.promise).resolves.toEqual({
          process: "unconfirmed",
          errors: [
            timeout
              ? expect.objectContaining({
                  message: "qa gateway child stdio did not close after process-tree shutdown",
                })
              : failure,
          ],
        });
        expect(f.log.writableEnded).toBe(false);
        expect(teardown.remove).not.toHaveBeenCalled();
      } finally {
        teardown.stopTree.mockResolvedValue(undefined);
        f.close();
        await stopping.promise;
        await f.lifetime.stop();
      }
      expect(teardown.remove).toHaveBeenCalledOnce();
    },
  );
});
