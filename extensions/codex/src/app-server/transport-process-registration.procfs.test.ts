import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  terminateCodexAppServerDescendants,
  terminateCodexAppServerOrphan,
} from "./transport-process-containment.js";
import {
  prepareCodexAppServerProcessRegistration,
  waitForCodexAppServerProcessRegistrationCleanup,
} from "./transport-process-registration.js";
import { readCodexAppServerProcessSnapshot } from "./transport-process-snapshot.js";
import {
  createRegistrationChild,
  registrationStoreOptions,
} from "./transport-registration-fixtures.test-support.js";

const procfs = vi.hoisted(() => {
  const files = new Map<string, string | Error | (() => string)>();
  return {
    files,
    readFile: (file: string): string => {
      const stored = files.get(file);
      const value = typeof stored === "function" ? stored() : stored;
      if (typeof value === "string") {
        return value;
      }
      throw value ?? Object.assign(new Error("gone"), { code: "ENOENT" });
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const { createProcfsFixture } = await import("./transport-procfs.test-support.js");
  return {
    ...original,
    ...createProcfsFixture(original, procfs.readFile, () =>
      [...procfs.files.keys()].flatMap((file) => /^\/proc\/(\d+)\/stat$/.exec(file)?.[1] ?? []),
    ),
  };
});

const bootId = "00000000-0000-0000-0000-000000000001";
const identity = (pid: number) => ({ pid, pgid: pid, startedAt: `${bootId}:12345` });
const parent = identity(500001);
const child = identity(500002);
const neighbor = 500003;
const command = "/opt/codex app-server --listen stdio://";
const commandFingerprint = createHash("sha256").update(command).digest("hex");
const registration = { parent, child: { ...child, commandFingerprint } };
const procFile = (pid: number, name = "stat") => `/proc/${pid}/${name}`;
const inspectionError = (code: string) => Object.assign(new Error("inspection failed"), { code });

function failStat(pid: number, code: string) {
  procfs.files.set(procFile(pid), inspectionError(code));
}

function addProcess(pid: number, ppid: number, state = "S", threads = 1) {
  procfs.files.set(
    procFile(pid),
    `${pid} (worker) ${state} ${ppid} ${pid}${" 0".repeat(14)} ${threads} 0 12345\n`,
  );
  procfs.files.set(procFile(pid, "cmdline"), command.replaceAll(" ", "\0"));
}

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let store: ReturnType<typeof createPluginStateSyncKeyedStore<typeof registration>>;
let kill: MockInstance<typeof process.kill>;

// Real SQLite workers and procfs inspection must observe the same native platform.
describe.skipIf(process.platform !== "linux")("Codex procfs registration", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "codex-registration-procfs-" });
    store = createPluginStateSyncKeyedStore("codex", registrationStoreOptions);
    // Synthetic PIDs must never reach the real signal syscall, even on regression.
    kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("unexpected signal");
    });
    procfs.files.set("/proc/sys/kernel/random/boot_id", bootId);
    addProcess(process.pid, process.ppid);
    addProcess(parent.pid, 1);
    addProcess(child.pid, parent.pid);
    failStat(neighbor, "EACCES");
  });

  afterEach(async () => {
    store.clear();
    vi.restoreAllMocks();
    procfs.files.clear();
    await state.cleanup();
  });

  it.each([
    { code: "threaded-owner", reason: undefined },
    { code: "EIO", reason: "unavailable" },
    { code: "EACCES", reason: "permission" },
  ])("preserves the registration when the owner is $code", async ({ code, reason }) => {
    store.register("owned", registration);
    if (reason) {
      failStat(parent.pid, code);
      await expect(prepareCodexAppServerProcessRegistration()).rejects.toMatchObject({ reason });
    } else {
      addProcess(parent.pid, 1, "Z", 2);
      await expect(
        Promise.all(Array.from({ length: 2 }, () => prepareCodexAppServerProcessRegistration())),
      ).resolves.toHaveLength(2);
    }
    expect(store.lookup("owned")).toEqual(registration);
    expect(kill).not.toHaveBeenCalled();
  });

  it.for([
    { mode: "startup", delayMs: 0, reason: undefined },
    { mode: "slow-inspection", delayMs: 3_000, reason: undefined },
    { mode: "exhausted-inspection", delayMs: 6_000, reason: "deadline" },
    { mode: "malformed", delayMs: 0, reason: "unavailable" },
    { mode: "deadline", delayMs: 0, reason: "deadline" },
    { mode: "missing-observer", delayMs: 0, reason: "unavailable" },
  ])(
    "registers a direct child only with usable ownership: $mode",
    async ({ mode, delayMs, reason }, ctx) => {
      addProcess(child.pid, process.pid);
      const spawned = createRegistrationChild(ctx, child.pid);
      const register = await prepareCodexAppServerProcessRegistration();
      if (delayMs || mode === "startup") {
        let now = performance.now();
        let reads = 0;
        if (delayMs) {
          vi.spyOn(performance, "now").mockImplementation(() => now);
          procfs.files.set("/proc/sys/kernel/random/boot_id", () => {
            now += delayMs;
            return bootId;
          });
        }
        procfs.files.set(procFile(child.pid, "cmdline"), () => {
          expect(store.entries()).toEqual([]);
          now += delayMs;
          return mode === "startup" && reads++ === 0 ? "" : command.replaceAll(" ", "\0");
        });
      } else if (mode === "missing-observer") {
        procfs.files.delete(procFile(process.pid));
      } else {
        procfs.files.set(
          procFile(child.pid),
          mode === "malformed" ? "" : inspectionError("ABORT_ERR"),
        );
      }
      const registered = register(spawned);
      spawned.emit("spawn");

      if (reason) {
        await expect(registered).rejects.toMatchObject({ reason });
        expect(store.entries()).toEqual([]);
        expect(kill).not.toHaveBeenCalled();
        return;
      }
      await registered;

      expect(store.entries().map((entry) => entry.value)).toEqual([
        { parent: identity(process.pid), child: { ...child, commandFingerprint } },
      ]);
      expect(kill).not.toHaveBeenCalled();
      spawned.emit("exit", 0, null);
      await waitForCodexAppServerProcessRegistrationCleanup(spawned);
      expect(store.entries()).toEqual([]);
    },
  );

  it("keeps full-tree inspection fail-closed with the same unreadable neighbor", async () => {
    await expect(readCodexAppServerProcessSnapshot()).rejects.toMatchObject({
      reason: "permission",
    });
    await expect(terminateCodexAppServerOrphan(child)).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it.for(["dead descendant", "threaded descendant", "threaded root"])(
    "requires whole-process quiescence only from the owned tree: %s",
    async (mode) => {
      const threadedRoot = mode === "threaded root";
      addProcess(child.pid, process.pid, threadedRoot ? "Z" : "S", threadedRoot ? 2 : 1);
      addProcess(neighbor, child.pid, "Z", mode === "dead descendant" ? 1 : 2);
      kill.mockImplementation((pid, signal) => {
        if (pid === child.pid && !threadedRoot) {
          addProcess(child.pid, process.pid, signal === "SIGSTOP" ? "T" : "S");
        }
        return true;
      });

      const contained = await terminateCodexAppServerDescendants({
        pid: child.pid,
        kill: (signal) => process.kill(child.pid, signal),
      });

      if (mode === "threaded descendant" || threadedRoot) {
        expect(contained).toBeUndefined();
        expect(kill).toHaveBeenCalledWith(child.pid, "SIGCONT");
        if (!threadedRoot) {
          expect(kill).toHaveBeenCalledWith(neighbor, "SIGSTOP");
          expect(kill).toHaveBeenCalledWith(neighbor, "SIGCONT");
        }
      } else {
        expect(contained).toMatchObject({ root: child });
        if (contained && contained !== "exited") {
          contained.resume();
        }
        expect(kill.mock.calls.every(([pid]) => pid === child.pid)).toBe(true);
      }
      expect(kill.mock.calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    },
  );

  it.for(["already dead", "killed"])("retires an orphan that is %s", async (mode) => {
    store.register("orphan", registration);
    procfs.files.delete(procFile(parent.pid));
    addProcess(child.pid, 1, mode === "already dead" ? "Z" : "S");
    if (mode === "killed") {
      procfs.files.delete(procFile(neighbor));
      kill.mockImplementation((pid, signal) => {
        if (pid === child.pid && signal === "SIGSTOP") {
          addProcess(child.pid, 1, "T");
        } else if (pid === -child.pid && signal === "SIGKILL") {
          procfs.files.delete(procFile(child.pid));
          failStat(neighbor, "EACCES");
        } else {
          throw new Error("unexpected signal");
        }
        return true;
      });
    }
    await expect(prepareCodexAppServerProcessRegistration()).resolves.toBeTypeOf("function");
    if (mode === "killed") {
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    } else {
      expect(kill).not.toHaveBeenCalled();
    }
    expect(store.lookup("orphan")).toBeUndefined();
  });
});
