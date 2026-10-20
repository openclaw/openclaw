import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "openclaw/plugin-sdk/sandbox";
import { useIsolatedStateGuard, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

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

import type { JsonValue } from "./protocol.js";
import { createSessionExecServer } from "./sandbox-exec-server-session.test-support.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { httpRequest } from "./sandbox-exec-server/http.js";
import { startProcess, terminateProcess } from "./sandbox-exec-server/processes.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type {
  CodexSandboxExecSessionNotifications,
  ManagedProcess,
} from "./sandbox-exec-server/types.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42_424,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

function createFakeNotifications() {
  return {
    send: vi.fn<CodexSandboxExecSessionNotifications["send"]>(),
    signal: new AbortController().signal,
  };
}

function processStartParams(processId: string) {
  return { processId, argv: ["sh", "-lc", "true"], cwd: "file:///workspace" };
}

function sessionCalls(session: CodexSandboxExecSession) {
  return (method: string, params: JsonValue, id = 1) =>
    session.handleRequest({ id, method, params });
}

function streamingHttpParams(requestId: string) {
  return { requestId, method: "GET", url: "https://example.test/sse", streamResponse: true };
}

function execSpec(finalizeToken = "token", argv = ["sandbox-child"]) {
  return { argv, env: {}, finalizeToken, stdinMode: "pipe-closed" as const };
}

function finalization(status: "failed" | "completed", exitCode: number | null, token = "token") {
  return { status, exitCode, timedOut: false, token };
}

function createFixture(
  overrides: Parameters<typeof createSandboxContext>[0] = {},
  release: Array<() => void> = [],
) {
  const child = createFakeChild();
  spawnMock.mockReturnValue(child);
  const finalizeExec = vi.fn(overrides.finalizeExec ?? (async () => undefined));
  const server = createSessionExecServer(
    createSandboxContext({
      buildExecSpec: async () => execSpec(),
      ...overrides,
      finalizeExec,
    }),
  );
  const notifications = createFakeNotifications();
  const processes = new Map<string, ManagedProcess>();
  const operations = new Set<Promise<void>>();
  const pending: Promise<unknown>[] = [];
  const send = vi.fn();
  const session = new CodexSandboxExecSession(server, { send, isOpen: () => true });
  return {
    child,
    finalizeExec,
    notifications,
    processes,
    operations,
    pending,
    send,
    session,
    call: sessionCalls(session),
    start: (processId: string) =>
      startProcess(server, processes, notifications.send, processStartParams(processId)),
    terminate: (processId: string) => terminateProcess(processes, { processId }),
    http: (requestId: string, streamResponse = true) =>
      httpRequest(
        server,
        notifications,
        { ...streamingHttpParams(requestId), streamResponse },
        operations,
      ),
    async [Symbol.asyncDispose]() {
      release.forEach((unblock) => unblock());
      child.emit("close", 143, "SIGTERM");
      await Promise.all([...operations, ...pending, session.close()]);
    },
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
  const state = { receivedSignal: false, transportClosed: false };
  transport.once("close", () => {
    state.transportClosed = true;
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
  const session = new CodexSandboxExecSession(createSessionExecServer(sandbox), {
    send,
    isOpen: () => true,
  });
  return {
    session,
    call: sessionCalls(session),
    send,
    finalizeExec,
    firstScanEntered: firstScanEntered.promise,
    firstScanCompleted: firstScanCompleted.promise,
    releaseFirstScan: releaseFirstScan.resolve,
    state,
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
        state.receivedSignal ||= output.includes("REMOTE_INT\n");
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
      if (!state.transportClosed) {
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

it("bounds interruption of a never-admitted remote process and settles cleanup", async () => {
  vi.useFakeTimers();
  let interrupting = true;
  const { child, session, call, send, finalizeExec } = createFixture({
    runShellCommand: async () => ({
      code: interrupting ? 75 : 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }),
  });
  signalProcessTreeMock.mockImplementation(() => child.emit("close", 143, "SIGTERM"));
  let interrupt: Promise<void> | undefined;
  try {
    await call("process/start", processStartParams("never-admitted"));
    let completed = false;
    interrupt = call(
      "process/signal",
      { processId: "never-admitted", signal: "interrupt" },
      2,
    ).then(() => {
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

it.skipIf(process.platform === "win32").each([false, true])(
  "joins remote interrupt admission before acknowledgement or finalization (closing=%s)",
  async (closing) => {
    const fixture = await createPendingRemoteSignalFixture(closing);
    let interrupt: Promise<void> | undefined;
    let cleanup: Promise<void> | undefined;
    try {
      const processId = closing ? "closing-remote-process" : "late-remote-process";
      await fixture.call("process/start", processStartParams(processId));
      interrupt = fixture.call("process/signal", { processId, signal: "interrupt" }, 2);
      if (closing) {
        await fixture.firstScanEntered;
        let closed = false;
        cleanup = fixture.session.close().then(() => {
          closed = true;
        });
        await vi.waitFor(() => expect(fixture.state.transportClosed).toBe(true), {
          timeout: 5_000,
        });
        await nextImmediate();
        expect(fixture.finalizeExec).not.toHaveBeenCalled();
        expect(closed).toBe(false);
        fixture.releaseFirstScan();
        await Promise.all([interrupt, cleanup]);
        expect(fixture.state.receivedSignal).toBe(false);
        expect(fixture.finalizeExec).toHaveBeenCalledOnce();
      } else {
        await fixture.firstScanCompleted;
        await nextImmediate();
        expect(fixture.send.mock.calls.some(([message]) => message.id === 2)).toBe(false);
        expect(fixture.state.receivedSignal).toBe(false);
        await fixture.admitReceiver();
        await interrupt;
        await vi.waitFor(() => expect(fixture.state.receivedSignal).toBe(true), {
          timeout: 5_000,
        });
        await vi.waitFor(() =>
          expect(fixture.send).toHaveBeenCalledWith({
            jsonrpc: "2.0",
            method: "process/exited",
            params: expect.objectContaining({ processId, exitCode: 42 }),
          }),
        );
        expect(fixture.send).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 2, result: {} });
      }
    } finally {
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
            createSessionExecServer(createSandboxContext({})),
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

it("reports a surviving tree instead of acknowledging termination", async () => {
  vi.useFakeTimers();
  const { child, finalizeExec, start, terminate } = createFixture();
  signalProcessTreeMock.mockImplementation(() => undefined);
  await start("process-survivor");
  const termination = terminate("process-survivor");
  const rejection = expect(termination).rejects.toThrow(
    `Sandbox child process tree ${child.pid} survived SIGKILL; tear down the sandbox environment and inspect the surviving process tree before retrying.`,
  );
  await vi.advanceTimersByTimeAsync(4_500);

  await rejection;
  expect(finalizeExec).not.toHaveBeenCalled();
});

it("joins pending HTTP preparation without launching after close", async () => {
  let preparing = false;
  const releasePreparation = createDeferred<void>();
  await using fixture = createFixture(
    {
      buildExecSpec: async () => {
        preparing = true;
        await releasePreparation.promise;
        return execSpec("cancelled-http-preparation", ["sandbox-http-child"]);
      },
    },
    [releasePreparation.resolve],
  );
  const { child, session, call, finalizeExec } = fixture;
  spawnMock.mockImplementation(() => {
    setImmediate(() => child.emit("close", 0, null));
    return child;
  });
  const request = call("http/request", streamingHttpParams("preparing-http"));
  await vi.waitFor(() => expect(preparing).toBe(true));
  let closed = false;
  const cleanup = session.close().then(() => {
    closed = true;
  });
  await nextImmediate();
  expect(closed).toBe(false);
  releasePreparation.resolve();
  await Promise.all([request, cleanup]);
  expect(spawnMock).not.toHaveBeenCalled();
  expect(finalizeExec).toHaveBeenCalledExactlyOnceWith(
    finalization("failed", null, "cancelled-http-preparation"),
  );
});

it.each(["process", "http"] as const)(
  "joins %s cleanup through reaping and finalization",
  async (kind) => {
    vi.useFakeTimers();
    const releaseFinalization = createDeferred<void>();
    await using fixture = createFixture(
      {
        finalizeExec: async () => await releaseFinalization.promise,
      },
      [releaseFinalization.resolve],
    );
    const { child, session, call, send, start, terminate, finalizeExec } = fixture;
    signalProcessTreeMock.mockImplementation(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 1_000);
    });
    if (kind === "process") {
      await start("process-race");
    } else {
      const request = call("http/request", streamingHttpParams("finalizing-http"));
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      (child.stdout as PassThrough).write(
        `${JSON.stringify({ type: "headers", status: 200, headers: [] })}\n`,
      );
      await request;
      expect(send).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id: 1,
        result: { status: 200, headers: [], bodyBase64: "" },
      });
    }
    let closed = false;
    const cleanup = (
      kind === "process"
        ? Promise.all([terminate("process-race"), terminate("process-race")])
        : session.close()
    ).then((result) => {
      closed = true;
      return result;
    });
    fixture.pending.push(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(signalProcessTreeMock).toHaveBeenCalledWith(child.pid, "SIGTERM", {
      detached: process.platform !== "win32",
      onComplete: expect.any(Function),
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toBe(false);
    expect(finalizeExec).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signalProcessTreeMock).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledExactlyOnceWith(
      finalization(kind === "process" ? "completed" : "failed", 1),
    );
    expect(closed).toBe(false);
    releaseFinalization.resolve();
    await expect(cleanup).resolves.toEqual(
      kind === "process" ? [{ running: true }, { running: true }] : undefined,
    );
  },
);

it("preserves the nonstreaming HTTP byte limit and settles overflow cleanup", async () => {
  const stream = "stdout";
  await using fixture = createFixture();
  const { child, finalizeExec, operations, http } = fixture;
  signalProcessTreeMock.mockImplementation(() => child.emit("close", 143, "SIGTERM"));
  const request = http("http-buffer-limit", false);
  const response = request.catch((error: unknown) => error);
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
  const output = child[stream] as PassThrough;
  // Reuse backing memory while exercising the real per-stream byte threshold.
  const chunk = Buffer.alloc(1024 * 1024, "x");
  for (let remaining = SANDBOX_COMMAND_MAX_BUFFER_BYTES; remaining > 0; remaining -= chunk.length) {
    output.write(chunk.subarray(0, Math.min(remaining, chunk.length)));
  }
  await nextImmediate();
  expect(signalProcessTreeMock).not.toHaveBeenCalled();

  output.write(Buffer.from("x"));

  await vi.waitFor(() => expect(signalProcessTreeMock).toHaveBeenCalledOnce());
  expect(await response).toMatchObject({
    message: `sandbox http/request ${stream} exceeded ${SANDBOX_COMMAND_MAX_BUFFER_BYTES} bytes`,
  });
  await Promise.all(operations);
  expect(finalizeExec).toHaveBeenCalledExactlyOnceWith(finalization("failed", 143));
});

it("retains the process backend lease after child error until close", async () => {
  const { child, finalizeExec, notifications, processes, start } = createFixture();
  await start("process-error");
  child.emit("error", new Error("child transport failed"));

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
  expect(finalizeExec).toHaveBeenCalledWith(finalization("failed", 23));
  expect(notifications.send.mock.calls.map(([method]) => method)).toEqual([
    "process/exited",
    "process/closed",
  ]);
});

it("finalizes process tokens after an empty exec spec", async () => {
  const { start, finalizeExec } = createFixture({
    buildExecSpec: async () => execSpec("process-start-token", []),
  });
  await expect(start("process-start-failure")).rejects.toThrow("did not provide a command");
  expect(finalizeExec).toHaveBeenCalledExactlyOnceWith(
    finalization("failed", null, "process-start-token"),
  );
});

it("retains the streaming HTTP backend lease through close and remote cleanup after child error", async () => {
  const releaseRemoteCleanup = createDeferred<void>();
  let remoteCleanupStarted = false;
  await using fixture = createFixture(
    {
      runShellCommand: async () => {
        remoteCleanupStarted = true;
        await releaseRemoteCleanup.promise;
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    },
    [releaseRemoteCleanup.resolve],
  );
  const { child, finalizeExec, operations, http } = fixture;
  const request = http("http-error");
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void request.then(markSettled, markSettled);
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

  child.emit("error", new Error("HTTP child transport failed"));
  await Promise.resolve();

  expect(settled).toBe(false);
  expect(finalizeExec).not.toHaveBeenCalled();

  const rejection = expect(request).rejects.toThrow("HTTP child transport failed");
  child.emit("close", 29, null);
  await rejection;
  await vi.waitFor(() => expect(remoteCleanupStarted).toBe(true));
  expect(finalizeExec).not.toHaveBeenCalled();

  releaseRemoteCleanup.resolve();
  await Promise.all(operations);
  expect(finalizeExec).toHaveBeenCalledExactlyOnceWith(finalization("failed", 29));
});
