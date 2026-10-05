import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileForegroundSandboxesAtStartup } from "./docker-native-custody.js";
import type { SandboxRegistryEntry } from "./registry.types.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  read: vi.fn(),
  readEntry: vi.fn(),
  lock: vi.fn(),
  captureExecutable: vi.fn(),
  assertCurrent: vi.fn(),
  record: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("../../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: mocks.captureExecutable,
}));
vi.mock("./registry.js", () => ({
  readRegistry: mocks.read,
  readRegistryEntry: mocks.readEntry,
  assertForegroundSandboxRegistryEntryCurrent: mocks.assertCurrent,
  recordForegroundSandboxReceipt: mocks.record,
  retireForegroundSandboxRegistryEntry: mocks.retire,
  withSandboxRegistryEntryLock: mocks.lock,
}));
vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  runNativeSandboxCleanup: (_engine: unknown, run: (exec: typeof mocks.command) => Promise<void>) =>
    run(mocks.command),
}));

function fixture(kind: "docker" | "podman") {
  const engineIdentity =
    kind === "docker"
      ? { kind: "docker" as const, id: "daemon-1" }
      : {
          kind: "podman" as const,
          graphRoot: "/storage/graph",
          runRoot: "/run/containers",
          driver: "overlay",
          rootless: true,
          idMappings: { uidmap: [], gidmap: [] },
        };
  const entry: SandboxRegistryEntry = {
    containerName: "foreground-test",
    runtimeLabel: "foreground-test",
    configLabelKind: "Image",
    backendId: kind,
    backendTarget:
      kind === "docker"
        ? {
            key: "unix:///var/run/docker.sock",
            globalArgs: ["--host", "unix:///var/run/docker.sock"],
          }
        : { key: "local", globalArgs: [] },
    sessionKey: "agent:main:thread",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "sandbox:test",
    configHash: "config-1",
    workspaceDir: "/workspace/project",
    runtimeState: "ready",
    foreground: {
      runId: "run-1",
      instanceId: "instance-1",
      engineIdentity,
      createAttempted: true,
      startAttempted: true,
      containerId: "a".repeat(64),
      ...(kind === "podman" ? { namespace: "" } : {}),
    },
  };
  const inspection = {
    Id: entry.foreground!.containerId,
    Name: kind === "docker" ? "/foreground-test" : "foreground-test",
    Namespace: "",
    Config: {
      Labels: {
        "openclaw.sandbox": "1",
        "openclaw.sessionKey": entry.sessionKey,
        "openclaw.createdAtMs": "1",
        "openclaw.configHash": "config-1",
      },
    },
    HostConfig: {
      PidMode: kind === "docker" ? "" : "private",
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
    },
    State: {
      Status: "running",
      Running: true,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: 123,
      Error: "",
      ExitCode: 0,
      StartedAt: "2026-01-01T00:00:00Z",
      FinishedAt: "0001-01-01T00:00:00Z",
    },
  };
  mocks.command.mockImplementation(async (args: string[]) => {
    let output: unknown = "";
    if (args[0] === "info") {
      output =
        kind === "docker"
          ? { OSType: "linux", ID: "daemon-1" }
          : {
              host: {
                os: "linux",
                security: { rootless: true },
                idMappings: { uidmap: [], gidmap: [] },
              },
              store: {
                graphRoot: "/storage/graph",
                runRoot: "/run/containers",
                graphDriverName: "overlay",
              },
            };
    }
    if (args[0] === "inspect") {
      output = inspection;
    }
    if (args[0] === "kill") {
      Object.assign(inspection.State, {
        Status: "exited",
        Running: false,
        Pid: 0,
        ExitCode: 137,
        FinishedAt: "2026-01-01T00:00:01Z",
      });
    }
    if (args[0] === "wait") {
      output = String(inspection.State.ExitCode);
    }
    return {
      code: 0,
      stdout: Buffer.from(typeof output === "string" ? output : JSON.stringify(output)),
      stderr: Buffer.alloc(0),
    };
  });
  mocks.read.mockResolvedValue({ entries: [entry] });
  mocks.readEntry.mockResolvedValue(entry);
  return { entry, inspection };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.captureExecutable.mockReturnValue(process.execPath);
  mocks.lock.mockImplementation(
    async (_entry: unknown, run: () => Promise<unknown>) => await run(),
  );
  mocks.record.mockImplementation(async (_previous: unknown, next: SandboxRegistryEntry) => {
    mocks.readEntry.mockResolvedValue(next);
  });
});

describe("startup retirement of recorded foreground allocations", () => {
  it("rereads under the exact lock and accepts a receipt retired by its previous owner", async () => {
    const { entry } = fixture("docker");
    let locked = false;
    mocks.lock.mockImplementation(async (_entry: unknown, run: () => Promise<unknown>) => {
      locked = true;
      try {
        return await run();
      } finally {
        locked = false;
      }
    });
    mocks.readEntry.mockImplementation(async () => {
      expect(locked).toBe(true);
      return null;
    });
    await expect(reconcileForegroundSandboxesAtStartup()).resolves.toEqual([]);
    expect(mocks.lock).toHaveBeenCalledWith(entry, expect.any(Function));
    expect(mocks.readEntry).toHaveBeenCalledWith(entry.containerName);
    expect(mocks.captureExecutable).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it.each(["rebound", "quarantined", "locked"] as const)(
    "preserves a %s allocation before capturing or touching its native engine",
    async (state) => {
      const { entry } = fixture("docker");
      if (state === "rebound") {
        mocks.readEntry.mockResolvedValue({
          ...entry,
          foreground: { ...entry.foreground, instanceId: "replacement" },
        });
      } else if (state === "quarantined") {
        entry.foreground!.cleanupUncertain = true;
      } else {
        mocks.lock.mockRejectedValue(new Error("allocation lock still held"));
      }
      const failures = await reconcileForegroundSandboxesAtStartup();
      expect(failures).toHaveLength(1);
      if (state === "quarantined") {
        expect(String(failures[0])).toContain("quarantined");
      }
      expect(mocks.captureExecutable).not.toHaveBeenCalled();
      expect(mocks.command).not.toHaveBeenCalled();
      expect(mocks.retire).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it("retires a proven non-dispatched create without guessing a container identity", async () => {
    const { entry } = fixture("docker");
    Object.assign(entry.foreground!, {
      createNotDispatched: true,
      startAttempted: false,
    });
    delete entry.foreground!.containerId;
    await expect(reconcileForegroundSandboxesAtStartup()).resolves.toEqual([]);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.retire).toHaveBeenCalledWith(entry);
  });

  it("removes the exact never-started container after proven non-dispatched start", async () => {
    const { entry, inspection } = fixture("docker");
    entry.foreground!.startNotDispatched = true;
    Object.assign(inspection.State, { Status: "created", Running: false, Pid: 0 });
    await expect(reconcileForegroundSandboxesAtStartup()).resolves.toEqual([]);
    expect(mocks.command.mock.calls.map(([args]) => args[0])).toEqual(["info", "inspect", "rm"]);
    expect(mocks.retire).toHaveBeenCalledWith(entry);
  });

  it.each(["docker", "podman"] as const)(
    "joins %s kill, wait and exit inspection before non-force removal",
    async (kind) => {
      const { entry } = fixture(kind);
      await expect(reconcileForegroundSandboxesAtStartup()).resolves.toEqual([]);
      expect(mocks.command.mock.calls.map(([args]) => args[0])).toEqual([
        "info",
        "inspect",
        "kill",
        "wait",
        "info",
        "inspect",
        "rm",
      ]);
      expect(mocks.command).toHaveBeenCalledWith(["rm", "a".repeat(64)], undefined);
      expect(mocks.retire).toHaveBeenCalledWith(entry);
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it.each(["host-pid", "unknown-exit", "missing-id", "changed-engine"])(
    "retains an uncertain receipt and never removes on %s",
    async (failure) => {
      const { entry, inspection } = fixture("podman");
      if (failure === "host-pid") {
        inspection.HostConfig.PidMode = "host";
      }
      if (failure === "unknown-exit") {
        Object.assign(inspection.State, {
          Status: "stopped",
          Running: false,
          Pid: 0,
          ExitCode: -1,
          Error: "conmon missing",
        });
      }
      if (failure === "missing-id") {
        delete entry.foreground!.containerId;
      }
      if (failure === "changed-engine" && entry.foreground!.engineIdentity.kind === "podman") {
        entry.foreground!.engineIdentity.runRoot = "/another/run";
      }
      expect(await reconcileForegroundSandboxesAtStartup()).toHaveLength(1);
      expect(mocks.command.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
      expect(mocks.retire).not.toHaveBeenCalled();
      expect(mocks.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          foreground: expect.objectContaining({ cleanupUncertain: true }),
        }),
      );
    },
  );

  it("does not erase the receipt when non-force removal fails", async () => {
    fixture("docker");
    const execute = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation(async (args: string[]) => {
      if (args[0] === "rm") {
        throw new Error("container disappeared before our removal");
      }
      return execute(args);
    });
    expect(await reconcileForegroundSandboxesAtStartup()).toHaveLength(1);
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(await mocks.readEntry()).toMatchObject({ foreground: { cleanupUncertain: true } });
  });
});
