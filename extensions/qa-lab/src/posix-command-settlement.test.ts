import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQaPosixCommandSettlement } from "./posix-command-settlement.js";

type Outcome = Parameters<Parameters<typeof createQaPosixCommandSettlement>[0]["onSettled"]>[0];
let processGroupAlive = false;
let processKill: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  processGroupAlive = false;
  processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid !== -42) {
      return true;
    }
    if (signal === 0 && !processGroupAlive) {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    if (signal === "SIGKILL") {
      processGroupAlive = false;
    }
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function start(params: { executionTimeoutMs?: number; forceKillAfterMs?: number } = {}) {
  const child = new EventEmitter() as ChildProcess;
  const childKill = vi.fn(() => true);
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.stdout = stdout as never;
  child.stderr = stderr as never;
  child.kill = childKill as ChildProcess["kill"];
  const settled = vi.fn<(outcome: Outcome) => void>();
  createQaPosixCommandSettlement({
    child,
    settlementFailureMessage: "settlement failed",
    executionTimeoutMs: params.executionTimeoutMs,
    forceKillAfterMs: params.forceKillAfterMs ?? 20,
    onSettled: settled,
    processGroupId: 42,
    verifyAfterMs: 10,
  });
  return {
    child,
    childKill,
    settled,
    readerCalls: () => [stdout.destroy.mock.calls.length, stderr.destroy.mock.calls.length],
  };
}
type Fixture = ReturnType<typeof start>;
function expectOutcome({ settled }: Fixture, primary: Outcome["primary"], failure?: unknown) {
  expect(settled).toHaveBeenCalledWith({
    primary,
    ...(failure ? { settlementFailure: failure } : {}),
  });
}
const drainFailure = expect.objectContaining({ message: "stdio-drain-timeout" });

it.each([
  { code: 7, grace: 20, idle: true },
  { code: 0, grace: 2_000, idle: false },
])("settles exit $code after delayed close (idle: $idle)", async ({ code, grace, idle }) => {
  processGroupAlive = !idle;
  const fixture = start({ forceKillAfterMs: grace });
  const { child, settled } = fixture;
  child.emit("exit", code, null);
  await vi.advanceTimersByTimeAsync(idle ? 90 : 2_100);
  if (idle) {
    child.stdout?.emit("data", Buffer.from("tail"));
    await vi.advanceTimersByTimeAsync(99);
  }
  expect(settled).not.toHaveBeenCalled();
  child.emit("close", code, null);
  expectOutcome(fixture, { type: "exit", exitCode: code, signal: null });
  expect(settled).toHaveBeenCalledOnce();
  expect(fixture.readerCalls()).toEqual([0, 0]);
  expect([child.listenerCount("exit"), child.listenerCount("close")]).toEqual([0, 0]);
  child.emit("close", code, null);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(settled).toHaveBeenCalledOnce();
});

it("caps active output at one second and destroys readers only after cleanup", async () => {
  processGroupAlive = true;
  const fixture = start();
  fixture.child.emit("exit", 0, null);
  for (let index = 0; index < 10; index += 1) {
    await vi.advanceTimersByTimeAsync(90);
    fixture.child.stdout?.emit("data", Buffer.from(String(index)));
  }
  await vi.advanceTimersByTimeAsync(99);
  expect(fixture.readerCalls()).toEqual([0, 0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
  expect(fixture.readerCalls()).toEqual([0, 0]);
  await vi.advanceTimersByTimeAsync(20);
  expect(processKill).toHaveBeenCalledWith(-42, "SIGKILL");
  await vi.advanceTimersByTimeAsync(10);
  expect(fixture.readerCalls()).toEqual([1, 1]);
  expectOutcome(fixture, { type: "exit", exitCode: 0, signal: null }, drainFailure);
});

it("preserves the timeout primary when process-group signaling fails", async () => {
  processGroupAlive = true;
  processKill.mockImplementation((pid: number, signal?: NodeJS.Signals | 0) => {
    if (pid === -42 && signal !== 0) {
      throw Object.assign(new Error("cannot signal group"), { code: "EPERM" });
    }
    return true;
  });
  const fixture = start({ executionTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  fixture.child.emit("exit", 0, null);
  fixture.child.emit("close", 0, null);
  await vi.advanceTimersByTimeAsync(30);
  expect(fixture.settled).toHaveBeenCalledOnce();
  expect(fixture.settled.mock.calls[0]?.[0]).toMatchObject({
    primary: { type: "timeout" },
    settlementFailure: expect.any(Error),
  });
  expect(fixture.childKill).not.toHaveBeenCalled();
});

it("bounds stdio draining when a timeout cleans the group without close", async () => {
  const fixture = start({ executionTimeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(1_099);
  expect(fixture.settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.readerCalls()).toEqual([1, 1]);
  expectOutcome(fixture, { type: "timeout" }, drainFailure);
});

it("preserves a stream failure that follows a successful exit", async () => {
  const fixture = start();
  const streamFailure = new Error("stdout pipe failed");
  fixture.child.emit("exit", 0, null);
  fixture.child.stdout?.emit("error", streamFailure);
  fixture.child.emit("close", 0, null);
  const failure = expect.objectContaining({
    cause: streamFailure,
    message: "stdout stream error: stdout pipe failed",
  });
  expectOutcome(fixture, { type: "exit", exitCode: 0, signal: null }, failure);
});
