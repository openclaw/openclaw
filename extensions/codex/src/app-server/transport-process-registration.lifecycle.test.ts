import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import {
  createCodexAppServerProcessReaperService,
  prepareCodexAppServerProcessRegistration,
} from "./transport-process-registration.js";
import type { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";
import {
  createRegistrationChild,
  registrationServiceContext,
} from "./transport-registration-fixtures.test-support.js";
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
  readCodexAppServerProcessSnapshot: async () =>
    [process.pid, 500002].map((pid, index) => ({
      pid,
      pgid: pid,
      ppid: index ? process.pid : process.ppid,
      state: "S",
      startedAt: index ? "child-start" : "parent-start",
    })),
  readCodexAppServerProcessCommand: async () => "/fixture/codex app-server",
}));
vi.mock("./transport-process-containment.js", () => ({
  terminateCodexAppServerDescendants: async () => undefined,
  terminateCodexAppServerOrphan: vi.fn(),
}));

const transportOptions = {
  transport: "stdio",
  command: "codex",
  args: [],
  headers: {},
} satisfies Parameters<typeof createStdioTransport>[0];
function queueSpawn(spawned: RegistrationTestChildProcess) {
  state.spawn.mockImplementation(() => {
    queueMicrotask(() => spawned.emit("spawn"));
    return spawned;
  });
}
function holdRegistration(fail = false) {
  const admission = Promise.withResolvers<void>();
  state.register.mockImplementation(async (key, value) => {
    await admission.promise;
    if (fail) {
      throw new Error("registration refused");
    }
    state.rows.set(key, value);
  });
  return admission;
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
  state.register.mockImplementation(async (key, value) => void state.rows.set(key, value));
  state.delete.mockImplementation(async (key) => void state.rows.delete(key));
  state.entries.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it("starts process inspection after a slow durable registration read", async (ctx) => {
  const reading = Promise.withResolvers<{ key: string; value: unknown }[]>();
  const existing = {
    parent: { pid: process.pid, pgid: process.pid, startedAt: "parent-start" },
    child: { pid: 500001, pgid: 500001, startedAt: "existing-child-start" },
  };
  state.rows.set("live-owner", existing);
  state.entries.mockReturnValue(reading.promise);
  // Advance the owner's clock to prove durable reads do not consume its inspection budget.
  let now = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const spawned = createRegistrationChild(ctx);
  queueSpawn(spawned);
  const starting = createStdioTransport(transportOptions);
  const started = expect(starting).resolves.toBe(spawned);
  await vi.waitFor(() => expect(state.entries).toHaveBeenCalledOnce());
  expect(state.spawn).not.toHaveBeenCalled();
  now += 11_000;
  reading.resolve([{ key: "live-owner", value: existing }]);
  await started;

  expect(state.spawn).toHaveBeenCalledOnce();
  expect(state.register).toHaveBeenCalledOnce();
  expect(state.rows.size).toBe(2);
  expect(state.rows.get("live-owner")).toEqual(existing);
  expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
  expect(state.delete).not.toHaveBeenCalled();
  exit(spawned);
  await closeCodexAppServerTransportAndWait(spawned);
  expect([...state.rows.entries()]).toEqual([["live-owner", existing]]);
});

it("keeps startup pending until the durable registration commits", async (ctx) => {
  const admission = holdRegistration();
  const spawned = createRegistrationChild(ctx);
  const { registered } = await startRegistration(spawned);
  const published = vi.fn();
  void registered.then(published);
  await vi.waitFor(() => expect(state.register).toHaveBeenCalledOnce());
  expect(published).not.toHaveBeenCalled();
  expect(state.rows.size).toBe(0);
  admission.resolve();
  await registered;
  expect(state.rows.size).toBe(1);
  exit(spawned);
  await closeCodexAppServerTransportAndWait(spawned);
  expect(state.rows.size).toBe(0);
});

it.for(["insertion", "failed deletion"])("joins pending %s before closing", async (mode, ctx) => {
  const gate = mode === "insertion" ? holdRegistration() : Promise.withResolvers<void>();
  if (mode === "failed deletion") {
    state.delete.mockImplementation(async () => {
      await gate.promise;
      throw new Error("database unavailable");
    });
  }
  const spawned = createRegistrationChild(ctx);
  const { registered } = await startRegistration(spawned);
  const startup =
    mode === "insertion"
      ? expect(registered).rejects.toThrow("exited during registration")
      : registered;
  if (mode === "insertion") {
    await vi.waitFor(() => expect(state.register).toHaveBeenCalledOnce());
  } else {
    await startup;
  }
  exit(spawned);
  const closed = vi.fn();
  const closing = closeCodexAppServerTransportAndWait(spawned).then(closed);
  if (mode === "insertion") {
    await setImmediate();
    expect(state.delete).not.toHaveBeenCalled();
  } else {
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
    expect(state.rows.size).toBe(1);
  }
  expect(closed).not.toHaveBeenCalled();
  gate.resolve();
  await startup;
  await closing;
  expect(state.delete).toHaveBeenCalledOnce();
  expect(state.rows.size).toBe(mode === "insertion" ? 0 : 1);
});

it.for(["revoked", "commit failure"])(
  "closes an unpublished transport after %s",
  async (mode, ctx) => {
    const admission = holdRegistration(mode === "commit failure");
    const spawned = createRegistrationChild(ctx);
    spawned.stdout.resume();
    spawned.stderr.resume();
    spawned.stdin.on("finish", () => exit(spawned));
    queueSpawn(spawned);
    let active = true;
    const starting = createStdioTransport(transportOptions, {}, () => {
      if (!active) {
        throw new Error("owner closed");
      }
    });
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
  const reading = Promise.withResolvers<{ key: string; value: unknown }[]>();
  state.entries.mockReturnValue(reading.promise);
  const service = createCodexAppServerProcessReaperService();
  const ctx = registrationServiceContext("/fixture");
  expect(service.start(ctx)).toBeUndefined();
  const stopped = vi.fn();
  const stopping = Promise.resolve(service.stop?.(ctx)).then(stopped);
  await setImmediate();
  expect(stopped).not.toHaveBeenCalled();
  reading.resolve([]);
  await stopping;
  expect(stopped).toHaveBeenCalledOnce();
});
