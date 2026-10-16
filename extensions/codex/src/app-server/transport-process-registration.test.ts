import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as pluginState from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import {
  createCodexAppServerProcessReaperService,
  prepareCodexAppServerProcessRegistration,
  waitForCodexAppServerProcessRegistrationCleanup,
} from "./transport-process-registration.js";
import { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";
import {
  ProcessInspectionError,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
  type PosixProcess,
} from "./transport-process-snapshot.js";

vi.mock("./transport-process-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport-process-snapshot.js")>()),
  readCodexAppServerProcessSnapshot: vi.fn(),
  readCodexAppServerProcessCommand: vi.fn(),
}));

vi.mock("./transport-process-containment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport-process-containment.js")>()),
  terminateCodexAppServerOrphan: vi.fn(),
}));

const observer: PosixProcess = {
  pid: process.pid,
  ppid: process.ppid,
  pgid: process.pid,
  state: "S",
  startedAt: "Sat Aug 29 10:00:00 2026",
};
const parent = { pid: process.pid + 1, pgid: process.pid + 1, startedAt: observer.startedAt };
const child = { pid: process.pid + 2, pgid: process.pid + 2, startedAt: observer.startedAt };
const liveChild: PosixProcess = { ...child, ppid: 1, state: "S" };
const command = "/opt/codex app-server --listen stdio://";
const commandFingerprint = createHash("sha256").update(command).digest("hex");

function openStore() {
  return pluginState.createPluginStateSyncKeyedStore<{
    parent: typeof parent;
    child: typeof child & { commandFingerprint?: string };
  }>("codex", {
    namespace: "app-server-processes",
    maxEntries: 512,
    overflowPolicy: "reject-new",
  });
}

// Real SQLite workers must observe the same native platform as the test process.
describe.skipIf(process.platform === "win32")("Codex POSIX process registration", () => {
  let root: string;
  let store: ReturnType<typeof openStore>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-process-registration-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    store = openStore();
    vi.mocked(readCodexAppServerProcessSnapshot).mockResolvedValue([
      observer,
      { ...parent, ppid: 1, state: "Z" },
      liveChild,
    ]);
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue(command);
    vi.mocked(terminateCodexAppServerOrphan).mockResolvedValue(true);
  });

  afterEach(async () => {
    store.clear();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never kills a same-second replacement process running a different command", async () => {
    store.register("orphan", { parent, child: { ...child, commandFingerprint } });
    vi.mocked(readCodexAppServerProcessCommand).mockResolvedValue("/usr/bin/unrelated-worker");

    await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
    expect(store.lookup("orphan")).toBeUndefined();
  });

  it("lets containment settle a child that exits during command inspection", async () => {
    store.register("orphan", { parent, child: { ...child, commandFingerprint } });
    vi.mocked(readCodexAppServerProcessCommand).mockRejectedValue(
      new ProcessInspectionError("permission"),
    );
    vi.mocked(readCodexAppServerProcessSnapshot)
      .mockResolvedValueOnce([observer, liveChild])
      .mockResolvedValue([observer]);

    await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");

    expect(terminateCodexAppServerOrphan).toHaveBeenCalledExactlyOnceWith({
      ...child,
      commandFingerprint,
    });
    expect(store.lookup("orphan")).toBeUndefined();
  });

  it("retains an unreadable-command registration when the child is live", async () => {
    const registration = { parent, child: { ...child, commandFingerprint } };
    store.register("orphan", registration);
    vi.mocked(readCodexAppServerProcessCommand).mockRejectedValue(
      new ProcessInspectionError("permission"),
    );
    await expect(prepareCodexAppServerProcessRegistration()).rejects.toMatchObject({
      reason: "permission",
    });

    expect(store.lookup("orphan")).toEqual(registration);
    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
  });

  it.for(["state directory changed", "exited during inspection"])(
    "registers only a live child with its command: %s",
    async (mode, ctx) => {
      const spawned = new RegistrationTestChildProcess(child.pid);
      ctx.onTestFinished(() => {
        spawned.stdin.destroy();
        spawned.stdout.destroy();
        spawned.stderr.destroy();
        spawned.removeAllListeners();
      });
      const kill = vi.spyOn(spawned, "kill").mockReturnValue(true);
      vi.mocked(readCodexAppServerProcessSnapshot).mockResolvedValue([
        observer,
        { ...liveChild, ppid: process.pid },
      ]);
      vi.mocked(readCodexAppServerProcessCommand).mockImplementation(async () => {
        if (mode === "exited during inspection") {
          Object.defineProperty(spawned, "exitCode", { value: 0, configurable: true });
          spawned.emit("exit", 0, null);
        }
        return command;
      });
      const register = await prepareCodexAppServerProcessRegistration();
      if (mode === "state directory changed") {
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "other-state"));
      }
      const registered = register(spawned);
      spawned.emit("spawn");

      if (mode === "state directory changed") {
        await registered;
        expect(store.entries()).toEqual([]);
        vi.stubEnv("OPENCLAW_STATE_DIR", root);
        expect(store.entries().map((entry) => entry.value)).toEqual([
          {
            parent: { pid: observer.pid, pgid: observer.pgid, startedAt: observer.startedAt },
            child: { ...child, commandFingerprint },
          },
        ]);
        // Durable rows must never expose the raw argv (appServer.args can carry secrets).
        expect(JSON.stringify(store.entries())).not.toContain(command);
        expect(kill).not.toHaveBeenCalled();
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "other-state"));
        spawned.emit("exit", 0, null);
        await waitForCodexAppServerProcessRegistrationCleanup(spawned);
        vi.stubEnv("OPENCLAW_STATE_DIR", root);
        expect(store.entries()).toEqual([]);
      } else {
        await expect(registered).rejects.toThrow("Cannot register the Codex child process command");
        expect(store.entries()).toEqual([]);
      }
    },
  );

  it.for(["reaped", "retry"])(
    "serializes boot and concurrent startup cleanup when the first sweep is %s",
    async (mode) => {
      const registration = { parent, child: { ...child, commandFingerprint } };
      store.register("orphan", registration);
      const asyncStore = pluginState.createPluginStateKeyedStore<unknown>("codex", {
        namespace: "app-server-processes",
        maxEntries: 512,
        overflowPolicy: "reject-new",
      });
      // Immediate reads make overlap observable without relying on worker timing.
      vi.spyOn(pluginState, "createPluginStateKeyedStore").mockReturnValue({
        ...asyncStore,
        entries: async () => store.entries(),
        delete: async (key) => store.delete(key),
      });
      const firstSweep = createDeferred<boolean>();
      const retryRows: unknown[] = [];
      vi.mocked(terminateCodexAppServerOrphan)
        .mockImplementation(async () => {
          retryRows.push(store.lookup("orphan"));
          return true;
        })
        .mockImplementationOnce(() => firstSweep.promise);
      const warn = vi.fn();
      const service = createCodexAppServerProcessReaperService();
      const ctx = {
        config: {},
        stateDir: root,
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      };
      expect(service.start(ctx)).toBeUndefined();
      await vi.waitFor(() => expect(terminateCodexAppServerOrphan).toHaveBeenCalledOnce());
      const starting = Promise.all([
        prepareCodexAppServerProcessRegistration(),
        prepareCodexAppServerProcessRegistration(),
      ]);
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(terminateCodexAppServerOrphan).toHaveBeenCalledOnce();
        expect(store.lookup("orphan")).toEqual(registration);
        firstSweep.resolve(mode === "reaped");
        await expect(starting).resolves.toEqual([expect.any(Function), expect.any(Function)]);
        await service.stop?.(ctx);
        expect(store.lookup("orphan")).toBeUndefined();
        expect(terminateCodexAppServerOrphan).toHaveBeenCalledTimes(mode === "reaped" ? 1 : 2);
        expect(retryRows).toEqual(mode === "reaped" ? [] : [registration]);
        expect(warn).toHaveBeenCalledTimes(mode === "reaped" ? 0 : 1);
      } finally {
        firstSweep.resolve(true);
        await starting.catch(() => undefined);
        await service.stop?.(ctx);
      }
    },
  );
});

describe("Codex process registration on Windows", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(pluginState, "createPluginStateKeyedStore");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("waits for spawn without inspecting or registering the child", async (ctx) => {
    const spawned = new RegistrationTestChildProcess(child.pid);
    ctx.onTestFinished(() => {
      spawned.stdin.destroy();
      spawned.stdout.destroy();
      spawned.stderr.destroy();
      spawned.removeAllListeners();
    });
    const kill = vi.spyOn(spawned, "kill").mockReturnValue(true);
    const register = await prepareCodexAppServerProcessRegistration();
    const registered = register(spawned);
    spawned.emit("spawn");
    await registered;

    expect(pluginState.createPluginStateKeyedStore).not.toHaveBeenCalled();
    expect(readCodexAppServerProcessSnapshot).not.toHaveBeenCalled();
    expect(readCodexAppServerProcessCommand).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("skips the boot sweep without opening the registration store", () => {
    const warn = vi.fn();
    const service = createCodexAppServerProcessReaperService();
    expect(
      service.start({
        config: {},
        stateDir: "/unused-state",
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      }),
    ).toBeUndefined();

    expect(pluginState.createPluginStateKeyedStore).not.toHaveBeenCalled();
    expect(readCodexAppServerProcessSnapshot).not.toHaveBeenCalled();
    expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
