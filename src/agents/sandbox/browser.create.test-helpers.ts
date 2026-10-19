import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { computeSandboxBrowserConfigHash } from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig, resolveSandboxConfigForAgent } from "./config.js";
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

const runtimeMocks = vi.hoisted(() => ({ log: vi.fn() }));

async function createDockerMock() {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return { ...actual, ...dockerMocks };
}

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

async function createEngineMock() {
  const actual =
    await vi.importActual<typeof import("./container-engine.js")>("./container-engine.js");
  return { ...actual, execContainer: namespaceMocks.execContainer };
}

async function createProfilesMock() {
  const actual = await vi.importActual<typeof import("../../plugin-sdk/browser-profiles.js")>(
    "../../plugin-sdk/browser-profiles.js",
  );
  return {
    ...actual,
    resolveProfile: (
      resolved: {
        cdpHost: string;
        profiles?: Record<string, { cdpPort?: number; cdpUrl?: string }>;
      },
      profileName: string,
    ) => {
      const profile = resolved.profiles?.[profileName];
      if (typeof profile?.cdpPort !== "number") {
        return null;
      }
      return {
        cdpPort: profile.cdpPort,
        cdpUrl: profile.cdpUrl ?? `http://${resolved.cdpHost}:${profile.cdpPort}`,
      };
    },
  };
}

export function createSandboxBrowserTestHarness(scopeKey = "session:test") {
  let BROWSER_BRIDGES: Map<string, unknown>;
  let ensureSandboxBrowser: typeof import("./browser.js").ensureSandboxBrowser;
  let prepareSandboxMountPlan: typeof import("./mount-plan.js").prepareSandboxMountPlan;
  let capturedDockerCreateEnvEntries: string[] | undefined;
  let testWorkspaceDir: string;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./docker.js", createDockerMock);
    vi.doMock("./docker-mount-source.js", createNamespaceMock);
    vi.doMock("./container-engine.js", createEngineMock);
    // mock-isolation: keep sandbox registry reads and writes in the suite fixture.
    vi.doMock("./registry.js", () => registryMocks);
    // mock-isolation: browser bridge lifecycle is simulated without opening live bridges.
    vi.doMock("../../plugin-sdk/browser-bridge.js", () => bridgeMocks);
    // mock-isolation: capture runtime logging and exits through the fixture.
    vi.doMock("../../runtime.js", () => ({ defaultRuntime: runtimeMocks }));
    vi.doMock("../../plugin-sdk/browser-profiles.js", createProfilesMock);
    ({ prepareSandboxMountPlan } = await import("./mount-plan.js"));
    ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
    ({ ensureSandboxBrowser } = await import("./browser.js"));
  });

  function buildConfig(noVncEnabled: boolean): SandboxConfig {
    const defaults = resolveSandboxConfigForAgent();
    return {
      ...defaults,
      scope: "session",
      browser: { ...defaults.browser, enabled: true, noVncEnabled },
      tools: { allow: ["browser"], deny: [] },
    };
  }

  async function computeTestBrowserHash(params: {
    cfg: SandboxConfig;
    createArgsEpoch: string;
  }): Promise<string> {
    const workspace = {
      workspaceDir: testWorkspaceDir,
      agentWorkspaceDir: testWorkspaceDir,
      workspaceAccess: params.cfg.workspaceAccess,
    };
    const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig(params.cfg);
    return computeSandboxBrowserConfigHash({
      docker: browserDockerCfg,
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
      ...workspace,
      mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
      createArgsEpoch: params.createArgsEpoch,
      managedMounts: (
        await prepareSandboxMountPlan({
          engine: DOCKER_SANDBOX_ENGINE,
          ...workspace,
          workdir: params.cfg.docker.workdir,
          binds: browserDockerCfg.binds,
        })
      ).binds,
    });
  }

  type EnsureSandboxBrowserParams = Parameters<typeof ensureSandboxBrowser>[0];

  async function ensureTestSandboxBrowser(
    params: Partial<Omit<EnsureSandboxBrowserParams, "bridgeAuth">> = {},
  ) {
    const workspaceDir = params.workspaceDir ?? testWorkspaceDir;
    return await ensureSandboxBrowser({
      scopeKey,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: buildConfig(false),
      evaluateEnabled: true,
      ...params,
      bridgeAuth: { token: "test-bridge-token" },
    });
  }

  function requireDockerCreateArgs(): string[] {
    return requireValue(
      findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create"),
      "docker create args",
    );
  }

  function snapshotDockerCreateEnvEntries(args: string[]): string[] | undefined {
    const envFile = collectDockerFlagValues(args, "--env-file")[0];
    return envFile ? readFileSync(envFile, "utf8").split("\n").filter(Boolean) : undefined;
  }

  function requireDockerCreateEnvEntries(): string[] {
    return requireValue(capturedDockerCreateEnvEntries, "docker create environment file");
  }

  function requireValue<T>(value: T | null | undefined, label: string): T {
    if (value === null || value === undefined) {
      throw new Error(`expected ${label}`);
    }
    return value;
  }

  function envValue(key: string, entries = requireDockerCreateEnvEntries()) {
    const value = requireValue(
      entries.find((entry) => entry.startsWith(`${key}=`)),
      key,
    );
    return value.slice(key.length + 1);
  }

  function reuseCreatedBrowser() {
    const entry = requireValue(
      registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[0],
      "browser registry entry",
    );
    dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
    const token = envValue("OPENCLAW_BROWSER_CDP_AUTH_TOKEN");
    dockerMocks.readDockerContainerEnvVar.mockResolvedValue(token);
    dockerMocks.readDockerContainerLabel.mockResolvedValue(entry.configHash);
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [entry] });
  }

  function bridgeFixture(resolved: unknown = { profiles: {} }) {
    return {
      server: { listening: true },
      port: 19000,
      baseUrl: "http://127.0.0.1:19000",
      state: { server: null, port: 19000, resolved, profiles: new Map() },
    };
  }

  function latestBridgeResolved(): Record<string, unknown> {
    return requireValue(
      bridgeMocks.startBrowserBridgeServer.mock.calls.at(-1)?.[0].resolved,
      "resolved browser config",
    );
  }

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
    for (const mock of [dockerMocks, registryMocks, bridgeMocks, runtimeMocks].flatMap(
      Object.values,
    )) {
      mock.mockClear();
    }
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
    dockerMocks.readDockerPort.mockImplementation(async (_containerName: string, port: number) =>
      port === 9222 ? 49100 : port === 6080 ? 49101 : null,
    );
    registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [] });
    registryMocks.updateBrowserRegistry.mockResolvedValue(undefined);
    bridgeMocks.startBrowserBridgeServer.mockResolvedValue(bridgeFixture());
    bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
  });

  return {
    execContainer: namespaceMocks.execContainer,
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
    envValue,
    reuseCreatedBrowser,
    bridgeFixture,
    get BROWSER_BRIDGES() {
      return BROWSER_BRIDGES;
    },
    get testWorkspaceDir() {
      return testWorkspaceDir;
    },
  };
}
