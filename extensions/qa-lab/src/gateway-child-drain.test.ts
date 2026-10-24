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
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function fixture(kind: "gateway" | "cli" = "gateway") {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(child, {
    pid: { value: 42, configurable: true },
    stdout: { value: stdout, configurable: true },
    stderr: { value: stderr, configurable: true },
  });
  const log = new PassThrough();
  const output: Buffer[] = [];
  log.on("data", (chunk: Buffer) => output.push(chunk));
  stdout.on("data", (chunk: Buffer) => log.write(chunk));
  stderr.resume();
  const lifetime = new QaGatewayChildLifecycle();
  const owned = lifetime.register(child, null, kind);
  lifetime.tempRoot = "/fixture/qa-gateway";
  // The fixture uses an in-memory sink with the same writable close boundary.
  lifetime.logStreams.push(["stdout", log as unknown as WriteStream]);
  return {
    child,
    lifetime,
    owned,
    log,
    output: () => Buffer.concat(output).toString(),
    close() {
      if (child.exitCode === null && child.signalCode === null) {
        Object.defineProperty(child, "exitCode", { value: 0 });
        child.emit("exit", 0, null);
      }
      stdout.end();
      stderr.end();
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
      let before;
      await beforeClose(f, stopping.promise, async () => {
        await vi.advanceTimersByTimeAsync(0);
        before = {
          stopped: stopping.settled,
          logEnded: f.log.writableEnded,
          removed: teardown.remove.mock.calls.length > 0,
        };
        f.child.stdout?.emit("data", Buffer.from("QA_FINAL_BUFFERED_TAIL\n"));
      });
      f.log.destroy();
      expect(archived).toBe("QA_FINAL_BUFFERED_TAIL\n");
      expect(before).toEqual({ stopped: false, logEnded: false, removed: false });
      expect(teardown.stopTree).toHaveBeenCalledOnce();
      expect(teardown.preserve).toHaveBeenCalledOnce();
      expect(teardown.remove).toHaveBeenCalledOnce();
    },
  );

  it("holds the direct stop boundary used before retry and state mutation", async () => {
    const f = fixture();
    const stopping = tracked(f.lifetime.stopProcess(f.owned));
    await beforeClose(f, stopping.promise, async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopping.settled).toBe(false);
      expect(f.owned.stopResult).toBeUndefined();
    });
    expect(stopping.settled).toBe(true);
    expect(f.owned.stopResult).toEqual(stoppedResult);
    expect(teardown.stopTree).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("remembers close that arrives before a stop request", async () => {
    const f = fixture();
    expect(f.child.listenerCount("close")).toBe(1);
    f.close();
    await expect(f.lifetime.stop()).resolves.toEqual(stoppedResult);
    expect(f.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains log and state ownership when the existing close bound expires", async () => {
    const f = fixture();
    const stopping = tracked(f.lifetime.stop());
    await beforeClose(f, stopping.promise, async () => {
      await vi.advanceTimersByTimeAsync(999);
      expect(stopping.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await stopping.promise).toEqual({
        process: "unconfirmed",
        errors: [
          expect.objectContaining({
            message: "qa gateway child stdio did not close after process-tree shutdown",
          }),
        ],
      });
      expect(f.log.writableEnded).toBe(false);
      expect(teardown.remove).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
    expect(teardown.stopTree).toHaveBeenCalledTimes(2);
    expect(teardown.remove).toHaveBeenCalledOnce();
  });

  it("does not wait for close or finalize logs after unconfirmed group shutdown", async () => {
    const f = fixture();
    const failure = new Error("synthetic process group still alive");
    teardown.stopTree.mockRejectedValue(failure);
    try {
      await expect(f.lifetime.stop()).resolves.toEqual({
        process: "unconfirmed",
        errors: [failure],
      });
      expect(f.log.writableEnded).toBe(false);
      expect(teardown.remove).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      teardown.stopTree.mockResolvedValue(undefined);
      f.close();
      await f.lifetime.stop();
    }
  });

  it("joins CLI operation completion without making stopProcess await its caller", async () => {
    const f = fixture("cli");
    let treeStopped = false;
    const operation = (async () => {
      await f.lifetime.stopProcess(f.owned);
      treeStopped = true;
      await f.lifetime.waitForClose(f.owned);
      return "QA_CLI_OUTPUT";
    })();
    f.lifetime.completeCli(f.owned, operation);
    const stopping = tracked(f.lifetime.stop());
    await beforeClose(f, stopping.promise, async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(treeStopped).toBe(true);
      expect(stopping.settled).toBe(false);
    });
    await operation;
    expect(await stopping.promise).toEqual(stoppedResult);
    expect(vi.getTimerCount()).toBe(0);
  });
});
