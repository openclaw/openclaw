import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeSandboxCustody } from "./container-engine.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
} from "./container-engine.js";
import { holdNativeSandboxAllocation } from "./docker-native-custody.js";
import type { SandboxRegistryEntry } from "./registry.types.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  assertCurrent: vi.fn(),
  record: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("../../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: () => process.execPath,
}));
vi.mock("./registry.js", () => ({
  assertForegroundSandboxRegistryEntryCurrent: mocks.assertCurrent,
  recordForegroundSandboxReceipt: mocks.record,
  retireForegroundSandboxRegistryEntry: mocks.retire,
  withSandboxRegistryEntryLock: <T>(_entry: unknown, run: () => Promise<T>) => run(),
}));
vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  runNativeSandboxCleanup: (_engine: unknown, run: (exec: typeof mocks.command) => Promise<void>) =>
    run(mocks.command),
}));

async function retireAllocation(native: Parameters<typeof holdNativeSandboxAllocation>[0]) {
  let cleanup!: (reason: string) => Promise<void>;
  native.custody.registerCleanup = (callback) => {
    cleanup = callback;
  };
  await holdNativeSandboxAllocation(native);
  await cleanup("foreground-end");
}

function fixture(kind: "docker" | "podman") {
  const custody: NativeSandboxCustody = {
    runtimeKey: "foreground:test",
    runInstance: { runId: "run-1", instanceId: "instance-1" },
    signal: new AbortController().signal,
    assertCurrent() {},
    assertCleanupConfirmed() {},
    registerCleanup() {},
    runProducer: (run) => run(),
  };
  const engine = bindNativeSandboxEngineTarget(
    captureNativeSandboxEngine(
      kind === "docker" ? DOCKER_SANDBOX_ENGINE : PODMAN_SANDBOX_ENGINE,
      custody,
    ),
    kind === "docker"
      ? {
          key: "unix:///var/run/docker.sock",
          globalArgs: ["--host", "unix:///var/run/docker.sock"],
        }
      : { key: "local", globalArgs: [] },
  );
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
    backendId: kind,
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
  return { native: { engine, custody, reservation: entry, reserved: true }, inspection };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exact native foreground retirement", () => {
  it("retires a proven non-dispatched create without guessing a container identity", async () => {
    const { native } = fixture("docker");
    Object.assign(native.reservation.foreground!, {
      createNotDispatched: true,
      startAttempted: false,
    });
    delete native.reservation.foreground!.containerId;
    await retireAllocation(native);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.retire).toHaveBeenCalledWith(native.reservation);
  });

  it("removes the exact never-started container after proven non-dispatched start", async () => {
    const { native, inspection } = fixture("docker");
    native.reservation.foreground!.startNotDispatched = true;
    Object.assign(inspection.State, { Status: "created", Running: false, Pid: 0 });
    await retireAllocation(native);
    expect(mocks.command.mock.calls.map(([args]) => args[0])).toEqual(["info", "inspect", "rm"]);
    expect(mocks.retire).toHaveBeenCalledWith(native.reservation);
  });

  it.each(["docker", "podman"] as const)(
    "joins %s kill, wait and exit inspection before non-force removal",
    async (kind) => {
      const { native } = fixture(kind);
      await retireAllocation(native);
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
      expect(mocks.retire).toHaveBeenCalledWith(native.reservation);
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it.each(["host-pid", "unknown-exit", "missing-id", "changed-engine"])(
    "retains an uncertain receipt and never removes on %s",
    async (failure) => {
      const { native, inspection } = fixture("podman");
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
        delete native.reservation.foreground!.containerId;
      }
      if (
        failure === "changed-engine" &&
        native.reservation.foreground!.engineIdentity.kind === "podman"
      ) {
        native.reservation.foreground!.engineIdentity.runRoot = "/another/run";
      }
      await expect(retireAllocation(native)).rejects.toThrow();
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
    const { native } = fixture("docker");
    const execute = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation(async (args: string[]) => {
      if (args[0] === "rm") {
        throw new Error("container disappeared before our removal");
      }
      return execute(args);
    });
    await expect(retireAllocation(native)).rejects.toThrow();
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(native.reservation.foreground?.cleanupUncertain).toBe(true);
  });
});
