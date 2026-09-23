// Codex tests cover sandbox exec-server child and backend lease lifecycle ordering.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SANDBOX_COMMAND_MAX_BUFFER_BYTES, type SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { useIsolatedStateGuard, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const signalProcessTreeMock = vi.hoisted(() => vi.fn());
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
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    signalProcessTree: (...args: Parameters<typeof actual.signalProcessTree>) => {
      signalProcessTreeMock(...args);
      args[2]?.onComplete?.();
    },
  };
});

import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { httpRequest } from "./sandbox-exec-server/http.js";
import { startProcess, terminateProcess } from "./sandbox-exec-server/processes.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type {
  CodexSandboxExecSessionNotifications,
  ManagedProcess,
  OpenClawExecServer,
} from "./sandbox-exec-server/types.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type FakeNotifications = CodexSandboxExecSessionNotifications & {
  send: ReturnType<typeof vi.fn<CodexSandboxExecSessionNotifications["send"]>>;
  close: () => void;
};

function createFakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42_424,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

function createFakeNotifications(): FakeNotifications {
  const controller = new AbortController();
  return {
    send: vi.fn<CodexSandboxExecSessionNotifications["send"]>(),
    isOpen: () => !controller.signal.aborted,
    signal: controller.signal,
    close: () => controller.abort(),
  };
}

function createExecServer(sandbox: SandboxContext): OpenClawExecServer {
  return {
    sandbox,
    backend: sandbox.backend,
    fsBridge: sandbox.fsBridge,
    children: new Set(),
    cleanupTasks: new Set(),
  } as OpenClawExecServer;
}

function processStartParams(processId: string) {
  return {
    processId,
    argv: ["sh", "-lc", "true"],
    cwd: "file:///workspace",
    env: {},
    tty: false,
    pipeStdin: false,
    arg0: null,
  };
}

function streamingHttpParams(requestId: string) {
  return {
    requestId,
    method: "GET",
    url: "https://example.test/sse",
    streamResponse: true,
  };
}

async function createPendingRemoteSignalFixture(holdFirstScan = false) {
  const { spawn: spawnReal } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const transport = createFakeChild();
  spawnMock.mockReturnValue(transport);
  signalProcessTreeMock.mockImplementation(() => transport.emit("close", 143, "SIGTERM"));
  const procRoot = tempDirs.make("codex-interrupt-procfs-");
  const firstScanEntered = createDeferred<void>();
  const firstScanCompleted = createDeferred<void>();
  const releaseFirstScan = createDeferred<void>();
  const finalizeExec = vi.fn(async () => undefined);
  const send = vi.fn();
  let marker = "";
  let firstScan = true;
  let receiver: ChildProcessWithoutNullStreams | undefined;
  let receiverClosed: Promise<void> | undefined;
  let receivedSignal = false;
  let transportClosed = false;
  transport.once("close", () => {
    transportClosed = true;
  });
  const sandbox = createSandboxContext({
    buildExecSpec: async ({ env }) => {
      marker = env.CODEX_SANDBOX_EXEC_ID ?? "";
      expect(marker).not.toBe("");
      return { argv: ["pending-remote-transport"], env: {}, stdinMode: "pipe-closed" };
    },
    finalizeExec,
    runShellCommand: async ({ script, args, signal }) => {
      const initial = firstScan;
      firstScan = false;
      if (initial) {
        firstScanEntered.resolve();
        if (holdFirstScan) {
          await releaseFirstScan.promise;
        }
      }
      // Run the real helper against a controlled Linux procfs view on either POSIX host.
      const helper = spawnReal(
        "/bin/sh",
        ["-c", script.replaceAll("/proc/", `${procRoot}/`), "remote-signal-test", ...(args ?? [])],
        { env: { PATH: process.env.PATH }, signal },
      );
      helper.stdin.end();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      helper.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      helper.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      const [code] = await once(helper, "close");
      if (initial) {
        firstScanCompleted.resolve();
      }
      return {
        code: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
    },
  });
  const session = new CodexSandboxExecSession(createExecServer(sandbox), {
    send,
    isOpen: () => true,
  });
  return {
    session,
    send,
    finalizeExec,
    firstScanEntered: firstScanEntered.promise,
    firstScanCompleted: firstScanCompleted.promise,
    releaseFirstScan: releaseFirstScan.resolve,
    get receivedSignal() {
      return receivedSignal;
    },
    get transportClosed() {
      return transportClosed;
    },
    async admitReceiver() {
      const ready = createDeferred<void>();
      let output = "";
      receiver = spawnReal(
        process.execPath,
        [
          "-e",
          "process.on('SIGINT', () => process.stdout.write('REMOTE_INT\\n', () => process.exit(42))); process.stdout.write('READY\\n'); setInterval(() => {}, 1000);",
        ],
        { env: { PATH: process.env.PATH, CODEX_SANDBOX_EXEC_ID: marker } },
      );
      receiver.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("READY\n")) {
          ready.resolve();
        }
        receivedSignal ||= output.includes("REMOTE_INT\n");
        transport.stdout.emit("data", chunk);
      });
      receiver.stderr.on("data", (chunk: Buffer) => transport.stderr.emit("data", chunk));
      const procEntry = path.join(procRoot, String(receiver.pid));
      receiverClosed = once(receiver, "close").then(([code, signal]) => {
        fs.rmSync(procEntry, { recursive: true, force: true });
        transport.emit("close", code, signal);
      });
      await Promise.race([
        ready.promise,
        receiverClosed.then(() => {
          throw new Error("Remote receiver exited before admission");
        }),
      ]);
      fs.mkdirSync(procEntry);
      fs.writeFileSync(path.join(procEntry, "environ"), `CODEX_SANDBOX_EXEC_ID=${marker}\0`);
    },
    async cleanup() {
      releaseFirstScan.resolve();
      receiver?.kill("SIGKILL");
      await receiverClosed;
      if (!transportClosed) {
        transport.emit("close", 143, "SIGTERM");
      }
      await session.close();
    },
  };
}

useIsolatedStateGuard();

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  signalProcessTreeMock.mockReset();
});

describe("Codex sandbox exec-server lifecycle", () => {
  it("bounds interruption of a never-admitted remote process and settles cleanup", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    signalProcessTreeMock.mockImplementation(() => child.emit("close", 143, "SIGTERM"));
    let interrupting = true;
    const finalizeExec = vi.fn(async () => undefined);
    const send = vi.fn();
    const session = new CodexSandboxExecSession(
      createExecServer(
        createSandboxContext({
          finalizeExec,
          runShellCommand: async () => ({
            code: interrupting ? 75 : 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          }),
        }),
      ),
      { send, isOpen: () => true },
    );
    let interrupt: Promise<void> | undefined;
    try {
      await session.handleRequest({
        id: 1,
        method: "process/start",
        params: processStartParams("never-admitted"),
      });
      let completed = false;
      interrupt = session
        .handleRequest({
          id: 2,
          method: "process/signal",
          params: { processId: "never-admitted", signal: "interrupt" },
        })
        .then(() => {
          completed = true;
        });
      await vi.advanceTimersByTimeAsync(4_499);
      expect(completed).toBe(false);
      expect(finalizeExec).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await interrupt;
      expect(send).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32603, message: expect.stringMatching(/interrupt/iu) },
      });
      interrupting = false;
      await session.close();
      expect(finalizeExec).toHaveBeenCalledOnce();
    } finally {
      interrupting = false;
      child.emit("close", 143, "SIGTERM");
      await vi.advanceTimersByTimeAsync(4_500);
      await Promise.all([interrupt, session.close()]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "waits for remote admission before acknowledging a process interrupt",
    async () => {
      const fixture = await createPendingRemoteSignalFixture();
      let interrupt: Promise<void> | undefined;
      try {
        await fixture.session.handleRequest({
          id: 1,
          method: "process/start",
          params: processStartParams("late-remote-process"),
        });
        interrupt = fixture.session.handleRequest({
          id: 2,
          method: "process/signal",
          params: { processId: "late-remote-process", signal: "interrupt" },
        });
        await fixture.firstScanCompleted;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(fixture.send.mock.calls.some(([message]) => message.id === 2)).toBe(false);
        expect(fixture.receivedSignal).toBe(false);

        await fixture.admitReceiver();
        await interrupt;
        await vi.waitFor(() => expect(fixture.receivedSignal).toBe(true), { timeout: 5_000 });
        await vi.waitFor(() =>
          expect(fixture.send).toHaveBeenCalledWith({
            jsonrpc: "2.0",
            method: "process/exited",
            params: expect.objectContaining({ processId: "late-remote-process", exitCode: 42 }),
          }),
        );
        expect(fixture.send).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 2, result: {} });
      } finally {
        await fixture.cleanup();
        await interrupt;
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "joins a pending remote interrupt before finalizing a closed session",
    async () => {
      const fixture = await createPendingRemoteSignalFixture(true);
      let interrupt: Promise<void> | undefined;
      let cleanup: Promise<void> | undefined;
      try {
        await fixture.session.handleRequest({
          id: 1,
          method: "process/start",
          params: processStartParams("closing-remote-process"),
        });
        interrupt = fixture.session.handleRequest({
          id: 2,
          method: "process/signal",
          params: { processId: "closing-remote-process", signal: "interrupt" },
        });
        await fixture.firstScanEntered;
        let closed = false;
        cleanup = fixture.session.close().then(() => {
          closed = true;
        });
        await vi.waitFor(() => expect(fixture.transportClosed).toBe(true), { timeout: 5_000 });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(fixture.finalizeExec).not.toHaveBeenCalled();
        expect(closed).toBe(false);

        fixture.releaseFirstScan();
        await Promise.all([interrupt, cleanup]);
        expect(fixture.receivedSignal).toBe(false);
        expect(fixture.finalizeExec).toHaveBeenCalledOnce();
      } finally {
        fixture.releaseFirstScan();
        await fixture.cleanup();
        await Promise.all([interrupt, cleanup]);
      }
    },
  );

  it.each([
    { key: "HOME", via: "path" },
    { key: "OPENCLAW_STATE_DIR", via: "path" },
    { key: "OPENCLAW_STATE_DIR", via: "symlink" },
  ] as const)(
    "refuses host metadata discovery outside the isolated home after $key changes ($via)",
    async ({ key, via }) => {
      const testHome = process.env.OPENCLAW_TEST_HOME!;
      // The path cases only point outside the home; nothing is created there.
      let foreignRoot = path.join(testHome, "..", "foreign-state-path");
      let target = foreignRoot;
      const cleanup: string[] = [];
      spawnMock.mockReturnValue(createFakeChild());
      try {
        if (via === "symlink") {
          // A state root that lexically sits inside the home but physically points outside.
          // Register each path before the next fallible call so a failed setup still cleans up.
          foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-foreign-state-"));
          cleanup.push(foreignRoot);
          target = path.join(testHome, "linked-state");
          cleanup.push(target);
          fs.symlinkSync(foreignRoot, target, "dir");
        }
        await withEnvAsync({ [key]: target }, async () => {
          await expect(
            startProcess(
              createExecServer(createSandboxContext({})),
              new Map(),
              createFakeNotifications().send,
              processStartParams("foreign-state"),
            ),
          ).rejects.toThrow("state escaped the isolated test home");
        });
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        for (const entry of cleanup) {
          fs.rmSync(entry, { recursive: true, force: true });
        }
      }
    },
  );

  it("owns JSON-RPC delivery, ordered process notifications, and idempotent session cleanup", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const finalizeExec = vi.fn(async () => undefined);
    const runShellCommand = vi.fn(async () => ({
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-child"],
        env: {},
        finalizeToken: "session-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
      runShellCommand,
    });
    const send = vi.fn();
    const session = new CodexSandboxExecSession(createExecServer(sandbox), {
      send,
      isOpen: () => true,
    });

    await session.handleRequest({ id: 1, method: "initialize" });
    await session.handleRequest({ id: 2, method: "environment/status" });
    await session.handleRequest({ id: 3, method: "unsupported/method" });
    await session.handleRequest({
      id: 4,
      method: "process/start",
      params: processStartParams("direct-session"),
    });
    (child.stdout as PassThrough).write(Buffer.from("session-output"));
    child.emit("close", 0, null);
    await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { sessionId: expect.any(String) } },
      { jsonrpc: "2.0", id: 2, result: { status: "ready" } },
      {
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32601,
          message: "Unsupported OpenClaw sandbox exec-server method: unsupported/method",
        },
      },
      { jsonrpc: "2.0", id: 4, result: { processId: "direct-session", sandboxType: "none" } },
      {
        jsonrpc: "2.0",
        method: "process/output",
        params: {
          processId: "direct-session",
          seq: 1,
          stream: "stdout",
          chunk: Buffer.from("session-output").toString("base64"),
        },
      },
      {
        jsonrpc: "2.0",
        method: "process/exited",
        params: { processId: "direct-session", seq: 2, exitCode: 0, sandboxDenied: false },
      },
      {
        jsonrpc: "2.0",
        method: "process/closed",
        params: { processId: "direct-session", seq: 3 },
      },
    ]);
    const cleanup = session.close();
    expect(session.close()).toBe(cleanup);
    await cleanup;
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(runShellCommand).not.toHaveBeenCalled();
  });

  it("reaps and finalizes a TERM-resistant child before acknowledging termination", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    let finishFinalize: (() => void) | undefined;
    const finalizeExec = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishFinalize = resolve;
        }),
    );
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-child"],
        env: {},
        finalizeToken: "terminate-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(sandbox),
      processes,
      createFakeNotifications().send,
      processStartParams("process-resistant"),
    );
    signalProcessTreeMock.mockImplementation(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 1_000);
    });

    let settled = false;
    const termination = Promise.resolve(
      terminateProcess(processes, { processId: "process-resistant" }),
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(false);
    expect(signalProcessTreeMock).toHaveBeenCalledWith(child.pid, "SIGTERM", {
      detached: process.platform !== "win32",
      onComplete: expect.any(Function),
    });

    await vi.runOnlyPendingTimersAsync();
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    finishFinalize?.();
    await expect(termination).resolves.toEqual({ running: true });
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "completed",
      exitCode: 1,
      timedOut: false,
      token: "terminate-token",
    });
  });

  it("preserves cooperative TERM exit without force killing", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    signalProcessTreeMock.mockImplementation(() => child.emit("close", 143, "SIGTERM"));
    const finalizeExec = vi.fn(async () => undefined);
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-child"],
            env: {},
            finalizeToken: "cooperative-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      processes,
      createFakeNotifications().send,
      processStartParams("process-cooperative"),
    );

    await expect(
      terminateProcess(processes, { processId: "process-cooperative" }),
    ).resolves.toEqual({ running: true });

    expect(signalProcessTreeMock).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "completed",
      exitCode: 143,
      timedOut: false,
      token: "cooperative-token",
    });
  });

  it("shares termination and finalization across concurrent cleanup", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    signalProcessTreeMock.mockImplementation(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 1_000);
    });
    const finalizeExec = vi.fn(async () => undefined);
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-child"],
            env: {},
            finalizeToken: "race-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      processes,
      createFakeNotifications().send,
      processStartParams("process-race"),
    );

    const first = terminateProcess(processes, { processId: "process-race" });
    const second = terminateProcess(processes, { processId: "process-race" });
    await vi.runOnlyPendingTimersAsync();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { running: true },
      { running: true },
    ]);
    expect(signalProcessTreeMock).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledOnce();
  });

  it("reports a surviving tree instead of acknowledging termination", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    signalProcessTreeMock.mockImplementation(() => undefined);
    const finalizeExec = vi.fn(async () => undefined);
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-child"],
            env: {},
            finalizeToken: "survivor-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      processes,
      createFakeNotifications().send,
      processStartParams("process-survivor"),
    );

    const termination = terminateProcess(processes, { processId: "process-survivor" });
    const rejection = expect(termination).rejects.toThrow(
      `Sandbox child process tree ${child.pid} survived SIGKILL; tear down the sandbox environment and inspect the surviving process tree before retrying.`,
    );
    await vi.advanceTimersByTimeAsync(4_500);

    await rejection;
    expect(finalizeExec).not.toHaveBeenCalled();
  });

  it("reaps a TERM-resistant streaming HTTP child on socket close", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    signalProcessTreeMock.mockImplementation(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 1_000);
    });
    const finalizeExec = vi.fn(async () => undefined);
    const notifications = createFakeNotifications();
    const request = httpRequest(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-http-child"],
            env: {},
            finalizeToken: "http-terminate-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      notifications,
      streamingHttpParams("http-resistant"),
      new Set(),
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    (child.stdout as PassThrough).write(
      `${JSON.stringify({ type: "headers", status: 200, headers: [] })}\n`,
    );
    await expect(request).resolves.toEqual({ status: 200, headers: [], bodyBase64: "" });

    notifications.close();
    await vi.runOnlyPendingTimersAsync();

    expect(signalProcessTreeMock).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: 1,
      timedOut: false,
      token: "http-terminate-token",
    });
  });

  it.each([true, false])(
    "joins pending HTTP preparation without launching after close (stream=%s)",
    async (streamResponse) => {
      let preparing = false;
      const releasePreparation = createDeferred<void>();
      const child = createFakeChild();
      spawnMock.mockImplementation(() => {
        setImmediate(() => child.emit("close", 0, null));
        return child;
      });
      const finalizeExec = vi.fn(async () => undefined);
      const session = new CodexSandboxExecSession(
        createExecServer(
          createSandboxContext({
            buildExecSpec: async () => {
              preparing = true;
              await releasePreparation.promise;
              return {
                argv: ["sandbox-http-child"],
                env: {},
                finalizeToken: "cancelled-http-preparation",
                stdinMode: "pipe-closed",
              };
            },
            finalizeExec,
          }),
        ),
        { send: vi.fn(), isOpen: () => true },
      );
      const request = session.handleRequest({
        id: 1,
        method: "http/request",
        params: { ...streamingHttpParams("preparing-http"), streamResponse },
      });
      try {
        await vi.waitFor(() => expect(preparing).toBe(true));
        let closed = false;
        const cleanup = session.close().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(closed).toBe(false);
        releasePreparation.resolve();
        await Promise.all([request, cleanup]);

        expect(spawnMock).not.toHaveBeenCalled();
        expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
          status: "failed",
          exitCode: null,
          timedOut: false,
          token: "cancelled-http-preparation",
        });
      } finally {
        releasePreparation.resolve();
        await Promise.all([request, session.close()]);
      }
    },
  );

  it("joins streaming HTTP finalization after returning headers", async () => {
    let finalizing = false;
    const releaseFinalization = createDeferred<void>();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    signalProcessTreeMock.mockImplementation(() => child.emit("close", 143, "SIGTERM"));
    const session = new CodexSandboxExecSession(
      createExecServer(
        createSandboxContext({
          finalizeExec: async () => {
            finalizing = true;
            await releaseFinalization.promise;
          },
        }),
      ),
      { send: vi.fn(), isOpen: () => true },
    );
    const request = session.handleRequest({
      id: 1,
      method: "http/request",
      params: streamingHttpParams("finalizing-http"),
    });
    try {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      (child.stdout as PassThrough).write(
        `${JSON.stringify({ type: "headers", status: 200, headers: [] })}\n`,
      );
      await request;
      let closed = false;
      const cleanup = session.close().then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(finalizing).toBe(true));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closed).toBe(false);
      releaseFinalization.resolve();
      await cleanup;
    } finally {
      releaseFinalization.resolve();
      await Promise.all([request, session.close()]);
    }
  });

  it.each(["stdout", "stderr"] as const)(
    "preserves the nonstreaming HTTP byte limit for %s and settles overflow cleanup",
    async (stream) => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      signalProcessTreeMock.mockImplementation(() => child.emit("close", 143, "SIGTERM"));
      const finalizeExec = vi.fn(async () => undefined);
      const operations = new Set<Promise<void>>();
      const request = httpRequest(
        createExecServer(createSandboxContext({ finalizeExec })),
        createFakeNotifications(),
        { ...streamingHttpParams("http-buffer-limit"), streamResponse: false },
        operations,
      );
      const response = request.catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
        const output = child[stream] as PassThrough;
        // Reuse backing memory while exercising the real per-stream byte threshold.
        const chunk = Buffer.alloc(1024 * 1024, "x");
        for (
          let remaining = SANDBOX_COMMAND_MAX_BUFFER_BYTES;
          remaining > 0;
          remaining -= chunk.length
        ) {
          output.write(chunk.subarray(0, Math.min(remaining, chunk.length)));
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(signalProcessTreeMock).not.toHaveBeenCalled();

        output.write(Buffer.from("x"));

        await vi.waitFor(() => expect(signalProcessTreeMock).toHaveBeenCalledOnce());
        expect(await response).toMatchObject({
          message: `sandbox http/request ${stream} exceeded ${SANDBOX_COMMAND_MAX_BUFFER_BYTES} bytes`,
        });
        await Promise.all(operations);
        expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
          status: "failed",
          exitCode: 143,
          timedOut: false,
          token: undefined,
        });
      } finally {
        child.emit("close", 143, "SIGTERM");
        await response;
        await Promise.allSettled(operations);
      }
    },
  );

  it("retains the process backend lease after child error until close", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-child"],
        env: {},
        finalizeToken: "process-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const notifications = createFakeNotifications();
    const processes = new Map<string, ManagedProcess>();

    await startProcess(
      createExecServer(sandbox),
      processes,
      notifications.send,
      processStartParams("process-error"),
    );
    child.emit("error", new Error("child transport failed"));

    expect(child.pid).toBe(42_424);
    expect(processes.get("process-error")).toMatchObject({
      closed: false,
      exited: false,
      failure: "child transport failed",
    });
    expect(finalizeExec).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();

    child.emit("close", 23, null);
    await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());

    expect(processes.get("process-error")).toMatchObject({
      closed: true,
      exited: true,
      exitCode: 23,
    });
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: 23,
      timedOut: false,
      token: "process-token",
    });
    expect(notifications.send.mock.calls.map(([method]) => method)).toEqual([
      "process/exited",
      "process/closed",
    ]);
  });

  it.each([
    { label: "an empty exec spec", argv: [] as string[], spawnError: null },
    { label: "a synchronous spawn failure", argv: ["sandbox-child"], spawnError: "spawn failed" },
  ])("finalizes process tokens after $label", async ({ argv, spawnError }) => {
    if (spawnError) {
      spawnMock.mockImplementationOnce(() => {
        throw new Error(spawnError);
      });
    }
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv,
        env: {},
        finalizeToken: "process-start-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });

    await expect(
      startProcess(
        createExecServer(sandbox),
        new Map(),
        createFakeNotifications().send,
        processStartParams("process-start-failure"),
      ),
    ).rejects.toThrow(spawnError ?? "did not provide a command");
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: "process-start-token",
    });
  });

  it("retains the streaming HTTP backend lease through close and remote cleanup after child error", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const releaseRemoteCleanup = createDeferred<void>();
    let remoteCleanupStarted = false;
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-http-child"],
        env: {},
        finalizeToken: "http-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
      runShellCommand: async () => {
        remoteCleanupStarted = true;
        await releaseRemoteCleanup.promise;
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    const operations = new Set<Promise<void>>();
    const request = httpRequest(
      createExecServer(sandbox),
      createFakeNotifications(),
      streamingHttpParams("http-error"),
      operations,
    );
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

    child.emit("error", new Error("HTTP child transport failed"));
    await Promise.resolve();

    expect(child.pid).toBe(42_424);
    expect(settled).toBe(false);
    expect(finalizeExec).not.toHaveBeenCalled();

    try {
      const rejection = expect(request).rejects.toThrow("HTTP child transport failed");
      child.emit("close", 29, null);
      await rejection;
      await vi.waitFor(() => expect(remoteCleanupStarted).toBe(true));
      expect(finalizeExec).not.toHaveBeenCalled();

      releaseRemoteCleanup.resolve();
      await Promise.all(operations);
      expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
        status: "failed",
        exitCode: 29,
        timedOut: false,
        token: "http-token",
      });
    } finally {
      releaseRemoteCleanup.resolve();
      await Promise.all(operations);
    }
  });

  it.each([
    { label: "an empty exec spec", argv: [] as string[], spawnError: null },
    {
      label: "a synchronous spawn failure",
      argv: ["sandbox-http-child"],
      spawnError: "HTTP spawn failed",
    },
  ])("finalizes streaming HTTP tokens after $label", async ({ argv, spawnError }) => {
    if (spawnError) {
      spawnMock.mockImplementationOnce(() => {
        throw new Error(spawnError);
      });
    }
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv,
        env: {},
        finalizeToken: "http-start-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });

    await expect(
      httpRequest(
        createExecServer(sandbox),
        createFakeNotifications(),
        streamingHttpParams("http-start-failure"),
        new Set(),
      ),
    ).rejects.toThrow(spawnError ?? "did not provide a command");
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: "http-start-token",
    });
  });
});
