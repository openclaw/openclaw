import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { withMockedWindowsPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type { OpenClawExecServer } from "./sandbox-exec-server/types.js";

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

function createFixture() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42_424,
  });
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
  if (!sandbox.backend || !sandbox.fsBridge) {
    throw new Error("The sandbox fixture requires its backend and filesystem bridge");
  }
  const server: OpenClawExecServer = {
    environmentId: "termination-test",
    authPath: "/termination-test",
    refCount: 1,
    closed: false,
    url: "ws://localhost/termination-test",
    sandbox,
    backend: sandbox.backend,
    fsBridge: sandbox.fsBridge,
    networkIsolated: true,
    children: new Set(),
    cleanupTasks: new Set(),
    server: { clients: [], close: (callback) => callback() },
  };
  const send = vi.fn();
  const session = new CodexSandboxExecSession(server, { send, isOpen: () => true });
  return {
    child,
    cleanupEntered,
    releaseCleanup,
    releaseFinalize,
    runShellCommand,
    finalizeExec,
    send,
    session,
    start: () =>
      session.handleRequest({
        id: 1,
        method: "process/start",
        params: { processId: "termination", argv: ["ignored"], cwd: "file:///workspace" },
      }),
  };
}

describe("Codex sandbox local termination authority", () => {
  it.skipIf(process.platform === "win32").each(
    (["request", "session-close"] as const).flatMap((via) =>
      (["before-request", "remote-cleanup", "term-grace"] as const).map((exitAt) => ({
        via,
        exitAt,
      })),
    ),
  )("stops local signals after exit during $exitAt via $via", async ({ via, exitAt }) => {
    vi.useFakeTimers();
    const fixture = createFixture();
    // Keep the real process-tree helper: its detached escalation used to outlive the owner.
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let cleanup: Promise<void> | undefined;
    let completed = false;
    const exit = () => {
      fixture.child.emit("exit", 7, null);
    };
    try {
      await fixture.start();
      if (exitAt === "before-request") {
        exit();
        await Promise.resolve();
      }
      cleanup = (
        via === "request"
          ? fixture.session.handleRequest({
              id: 2,
              method: "process/terminate",
              params: { processId: "termination" },
            })
          : fixture.session.close()
      ).then(() => {
        completed = true;
      });
      await fixture.cleanupEntered.promise;
      if (exitAt === "remote-cleanup") {
        exit();
      }
      fixture.releaseCleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (exitAt === "term-grace") {
        expect(kill).toHaveBeenCalledExactlyOnceWith(-fixture.child.pid, "SIGTERM");
        exit();
      }
      await vi.advanceTimersByTimeAsync(1_001);
      expect(kill.mock.calls).toEqual(
        exitAt === "term-grace" ? [[-fixture.child.pid, "SIGTERM"]] : [],
      );
      expect(completed).toBe(false);
      expect(fixture.finalizeExec).not.toHaveBeenCalled();
      fixture.child.stdout.write("LATE_OUTPUT");
      fixture.child.emit("close", 7, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.finalizeExec).toHaveBeenCalledOnce();
      expect(completed).toBe(false);
      fixture.releaseFinalize.resolve();
      await cleanup;
      expect(fixture.runShellCommand).toHaveBeenCalledOnce();
      expect(fixture.send).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        method: "process/output",
        params: expect.objectContaining({ chunk: Buffer.from("LATE_OUTPUT").toString("base64") }),
      });
      if (via === "request") {
        expect(fixture.send).toHaveBeenCalledWith({
          jsonrpc: "2.0",
          id: 2,
          result: { running: exitAt !== "before-request" },
        });
      }
      await vi.advanceTimersByTimeAsync(1_001);
      expect(kill.mock.calls).toEqual(
        exitAt === "term-grace" ? [[-fixture.child.pid, "SIGTERM"]] : [],
      );
    } finally {
      fixture.releaseCleanup.resolve();
      fixture.releaseFinalize.resolve();
      fixture.child.emit("close", 7, null);
      await Promise.allSettled([cleanup, fixture.session.close()]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "force kills a still-running child and joins output and backend finalization",
    async () => {
      vi.useFakeTimers();
      const fixture = createFixture();
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      let cleanup: Promise<void> | undefined;
      try {
        await fixture.start();
        cleanup = fixture.session.close();
        await fixture.cleanupEntered.promise;
        fixture.releaseCleanup.resolve();
        await vi.advanceTimersByTimeAsync(999);
        expect(kill).toHaveBeenCalledExactlyOnceWith(-fixture.child.pid, "SIGTERM");
        await vi.advanceTimersByTimeAsync(1);
        expect(kill).toHaveBeenCalledWith(-fixture.child.pid, "SIGKILL");
        expect(fixture.finalizeExec).not.toHaveBeenCalled();
        fixture.child.emit("close", 1, "SIGKILL");
        fixture.releaseFinalize.resolve();
        await cleanup;
        expect(fixture.finalizeExec).toHaveBeenCalledOnce();
      } finally {
        fixture.releaseCleanup.resolve();
        fixture.releaseFinalize.resolve();
        fixture.child.emit("close", 1, "SIGKILL");
        await Promise.allSettled([cleanup, fixture.session.close()]);
      }
    },
  );

  it("joins an admitted Windows taskkill after child close before releasing the backend", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const taskkill = new ChildProcess();
    spawnMock.mockImplementation((command) => (command === "taskkill" ? taskkill : fixture.child));
    vi.spyOn(process, "kill").mockReturnValue(true);
    let cleanup: Promise<void> | undefined;
    let completed = false;
    await withMockedWindowsPlatform(async () => {
      try {
        await fixture.start();
        cleanup = fixture.session.close().then(() => {
          completed = true;
        });
        await fixture.cleanupEntered.promise;
        fixture.releaseCleanup.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnMock).toHaveBeenCalledWith(
          "taskkill",
          ["/T", "/PID", String(fixture.child.pid)],
          expect.any(Object),
        );
        fixture.child.emit("close", 143, "SIGTERM");
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.finalizeExec).not.toHaveBeenCalled();
        expect(completed).toBe(false);
        await vi.advanceTimersByTimeAsync(1_001);
        expect(spawnMock.mock.calls.filter(([command]) => command === "taskkill")).toHaveLength(1);
        taskkill.emit("close", 0);
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.finalizeExec).toHaveBeenCalledOnce();
        expect(completed).toBe(false);
        fixture.releaseFinalize.resolve();
        await cleanup;
      } finally {
        fixture.releaseCleanup.resolve();
        fixture.releaseFinalize.resolve();
        fixture.child.emit("close", 143, "SIGTERM");
        taskkill.emit("close", 0);
        await Promise.allSettled([cleanup, fixture.session.close()]);
      }
    });
  });
});
