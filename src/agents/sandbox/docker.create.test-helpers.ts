import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { DOCKER_SANDBOX_ENGINE } from "./container-engine.js";
import type { SandboxConfig } from "./types.js";

type SpawnCall = {
  command: string;
  args: string[];
  globalArgs: string[];
  envFileContents?: string;
};

const namespaceMocks = vi.hoisted(() => ({
  resolveDockerSourceNamespace: vi
    .fn<typeof import("./docker-mount-source.js").resolveDockerSourceNamespace>()
    .mockResolvedValue(undefined),
}));

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  containerExists: true,
  inspectRunning: true,
  inspectError: "",
  createError: "",
  labelHash: "",
  mounts: "[]",
  tmpfs: null as Record<string, string> | null,
  podmanInfo: "true\tfalse\t\t5.0.0\n",
  podmanConnections: "[]\n",
  podmanMachines: "[]\n",
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

function usePodmanMachine() {
  spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
  spawnState.podmanConnections = JSON.stringify([
    {
      Name: "podman-machine-default",
      URI: "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
      Identity: "/tmp/podman-machine-default",
      Default: true,
    },
  ]);
  spawnState.podmanMachines = JSON.stringify([
    {
      Name: "podman-machine-default",
      Running: true,
      IdentityPath: "/tmp/podman-machine-default",
      Port: 60000,
      RemoteUsername: "core",
    },
  ]);
}

function createRegistryMock() {
  return {
    readRegistryEntry: registryMocks.readRegistryEntry,
    removeRegistryEntry: registryMocks.removeRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  };
}

vi.mock("./registry.js", createRegistryMock);

function createRuntimeMock() {
  return {
    defaultRuntime: runtimeMocks,
  };
}

vi.mock("../../runtime.js", createRuntimeMock);

async function createNamespaceMock() {
  const actual = await vi.importActual<typeof import("./docker-mount-source.js")>(
    "./docker-mount-source.js",
  );
  return {
    parseInspectedSandboxMounts: actual.parseInspectedSandboxMounts,
    translateSandboxMountSources: actual.translateSandboxMountSources,
    resolveDockerSourceNamespace: namespaceMocks.resolveDockerSourceNamespace,
  };
}

vi.mock("./docker-mount-source.js", createNamespaceMock);

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
  // The tests assert docker CLI arguments without requiring Docker; this mock
  // implements only the inspect/create/start/rm calls used by ensureSandboxContainer.
  const envFileIndex = args.indexOf("--env-file");
  const envFile = envFileIndex === -1 ? undefined : args[envFileIndex + 1];
  const call: SpawnCall = { command, args, globalArgs };
  if (args[0] === "create" && envFile) {
    call.envFileContents = fs.readFileSync(envFile, "utf8");
  }
  spawnState.calls.push(call);

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker" && command !== "podman") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
    if (spawnState.inspectError) {
      code = 125;
      stderr = spawnState.inspectError;
    } else if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = spawnState.inspectRunning ? "true\n" : "false\n";
    }
  } else if (
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2]?.includes('index .Config.Labels "openclaw.configHash"')
  ) {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = `${spawnState.labelHash}\n`;
    }
  } else if (
    args[0] === "inspect" &&
    args[2] === '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}'
  ) {
    stdout = JSON.stringify({ Mounts: JSON.parse(spawnState.mounts), Tmpfs: spawnState.tmpfs });
  } else if (command === "podman" && args[0] === "info") {
    stdout = spawnState.podmanInfo;
  } else if (command === "podman" && args[0] === "system") {
    stdout = spawnState.podmanConnections;
  } else if (command === "podman" && args[0] === "machine") {
    stdout = spawnState.podmanMachines;
  } else if (args[0] === "rm" && args[1] === "-f") {
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
  } else if (args[0] === "image" && args[1] === "inspect") {
    code = 0;
  } else if (args[0] === "create") {
    if (spawnState.createError) {
      code = 125;
      stderr = spawnState.createError;
    } else if (spawnState.containerExists) {
      code = 1;
      stderr = "container name is already in use";
    } else {
      spawnState.containerExists = true;
      spawnState.inspectRunning = false;
      spawnState.labelHash =
        args
          .find((arg) => arg.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length) ?? "";
    }
  } else if (args[0] === "start") {
    spawnState.inspectRunning = true;
  } else if (args[0] === "exec") {
    code = 0;
  } else {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

async function createProcessMock() {
  return {
    ...(await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js")),
    spawnCommand: spawnDockerProcess,
  };
}

vi.mock("../../process/exec.js", createProcessMock);

function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env,
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

export function createSandboxContainerTestHarness() {
  // Keep loaded modules and temporary directories per suite. Shared mock modules
  // are reset by the hooks installed for that suite.
  let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;
  let resolveDockerEnvPolicyEpoch: typeof import("./docker.js").resolveDockerEnvPolicyEpoch;
  let PODMAN_SANDBOX_ENGINE: typeof import("./docker.js").PODMAN_SANDBOX_ENGINE;
  let prepareSandboxMountPlan: typeof import("./mount-plan.js").prepareSandboxMountPlan;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./registry.js", createRegistryMock);
    vi.doMock("../../runtime.js", createRuntimeMock);
    vi.doMock("./docker-mount-source.js", createNamespaceMock);
    vi.doMock("../../process/exec.js", createProcessMock);
    ({ prepareSandboxMountPlan } = await import("./mount-plan.js"));
    ({ ensureSandboxContainer, resolveDockerEnvPolicyEpoch, PODMAN_SANDBOX_ENGINE } =
      await import("./docker.js"));
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
    await ensureSandboxContainer({
      scopeKey: params.scopeKey ?? "shared",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: params.cfg,
      ...(params.engine ? { engine: params.engine } : {}),
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
    spawnState.calls.length = 0;
    spawnState.containerExists = true;
    spawnState.inspectRunning = true;
    spawnState.inspectError = "";
    spawnState.createError = "";
    spawnState.labelHash = "";
    spawnState.mounts = "[]";
    spawnState.tmpfs = null;
    namespaceMocks.resolveDockerSourceNamespace.mockResolvedValue(undefined);
    spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
    spawnState.podmanConnections = "[]\n";
    spawnState.podmanMachines = "[]\n";
    registryMocks.readRegistryEntry.mockClear();
    registryMocks.removeRegistryEntry.mockClear();
    registryMocks.removeRegistryEntry.mockResolvedValue(undefined);
    registryMocks.updateRegistry.mockClear();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
    runtimeMocks.log.mockClear();
  });

  return {
    resolveDockerSourceNamespace: namespaceMocks.resolveDockerSourceNamespace,
    spawnState,
    registryMocks,
    runtimeMocks,
    tempDirs,
    usePodmanMachine,
    createSandboxConfig,
    computeTestSandboxHash,
    ensureSandboxCreateCallForTest,
    get ensureSandboxContainer() {
      return ensureSandboxContainer;
    },
    get resolveDockerEnvPolicyEpoch() {
      return resolveDockerEnvPolicyEpoch;
    },
    get PODMAN_SANDBOX_ENGINE() {
      return PODMAN_SANDBOX_ENGINE;
    },
  };
}
