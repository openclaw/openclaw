import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { DOCKER_SANDBOX_ENGINE } from "./container-engine.js";
import type { SandboxConfig } from "./types.js";

type SpawnCall = {
  command: string;
  args: string[];
  globalArgs: string[];
  envFileContents?: string;
};

const resolveDockerSourceNamespace =
  vi.fn<typeof import("./docker-mount-source.js").resolveDockerSourceNamespace>();

function freshSpawnState() {
  return {
    calls: [] as SpawnCall[],
    containerExists: true,
    inspectRunning: true,
    readOnlyRoot: true,
    inspectError: "",
    createError: "",
    labelHash: "",
    mounts: "[]",
    tmpfs: null as Record<string, string> | null,
    podmanInfo: "true\tfalse\t\t5.0.0\n",
    podmanConnections: "[]\n",
    podmanMachines: "[]\n",
  };
}
const spawnState = freshSpawnState();

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
  completeSandboxRegistryReservation: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({ log: vi.fn() }));

function usePodmanMachine() {
  const machine = {
    Name: "podman-machine-default",
    Running: true,
    IdentityPath: "/tmp/podman-machine-default",
    Port: 60000,
    RemoteUsername: "core",
  };
  spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
  spawnState.podmanConnections = JSON.stringify([
    {
      Name: machine.Name,
      URI: "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      Identity: machine.IdentityPath,
      Default: true,
    },
  ]);
  spawnState.podmanMachines = JSON.stringify([machine]);
}

async function createNamespaceMock() {
  const actual = await vi.importActual<typeof import("./docker-mount-source.js")>(
    "./docker-mount-source.js",
  );
  return {
    parseInspectedSandboxMounts: actual.parseInspectedSandboxMounts,
    translateSandboxMountSources: actual.translateSandboxMountSources,
    resolveDockerSourceNamespace,
  };
}

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...rawArgs] = commandAndArgs;
  const globalArgs: string[] = [];
  let args = rawArgs;
  if (command === "podman") {
    while (args[0] === "--url" || args[0] === "--identity") {
      globalArgs.push(...args.slice(0, 2));
      args = args.slice(2);
    }
  }
  const envFileIndex = args.indexOf("--env-file");
  const envFile = envFileIndex === -1 ? undefined : args[envFileIndex + 1];
  const call: SpawnCall = { command, args, globalArgs };
  if (args[0] === "create" && envFile) {
    call.envFileContents = fs.readFileSync(envFile, "utf8");
  }
  spawnState.calls.push(call);

  const result = (code = 0, stdout = "", stderr = "") => ({
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  });
  const missing = () => result(1, "", "No such object");
  if (command !== "docker" && command !== "podman") {
    return result(1, "", `unexpected command: ${command}`);
  }
  if (args[0] === "inspect") {
    const format = args[2];
    if (args[1] === "-f" && format === "{{.State.Running}}") {
      if (spawnState.inspectError) {
        return result(125, "", spawnState.inspectError);
      }
      return spawnState.containerExists ? result(0, `${spawnState.inspectRunning}\n`) : missing();
    }
    if (
      format ===
      '{{.Id}}\n{{.State.Running}}\n{{.HostConfig.ReadonlyRootfs}}\n{{ index .Config.Labels "openclaw.configHash" }}'
    ) {
      if (spawnState.inspectError) {
        return result(125, "", spawnState.inspectError);
      }
      return spawnState.containerExists
        ? result(
            0,
            `${"c".repeat(64)}\n${spawnState.inspectRunning}\n${spawnState.readOnlyRoot}\n${spawnState.labelHash}\n`,
          )
        : missing();
    }
    if (format === "{{.Id}}") {
      return result(0, "c".repeat(64));
    }
    if (format === '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}') {
      return result(
        0,
        JSON.stringify({ Mounts: JSON.parse(spawnState.mounts), Tmpfs: spawnState.tmpfs }),
      );
    }
  }
  if (command === "podman") {
    const output = new Map([
      ["info", spawnState.podmanInfo],
      ["system", spawnState.podmanConnections],
      ["machine", spawnState.podmanMachines],
    ]).get(args[0] ?? "");
    if (output !== undefined) {
      return result(0, output);
    }
  }
  if (args[0] === "rm" && args[1] === "-f") {
    spawnState.containerExists = spawnState.inspectRunning = false;
  } else if (args[0] === "create") {
    if (spawnState.createError) {
      return result(125, "", spawnState.createError);
    }
    if (spawnState.containerExists) {
      return result(1, "", "container name is already in use");
    }
    spawnState.containerExists = true;
    spawnState.inspectRunning = false;
    const label = args.find((arg) => arg.startsWith("openclaw.configHash="));
    spawnState.labelHash = label?.slice("openclaw.configHash=".length) ?? "";
    return result(0, "c".repeat(64));
  } else if (args[0] === "start") {
    spawnState.inspectRunning = true;
  } else if (args[0] !== "exec" && !(args[0] === "image" && args[1] === "inspect")) {
    return result(1, "", `unexpected docker args: ${args.join(" ")}`);
  }
  return result();
}

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  const defaults = resolveSandboxConfigForAgent();
  return {
    ...defaults,
    scope: "shared",
    workspaceAccess,
    docker: {
      ...defaults.docker,
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      env,
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
  };
}

export function createSandboxContainerTestHarness() {
  let docker: typeof import("./docker.js");
  let prepareSandboxMountPlan: typeof import("./mount-plan.js").prepareSandboxMountPlan;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeAll(async () => {
    vi.resetModules();
    // mock-isolation: keep container registration in the suite-owned registry fixture.
    vi.doMock("./registry.js", () => registryMocks);
    // mock-isolation: route runtime logging and exits to fixture spies.
    vi.doMock("../../runtime.js", () => ({ defaultRuntime: runtimeMocks }));
    // mock-isolation: model container namespaces without consulting host mount state.
    vi.doMock("./docker-mount-source.js", createNamespaceMock);
    vi.doMock("../../process/exec.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../process/exec.js")>()),
      spawnCommand: spawnDockerProcess,
    }));
    ({ prepareSandboxMountPlan } = await import("./mount-plan.js"));
    docker = await import("./docker.js");
  });

  async function computeTestSandboxHash(input: Parameters<typeof computeSandboxConfigHash>[0]) {
    const plan = await prepareSandboxMountPlan({
      engine: DOCKER_SANDBOX_ENGINE,
      workspaceDir: input.workspaceDir,
      agentWorkspaceDir: input.agentWorkspaceDir,
      workdir: input.docker.workdir,
      workspaceAccess: input.workspaceAccess,
      binds: input.docker.binds,
    });
    return computeSandboxConfigHash({ ...input, managedMounts: plan.binds });
  }

  async function ensureSandboxCreateCallForTest(params: {
    cfg: SandboxConfig;
    workspaceDir?: string;
    scopeKey?: string;
    engine?: import("./docker.js").SandboxContainerEngine;
  }): Promise<SpawnCall> {
    const workspaceDir = params.workspaceDir ?? "/tmp/workspace";
    await docker.ensureSandboxContainer({
      scopeKey: params.scopeKey ?? "shared",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: params.cfg,
      engine: params.engine ?? DOCKER_SANDBOX_ENGINE,
    });

    const createCall = spawnState.calls.find(
      (call) => call.command === (params.engine?.command ?? "docker") && call.args[0] === "create",
    );
    if (!createCall) {
      throw new Error(`expected ${params.engine?.command ?? "docker"} create call`);
    }
    return createCall;
  }

  beforeEach(() => {
    Object.assign(spawnState, freshSpawnState());
    resolveDockerSourceNamespace.mockResolvedValue(undefined);
    registryMocks.readRegistryEntry.mockClear();
    registryMocks.removeRegistryEntry.mockClear().mockResolvedValue(undefined);
    registryMocks.updateRegistry.mockClear().mockResolvedValue(undefined);
    registryMocks.completeSandboxRegistryReservation.mockClear().mockResolvedValue(undefined);
    runtimeMocks.log.mockClear();
  });

  return {
    resolveDockerSourceNamespace,
    spawnState,
    registryMocks,
    tempDirs,
    usePodmanMachine,
    createSandboxConfig,
    computeTestSandboxHash,
    ensureSandboxCreateCallForTest,
    ensureSandboxContainer(
      params: Omit<Parameters<typeof docker.ensureSandboxContainer>[0], "engine"> & {
        engine?: import("./docker.js").SandboxContainerEngine;
      },
    ) {
      return docker.ensureSandboxContainer({ engine: DOCKER_SANDBOX_ENGINE, ...params });
    },
    get resolveDockerEnvPolicyEpoch() {
      return docker.resolveDockerEnvPolicyEpoch;
    },
    get PODMAN_SANDBOX_ENGINE() {
      return docker.PODMAN_SANDBOX_ENGINE;
    },
  };
}
