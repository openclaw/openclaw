import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { computeSandboxBrowserConfigHash } from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig } from "./config.js";
import {
  SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
  SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
} from "./constants.js";
import { DOCKER_SANDBOX_ENGINE } from "./container-engine.js";
import { collectDockerFlagValues, findDockerArgsCall } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

const namespaceMocks = vi.hoisted(() => ({
  resolveDockerSourceNamespace: vi
    .fn<typeof import("./docker-mount-source.js").resolveDockerSourceNamespace>()
    .mockResolvedValue(undefined),
  execContainer: vi.fn<typeof import("./container-engine.js").execContainer>(),
}));

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  execDocker: vi.fn(),
  readDockerContainerEnvVar: vi.fn(),
  readDockerContainerLabel: vi.fn(),
  readDockerPort: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  updateBrowserRegistry: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  startBrowserBridgeServer: vi.fn(),
  stopBrowserBridgeServer: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

async function createDockerMock() {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    execDocker: dockerMocks.execDocker,
    readDockerContainerEnvVar: dockerMocks.readDockerContainerEnvVar,
    readDockerContainerLabel: dockerMocks.readDockerContainerLabel,
    readDockerPort: dockerMocks.readDockerPort,
  };
}

vi.mock("./docker.js", createDockerMock);

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
async function createEngineMock() {
  const actual =
    await vi.importActual<typeof import("./container-engine.js")>("./container-engine.js");
  return { ...actual, execContainer: namespaceMocks.execContainer };
}

vi.mock("./container-engine.js", createEngineMock);

function createRegistryMock() {
  return {
    readBrowserRegistry: registryMocks.readBrowserRegistry,
    updateBrowserRegistry: registryMocks.updateBrowserRegistry,
  };
}

vi.mock("./registry.js", createRegistryMock);

function createBridgeMock() {
  return {
    startBrowserBridgeServer: bridgeMocks.startBrowserBridgeServer,
    stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
  };
}

vi.mock("../../plugin-sdk/browser-bridge.js", createBridgeMock);

function createRuntimeMock() {
  return {
    defaultRuntime: runtimeMocks,
  };
}

vi.mock("../../runtime.js", createRuntimeMock);

function createProfilesMock() {
  return {
    DEFAULT_BROWSER_ACTION_TIMEOUT_MS: 60_000,
    DEFAULT_BROWSER_EVALUATE_ENABLED: true,
    DEFAULT_OPENCLAW_BROWSER_COLOR: "#FF4500",
    DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: "openclaw",
    resolveProfile: (
      resolved: { cdpHost: string; cdpIsLoopback: boolean; profiles?: Record<string, unknown> },
      profileName: string,
    ) => {
      const profile = resolved.profiles?.[profileName] as {
        cdpPort?: number;
        cdpUrl?: string;
        color?: string;
      };
      if (typeof profile?.cdpPort !== "number") {
        return null;
      }
      return {
        name: profileName,
        cdpPort: profile.cdpPort,
        cdpUrl: profile.cdpUrl ?? `http://${resolved.cdpHost}:${profile.cdpPort}`,
        cdpHost: resolved.cdpHost,
        cdpIsLoopback: resolved.cdpIsLoopback,
        color: profile.color ?? "#FF4500",
        driver: "openclaw",
        attachOnly: true,
      };
    },
  };
}

vi.mock("../../plugin-sdk/browser-profiles.js", createProfilesMock);

export function createSandboxBrowserTestHarness() {
  // Keep loaded modules and temporary directories per suite. Shared mock modules
  // are reset by the hooks installed for that suite.
  let BROWSER_BRIDGES: Map<string, unknown>;
  let ensureSandboxBrowser: typeof import("./browser.js").ensureSandboxBrowser;
  let prepareSandboxMountPlan: typeof import("./mount-plan.js").prepareSandboxMountPlan;
  let capturedDockerCreateEnvEntries: string[] | undefined;
  let testWorkspaceDir: string;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  async function loadFreshBrowserModulesForTest() {
    vi.resetModules();
    vi.doMock("./docker.js", createDockerMock);
    vi.doMock("./docker-mount-source.js", createNamespaceMock);
    vi.doMock("./container-engine.js", createEngineMock);
    vi.doMock("./registry.js", createRegistryMock);
    vi.doMock("../../plugin-sdk/browser-bridge.js", createBridgeMock);
    vi.doMock("../../runtime.js", createRuntimeMock);
    vi.doMock("../../plugin-sdk/browser-profiles.js", createProfilesMock);
    ({ prepareSandboxMountPlan } = await import("./mount-plan.js"));
    ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
    ({ ensureSandboxBrowser } = await import("./browser.js"));
  }

  function buildConfig(noVncEnabled: boolean): SandboxConfig {
    return {
      mode: "all",
      backend: "docker",
      scope: "session",
      workspaceAccess: "none",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      dockerTmpfsSource: "default",
      docker: {
        image: "openclaw-sandbox:bookworm-slim",
        containerPrefix: "openclaw-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp", "/var/tmp", "/run"],
        network: "none",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      ssh: {
        command: "ssh",
        workspaceRoot: "/tmp/openclaw-sandboxes",
        strictHostKeyChecking: true,
        updateHostKeys: true,
      },
      browser: {
        enabled: true,
        image: "openclaw-sandbox-browser:bookworm-slim",
        containerPrefix: "openclaw-sbx-browser-",
        network: "openclaw-sandbox-browser",
        cdpPort: 9222,
        vncPort: 5900,
        noVncPort: 6080,
        headless: false,
        noVncEnabled,
        allowHostControl: false,
        autoStart: true,
        autoStartTimeoutMs: 12_000,
      },
      tools: {
        allow: ["browser"],
        deny: [],
      },
      prune: {
        idleHours: 24,
        maxAgeDays: 7,
      },
    };
  }

  async function computeTestBrowserHash(params: {
    cfg: SandboxConfig;
    createArgsEpoch: string;
    workspaceDir?: string;
    agentWorkspaceDir?: string;
    dockerEnvPolicyEpoch?: string;
  }): Promise<string> {
    const workspaceDir = params.workspaceDir ?? testWorkspaceDir;
    const agentWorkspaceDir = params.agentWorkspaceDir ?? workspaceDir;
    const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
      docker: params.cfg.docker,
      browser: params.cfg.browser,
    });
    return computeSandboxBrowserConfigHash({
      docker: browserDockerCfg,
      dockerEnvPolicyEpoch: params.dockerEnvPolicyEpoch,
      browser: {
        cdpPort: params.cfg.browser.cdpPort,
        cdpSourceRange: params.cfg.browser.cdpSourceRange,
        vncPort: params.cfg.browser.vncPort,
        noVncPort: params.cfg.browser.noVncPort,
        headless: params.cfg.browser.headless,
        noVncEnabled: params.cfg.browser.noVncEnabled,
        autoStartTimeoutMs: params.cfg.browser.autoStartTimeoutMs,
      },
      securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
      workspaceAccess: params.cfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: params.createArgsEpoch,
      managedMounts: (
        await prepareSandboxMountPlan({
          engine: DOCKER_SANDBOX_ENGINE,
          workspaceDir,
          agentWorkspaceDir,
          workdir: params.cfg.docker.workdir,
          workspaceAccess: params.cfg.workspaceAccess,
          binds: browserDockerCfg.binds,
        })
      ).binds,
    });
  }

  type EnsureSandboxBrowserParams = Parameters<
    typeof import("./browser.js").ensureSandboxBrowser
  >[0];

  async function ensureTestSandboxBrowser(params: Omit<EnsureSandboxBrowserParams, "bridgeAuth">) {
    return await ensureSandboxBrowser({
      ...params,
      bridgeAuth: { token: "test-bridge-token" },
    });
  }

  function requireDockerCreateArgs(): string[] {
    const createArgs = findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create");
    if (!createArgs) {
      throw new Error("expected docker create args");
    }
    return createArgs;
  }

  function snapshotDockerCreateEnvEntries(args: string[]): string[] | undefined {
    const envFile = collectDockerFlagValues(args, "--env-file")[0];
    return envFile ? readFileSync(envFile, "utf8").split("\n").filter(Boolean) : undefined;
  }

  function requireDockerCreateEnvEntries(): string[] {
    if (!capturedDockerCreateEnvEntries) {
      throw new Error("expected the docker create environment file to exist during create");
    }
    return capturedDockerCreateEnvEntries;
  }

  function requireValue<T>(value: T | null | undefined, label: string): T {
    if (value === null || value === undefined) {
      throw new Error(`expected ${label}`);
    }
    return value;
  }

  function latestBridgeResolved(): Record<string, unknown> {
    const params = bridgeMocks.startBrowserBridgeServer.mock.calls.at(-1)?.[0];
    if (!params || typeof params !== "object") {
      throw new Error("expected browser bridge start params");
    }
    const resolved = params.resolved;
    if (!resolved || typeof resolved !== "object") {
      throw new Error("expected resolved browser bridge config");
    }
    return resolved;
  }

  beforeAll(async () => {
    await loadFreshBrowserModulesForTest();
  });

  beforeEach(() => {
    testWorkspaceDir = tempDirs.make("openclaw-browser-workspace-");
    vi.restoreAllMocks();
    BROWSER_BRIDGES.clear();
    namespaceMocks.resolveDockerSourceNamespace.mockResolvedValue(undefined);
    namespaceMocks.execContainer.mockResolvedValue({
      stdout: JSON.stringify({
        Mounts: [{ Type: "bind", Source: testWorkspaceDir, Destination: "/workspace", RW: true }],
        Tmpfs: null,
      }),
      stderr: "",
      code: 0,
    });
    dockerMocks.dockerContainerState.mockClear();
    dockerMocks.execDocker.mockClear();
    dockerMocks.readDockerContainerEnvVar.mockClear();
    dockerMocks.readDockerContainerLabel.mockClear();
    dockerMocks.readDockerPort.mockClear();
    registryMocks.readBrowserRegistry.mockClear();
    registryMocks.updateBrowserRegistry.mockClear();
    bridgeMocks.startBrowserBridgeServer.mockClear();
    bridgeMocks.stopBrowserBridgeServer.mockClear();
    runtimeMocks.log.mockClear();
    capturedDockerCreateEnvEntries = undefined;

    dockerMocks.dockerContainerState.mockResolvedValue({ exists: false, running: false });
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: `${SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "create") {
        capturedDockerCreateEnvEntries = snapshotDockerCreateEnvEntries(args);
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    dockerMocks.readDockerContainerLabel.mockResolvedValue(null);
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(null);
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) => {
      if (port === 9222) {
        return 49100;
      }
      if (port === 6080) {
        return 49101;
      }
      return null;
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.updateBrowserRegistry.mockResolvedValue(undefined);
    bridgeMocks.startBrowserBridgeServer.mockResolvedValue({
      server: { listening: true } as never,
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: {
        server: null,
        port: 19000,
        resolved: { profiles: {} },
        profiles: new Map(),
      },
    });
    bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  return {
    execContainer: namespaceMocks.execContainer,
    resolveDockerSourceNamespace: namespaceMocks.resolveDockerSourceNamespace,
    dockerMocks,
    registryMocks,
    bridgeMocks,
    runtimeMocks,
    tempDirs,
    buildConfig,
    computeTestBrowserHash,
    ensureTestSandboxBrowser,
    requireDockerCreateArgs,
    snapshotDockerCreateEnvEntries,
    requireDockerCreateEnvEntries,
    requireValue,
    latestBridgeResolved,
    get BROWSER_BRIDGES() {
      return BROWSER_BRIDGES;
    },
    get testWorkspaceDir() {
      return testWorkspaceDir;
    },
  };
}
