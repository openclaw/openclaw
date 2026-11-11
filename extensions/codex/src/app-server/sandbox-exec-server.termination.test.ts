import { ChildProcess } from "node:child_process";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { withMockedWindowsPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionExecServer } from "./sandbox-exec-server-session.test-support.js";
import { createSandboxChild, createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = spawnMock(...args);
      void Promise.resolve().then(() => child.emit("spawn"));
      return child;
    },
  };
});

useIsolatedStateGuard();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

function createFixture(code = 7, signal: NodeJS.Signals | null = null) {
  vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const child = createSandboxChild(false);
  spawnMock.mockReturnValue(child);
  const cleanupEntered = createDeferred<void>();
  const releaseCleanup = createDeferred<void>();
  const releaseFinalize = createDeferred<void>();
  const runShellCommand = vi.fn(async () => {
    cleanupEntered.resolve();
    await releaseCleanup.promise;
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  const finalizeExec = vi.fn(async () => await releaseFinalize.promise);
  const sandbox = createSandboxContext({ runShellCommand, finalizeExec });
  const send = vi.fn();
  const session = new CodexSandboxExecSession(createSessionExecServer(sandbox), {
    send,
    isOpen: () => true,
  });
  const taskkill = new ChildProcess();
  let cleanup: Promise<void> | undefined;
  let completed = false;
  return {
    kill,
    taskkill,
    child,
    cleanupEntered,
    releaseCleanup,
    runShellCommand,
    finalizeExec,
    send,
    get completed() {
      return completed;
    },
    close: (pending = session.close()) => {
      cleanup = pending.then(() => {
        completed = true;
      });
    },
    terminate: () =>
      session.handleRequest({
        id: 2,
        method: "process/terminate",
        params: { processId: "termination" },
      }),
    async releaseRemoteCleanup() {
      await cleanupEntered.promise;
      releaseCleanup.resolve();
    },
    async finish() {
      await vi.advanceTimersByTimeAsync(0);
      expect(finalizeExec).toHaveBeenCalledOnce();
      expect(completed).toBe(false);
      releaseFinalize.resolve();
      await cleanup;
    },
    async [Symbol.asyncDispose]() {
      releaseCleanup.resolve();
      releaseFinalize.resolve();
      child.emit("close", code, signal);
      taskkill.emit("close", 0);
      await Promise.allSettled([cleanup, session.close()]);
    },
    start: () =>
      session.handleRequest({
        id: 1,
        method: "process/start",
        params: { processId: "termination", argv: ["ignored"], cwd: "file:///workspace" },
      }),
  };
}

it.skipIf(process.platform === "win32").each([
  ["before-request", []],
  ["remote-cleanup", []],
  ["term-grace", ["SIGTERM"]],
  ["force-kill", ["SIGTERM", "SIGKILL"]],
] as const)(
  "bounds local signals across child exit and escalation (%s)",
  async (exitAt, expectedSignals) => {
    const force = exitAt === "force-kill";
    const code = force ? 1 : 7;
    const signal = force ? "SIGKILL" : null;
    await using fixture = createFixture(code, signal);
    // Keep the real process-tree helper: its detached escalation used to outlive the owner.
    const { kill, child, finalizeExec, send } = fixture;
    const exit = () => {
      child.emit("exit", 7, null);
    };
    await fixture.start();
    if (exitAt === "before-request") {
      exit();
      await Promise.resolve();
    }
    fixture.close(force ? undefined : fixture.terminate());
    await fixture.cleanupEntered.promise;
    if (exitAt === "remote-cleanup") {
      exit();
    }
    fixture.releaseCleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (exitAt === "term-grace") {
      expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGTERM");
      exit();
    }
    if (force) {
      await vi.advanceTimersByTimeAsync(999);
      expect(kill).toHaveBeenCalledExactlyOnceWith(-child.pid, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1);
    } else {
      await vi.advanceTimersByTimeAsync(1_001);
    }
    const signals = expectedSignals.map((expectedSignal) => [-child.pid, expectedSignal]);
    expect(kill.mock.calls).toEqual(signals);
    expect(fixture.completed).toBe(false);
    expect(finalizeExec).not.toHaveBeenCalled();
    child.stdout.write("LATE_OUTPUT");
    child.emit("close", code, signal);
    await fixture.finish();
    expect(fixture.runShellCommand).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      method: "process/output",
      params: expect.objectContaining({ chunk: Buffer.from("LATE_OUTPUT").toString("base64") }),
    });
    if (!force) {
      expect(send).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id: 2,
        result: { running: exitAt !== "before-request" },
      });
    }
    await vi.advanceTimersByTimeAsync(1_001);
    expect(kill.mock.calls).toEqual(signals);
  },
);

it("joins an admitted Windows taskkill after child close before releasing the backend", async () => {
  await withMockedWindowsPlatform(async () => {
    await using fixture = createFixture(143, "SIGTERM");
    const { taskkill, child, finalizeExec } = fixture;
    spawnMock.mockImplementation((command) => (command === "taskkill" ? taskkill : child));
    await fixture.start();
    fixture.close();
    await fixture.releaseRemoteCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnMock).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/PID", String(child.pid)],
      expect.any(Object),
    );
    child.emit("close", 143, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeExec).not.toHaveBeenCalled();
    expect(fixture.completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(spawnMock.mock.calls.filter(([command]) => command === "taskkill")).toHaveLength(1);
    taskkill.emit("close", 0);
    await fixture.finish();
  });
});
