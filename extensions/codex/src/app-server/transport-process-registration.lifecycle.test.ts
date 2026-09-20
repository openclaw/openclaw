import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexAppServerProcessReaperService,
  prepareCodexAppServerProcessRegistration,
} from "./transport-process-registration.js";
import { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";
import { createStdioTransport } from "./transport-stdio.js";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

const state = vi.hoisted(() => ({
  register: vi.fn<(key: string, value: unknown) => Promise<void>>(),
  delete: vi.fn<(key: string) => Promise<void>>(),
  entries: vi.fn<() => Promise<{ key: string; value: unknown }[]>>(),
  rows: new Map<string, unknown>(),
  spawn: vi.fn<() => ChildProcessWithoutNullStreams>(),
}));
vi.mock("openclaw/plugin-sdk/plugin-state-store-runtime", () => ({
  createPluginStateKeyedStore: () => state,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: state.spawn,
}));
vi.mock("./transport-process-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport-process-snapshot.js")>()),
  readCodexAppServerProcessSnapshot: async () => [
    {
      pid: process.pid,
      ppid: process.ppid,
      pgid: process.pid,
      state: "S",
      startedAt: "parent-start",
    },
    { pid: 500002, ppid: process.pid, pgid: 500002, state: "S", startedAt: "child-start" },
  ],
  readCodexAppServerProcessCommand: async () => "/fixture/codex app-server",
}));
vi.mock("./transport-process-containment.js", () => ({
  terminateCodexAppServerDescendants: async () => undefined,
  terminateCodexAppServerOrphan: vi.fn(),
}));

const children: RegistrationTestChildProcess[] = [];
function child() {
  const spawned = new RegistrationTestChildProcess(500002);
  children.push(spawned);
  return spawned;
}
function exit(spawned: RegistrationTestChildProcess) {
  Object.defineProperty(spawned, "exitCode", { value: 0, configurable: true });
  spawned.stdout.end();
  spawned.stderr.end();
  spawned.emit("exit", 0, null);
}
async function startRegistration(spawned: RegistrationTestChildProcess) {
  const register = await prepareCodexAppServerProcessRegistration();
  const registered = register(spawned);
  spawned.emit("spawn");
  return { registered };
}

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  state.rows.clear();
  state.register.mockImplementation(async (key, value) => {
    state.rows.set(key, value);
  });
  state.delete.mockImplementation(async (key) => {
    state.rows.delete(key);
  });
  state.entries.mockResolvedValue([]);
});
afterEach(() => {
  for (const spawned of children.splice(0)) {
    spawned.stdin.destroy();
    spawned.stdout.destroy();
    spawned.stderr.destroy();
    spawned.removeAllListeners();
  }
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("Codex registration settlement", () => {
  it("keeps startup pending until the durable registration commits", async () => {
    const admission = createDeferred<void>();
    state.register.mockImplementation(async (key, value) => {
      await admission.promise;
      state.rows.set(key, value);
    });
    const spawned = child();
    const { registered } = await startRegistration(spawned);
    let published = false;
    void registered.then(() => {
      published = true;
    });
    await vi.waitFor(() => expect(state.register).toHaveBeenCalledOnce());
    expect(published).toBe(false);
    expect(state.rows.size).toBe(0);
    admission.resolve();
    await registered;
    expect(state.rows.size).toBe(1);
    exit(spawned);
    await closeCodexAppServerTransportAndWait(spawned);
    expect(state.rows.size).toBe(0);
  });

  it("orders an early exit after the pending insertion and rejects startup", async () => {
    const admission = createDeferred<void>();
    state.register.mockImplementation(async (key, value) => {
      await admission.promise;
      state.rows.set(key, value);
    });
    const spawned = child();
    const { registered } = await startRegistration(spawned);
    const rejected = expect(registered).rejects.toThrow("exited during registration");
    await vi.waitFor(() => expect(state.register).toHaveBeenCalledOnce());
    exit(spawned);
    let closed = false;
    const closing = closeCodexAppServerTransportAndWait(spawned).then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(closed).toBe(false);
    expect(state.delete).not.toHaveBeenCalled();
    admission.resolve();
    await rejected;
    await closing;
    expect(state.delete).toHaveBeenCalledOnce();
    expect(state.rows.size).toBe(0);
  });

  it.for(["deleted", "retained"])("joins delayed cleanup, leaving a %s fact", async (mode) => {
    const deletion = createDeferred<void>();
    state.delete.mockImplementation(async (key) => {
      await deletion.promise;
      if (mode === "retained") {
        throw new Error("database unavailable");
      }
      state.rows.delete(key);
    });
    const spawned = child();
    const { registered } = await startRegistration(spawned);
    await registered;
    exit(spawned);
    let closed = false;
    const closing = closeCodexAppServerTransportAndWait(spawned).then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    expect(state.rows.size).toBe(1);
    deletion.resolve();
    await closing;
    expect(state.rows.size).toBe(mode === "retained" ? 1 : 0);
  });

  it.for(["revoked", "commit failure"])(
    "closes an unpublished transport after %s",
    async (mode) => {
      const admission = createDeferred<void>();
      state.register.mockImplementation(async (key, value) => {
        await admission.promise;
        if (mode === "commit failure") {
          throw new Error("registration refused");
        }
        state.rows.set(key, value);
      });
      const spawned = child();
      spawned.stdout.resume();
      spawned.stderr.resume();
      spawned.stdin.on("finish", () => exit(spawned));
      state.spawn.mockImplementation(() => {
        queueMicrotask(() => spawned.emit("spawn"));
        return spawned;
      });
      let active = true;
      const starting = createStdioTransport(
        { transport: "stdio", command: "codex", args: [], headers: {} },
        {},
        () => {
          if (!active) {
            throw new Error("owner closed");
          }
        },
      );
      const rejected = expect(starting).rejects.toThrow(
        mode === "revoked" ? "owner closed" : "registration refused",
      );
      await vi.waitFor(() => expect(state.register).toHaveBeenCalledOnce());
      expect(spawned.stdin.readableLength).toBe(0);
      active = mode !== "revoked";
      admission.resolve();
      await rejected;
      expect(spawned.exitCode).toBe(0);
      expect(state.delete).toHaveBeenCalledOnce();
      expect(state.rows.size).toBe(0);
    },
  );

  it("joins the best-effort boot sweep when the service stops", async () => {
    const reading = createDeferred<{ key: string; value: unknown }[]>();
    state.entries.mockReturnValue(reading.promise);
    const service = createCodexAppServerProcessReaperService();
    const ctx = {
      config: {},
      stateDir: "/fixture",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    expect(service.start(ctx)).toBeUndefined();
    let stopped = false;
    const stopping = Promise.resolve(service.stop?.(ctx)).then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(stopped).toBe(false);
    reading.resolve([]);
    await stopping;
    expect(stopped).toBe(true);
  });
});
