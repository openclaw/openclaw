import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { computeSandboxBrowserConfigHash } from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig, resolveSandboxConfigForAgent } from "./config.js";
import {
  SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
  SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
  SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
} from "./constants.js";
import { DOCKER_SANDBOX_ENGINE } from "./container-engine.js";
import { acquireSandboxGatewayOwner } from "./registry.test-support.js";
import { captureSandboxStateOwner } from "./state-owner.js";
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

const scopeKey = "session:test";
let BROWSER_BRIDGES: Map<string, unknown>;
let ensureSandboxBrowser: typeof import("./browser.js").ensureSandboxBrowser;
let prepareSandboxMountPlan: typeof import("./mount-plan.js").prepareSandboxMountPlan;
let capturedDockerCreateEnvEntries: string[] | undefined;
let testWorkspaceDir: string;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("./docker.js", createDockerMock);
  // mock-isolation: retain real mount parsing/translation while pinning the Docker source namespace.
  vi.doMock("./docker-mount-source.js", async () => ({
    ...(await vi.importActual<typeof import("./docker-mount-source.js")>(
      "./docker-mount-source.js",
    )),
    resolveDockerSourceNamespace: namespaceMocks.resolveDockerSourceNamespace,
  }));
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
  return expectDefined(
    findDockerArgsCall(dockerMocks.execDocker.mock.calls, "create"),
    "docker create args",
  );
}

function snapshotDockerCreateEnvEntries(args: string[]): string[] | undefined {
  const envFile = collectDockerFlagValues(args, "--env-file")[0];
  return envFile ? readFileSync(envFile, "utf8").split("\n").filter(Boolean) : undefined;
}

function requireDockerCreateEnvEntries(): string[] {
  return expectDefined(capturedDockerCreateEnvEntries, "docker create environment file");
}

function envValue(key: string, entries = requireDockerCreateEnvEntries()) {
  return expectDefined(
    entries.find((entry) => entry.startsWith(`${key}=`)),
    key,
  ).slice(key.length + 1);
}

function reuseCreatedBrowser() {
  const entry = expectDefined(
    registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[0],
    "browser registry entry",
  );
  dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
  const token = envValue("OPENCLAW_BROWSER_CDP_AUTH_TOKEN");
  dockerMocks.readDockerContainerEnvVar.mockResolvedValue(token);
  dockerMocks.readDockerContainerLabel.mockResolvedValue(entry.configHash);
  registryMocks.readBrowserRegistry.mockResolvedValue({ entries: [entry] });
}

const browserName = "openclaw-sbx-browser-session-test-0661d10a";
function seedExistingBrowser(
  hash: string | null = null,
  token: string | null = null,
  cached = true,
) {
  dockerMocks.dockerContainerState.mockResolvedValue({ exists: true, running: true });
  dockerMocks.readDockerContainerEnvVar.mockResolvedValue(token);
  dockerMocks.readDockerContainerLabel.mockResolvedValue(hash);
  const bridge = { containerName: browserName, bridge: { server: { listening: true } } };
  if (cached) {
    BROWSER_BRIDGES.set(scopeKey, bridge);
  }
  return bridge;
}

function inspectWorkspace(tmpfs: Record<string, string> | null = null) {
  namespaceMocks.execContainer.mockResolvedValue({
    stdout: JSON.stringify({
      Mounts: [{ Type: "bind", Source: testWorkspaceDir, Destination: "/workspace", RW: true }],
      Tmpfs: tmpfs,
    }),
    stderr: "",
    code: 0,
  });
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
  return expectDefined(
    bridgeMocks.startBrowserBridgeServer.mock.calls.at(-1)?.[0].resolved,
    "resolved browser config",
  );
}

beforeEach(() => {
  testWorkspaceDir = tempDirs.make("openclaw-browser-workspace-");
  vi.restoreAllMocks();
  BROWSER_BRIDGES.clear();
  namespaceMocks.resolveDockerSourceNamespace.mockResolvedValue(undefined);
  inspectWorkspace();
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
  bridgeMocks.startBrowserBridgeServer.mockImplementation(async ({ resolved }) =>
    bridgeFixture(resolved),
  );
  bridgeMocks.stopBrowserBridgeServer.mockResolvedValue(undefined);
});

describe("sandbox browser lifecycle", () => {
  const { execDocker, dockerContainerState } = dockerMocks;
  const { updateBrowserRegistry } = registryMocks;
  const { startBrowserBridgeServer, stopBrowserBridgeServer } = bridgeMocks;

  const dockerArgs = (command: string) =>
    findDockerArgsCall(dockerMocks.execDocker.mock.calls, command);
  const dockerCalls = (command: string) =>
    dockerMocks.execDocker.mock.calls.filter(([args]) => args[0] === command);
  function expectBridgeStoppedBeforeRemoval() {
    const index = dockerMocks.execDocker.mock.calls.findIndex(([args]) => args[0] === "rm");
    expect(bridgeMocks.stopBrowserBridgeServer.mock.invocationCallOrder[0]).toBeLessThan(
      dockerMocks.execDocker.mock.invocationCallOrder[index] ?? Number.MAX_SAFE_INTEGER,
    );
  }
  const attach = (index = 0) => {
    const callback = startBrowserBridgeServer.mock.calls[index]?.[0].onEnsureAttachTarget;
    expect(callback).toBeTypeOf("function");
    return expectDefined(callback, "browser attach callback")({});
  };
  const custody = (managed: boolean, assertCurrent: () => void) =>
    managed
      ? {
          withWorkspace: async <T>(run: () => Promise<T>) => {
            assertCurrent();
            return await run();
          },
        }
      : { assertCurrent };

  it.each([
    {
      stdout: "<no value>\n",
      stderr: "",
      code: 0,
      error: "Sandbox browser image openclaw-sandbox-browser:trixie-slim is stale or incompatible",
    },
    {
      stdout: "",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      code: 1,
      error: "Docker daemon is not available",
    },
  ])("rejects image inspection before creation: $error", async ({ error, ...result }) => {
    dockerMocks.execDocker.mockImplementation(async (args: string[]) =>
      args[0] === "image" && args[1] === "inspect" ? result : { stdout: "", stderr: "", code: 0 },
    );
    await expect(ensureTestSandboxBrowser()).rejects.toThrow(error);
    expect(dockerArgs("create")).toBeUndefined();
  });

  it("keeps the browser Dockerfile contract label aligned with the runtime constant", () => {
    const dockerfile = readFileSync(
      new URL("../../../scripts/docker/sandbox/Dockerfile.browser", import.meta.url),
      "utf8",
    );
    const label = dockerfile.match(
      /^LABEL org\.openclaw\.sandbox-browser\.contract="([^"]+)"$/m,
    )?.[1];

    expect(label).toBe(SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH);
  });

  it.each([undefined, "10.0.0.0/24"])(
    "delivers configured browser and generated CDP/noVNC environment without argv values (relay filter=%s)",
    async (cdpSourceRange) => {
      const configuredSentinel = "synthetic-browser-transport-value";
      const cfg = buildConfig(true);
      cfg.docker.env = { ...cfg.docker.env, BROWSER_TRANSPORT_SENTINEL: configuredSentinel };
      cfg.browser.cdpSourceRange = cdpSourceRange;
      const result = await ensureTestSandboxBrowser({ cfg });

      const createArgs = requireDockerCreateArgs();
      expect(createArgs.filter((arg) => arg === "--init")).toHaveLength(1);
      expect(createArgs).toContain(`openclaw.createArgsEpoch=${SANDBOX_DOCKER_CREATE_ARGS_EPOCH}`);

      expect(createArgs.some((arg) => arg.includes(configuredSentinel))).toBe(false);
      expect(createArgs).toContain("127.0.0.1::6080");
      expect(collectDockerFlagValues(createArgs, "--env-file")).toHaveLength(1);
      expect(createArgs).not.toContain("-e");
      expect(createArgs).not.toContain("--env");
      const envEntries = requireDockerCreateEnvEntries();
      expect(envEntries).toContain(`BROWSER_TRANSPORT_SENTINEL=${configuredSentinel}`);
      expect(envEntries).toContain("OPENCLAW_BROWSER_NO_SANDBOX=1");
      const noVncPassword = envValue("OPENCLAW_BROWSER_NOVNC_PASSWORD");
      const cdpAuthToken = envValue("OPENCLAW_BROWSER_CDP_AUTH_TOKEN");
      expect(noVncPassword).toMatch(/^[A-Za-z0-9]{8}$/);
      expect(cdpAuthToken).toMatch(/^[0-9a-f]{48}$/);
      expect(createArgs.some((arg) => arg.includes(noVncPassword))).toBe(false);
      expect(createArgs.some((arg) => arg.includes(cdpAuthToken))).toBe(false);
      expect(envEntries).not.toContain("OPENCLAW_BROWSER_CDP_SOURCE_RANGE=172.21.0.1/32");
      if (cdpSourceRange) {
        expect(envEntries).toContain(`OPENCLAW_BROWSER_CDP_SOURCE_RANGE=${cdpSourceRange}`);
      }
      expect(latestBridgeResolved().profiles).toMatchObject({
        openclaw: { cdpPort: 49100, cdpUrl: `http://openclaw:${cdpAuthToken}@127.0.0.1:49100` },
      });
      expect(result?.noVncUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sandbox\/novnc\?token=/);
      expect(result?.noVncUrl).not.toContain("password=");
    },
  );

  it("serializes concurrent provisioning for the same browser container", async () => {
    let created = false;
    let cdpAuthToken: string | undefined;
    let configHash: string | undefined;
    dockerMocks.dockerContainerState.mockImplementation(async () => ({
      exists: created,
      running: created,
    }));
    dockerMocks.readDockerContainerEnvVar.mockImplementation(async (_containerName, key) =>
      key === "OPENCLAW_BROWSER_CDP_AUTH_TOKEN" ? (cdpAuthToken ?? null) : null,
    );
    dockerMocks.readDockerContainerLabel.mockImplementation(async () => configHash ?? null);
    dockerMocks.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: `${SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "create") {
        if (created) {
          throw new Error("docker name conflict");
        }
        created = true;
        const envEntries = expectDefined(
          snapshotDockerCreateEnvEntries(args),
          "docker create environment file",
        );
        cdpAuthToken = envValue("OPENCLAW_BROWSER_CDP_AUTH_TOKEN", envEntries);
        configHash = envValue("openclaw.configHash", collectDockerFlagValues(args, "--label"));
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    await expect(
      Promise.all([ensureTestSandboxBrowser(), ensureTestSandboxBrowser()]),
    ).resolves.toHaveLength(2);

    expect(dockerCalls("create")).toHaveLength(1);
    expect(dockerCalls("start")).toHaveLength(1);
  });

  it.each([false, true])("handles a pre-init browser epoch (hot=%s)", async (hot) => {
    const cfg = buildConfig(false);
    const oldHash = await computeTestBrowserHash({ cfg, createArgsEpoch: "pre-init" });
    seedExistingBrowser(oldHash, "existing-cdp-token", !hot);
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: browserName,
          sessionKey: scopeKey,
          createdAtMs: 1,
          lastUsedAtMs: hot ? Date.now() : 0,
          image: cfg.browser.image,
          configHash: oldHash,
          cdpPort: 49100,
        },
      ],
    });
    const result = await ensureTestSandboxBrowser({ cfg });
    if (hot) {
      expect(dockerArgs("rm")).toBeUndefined();
      expect(dockerArgs("create")).toBeUndefined();
      expect(runtimeMocks.log).toHaveBeenCalledWith(
        expect.stringContaining(
          "Recreate to apply: openclaw sandbox recreate --browser --session session:test",
        ),
      );
      expect(registryMocks.updateBrowserRegistry.mock.calls.at(-1)?.[0]?.configHash).toBe(oldHash);
    } else {
      expect(dockerMocks.execDocker).toHaveBeenCalledWith(["rm", "-f", browserName], {
        allowFailure: true,
      });
      expectBridgeStoppedBeforeRemoval();
      expect(requireDockerCreateArgs()).toContain("--init");
      expect(
        requireDockerCreateEnvEntries().filter((entry) =>
          entry.startsWith("OPENCLAW_BROWSER_NOVNC_PASSWORD="),
        ),
      ).toStrictEqual([]);
      expect(result?.noVncUrl).toBeUndefined();
    }
  });

  it.each([
    { policy: "SSRF", change: { ssrfPolicy: { allowedHostnames: ["example.com"] } } },
    { policy: "evaluate", change: { evaluateEnabled: false } },
  ])("recreates a reusable bridge when its $policy policy changes", async ({ change }) => {
    const common = { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } };

    await ensureTestSandboxBrowser(common);
    const initialBridge = await expectDefined(
      bridgeMocks.startBrowserBridgeServer.mock.results[0],
      "bridge startup",
    ).value;
    reuseCreatedBrowser();

    await ensureTestSandboxBrowser(common);
    expect(bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();

    await ensureTestSandboxBrowser({ ...common, ...change });
    expect(bridgeMocks.stopBrowserBridgeServer).toHaveBeenCalledExactlyOnceWith(
      initialBridge.server,
    );
    expect(bridgeMocks.startBrowserBridgeServer).toHaveBeenCalledTimes(2);
    expect(latestBridgeResolved()).toMatchObject(change);
    expect(dockerArgs("rm")).toBeUndefined();
  });

  it.each([200, 503])(
    "cancels the CDP probe response body after a %i startup probe",
    async (status) => {
      const cancels: Array<ReturnType<typeof vi.fn>> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const cancel = vi.fn().mockResolvedValue(undefined);
        cancels.push(cancel);
        return {
          ok: status === 200,
          body: { cancel },
        } as never;
      });
      bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
        await params.onEnsureAttachTarget?.({});
        throw new Error("probe completed before bridge creation");
      });

      const cfg = buildConfig(false);
      cfg.browser.autoStartTimeoutMs = 50;

      await expect(ensureTestSandboxBrowser({ cfg })).rejects.toThrow(
        status === 200
          ? "probe completed before bridge creation"
          : "hung container has been forcefully removed",
      );

      expect(cancels).not.toHaveLength(0);
      cancels.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
    },
  );

  it("keeps a stalled CDP request inside the browser startup deadline", async ({ signal }) => {
    const requestReceived = createDeferredCore();
    const responseClosed = createDeferredCore();
    const probeAdmitted = createDeferredCore();
    let requestPath: string | undefined;
    await withServer(
      (req, res) => {
        requestPath = req.url;
        req.resume();
        res.on("close", () => responseClosed.resolve());
        requestReceived.resolve();
        // Accept the actual CDP request but never send response headers.
      },
      async (baseUrl) => {
        const cdpPort = Number(new URL(baseUrl).port);
        dockerMocks.readDockerPort.mockImplementation(
          async (_containerName: string, port: number) =>
            port === 9222 ? cdpPort : port === 6080 ? 49101 : null,
        );
        bridgeMocks.startBrowserBridgeServer.mockImplementationOnce(async (params) => {
          probeAdmitted.resolve();
          await params.onEnsureAttachTarget?.({});
          throw new Error("expected CDP startup to time out before bridge creation");
        });

        const cfg = buildConfig(false);
        cfg.browser.autoStartTimeoutMs = 250;
        let settled = false;
        const errors: unknown[] = [];
        let startupResult: Promise<unknown> | undefined;
        try {
          // Keep the production deadline clock still while native HTTP establishes
          // the fixture's stalled request. Advance that same 250ms deadline only
          // after real request admission; never replace fetch or its abort signal.
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          startupResult = ensureTestSandboxBrowser({ cfg })
            .then(
              () => new Error("Sandbox browser startup completed before the stalled request"),
              (error: unknown) => error,
            )
            .finally(() => {
              settled = true;
            });
          const earlySettlement = startupResult.then((error) => {
            throw error;
          });
          await withinTest(Promise.race([probeAdmitted.promise, earlySettlement]), signal);
          await withinTest(Promise.race([requestReceived.promise, earlySettlement]), signal);

          expect(requestPath).toBe("/json/version");
          await vi.advanceTimersByTimeAsync(cfg.browser.autoStartTimeoutMs - 1);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          const result = await withinTest(startupResult, signal);
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toContain(
            `within ${cfg.browser.autoStartTimeoutMs}ms. The hung container has been forcefully removed.`,
          );
          expect(dockerMocks.execDocker).toHaveBeenCalledWith(
            ["rm", "-f", "openclaw-sbx-browser-session-test-0661d10a"],
            { allowFailure: true },
          );
          await withinTest(responseClosed.promise, signal);
        } catch (error) {
          errors.push(error);
        }
        try {
          if (startupResult && !settled) {
            await vi.advanceTimersByTimeAsync(cfg.browser.autoStartTimeoutMs);
            await withinTest(startupResult, signal);
          }
        } catch (error) {
          errors.push(error);
        } finally {
          vi.useRealTimers();
        }
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "CDP test and fixture cleanup failed");
        }
      },
    );
  });

  it("retains a stale container and cached bridge until bridge cleanup can retry", async () => {
    const cached = seedExistingBrowser();
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

    await expect(ensureTestSandboxBrowser()).rejects.toThrow("bridge cleanup failed");

    expect(BROWSER_BRIDGES.get("session:test")).toBe(cached);
    expect(dockerArgs("rm")).toBeUndefined();

    bridgeMocks.stopBrowserBridgeServer.mockClear();
    dockerMocks.execDocker.mockClear();
    await ensureTestSandboxBrowser();

    expectBridgeStoppedBeforeRemoval();
    expect(BROWSER_BRIDGES.get("session:test")).not.toBe(cached);
  });

  it("rejects network=none before Docker inspection or browser bridge startup", async () => {
    const cfg = buildConfig(false);
    cfg.browser.network = "none";

    await expect(ensureTestSandboxBrowser({ cfg })).rejects.toThrow(
      'Sandbox browser network mode "none" is unsupported because browser control requires a host-reachable published CDP port.',
    );
    expect(dockerMocks.dockerContainerState).not.toHaveBeenCalled();
    expect(dockerMocks.execDocker).not.toHaveBeenCalled();
    expect(dockerMocks.readDockerPort).not.toHaveBeenCalled();
    expect(bridgeMocks.startBrowserBridgeServer).not.toHaveBeenCalled();
  });

  it("preserves a hot browser and bridge when a descendant tmpfs was removed", async () => {
    const bridge = seedExistingBrowser("old-tmpfs-config", "existing-cdp-token");
    inspectWorkspace({ "/workspace/cache": "rw" });
    const cfg = buildConfig(false);
    cfg.docker.tmpfs = [];
    await expect(ensureTestSandboxBrowser({ cfg })).rejects.toThrow(
      "openclaw sandbox recreate --browser --session session:test",
    );
    expect(dockerArgs("rm")).toBeUndefined();
    expect(dockerArgs("create")).toBeUndefined();
    expect(bridgeMocks.stopBrowserBridgeServer).not.toHaveBeenCalled();
    expect(BROWSER_BRIDGES.get("session:test")).toBe(bridge);
  });

  it("skips browser user binds that conflict with protected skill overlay container paths", async () => {
    const workspaceDir = tempDirs.make("openclaw-browser-mounts-");
    const customRoot = tempDirs.make("openclaw-browser-mounts-");
    mkdirSync(path.join(workspaceDir, "skills", "demo"), { recursive: true });
    const cfg = buildConfig(false);
    cfg.workspaceAccess = "rw";
    cfg.docker.dangerouslyAllowExternalBindSources = true;
    cfg.docker.dangerouslyAllowReservedContainerTargets = true;
    cfg.browser.binds = [`${customRoot}:/workspace/skills:rw`];

    await ensureTestSandboxBrowser({ cfg, workspaceDir });

    const bindArgs = collectDockerFlagValues(requireDockerCreateArgs(), "-v");
    const workspaceMountIdx = bindArgs.indexOf(`${workspaceDir}:/workspace:z`);
    const customMount = `${customRoot}:/workspace/skills:rw`;
    const protectedMount = `${path.join(workspaceDir, "skills")}:/workspace/skills:ro,z`;
    const protectedMountIdx = bindArgs.indexOf(protectedMount);

    expect(workspaceMountIdx).toBeGreaterThanOrEqual(0);
    expect(bindArgs).not.toContain(customMount);
    expect(protectedMountIdx).toBeGreaterThan(workspaceMountIdx);
  });

  it.each([
    "startup",
    "publication",
    "publication rejection",
    "CDP readiness",
    "quota create",
    "quota start",
    "quota attach",
  ])("rejects lost custody or failed publication at %s", async (phase) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: testWorkspaceDir }, async () => {
      using owner = acquireSandboxGatewayOwner(testWorkspaceDir);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const publicationError = new Error("synthetic registry publication failure");
      const waitForRelease = async () => {
        entered.resolve();
        await resume.promise;
        if (phase === "publication rejection") {
          throw publicationError;
        }
      };
      const server = createServer();
      const assertCurrent = await captureSandboxStateOwner();
      const retry = vi.fn();
      const quotaRecovery = phase.startsWith("quota");
      let preparation: Promise<unknown> | undefined;
      try {
        if (phase === "quota attach") {
          await ensureTestSandboxBrowser({ assertCurrent });
        }
        if (quotaRecovery) {
          const original = execDocker.getMockImplementation()!;
          execDocker.mockImplementation(async (args, opts) => {
            if (args[0] === (phase === "quota create" ? "create" : "start")) {
              // The engine awaits idle-container reclamation after its EDQUOT result.
              await waitForRelease();
              opts?.assertCurrent?.();
              retry();
            }
            return await original(args, opts);
          });
        }
        if (phase === "CDP readiness" || phase === "quota attach") {
          if (phase === "CDP readiness") {
            await ensureTestSandboxBrowser({ assertCurrent });
          }
          dockerContainerState.mockResolvedValue({
            exists: true,
            running: phase === "CDP readiness",
          });
          vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
            await waitForRelease();
            return new Response("{}");
          });
          preparation = Promise.resolve(attach());
        } else {
          startBrowserBridgeServer.mockImplementationOnce(async ({ resolved }) => {
            if (phase === "startup") {
              await waitForRelease();
            }
            return { ...bridgeFixture(resolved), server };
          });
          if (phase.startsWith("publication")) {
            updateBrowserRegistry.mockImplementationOnce(waitForRelease);
          }
          preparation = ensureTestSandboxBrowser({ assertCurrent });
        }
        await awaitGateBeforeSettlement(
          entered.promise,
          preparation,
          "Browser lifecycle barrier not reached",
        );
        if (phase !== "publication rejection") {
          owner.release();
        }
        resume.resolve();
        const error = await preparation.catch((failure: unknown) => failure);
        if (quotaRecovery) {
          expect(retry).not.toHaveBeenCalled();
        } else if (phase !== "CDP readiness") {
          expect(stopBrowserBridgeServer).toHaveBeenCalledExactlyOnceWith(server);
          expect(BROWSER_BRIDGES.size).toBe(0);
          expect(updateBrowserRegistry).toHaveBeenCalledTimes(phase === "startup" ? 0 : 1);
        }
        if (phase === "publication rejection") {
          expect(error).toBe(publicationError);
        } else {
          expect(error).toMatchObject({ code: "GATEWAY_STATE_OWNER_REQUIRED" });
        }
      } finally {
        resume.resolve();
        await preparation?.catch(() => {});
      }
    });
  });

  it.each([false, true])("rejoins custody for late start (revoked=%s)", async (revoked) => {
    let current = true;
    let owned = false;
    const entered = vi.fn();
    const withWorkspace = async <T>(run: () => Promise<T>) => {
      entered();
      expect(owned).toBe(false);
      owned = true;
      try {
        return await run();
      } finally {
        owned = false;
      }
    };
    const result = await ensureTestSandboxBrowser({
      withWorkspace,
      assertCurrent: () => {
        if (!current) {
          throw new Error("browser owner revoked");
        }
      },
    });
    expect(result).not.toBeNull();
    const starts = dockerCalls("start").length;
    dockerContainerState.mockImplementation(async () => {
      expect(owned).toBe(true);
      await Promise.resolve();
      current = !revoked;
      return { exists: true, running: false };
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    if (revoked) {
      await expect(attach()).rejects.toThrow("browser owner revoked");
      expect(dockerCalls("start")).toHaveLength(starts);
    } else {
      await attach();
    }
    expect(entered).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("replaces guarded restart callbacks (managed=%s)", async (managed) => {
    let firstCurrent = true;
    const assertCurrent = () => {
      if (!firstCurrent) {
        throw new Error("first turn closed");
      }
    };
    await ensureTestSandboxBrowser(custody(managed, assertCurrent));
    reuseCreatedBrowser();
    firstCurrent = false;
    await ensureTestSandboxBrowser(custody(managed, () => {}));
    expect(stopBrowserBridgeServer).toHaveBeenCalledOnce();
    expect(startBrowserBridgeServer).toHaveBeenCalledTimes(2);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await attach(1);
  });

  it("awaits durable custody before allocation even when startup fails", async () => {
    dockerMocks.readDockerPort.mockResolvedValue(null);
    const started = createDeferredCore();
    const acknowledgment = createDeferredCore();
    const assertCurrent = vi.fn();
    const entered = vi.fn();
    updateBrowserRegistry.mockImplementationOnce(async (_entry, guard) => {
      expect(guard).toBe(assertCurrent);
      started.resolve();
      await acknowledgment.promise;
    });
    const operation = ensureTestSandboxBrowser({
      withWorkspace: async (run) => {
        entered();
        return await run();
      },
      assertCurrent,
    });
    const settled = expect(operation).rejects.toThrow("port mapping");
    try {
      await awaitGateBeforeSettlement(started.promise, operation, "reservation was not reached");
      expect(dockerCalls("create")).toHaveLength(0);
    } finally {
      acknowledgment.resolve();
      await settled;
    }
    expect(entered).toHaveBeenCalledOnce();
    expect(updateBrowserRegistry.mock.calls[0]?.[0]).toMatchObject({
      workspaceDir: testWorkspaceDir,
      cdpPort: 0,
    });
    const createIndex = execDocker.mock.calls.findIndex(([args]) => args[0] === "create");
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(updateBrowserRegistry.mock.invocationCallOrder[0]!).toBeLessThan(
      execDocker.mock.invocationCallOrder[createIndex]!,
    );
    expect(updateBrowserRegistry.mock.calls.at(-1)?.[1]).toBe(assertCurrent);
  });
});
