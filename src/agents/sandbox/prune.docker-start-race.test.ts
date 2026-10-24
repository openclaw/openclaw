import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const docker = vi.hoisted(() => ({
  container: null as null | { id: string; hash: string; running: boolean },
  created: 0,
  beforeStart: undefined as undefined | (() => Promise<void>),
  beforeSetup: undefined as undefined | (() => Promise<void>),
  afterScan: undefined as undefined | (() => void),
}));

// mock-isolation: model one Docker container; registry, cleanup, and locks stay real.
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: async ([, ...args]: string[]) => {
    const result = (code = 0, stdout = "", stderr = "") => ({
      failed: code !== 0,
      isCanceled: false,
      exitCode: code,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
    });
    const container = docker.container;
    const [operation, ...rest] = args;
    if (operation === "image") {
      return result();
    }
    if (operation === "create") {
      docker.created += 1;
      const hash = rest.find((arg) => arg.startsWith("openclaw.configHash="));
      docker.container = {
        id: String(docker.created).repeat(64),
        hash: hash?.slice("openclaw.configHash=".length) ?? "",
        running: false,
      };
      return result(0, docker.container.id);
    }
    if (!container) {
      return result(1, "", "Error response from daemon: No such container");
    }
    if (operation === "inspect") {
      const format = rest.at(-2) ?? "";
      if (format === "{{.State.Running}}") {
        return result(0, `${container.running}\n`);
      }
      if (format === "{{.Id}}") {
        return result(0, container.id);
      }
      if (format.includes("openclaw.configHash")) {
        return result(0, `${container.hash}\n`);
      }
    }
    if (operation === "start") {
      await docker.beforeStart?.();
      container.running = true;
      return result();
    }
    if (operation === "exec") {
      await docker.beforeSetup?.();
      return result();
    }
    if (operation === "rm") {
      docker.container = null;
      return result();
    }
    return result(1, "", `unexpected docker args: ${args.join(" ")}`);
  },
}));

// mock-isolation: keep mount planning off the host's container namespace.
vi.mock("./docker-mount-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-mount-source.js")>()),
  resolveDockerSourceNamespace: async () => undefined,
}));

vi.mock("./registry.js", async (importOriginal) => {
  const registry = await importOriginal<typeof import("./registry.js")>();
  return {
    ...registry,
    readRegistry: async () => {
      const scanned = await registry.readRegistry();
      docker.afterScan?.();
      return scanned;
    },
  };
});

const HOUR_MS = 60 * 60 * 1000;

let sandbox: {
  config: typeof import("./config.js");
  dockerBackend: typeof import("./docker-backend.js");
  docker: typeof import("./docker.js");
  prune: typeof import("./prune.js");
  registry: typeof import("./registry.js");
};

beforeEach(async () => {
  vi.resetModules();
  sandbox = {
    config: await import("./config.js"),
    dockerBackend: await import("./docker-backend.js"),
    docker: await import("./docker.js"),
    prune: await import("./prune.js"),
    registry: await import("./registry.js"),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(docker, {
    container: null,
    created: 0,
    beforeStart: undefined,
    beforeSetup: undefined,
    afterScan: undefined,
  });
});

async function withIdleContainer(
  prune: { idleHours: number; maxAgeDays: number },
  options: { setupCommand?: string; workspaceSource?: "managed-worktree"; createdAtMs?: number },
  run: (
    params: Parameters<typeof import("./docker.js").ensureSandboxContainer>[0],
  ) => Promise<void>,
) {
  await withOpenClawTestState({ label: "sandbox-prune-start-race" }, async (state) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: { mode: "all", prune, docker: { setupCommand: options.setupCommand } },
        },
      },
    };
    const params = {
      engine: sandbox.docker.DOCKER_SANDBOX_ENGINE,
      scopeKey: "agent:main:main",
      workspaceDir: state.workspaceDir,
      workspaceSource: options.workspaceSource,
      agentWorkspaceDir: state.workspaceDir,
      cfg: sandbox.config.resolveSandboxConfigForAgent(config, "main"),
    };
    const clock =
      options.createdAtMs === undefined
        ? undefined
        : vi.spyOn(Date, "now").mockReturnValue(options.createdAtMs);
    const { containerName } = await sandbox.docker.ensureSandboxContainer(params);
    clock?.mockRestore();
    const idle = await sandbox.registry.readRegistryEntry(containerName);
    await sandbox.registry.updateRegistry({ ...idle!, lastUsedAtMs: Date.now() - 2 * HOUR_MS });
    docker.container!.running = false;
    await run(params);
  });
}

async function expectStartedContainerKept(
  started: { containerName: string; containerId: string },
  startedAtMs: number,
) {
  expect(docker.container, "the started container must survive cleanup").toEqual({
    id: started.containerId,
    hash: expect.any(String),
    running: true,
  });
  const recorded = await sandbox.registry.readRegistryEntry(started.containerName);
  expect(recorded?.lastUsedAtMs, "the run records its use").toBeGreaterThanOrEqual(startedAtMs);
  expect(["removing", "removing-pending"], "cleanup leaves no removal intent behind").not.toContain(
    recorded?.runtimeState,
  );
}

describe("sandbox prune and Docker container start", () => {
  it("keeps a container that a run starts while cleanup removes its idle predecessor", async () => {
    const prune = { idleHours: 1, maxAgeDays: 0 };
    await withIdleContainer(prune, {}, async (params) => {
      const removeRuntime = sandbox.dockerBackend.dockerSandboxBackendManager.removeRuntime.bind(
        sandbox.dockerBackend.dockerSandboxBackendManager,
      );
      const removing = createDeferred();
      const releaseRemoval = createDeferred();
      vi.spyOn(
        sandbox.dockerBackend.dockerSandboxBackendManager,
        "removeRuntime",
      ).mockImplementation(async (input) => {
        removing.resolve();
        await releaseRemoval.promise;
        return await removeRuntime(input);
      });

      const pruning = sandbox.prune.maybePruneSandboxes({
        agents: { defaults: { sandbox: { mode: "all", prune } } },
      });
      await awaitGateBeforeSettlement(
        removing.promise,
        pruning,
        "Cleanup settled without selecting the idle container",
      );
      const startedAtMs = Date.now();
      const starting = sandbox.docker.ensureSandboxContainer(params);
      releaseRemoval.resolve();
      const [started] = await Promise.all([starting, pruning]);

      await expectStartedContainerKept(started, startedAtMs);
    });
  });

  it("keeps an expired setup container that a run starts before cleanup removes it", async () => {
    const prune = { idleHours: 1, maxAgeDays: 1 };
    await withIdleContainer(
      prune,
      { setupCommand: "echo ready", createdAtMs: Date.now() - 2 * 24 * HOUR_MS },
      async (params) => {
        const startEntered = createDeferred();
        const releaseStart = createDeferred();
        docker.beforeStart = async () => {
          startEntered.resolve();
          await releaseStart.promise;
        };
        const scanned = createDeferred();
        docker.afterScan = scanned.resolve;

        const startedAtMs = Date.now();
        const starting = sandbox.docker.ensureSandboxContainer(params);
        await awaitGateBeforeSettlement(
          startEntered.promise,
          starting,
          "The run settled without starting its container",
        );
        const pruning = sandbox.prune.maybePruneSandboxes({
          agents: { defaults: { sandbox: { mode: "all", prune } } },
        });
        await awaitGateBeforeSettlement(
          scanned.promise,
          pruning,
          "Cleanup settled without scanning the registry",
        );
        releaseStart.resolve();
        const [started] = await Promise.all([starting, pruning]);

        await expectStartedContainerKept(started, startedAtMs);
      },
    );
  });

  it.each([
    { kind: "setup", options: { setupCommand: "echo ready" }, pause: "beforeSetup" },
    {
      kind: "managed-worktree",
      options: { workspaceSource: "managed-worktree" },
      pause: "beforeStart",
    },
  ] as const)(
    "keeps an expired $kind container that a run recreates while cleanup scans it",
    async ({ options, pause }) => {
      const prune = { idleHours: 1, maxAgeDays: 1 };
      await withIdleContainer(
        prune,
        { ...options, createdAtMs: Date.now() - 2 * 24 * HOUR_MS },
        async (params) => {
          docker.container!.hash = "stale-config";
          const paused = createDeferred();
          const release = createDeferred();
          docker[pause] = async () => {
            paused.resolve();
            await release.promise;
          };
          const scanned = createDeferred();
          docker.afterScan = scanned.resolve;

          const startedAtMs = Date.now();
          const starting = sandbox.docker.ensureSandboxContainer(params);
          await awaitGateBeforeSettlement(
            paused.promise,
            starting,
            "The run settled without reaching its paused container step",
          );
          const pruning = sandbox.prune.maybePruneSandboxes({
            agents: { defaults: { sandbox: { mode: "all", prune } } },
          });
          await awaitGateBeforeSettlement(
            scanned.promise,
            pruning,
            "Cleanup settled without scanning the registry",
          );
          const now = Date.now.bind(Date);
          vi.spyOn(Date, "now").mockImplementation(() => now() + 1000);
          release.resolve();
          const [started] = await Promise.all([starting, pruning]);

          expect(docker.created, "the run replaced the stale container").toBe(2);
          await expectStartedContainerKept(started, startedAtMs);
        },
      );
    },
  );
});
