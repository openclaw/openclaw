import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QA_CHILD_STDERR_TAIL_BYTES, QA_CHILD_STDOUT_MAX_BYTES } from "./child-output.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  resetQaScenarioCommandCleanupTimings,
  runQaScenarioCommandLifecycle,
  setQaScenarioCommandCleanupTimings,
} from "./test-file-scenario-command-lifecycle.js";

type ParentSignal = "SIGINT" | "SIGTERM";
type ParentHandler = (() => void) | ((signal: ParentSignal) => void);

function spyOnProcessKill() {
  return vi.spyOn(process, "kill");
}

function createChild(pid = 42) {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: pid });
  child.stdout = new EventEmitter() as NonNullable<ChildProcess["stdout"]>;
  child.stderr = new EventEmitter() as NonNullable<ChildProcess["stderr"]>;
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  spawnMock.mockReturnValue(child);
  return child;
}

function runCommand(timeoutMs?: number) {
  return runQaScenarioCommandLifecycle({
    command: "/usr/local/bin/scenario-command",
    args: ["--run"],
    cwd: "/tmp/qa",
    env: { OPENCLAW_QA_REF: "test" },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe.skipIf(process.platform === "win32")("qa scenario command lifecycle", () => {
  const parentHandlers = new Map<ParentSignal | "exit", ParentHandler>();
  let processKill: ReturnType<typeof spyOnProcessKill>;

  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      parentHandlers.set(event as ParentSignal | "exit", listener as ParentHandler);
      return process;
    });
    vi.spyOn(process, "removeListener").mockImplementation((event, listener) => {
      if (parentHandlers.get(event as ParentSignal | "exit") === listener) {
        parentHandlers.delete(event as ParentSignal | "exit");
      }
      return process;
    });
    processKill = spyOnProcessKill().mockImplementation((pid, signal) => {
      if (pid === -42 && signal === 0) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });
  });

  afterEach(() => {
    resetQaScenarioCommandCleanupTimings();
    parentHandlers.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the exact close result and removes parent handlers", async () => {
    const child = createChild();
    const resultPromise = runCommand(5_000);

    child.stdout?.emit("data", Buffer.from("out\n"));
    child.stderr?.emit("data", Buffer.from("err\n"));
    child.emit("close", 3, null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 3,
      signal: null,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect(spawnMock).toHaveBeenCalledWith("/usr/local/bin/scenario-command", ["--run"], {
      cwd: "/tmp/qa",
      detached: true,
      env: { OPENCLAW_QA_REF: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(parentHandlers.size).toBe(0);
    expect(processKill).toHaveBeenCalledWith(-42, 0);
    processKill.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processKill).not.toHaveBeenCalled();
  });

  it("preserves spawn rejection without installing lifecycle handlers", async () => {
    const error = new Error("spawn failed");
    spawnMock.mockImplementationOnce(() => {
      throw error;
    });

    await expect(runCommand()).rejects.toBe(error);
    expect(parentHandlers.size).toBe(0);
  });

  it.each(["stdout", "stderr"] as const)(
    "stops the process group and reports a %s pipe failure once",
    async (streamName) => {
      const child = createChild();
      const resultPromise = runCommand(5_000);
      const message = `synthetic ${streamName} read failure`;

      child[streamName]?.emit("error", new Error(message));
      child.emit("close", 0, null);
      child.emit("close", 0, null);

      await expect(resultPromise).resolves.toEqual({
        exitCode: 1,
        failureMessage: `scenario-command ${streamName} stream failed: ${message}`,
        signal: null,
        stdout: "",
        stderr: "",
      });
      expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
      expect(parentHandlers.size).toBe(0);
      processKill.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(processKill).not.toHaveBeenCalled();
    },
  );

  it("bounds stdout and keeps close from replacing the overflow failure", async () => {
    const child = createChild();
    const resultPromise = runCommand(5_000);

    child.stdout?.emit("data", Buffer.alloc(QA_CHILD_STDOUT_MAX_BYTES + 1, "x"));
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result).toMatchObject({
      exitCode: 1,
      failureMessage: `scenario-command stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes`,
      signal: null,
    });
    expect(Buffer.byteLength(result.stdout)).toBe(QA_CHILD_STDOUT_MAX_BYTES);
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(parentHandlers.size).toBe(0);
  });

  it("retains the stderr tail after overflow", async () => {
    const child = createChild();
    const resultPromise = runCommand(5_000);
    const prefix = "discarded startup output\n";
    const suffix = "\nretained final stack trace";

    child.stderr?.emit(
      "data",
      Buffer.concat([
        Buffer.from(prefix),
        Buffer.alloc(QA_CHILD_STDERR_TAIL_BYTES, "x"),
        Buffer.from(suffix),
      ]),
    );
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result).toMatchObject({
      exitCode: 1,
      failureMessage: `scenario-command stderr exceeded ${QA_CHILD_STDERR_TAIL_BYTES} bytes`,
      signal: null,
    });
    expect(Buffer.byteLength(result.stderr)).toBe(QA_CHILD_STDERR_TAIL_BYTES);
    expect(result.stderr).not.toContain(prefix);
    expect(result.stderr.endsWith(suffix)).toBe(true);
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(parentHandlers.size).toBe(0);
  });

  it("escalates timed-out commands and preserves the timeout result", async () => {
    createChild();
    setQaScenarioCommandCleanupTimings({ killGraceMs: 20, forceSettleMs: 10 });
    let processGroupAlive = true;
    processKill.mockImplementation((pid, signal) => {
      if (pid === -42 && signal === "SIGKILL") {
        processGroupAlive = false;
      }
      if (pid === -42 && signal === 0 && !processGroupAlive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });

    const resultPromise = runCommand(100);
    await vi.advanceTimersByTimeAsync(130);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 1,
      failureMessage: "scenario-command timed out after 100ms",
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(-42, "SIGKILL");
    expect(parentHandlers.size).toBe(0);
  });

  it("forwards parent signals, cleans handlers, and preserves interruption details", async () => {
    createChild();
    setQaScenarioCommandCleanupTimings({ killGraceMs: 20, forceSettleMs: 10 });
    let processGroupAlive = true;
    processKill.mockImplementation((pid, signal) => {
      if (pid === -42 && signal === "SIGKILL") {
        processGroupAlive = false;
      }
      if (pid === -42 && signal === 0 && !processGroupAlive) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });

    const resultPromise = runCommand();
    const signalHandler = parentHandlers.get("SIGTERM") as
      | ((signal: ParentSignal) => void)
      | undefined;
    expect(signalHandler).toBeDefined();
    signalHandler?.("SIGTERM");
    await vi.advanceTimersByTimeAsync(30);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 1,
      failureMessage: "scenario-command interrupted by SIGTERM",
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(processKill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(parentHandlers.size).toBe(0);
  });
});
