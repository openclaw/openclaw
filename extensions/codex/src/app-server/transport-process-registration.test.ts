import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as pluginState from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminateCodexAppServerOrphan } from "./transport-process-containment.js";
import {
  createCodexAppServerProcessReaperService,
  prepareCodexAppServerProcessRegistration,
  waitForCodexAppServerProcessRegistrationCleanup,
} from "./transport-process-registration.js";
import {
  ProcessInspectionError,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
  type PosixProcess,
} from "./transport-process-snapshot.js";
import {
  createRegistrationChild,
  registrationServiceContext,
  registrationStoreOptions,
} from "./transport-registration-fixtures.test-support.js";

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
const registration = { parent, child: { ...child, commandFingerprint } };

function openStore() {
  return pluginState.createPluginStateSyncKeyedStore<typeof registration>(
    "codex",
    registrationStoreOptions,
  );
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

  it.for(["different command", "exited during inspection", "live unreadable command"])(
    "settles a registered orphan safely: %s",
    async (mode) => {
      store.register("orphan", registration);
      vi.mocked(readCodexAppServerProcessCommand).mockImplementation(async () => {
        if (mode !== "different command") {
          throw new ProcessInspectionError("permission");
        }
        return "/usr/bin/unrelated-worker";
      });
      if (mode === "exited during inspection") {
        vi.mocked(readCodexAppServerProcessSnapshot)
          .mockResolvedValueOnce([observer, liveChild])
          .mockResolvedValue([observer]);
      }
      const preparing = prepareCodexAppServerProcessRegistration();
      if (mode === "live unreadable command") {
        await expect(preparing).rejects.toMatchObject({ reason: "permission" });
      } else {
        await expect(preparing).resolves.toBeTypeOf("function");
      }
      expect(store.lookup("orphan")).toEqual(
        mode === "live unreadable command" ? registration : undefined,
      );
      expect(vi.mocked(terminateCodexAppServerOrphan).mock.calls).toEqual(
        mode === "exited during inspection" ? [[registration.child]] : [],
      );
    },
  );

  it.for(["state directory changed", "exited during inspection"])(
    "registers only a live child with its command: %s",
    async (mode, ctx) => {
      const spawned = createRegistrationChild(ctx, child.pid);
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
      store.register("orphan", registration);
      const asyncStore = pluginState.createPluginStateKeyedStore<unknown>(
        "codex",
        registrationStoreOptions,
      );
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
      const ctx = registrationServiceContext(root, warn);
      expect(service.start(ctx)).toBeUndefined();
      await vi.waitFor(() => expect(terminateCodexAppServerOrphan).toHaveBeenCalledOnce());
      const starting = Promise.all([
        prepareCodexAppServerProcessRegistration(),
        prepareCodexAppServerProcessRegistration(),
      ]);
      try {
        await setImmediate();
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

  it.for(["spawn", "boot"])("bypasses process registration during %s", async (mode, ctx) => {
    if (mode === "spawn") {
      const spawned = createRegistrationChild(ctx, child.pid);
      const kill = vi.spyOn(spawned, "kill").mockReturnValue(true);
      const register = await prepareCodexAppServerProcessRegistration();
      const registered = register(spawned);
      spawned.emit("spawn");
      await registered;
      expect(readCodexAppServerProcessCommand).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } else {
      const warn = vi.fn();
      expect(
        createCodexAppServerProcessReaperService().start(
          registrationServiceContext("/unused-state", warn),
        ),
      ).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(terminateCodexAppServerOrphan).not.toHaveBeenCalled();
    }
    expect(pluginState.createPluginStateKeyedStore).not.toHaveBeenCalled();
    expect(readCodexAppServerProcessSnapshot).not.toHaveBeenCalled();
  });
});
