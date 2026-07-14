// Codex tests cover sandbox exec-server child-process stream error handling.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createSandboxContext } from "../sandbox-exec-server.test-helpers.js";
import { startProcess } from "./processes.js";
import type { ManagedProcess, OpenClawExecServer } from "./types.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

// Realistic child: stdout/stderr/stdin are real streams so the production close
// path's `stdin.destroy()` runs and `finalizeExec` is actually reached (a bare
// EventEmitter stdin would throw inside finalize and silently skip finalization).
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

function sentMethods(sendMock: ReturnType<typeof vi.fn>): string[] {
  return sendMock.mock.calls
    .map((call) => {
      try {
        return (JSON.parse(String(call[0])) as { method?: string }).method ?? "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

const flush = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

async function startFakeProcess(
  processId: string,
  overrides: { finalizeExec?: ReturnType<typeof vi.fn> } = {},
): Promise<{
  managed: ManagedProcess;
  child: FakeChild;
  send: ReturnType<typeof vi.fn>;
}> {
  const child = makeFakeChild();
  spawnMock.mockReturnValueOnce(child);
  const send = vi.fn();
  const socket = { readyState: 1, send } as unknown as WebSocket;
  const execServer = {
    sandbox: createSandboxContext({ finalizeExec: overrides.finalizeExec }),
  } as unknown as OpenClawExecServer;
  const processes = new Map<string, ManagedProcess>();
  await startProcess(execServer, processes, socket, {
    processId,
    argv: ["echo", "hi"],
    cwd: "/workspace",
  });
  const managed = processes.get(processId);
  if (!managed) {
    throw new Error("managed process was not registered");
  }
  return { managed, child, send };
}

describe("sandbox exec-server child stream error handling", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  it("terminates the child on stdout error and finalizes through the close path", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const { managed, child, send } = await startFakeProcess("stdout-fail", { finalizeExec });

    child.stdout.emit("error", new Error("EPIPE stdout broken"));

    // Failure is recorded and the child is terminated, but the process is NOT
    // reported closed yet — the real "close" event owns finalization.
    expect(managed.failure).toBe("EPIPE stdout broken");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(managed.closed).toBe(false);
    expect(finalizeExec).not.toHaveBeenCalled();

    // The subsequent close finalizes exactly once, in exited-then-closed order,
    // and the backend finalizer runs with a failed status.
    child.emit("close", null);
    await flush();

    expect(managed.closed).toBe(true);
    expect(finalizeExec).toHaveBeenCalledTimes(1);
    expect(finalizeExec).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    const methods = sentMethods(send);
    const exitedIdx = methods.indexOf("process/exited");
    const closedIdx = methods.indexOf("process/closed");
    expect(exitedIdx).toBeGreaterThanOrEqual(0);
    expect(closedIdx).toBeGreaterThan(exitedIdx);
  });

  it("logs a warning on a stderr stream error and keeps the process alive", async () => {
    const warnSpy = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const finalizeExec = vi.fn(async () => undefined);
    const { managed, child } = await startFakeProcess("stderr-fail", { finalizeExec });

    child.stderr.emit("error", new Error("EPIPE stderr broken"));
    await flush();

    expect(warnSpy).toHaveBeenCalledWith("codex sandbox stderr stream failed", {
      error: expect.any(Error),
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(managed.closed).toBe(false);
    expect(managed.failure).toBeNull();
    expect(finalizeExec).not.toHaveBeenCalled();
  });
});
