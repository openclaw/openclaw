import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const ptyMock = vi.hoisted(() => vi.fn());
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
    spawnTerminalPty: ptyMock,
    signalProcessTree: (...args: Parameters<typeof actual.signalProcessTree>) => {
      args[2]?.onComplete?.();
    },
  };
});
import { createSessionExecServer } from "./sandbox-exec-server-session.test-support.js";
import { createSandboxChild, createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { httpRequest } from "./sandbox-exec-server/http.js";
import { startProcess, terminateProcess, writeProcess } from "./sandbox-exec-server/processes.js";
import type { ManagedProcess } from "./sandbox-exec-server/types.js";

function createFixture(overrides: Parameters<typeof createSandboxContext>[0] = {}) {
  const child = createSandboxChild();
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("workspace revoked");
    }
  };
  spawnMock.mockReturnValue(child);
  const sandbox = createSandboxContext({
    buildExecSpec: async () => ({
      argv: ["sandbox-child"],
      env: {},
      stdinMode: "pipe-open",
      finalizeToken: "retired",
      assertCurrent,
    }),
    ...overrides,
  });
  const server = createSessionExecServer(sandbox);
  const processes = new Map<string, ManagedProcess>();
  return {
    child,
    server,
    processes,
    prepareCleanup: (terminate: () => Promise<void>) => {
      sandbox.backend!.prepareProcessCleanup = (env) => {
        assertCurrent();
        return { env, terminate, interrupt: async () => false };
      };
    },
    revoke: () => {
      current = false;
    },
    start: (params: { tty?: boolean; pipeStdin?: boolean } = {}) =>
      startProcess(server, processes, vi.fn<ManagedProcess["emitNotification"]>(), {
        processId: "owned-child",
        argv: ["sh", "-lc", "true"],
        cwd: "file:///workspace",
        ...params,
      }),
    terminate: () => terminateProcess(processes, { processId: "owned-child" }),
  };
}
useIsolatedStateGuard();
afterEach(() => {
  spawnMock.mockReset();
  ptyMock.mockReset();
});
it("revalidates a prepared exec spec immediately before spawning the transport", async () => {
  const finalizeExec = vi.fn(async () => undefined);
  const { start, revoke } = createFixture({ finalizeExec });
  revoke();
  await expect(start()).rejects.toThrow("workspace revoked");
  expect(spawnMock).not.toHaveBeenCalled();
  expect(finalizeExec).toHaveBeenCalledWith({
    status: "failed",
    exitCode: null,
    timedOut: false,
    token: "retired",
  });
});

it.each([false, true])(
  "rejects retained input after workspace revocation (pty=%s) and still terminates",
  async (tty) => {
    const writes: string[] = [];
    let exitPty: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    ptyMock.mockResolvedValue({
      pid: 42_424,
      write: (data: string | Buffer) => writes.push(data.toString()),
      onData: () => {},
      onExit: (listener: typeof exitPty) => {
        exitPty = listener;
      },
      kill: () => exitPty?.({ exitCode: 0, signal: 9 }),
    });
    const runShellCommand = vi.fn(async () => {
      throw new Error("revoked execution");
    });
    const { child, prepareCleanup, server, processes, start, terminate, revoke } = createFixture({
      runShellCommand,
    });
    child.stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString()));
    const cleanup = vi.fn(async () => {
      if (tty) {
        exitPty?.({ exitCode: 0, signal: 9 });
      } else {
        child.emit("close", 143, "SIGTERM");
      }
    });
    prepareCleanup(cleanup);
    await start({ tty, pipeStdin: true });
    const input = (text: string) => ({
      processId: "owned-child",
      chunk: Buffer.from(text).toString("base64"),
    });
    try {
      expect(writeProcess(processes, input("accepted"))).toEqual({ status: "accepted" });
      revoke();
      expect(() => writeProcess(processes, input("forbidden"))).toThrow("workspace revoked");
      expect(writes).toEqual(["accepted"]);
    } finally {
      await terminate();
    }
    expect(processes.get("owned-child")?.exitCode).toBe(tty ? 1 : 143);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(server.children.size).toBe(0);
  },
);

it.each(["process", "http"] as const)(
  "blocks %s input and settles cleanup when authority closes during readiness",
  async (kind) => {
    const { child, prepareCleanup, server, processes, start, revoke } = createFixture();
    child.once("spawn", revoke);
    const end = vi.spyOn(child.stdin, "end");
    child.stdin.on("data", () => {
      child.stdout.push(JSON.stringify({ status: 200, headers: [], bodyBase64: "" }));
      child.emit("close", 0, null);
    });
    const terminate = vi.fn(async () => {
      await Promise.resolve();
      child.emit("close", 143, "SIGTERM");
    });
    prepareCleanup(terminate);
    const operations = new Set<Promise<void>>();
    const request =
      kind === "process"
        ? start({ pipeStdin: true })
        : httpRequest(
            server,
            { send: vi.fn(), signal: new AbortController().signal },
            {
              requestId: "readiness",
              method: "POST",
              url: "https://example.test/",
              bodyBase64: Buffer.from("must not send").toString("base64"),
            },
            operations,
          );
    await expect(request).rejects.toThrow("workspace revoked");
    await Promise.allSettled(operations);
    expect(end).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();
    expect([server.children.size, processes.size]).toEqual([0, 0]);
  },
);
