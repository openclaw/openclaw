import { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("QA Gateway owned child drain", () => {
  it("preserves buffered output before finalizing logs, artifacts, and state", async () => {
    const f = fixture();
    let archived = "";
    teardown.preserve.mockImplementation(async () => {
      archived = f.output();
    });
    let stopped = false;
    const stopping = f.lifetime.stop({ preserveToDir: "/fixture/proof" }).then((result) => {
      stopped = true;
      return result;
    });
    let beforeClose;
    try {
      await vi.advanceTimersByTimeAsync(0);
      beforeClose = {
        stopped,
        logEnded: f.log.writableEnded,
        removed: teardown.remove.mock.calls.length > 0,
      };
      f.child.stdout?.emit("data", Buffer.from("QA_FINAL_BUFFERED_TAIL\n"));
    } finally {
      f.close();
      await stopping;
      f.log.destroy();
    }
    expect(archived).toBe("QA_FINAL_BUFFERED_TAIL\n");
    expect(beforeClose).toEqual({ stopped: false, logEnded: false, removed: false });
    expect(teardown.stopTree).toHaveBeenCalledOnce();
    expect(teardown.preserve).toHaveBeenCalledOnce();
    expect(teardown.remove).toHaveBeenCalledOnce();
  });

  it("holds the direct stop boundary used before retry and state mutation", async () => {
    const f = fixture();
    let mutationAdmitted = false;
    const stopping = f.lifetime.stopProcess(f.owned).then((result) => {
      mutationAdmitted = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mutationAdmitted).toBe(false);
      expect(f.owned.stopResult).toBeUndefined();
    } finally {
      f.close();
      await stopping;
      await f.lifetime.stop();
    }
    expect(mutationAdmitted).toBe(true);
    expect(f.owned.stopResult).toEqual({ process: "confirmed-stopped", errors: [] });
    expect(teardown.stopTree).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("remembers close that arrives before a stop request", async () => {
    const f = fixture();
    expect(f.child.listenerCount("close")).toBe(1);
    f.close();
    await expect(f.lifetime.stop()).resolves.toEqual({
      process: "confirmed-stopped",
      errors: [],
    });
    expect(f.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for a failed spawn's close without requiring an exit event", async () => {
    const child = new ChildProcess();
    child.on("error", () => {});
    const lifetime = new QaGatewayChildLifecycle();
    lifetime.register(child, null);
    child.emit("error", new Error("synthetic spawn failure"));
    let stopped = false;
    const stopping = lifetime.stop().then((result) => {
      stopped = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
    } finally {
      child.emit("close", -1, null);
      await stopping;
    }
    expect(await stopping).toEqual({ process: "never-spawned", errors: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps reading after exit until the owned child's stdio closes", async () => {
    const f = fixture();
    Object.defineProperty(f.child, "exitCode", { value: 0 });
    f.child.emit("exit", 0, null);
    const stopping = f.lifetime.stop();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.log.writableEnded).toBe(false);
      f.child.stdout?.emit("data", Buffer.from("QA_AFTER_EXIT_TAIL\n"));
    } finally {
      f.close();
      await stopping;
    }
    expect(f.output()).toBe("QA_AFTER_EXIT_TAIL\n");
  });

  it("retains log and state ownership when the existing close bound expires", async () => {
    const f = fixture();
    const stopping = f.lifetime.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await stopping).toEqual({
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
    } finally {
      f.close();
      await stopping;
      await f.lifetime.stop();
    }
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
    let stopped = false;
    const stopping = f.lifetime.stop().then((result) => {
      stopped = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(treeStopped).toBe(true);
      expect(stopped).toBe(false);
    } finally {
      f.close();
      await operation;
      await stopping;
    }
    expect(await stopping).toEqual({ process: "confirmed-stopped", errors: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
