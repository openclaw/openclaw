import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareForegroundTestAdmission } from "../run-execution-policy.test-support.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
} from "./container-engine.js";
import { createDockerSandboxBackend } from "./docker-backend.js";
import {
  reconcileForegroundSandboxWorkspace,
  reconcileForegroundSandboxesAtStartup,
  type NativeSandboxContainerCustody,
} from "./docker-native-custody.js";
import { ensureSandboxContainer } from "./docker.js";
import { acquireForegroundSandboxCustody } from "./foreground-owner.js";
import {
  readRegistryEntry,
  reserveForegroundSandboxRegistryEntry,
  withSandboxRegistryEntryLock,
} from "./registry.js";
import type { SandboxRegistryEntry } from "./registry.types.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  afterRecord: vi.fn<(entry: SandboxRegistryEntry) => Promise<void>>(),
}));
vi.mock("../../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: () => process.execPath,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: mocks.command,
}));
vi.mock("./docker-mount-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-mount-source.js")>()),
  resolveDockerSourceNamespace: async () => undefined,
}));
vi.mock("./registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./registry.js")>();
  return {
    ...actual,
    recordForegroundSandboxReceipt: async (
      previous: SandboxRegistryEntry,
      entry: SandboxRegistryEntry,
    ) => {
      await actual.recordForegroundSandboxReceipt(previous, entry);
      await mocks.afterRecord(entry);
    },
  };
});

function nativeTransport() {
  const id = "a".repeat(64);
  let inspection: Record<string, unknown> | undefined;
  let state: Record<string, unknown> = {};
  const dispatched: string[] = [];
  const execute = async (argv: string[]) => {
    const args = argv.slice(3);
    dispatched.push(args[0]!);
    let output: unknown = "";
    if (args[0] === "info") {
      output = { OSType: "linux", ID: "daemon-1" };
    } else if (args[0] === "create") {
      const labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--label") {
          const label = args[++i]!;
          labels[label.slice(0, label.indexOf("="))] = label.slice(label.indexOf("=") + 1);
        }
      }
      state = {
        Status: "created",
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        Pid: 0,
        Error: "",
        ExitCode: 0,
        StartedAt: "0001-01-01T00:00:00Z",
        FinishedAt: "0001-01-01T00:00:00Z",
      };
      inspection = {
        Id: id,
        Name: `/${args[args.indexOf("--name") + 1]}`,
        Config: { Labels: labels },
        HostConfig: { PidMode: "", AutoRemove: false, RestartPolicy: { Name: "no" } },
        State: state,
      };
      output = id;
    } else if (args[0] === "inspect") {
      output = args.includes('{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}')
        ? { Mounts: [], Tmpfs: null }
        : inspection;
    } else if (args[0] === "exec") {
      output = args.includes("/proc/self/mountinfo") ? "1 1 0:1 / / rw - overlay overlay rw\n" : "";
    } else if (args[0] === "start") {
      Object.assign(state, {
        Status: "running",
        Running: true,
        Pid: 123,
        StartedAt: "2026-01-01T00:00:00Z",
      });
    } else if (args[0] === "kill") {
      Object.assign(state, {
        Status: "exited",
        Running: false,
        Pid: 0,
        ExitCode: 137,
        FinishedAt: "2026-01-01T00:00:01Z",
      });
    } else if (args[0] === "wait") {
      output = "137";
    } else if (args[0] === "rm") {
      inspection = undefined;
    } else if (args[0] !== "image") {
      throw new Error(`Unexpected native command ${args[0]}`);
    }
    return {
      failed: false,
      exitCode: 0,
      stdout: Buffer.from(typeof output === "string" ? output : JSON.stringify(output)),
      stderr: Buffer.alloc(0),
    };
  };
  mocks.command.mockImplementation(execute);
  return { dispatched, execute, id };
}

async function owner(runId: string) {
  const prepared = prepareForegroundTestAdmission(runId);
  const context = await prepared.admit("embedded");
  const custody = acquireForegroundSandboxCustody(context);
  const engine = bindNativeSandboxEngineTarget(
    captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody),
    { key: "unix:///var/run/docker.sock", globalArgs: ["--host", "unix:///var/run/docker.sock"] },
  );
  return { prepared, native: { custody, engine } as NativeSandboxContainerCustody };
}

beforeEach(() => {
  mocks.command.mockReset();
  mocks.afterRecord.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("foreground allocation with the native registry owner", () => {
  it.each([false, true])(
    "rechecks the workspace at queued backend dispatch (revoked=%s)",
    async (revoked) => {
      await withOpenClawTestState({ label: "foreground-workspace-dispatch" }, async (fixture) => {
        vi.stubEnv("DOCKER_CONTEXT", "");
        vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
        const transport = nativeTransport();
        const prepared = prepareForegroundTestAdmission("foreground-workspace-dispatch");
        try {
          const context = await prepared.admit("embedded");
          const custody = acquireForegroundSandboxCustody(context);
          let current = true;
          const backend = await createDockerSandboxBackend(
            {
              sessionKey: "agent:main:bounded",
              scopeKey: "agent:main:bounded",
              workspaceDir: fixture.workspaceDir,
              agentWorkspaceDir: fixture.workspaceDir,
              cfg: { ...resolveSandboxConfigForAgent(), workspaceAccess: "rw" },
              assertRuntimeCurrent: () => {
                if (!current) {
                  throw new Error("workspace generation retired");
                }
              },
            },
            undefined,
            custody,
          );
          transport.dispatched.length = 0;
          const pending = backend.runShellCommand({ script: "write must retain its workspace" });
          current = !revoked;
          // Admission remains live; the separately captured workspace owner changed.
          expect(() => custody.assertCurrent()).not.toThrow();
          if (revoked) {
            await expect(pending).rejects.toThrow("workspace generation retired");
            expect(transport.dispatched).toEqual([]);
          } else {
            await expect(pending).resolves.toMatchObject({ code: 0 });
            expect(transport.dispatched).toEqual(["exec"]);
          }
          // Resource retirement remains valid after execution authority is revoked.
          await prepared.close();
          expect(await readRegistryEntry(backend.runtimeId)).toBeNull();
          expect(transport.dispatched.at(-1)).toBe("rm");
        } finally {
          await prepared.close();
        }
      });
    },
  );

  it.each(["normal", "create-intent", "start-intent", "create-response"] as const)(
    "joins exact allocation retirement after %s",
    async (boundary) => {
      await withOpenClawTestState({ label: `foreground-${boundary}` }, async (fixture) => {
        const transport = nativeTransport();
        const retainedFile = path.join(fixture.workspaceDir, "draft.txt");
        await fs.writeFile(retainedFile, "retained draft");
        const { prepared, native } = await owner(`foreground-${boundary}`);
        const reached = createDeferred();
        const resume = createDeferred();
        if (boundary === "create-response") {
          mocks.command.mockImplementation(async (argv: string[]) => {
            const result = await transport.execute(argv);
            if (argv[3] === "create") {
              reached.resolve();
              await resume.promise;
            }
            return result;
          });
        }
        if (boundary === "create-intent" || boundary === "start-intent") {
          mocks.afterRecord.mockImplementation(async (entry) => {
            if (
              boundary === "create-intent"
                ? entry.foreground?.createAttempted &&
                  !entry.foreground.containerId &&
                  !entry.foreground.createNotDispatched
                : entry.foreground?.startAttempted && !entry.foreground.startNotDispatched
            ) {
              reached.resolve();
              await resume.promise;
            }
          });
        }
        const cfg = { ...resolveSandboxConfigForAgent(), workspaceAccess: "rw" as const };
        const allocation = native.custody.runProducer(
          () =>
            ensureSandboxContainer({
              native,
              engine: native.engine,
              scopeKey: "agent:main:bounded",
              workspaceDir: fixture.workspaceDir,
              agentWorkspaceDir: fixture.workspaceDir,
              cfg,
            }),
          { settleAfterAbort: true },
        );
        let closing: Promise<void> | undefined;
        try {
          if (boundary === "normal") {
            await allocation;
            expect(await readRegistryEntry(native.reservation!.containerName)).toMatchObject({
              foreground: { containerId: transport.id, startAttempted: true },
              runtimeState: "ready",
            });
            closing = prepared.close();
          } else {
            const stopped = expect(allocation).rejects.toThrow();
            await reached.promise;
            closing = prepared.close();
            resume.resolve();
            await stopped;
          }
          await closing;
          expect(await readRegistryEntry(native.reservation!.containerName)).toBeNull();
          expect(await fs.readFile(retainedFile, "utf8")).toBe("retained draft");
          if (boundary === "create-intent") {
            expect(transport.dispatched).not.toContain("create");
            expect(transport.dispatched).not.toContain("rm");
            expect(native.reservation!.foreground?.createNotDispatched).toBe(true);
          } else {
            expect(transport.dispatched.at(-1)).toBe("rm");
            expect(native.reservation!.foreground?.containerId).toBe(transport.id);
            if (boundary !== "normal") {
              expect(transport.dispatched).not.toContain("start");
            }
          }
        } finally {
          resume.resolve();
          await Promise.allSettled([allocation, closing ?? prepared.close()]);
        }
      });
    },
  );

  it("does not steal a competing foreground lock or erase its receipt", async () => {
    await withOpenClawTestState({ label: "foreground-held-lock" }, async (fixture) => {
      const { prepared, native } = await owner("replacement");
      const entry: SandboxRegistryEntry = {
        containerName: "previous",
        backendId: "docker",
        backendTarget: {
          key: "unix:///var/run/docker.sock",
          globalArgs: ["--host", "unix:///var/run/docker.sock"],
        },
        sessionKey: "agent:main:bounded",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "sandbox:test",
        workspaceDir: fixture.workspaceDir,
        foreground: {
          runId: "previous",
          instanceId: "previous-instance",
          engineIdentity: { kind: "docker", id: "daemon-1" },
          createAttempted: false,
          startAttempted: false,
        },
      };
      await reserveForegroundSandboxRegistryEntry(entry);
      try {
        await withSandboxRegistryEntryLock(entry, async () => {
          await expect(
            reconcileForegroundSandboxWorkspace({
              custody: native.custody,
              engine: native.engine,
              workspaceDir: fixture.workspaceDir,
            }),
          ).rejects.toThrow("previous foreground request still owns");
          expect(await readRegistryEntry(entry.containerName)).toMatchObject(entry);
          expect(mocks.command).not.toHaveBeenCalled();
        });
        // A crashed, never-dispatched generation is safe to retire once its lock is released.
        await reconcileForegroundSandboxWorkspace({
          custody: native.custody,
          engine: native.engine,
          workspaceDir: fixture.workspaceDir,
        });
        expect(await readRegistryEntry(entry.containerName)).toBeNull();
      } finally {
        await prepared.close();
      }
    });
  });
});

it.each(["running", "competing-owner", "changed-engine"] as const)(
  "reconciles a retained restart receipt without new run admission (%s)",
  async (scenario) => {
    await withOpenClawTestState({ label: `foreground-startup-${scenario}` }, async (fixture) => {
      const transport = nativeTransport();
      const entry: SandboxRegistryEntry = {
        containerName: "retained-startup",
        backendId: "docker",
        backendTarget: {
          key: "unix:///var/run/docker.sock",
          globalArgs: ["--host", "unix:///var/run/docker.sock"],
        },
        sessionKey: "agent:main:bounded",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "sandbox:test",
        workspaceDir: fixture.workspaceDir,
        foreground: {
          runId: "old-run",
          instanceId: "old-instance",
          engineIdentity: { kind: "docker", id: "daemon-1" },
          createAttempted: true,
          startAttempted: true,
          containerId: transport.id,
        },
      };
      const argv = [process.execPath, "--host", "unix:///var/run/docker.sock"];
      await transport.execute([
        ...argv,
        "create",
        "--name",
        entry.containerName,
        "--label",
        "openclaw.sandbox=1",
        "--label",
        `openclaw.sessionKey=${entry.sessionKey}`,
        "--label",
        "openclaw.createdAtMs=1",
      ]);
      await transport.execute([...argv, "start", transport.id]);
      await reserveForegroundSandboxRegistryEntry(entry);
      transport.dispatched.length = 0;
      if (scenario === "competing-owner") {
        await withSandboxRegistryEntryLock(entry, async () => {
          expect(await reconcileForegroundSandboxesAtStartup()).toHaveLength(1);
          expect(await readRegistryEntry(entry.containerName)).toMatchObject(entry);
          expect(transport.dispatched).toEqual([]);
        });
      }
      if (scenario === "changed-engine") {
        mocks.command.mockImplementation(async (args: string[]) =>
          args[3] === "info"
            ? {
                failed: false,
                exitCode: 0,
                stdout: Buffer.from(JSON.stringify({ OSType: "linux", ID: "different-daemon" })),
                stderr: Buffer.alloc(0),
              }
            : transport.execute(args),
        );
        expect(await reconcileForegroundSandboxesAtStartup()).toHaveLength(1);
        expect(await readRegistryEntry(entry.containerName)).toMatchObject({
          foreground: { cleanupUncertain: true },
        });
        expect(transport.dispatched).not.toContain("kill");
        expect(transport.dispatched).not.toContain("rm");
      } else {
        expect(await reconcileForegroundSandboxesAtStartup()).toEqual([]);
        expect(transport.dispatched).toEqual([
          "info",
          "inspect",
          "kill",
          "wait",
          "info",
          "inspect",
          "rm",
        ]);
        expect(await readRegistryEntry(entry.containerName)).toBeNull();
      }
    });
  },
);
