// Codex tests cover shared client plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { createCodexAppServerAgentHarness } from "../../harness.js";
import type { CodexAppServerAuthHandoff, CodexAppServerPreparedAuth } from "./auth-types.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { withCodexAppServerJsonClient } from "./request.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  deferNextAuthProfileApplication,
  registerSharedClientAcquisitionDiagnosticsTests,
} from "./shared-client-acquisition-diagnostics.test-support.js";
import { registerSharedClientCompactionRetentionTests } from "./shared-client-compaction-retention.test-support.js";
import { registerSharedClientConnectionArtifactTests } from "./shared-client-connection-artifact.test-support.js";
import { registerSharedClientIdleTests } from "./shared-client-idle.test-support.js";
import { registerSharedClientInferenceTests } from "./shared-client-inference.test-support.js";
import { retireSharedCodexAppServerClientsBeforeDesktopGeneration } from "./shared-client-lifecycle.js";
import { registerSharedClientLifetimeTests } from "./shared-client-lifetime.test-support.js";
import { registerSharedClientManagedFallbackTests } from "./shared-client-managed-fallback.test-support.js";
import { registerSharedClientWebSocketStartupTests } from "./shared-client-websocket-startup.test-support.js";
import { createClientHarness } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION, MIN_SUPPORTED_CODEX_APP_SERVER_VERSION } from "./version.js";

const mocks = vi.hoisted(() => ({
  CodexComputerUseCandidateArtifactsUnavailableError: class extends Error {
    readonly code = "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE";
  },
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  reconcileCodexComputerUseStartArtifacts: vi.fn(
    async (_params?: {
      startOptions: { command: string };
      desktopGeneration?: { epoch: number; fingerprint: string };
    }): Promise<void> => undefined,
  ),
  applyCodexAppServerAuthProfile: vi.fn(
    async (_params?: {
      agentDir?: string;
      authProfileId?: string;
      config?: unknown;
    }): Promise<CodexAppServerAuthHandoff | undefined> => undefined,
  ),
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(
    (params?: { authProfileId?: string }) => params?.authProfileId,
  ),
  resolveCodexAppServerAuthProfileStore: vi.fn(
    (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
  ),
  resolveCodexAppServerPreparedAuthProfileSnapshot: vi.fn(async () => ({
    loginParams: {
      type: "chatgptAuthTokens" as const,
      accessToken: "prepared-token",
      chatgptAccountId: "prepared-account",
      chatgptPlanType: null,
    },
    secretFreeCacheKey: "prepared-account:token:sha256:prepared",
  })),
  refreshCodexAppServerAuthTokens: vi.fn(async () => ({
    accessToken: "refreshed-access",
    chatgptAccountId: "refreshed-account",
    chatgptPlanType: null,
  })),
  resolveCodexAppServerFallbackApiKeyCacheKey: vi.fn(() => undefined as string | undefined),
  resolveCodexAppServerPreparedApiKeyCacheKey: vi.fn(
    (_apiKey: string) => "api_key:sha256:prepared",
  ),
  resolveManagedCodexAppServerStartOptions: vi.fn(async (startOptions) => startOptions),
  resolveManagedCodexNativeCommand: vi.fn((command: string) => `${command}.native`),
  isManagedCodexDesktopCommand: vi.fn((command: string) => command.startsWith("/Applications/")),
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  resolveDefaultAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
  desktopGeneration: undefined as { epoch: number; fingerprint: string } | undefined,
  waitForCodexDesktopGeneration: vi.fn(),
}));
mocks.waitForCodexDesktopGeneration.mockImplementation(async () => mocks.desktopGeneration);

vi.mock("./auth-bridge.js", () => ({
  applyCodexAppServerAuthProfile: mocks.applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
  reconcileCodexComputerUseStartArtifacts: mocks.reconcileCodexComputerUseStartArtifacts,
  resolveCodexAppServerPreparedAuthProfileSnapshot:
    mocks.resolveCodexAppServerPreparedAuthProfileSnapshot,
  refreshCodexAppServerAuthTokens: mocks.refreshCodexAppServerAuthTokens,
  resolveCodexAppServerHomeDir: (agentDir: string) =>
    path.join(path.resolve(agentDir), "codex-home"),
}));

vi.mock("./auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileIdForAgent: mocks.resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore: mocks.resolveCodexAppServerAuthProfileStore,
}));

vi.mock("./auth-cache-key.js", () => ({
  fingerprintTokenAuthProfileCacheKey: (accessToken: string) => `token:${accessToken}`,
  resolveCodexAppServerFallbackApiKeyCacheKey: mocks.resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey: mocks.resolveCodexAppServerPreparedApiKeyCacheKey,
}));

vi.mock("./managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./managed-binary.js")>()),
  isManagedCodexDesktopCommand: mocks.isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions: mocks.resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand: mocks.resolveManagedCodexNativeCommand,
}));

vi.mock("./desktop-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktop-generation.js")>()),
  waitForCodexDesktopGeneration: mocks.waitForCodexDesktopGeneration,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-registration")>()),
  resolveDefaultAgentDir: mocks.resolveDefaultAgentDir,
}));

import {
  captureSharedCodexAppServerCatalogLifetime,
  getSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
} from "./shared-client.js";
import { resolveCodexAppServerSpawnIdentity } from "./spawn-identity.js";

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let clearSharedCodexAppServerClientAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientAndWait;
let clearSharedCodexAppServerClientIfCurrentAndUnclaimed: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrentAndUnclaimed;
let clearSharedCodexAppServerClientIfCurrentAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientIfCurrentAndWait;
let createIsolatedCodexAppServerClient: typeof import("./shared-client.js").createIsolatedCodexAppServerClient;
let getLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").getLeasedSharedCodexAppServerClient;
let retainSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").retainSharedCodexAppServerClientIfCurrent;
let retainSharedCodexAppServerClientByInstanceId: typeof import("./shared-client.js").retainSharedCodexAppServerClientByInstanceId;
let releaseLeasedSharedCodexAppServerClient: typeof import("./shared-client.js").releaseLeasedSharedCodexAppServerClient;
let retireSharedCodexAppServerClientIfCurrent: typeof import("./shared-client.js").retireSharedCodexAppServerClientIfCurrent;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.test-support.js").resetSharedCodexAppServerClientForTests;

async function sendInitializeResult(
  harness: ReturnType<typeof createClientHarness>,
  userAgent: string,
): Promise<void> {
  const initialize = JSON.parse(await harness.waitForWrite(0)) as { id: number; method: string };
  expect(initialize.method).toBe("initialize");
  harness.send({ id: initialize.id, result: { userAgent } });
}

// Capture reads runtime files before startup; respond when initialize reaches the wire.
function createInitializingClientHarness(userAgent = `codex-cli/${CODEX_APP_SERVER_VERSION}`) {
  return createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "initialize") {
        send({ id: request.id, result: { userAgent } });
      }
    },
  });
}

async function sendEmptyModelList(harness: ReturnType<typeof createClientHarness>): Promise<void> {
  const modelList = JSON.parse(await harness.waitForWrite(2)) as { id: number; method: string };
  expect(modelList.method).toBe("model/list");
  harness.send({ id: modelList.id, result: { data: [] } });
}

function firstMockArg(mock: unknown, label: string): unknown {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.at(0);
  if (!call) {
    throw new Error(`Expected ${label} first call`);
  }
  return call[0];
}

function bridgeStartOptionsCall() {
  return firstMockArg(mocks.bridgeCodexAppServerStartOptions, "bridge start options") as {
    agentDir?: string;
    agentId?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    preparedAuth?:
      | { kind: "api-key"; apiKey: string }
      | { kind: "profile"; profileId: string; snapshot?: unknown };
    config?: unknown;
    startOptions: { command?: string; commandSource?: string };
  };
}

function applyAuthProfileCall() {
  return firstMockArg(mocks.applyCodexAppServerAuthProfile, "apply auth profile") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    preparedAuth?:
      | { kind: "api-key"; apiKey: string }
      | { kind: "profile"; snapshot: { loginParams: unknown } };
    config?: unknown;
  };
}

function resolveAuthProfileCall() {
  return firstMockArg(mocks.resolveCodexAppServerAuthProfileIdForAgent, "resolve auth profile") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
    config?: unknown;
  };
}

function managedStartOptionsCall() {
  return firstMockArg(mocks.resolveManagedCodexAppServerStartOptions, "managed start options") as {
    command?: string;
    commandSource?: string;
    managedCommandOrder?: string;
  };
}

function clientStartCall(startSpy: unknown) {
  return firstMockArg(startSpy, "CodexAppServerClient.start") as {
    command?: string;
    commandSource?: string;
  };
}

function configureManagedDesktopFallback(): CodexAppServerStartOptions {
  mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
    ...startOptions,
    command: "/Applications/Codex.app/Contents/Resources/codex",
    commandSource: "resolved-managed",
    managedFallbackCommandPaths: ["/cache/openclaw/codex"],
  }));
  return createStartOptions({
    homeScope: "user",
    commandSource: "managed",
    args: ["app-server", "--listen", "stdio://"],
  });
}

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return { transport: "stdio", command: "codex", args: ["app-server"], headers: {}, ...overrides };
}

describe("shared Codex app-server client", () => {
  beforeEach(() => {
    vi.spyOn(embeddedAgentLog, "debug").mockImplementation(mocks.embeddedAgentLog.debug);
    vi.spyOn(embeddedAgentLog, "warn").mockImplementation(mocks.embeddedAgentLog.warn);
  });

  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({
      clearSharedCodexAppServerClientAndWait,
      clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
      clearSharedCodexAppServerClientIfCurrentAndWait,
      createIsolatedCodexAppServerClient,
      getLeasedSharedCodexAppServerClient,
      retainSharedCodexAppServerClientIfCurrent,
      retainSharedCodexAppServerClientByInstanceId,
      releaseLeasedSharedCodexAppServerClient,
      retireSharedCodexAppServerClientIfCurrent,
    } = await import("./shared-client.js"));
    ({ resetSharedCodexAppServerClientForTests } = await import("./shared-client.test-support.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
    mocks.reconcileCodexComputerUseStartArtifacts.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockResolvedValue(undefined);
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockClear();
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockImplementation(
      (params?: { authProfileId?: string }) => params?.authProfileId,
    );
    mocks.resolveCodexAppServerAuthProfileStore.mockClear();
    mocks.resolveCodexAppServerAuthProfileStore.mockImplementation(
      (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
    );
    mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockReset();
    mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockResolvedValue({
      loginParams: {
        type: "chatgptAuthTokens",
        accessToken: "prepared-token",
        chatgptAccountId: "prepared-account",
        chatgptPlanType: null,
      },
      secretFreeCacheKey: "prepared-account:token:sha256:prepared",
    });
    mocks.refreshCodexAppServerAuthTokens.mockClear();
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockClear();
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockReturnValue(undefined);
    mocks.resolveCodexAppServerPreparedApiKeyCacheKey.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(
      async (startOptions) => startOptions,
    );
    mocks.desktopGeneration = undefined;
    mocks.waitForCodexDesktopGeneration.mockReset();
    mocks.waitForCodexDesktopGeneration.mockImplementation(async () => mocks.desktopGeneration);
    mocks.resolveManagedCodexNativeCommand.mockClear();
    mocks.resolveManagedCodexNativeCommand.mockImplementation(
      (command: string) => `${command}.native`,
    );
    mocks.embeddedAgentLog.debug.mockClear();
    mocks.embeddedAgentLog.warn.mockClear();
    mocks.resolveDefaultAgentDir.mockClear();
  });

  registerSharedClientWebSocketStartupTests({
    createStartOptions,
    createInitializingClientHarness,
    authHandoff: mocks.applyCodexAppServerAuthProfile,
  });

  registerSharedClientAcquisitionDiagnosticsTests({
    createInitializingClientHarness,
    sendInitializeResult,
  });

  registerSharedClientInferenceTests((generation, command) => {
    mocks.desktopGeneration = generation;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (options) =>
      options.transport === "stdio" && options.commandSource === "managed"
        ? { ...options, command, commandSource: "resolved-managed" }
        : options,
    );
  }, sendInitializeResult);

  it("preserves explicit start options over the plugin endpoint", async () => {
    const harness = createInitializingClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    const client = await getSharedCodexAppServerClient({
      pluginConfig: {
        appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
      },
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        headers: {},
        url: "ws://127.0.0.1:39176",
      },
      timeoutMs: 1_000,
    });

    expect(client).toBe(harness.client);
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "websocket", url: "ws://127.0.0.1:39176" }),
      expect.anything(),
    );
    await client.closeAndWait();
  });

  it.each(["shared", "isolated"] as const)(
    "opens a native %s catalog client without selecting an OpenClaw agent",
    async (kind) => {
      const harness = createInitializingClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const acquire =
        kind === "shared" ? getSharedCodexAppServerClient : createIsolatedCodexAppServerClient;
      await mocks.resolveDefaultAgentDir.withImplementation(
        () => {
          throw new Error("An OpenClaw agent must be selected");
        },
        async () => {
          const client = await acquire({
            config: { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } },
            startOptions: {
              transport: "stdio",
              homeScope: "user",
              command: "codex",
              commandSource: "managed",
              args: ["app-server"],
              headers: {},
              env: { CODEX_HOME: "/native/codex" },
            },
            authProfileId: null,
            timeoutMs: 1_000,
          });
          expect(client).toBe(harness.client);
          expect(startSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              homeScope: "user",
              managedCommandOrder: "desktop-first",
              env: { CODEX_HOME: "/native/codex" },
            }),
            expect.anything(),
          );
          await client.closeAndWait();
        },
      );
    },
  );

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.117.9 (macOS; test)");

    await expect(listPromise).rejects.toThrow(
      `Codex app-server ${MIN_SUPPORTED_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.process.stdin.destroyed).toBe(true);
    startSpy.mockRestore();
  });

  it("fingerprints argv without exposing secret-shaped config overrides", () => {
    const identity = resolveCodexAppServerSpawnIdentity(
      createStartOptions({
        homeScope: "agent",
        command: "/usr/local/bin/codex",
        commandSource: "config",
        args: ["-c", "provider.api_key=super-secret-value", "app-server"],
      }),
    );

    expect(identity.argsFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain("super-secret-value");
  });

  it("does not resolve startup context for a pre-aborted acquire", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const startSpy = vi.spyOn(CodexAppServerClient, "start");

    await expect(
      getLeasedSharedCodexAppServerClient({
        abandonSignal: abortController.signal,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("codex app-server initialize aborted");

    expect(mocks.resolveManagedCodexAppServerStartOptions).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it.each(["implicit", "explicit"] as const)(
    "revalidates %s auth before reusing a warm client after account replacement",
    async (selector) => {
      const first = createClientHarness();
      const replacement = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(replacement.client);
      mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:work");
      mocks.resolveCodexAppServerAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
      const options = {
        config: { auth: { order: { openai: ["openai:work"] } } },
        startOptions: createStartOptions({
          homeScope: "agent",
        }) satisfies CodexAppServerStartOptions,
        authProfileId: selector === "explicit" ? "openai:work" : undefined,
        timeoutMs: 1_000,
      };
      const firstAcquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(first, "openclaw/0.149.0 (Linux; test)");
      await expect(firstAcquire).resolves.toBe(first.client);
      releaseLeasedSharedCodexAppServerClient(first.client);
      await expect(getLeasedSharedCodexAppServerClient(options)).resolves.toBe(first.client);
      releaseLeasedSharedCodexAppServerClient(first.client);

      mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockResolvedValue({
        loginParams: {
          type: "chatgptAuthTokens",
          accessToken: "replacement-token",
          chatgptAccountId: "replacement-account",
          chatgptPlanType: null,
        },
        secretFreeCacheKey: "replacement-account",
      });
      const nextAcquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(replacement, "openclaw/0.149.0 (Linux; test)");
      expect(startSpy).toHaveBeenCalledTimes(2);
      await expect(nextAcquire).resolves.toBe(replacement.client);
      releaseLeasedSharedCodexAppServerClient(replacement.client);
      expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenLastCalledWith(
        expect.objectContaining({
          preparedAuth: expect.objectContaining({
            snapshot: expect.objectContaining({
              loginParams: expect.objectContaining({
                accessToken: "replacement-token",
                chatgptAccountId: "replacement-account",
              }),
            }),
          }),
        }),
      );
    },
  );

  it("does not spawn after startup context exceeds its total deadline", async () => {
    vi.useFakeTimers();
    let resolveManaged: ((value: CodexAppServerStartOptions) => void) | undefined;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveManaged = resolve;
        }),
    );
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    const acquire = getLeasedSharedCodexAppServerClient({ timeoutMs: 50 });
    const rejection = expect(acquire).rejects.toThrow("codex app-server initialize timed out");

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(startSpy).not.toHaveBeenCalled();

    resolveManaged?.(
      createStartOptions({
        homeScope: "agent",
        commandSource: "managed",
      }),
    );
    await Promise.resolve();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps sibling startup alive when an acquire aborts (leased=%s)",
    async (leased) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const abortController = new AbortController();
      const acquire = leased ? getLeasedSharedCodexAppServerClient : getSharedCodexAppServerClient;
      const first = acquire({ abandonSignal: abortController.signal, timeoutMs: 1_000 });
      const second = acquire({ timeoutMs: 1_000 });
      await harness.waitForWrite(0);
      expect(harness.writes).toHaveLength(1);
      const rejection = expect(first).rejects.toThrow("codex app-server initialize aborted");
      abortController.abort();
      expect(harness.stdinDestroyed).toBe(false);
      await rejection;
      await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
      await expect(second).resolves.toBe(harness.client);
      expect(harness.stdinDestroyed).toBe(false);
      if (leased) {
        expect(releaseLeasedSharedCodexAppServerClient(harness.client)).toBe(true);
      }
    },
  );

  it.each([
    {
      version: "2026.7.1",
      create: () => ({ clients: new Map(), leasedReleases: new WeakMap() }),
    },
    {
      version: "2026.9.1",
      create: () => ({
        clients: new Map(),
        liveClients: new Set(),
        isolatedClients: new Set(),
        entriesByClient: new WeakMap(),
        leasedReleases: new WeakMap(),
        desktopGenerationDrainChecks: new Set(),
      }),
    },
  ])("does not adopt shared client state from published $version", async ({ create }) => {
    // A plugin update inside a container restarts the gateway in-process, so the
    // new plugin build starts with the previous build's globalThis. This is the
    // slot name and record shape every build before the keyed slot wrote.
    const legacySlot = Symbol.for("openclaw.codexAppServerClientState");
    const legacyState = create();
    const globalState = globalThis as Record<symbol, unknown>;
    globalState[legacySlot] = legacyState;
    try {
      const harness = createInitializingClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const client = await getLeasedSharedCodexAppServerClient({ timeoutMs: 1_000 });

      expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      expect(legacyState.clients.size).toBe(0);
    } finally {
      delete globalState[legacySlot];
    }
  });

  registerSharedClientCompactionRetentionTests();
  registerSharedClientIdleTests();
  registerSharedClientLifetimeTests(
    () => {
      mocks.bridgeCodexAppServerStartOptions.mockImplementationOnce(async ({ startOptions }) => ({
        ...startOptions,
        transport: "websocket",
        url: "ws://127.0.0.1:8123",
      }));
    },
    (error) => mocks.applyCodexAppServerAuthProfile.mockRejectedValue(error),
  );

  it("falls back before starting a desktop candidate with incomplete Computer Use artifacts", async () => {
    const pluginLocal = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(pluginLocal.client);
    mocks.reconcileCodexComputerUseStartArtifacts
      .mockRejectedValueOnce(
        new mocks.CodexComputerUseCandidateArtifactsUnavailableError(
          "desktop artifacts unavailable",
        ),
      )
      .mockResolvedValueOnce(undefined);
    const startOptions = configureManagedDesktopFallback();

    const acquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await sendInitializeResult(pluginLocal, "openclaw/0.149.0 (macOS; test)");
    const client = await acquire;

    expect(client).toBe(pluginLocal.client);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/cache/openclaw/codex" }),
      expect.any(Function),
    );
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileCodexComputerUseStartArtifacts.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        startOptions: expect.objectContaining({
          command: "/Applications/Codex.app/Contents/Resources/codex",
        }),
      }),
    );
    expect(mocks.reconcileCodexComputerUseStartArtifacts.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        startOptions: expect.objectContaining({ command: "/cache/openclaw/codex" }),
      }),
    );
  });

  it("classifies terminal incomplete Computer Use artifacts as harness preflight", async () => {
    mocks.reconcileCodexComputerUseStartArtifacts.mockRejectedValueOnce(
      new mocks.CodexComputerUseCandidateArtifactsUnavailableError("desktop artifacts unavailable"),
    );

    await expect(
      getSharedCodexAppServerClient({
        startOptions: createStartOptions({
          command: "/Applications/Codex.app/Contents/Resources/codex",
          commandSource: "config",
        }),
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError", scope: "harness" });
  });

  it("reuses the successful managed fallback after desktop initialize is unsupported", async () => {
    const desktop = createClientHarness();
    const pluginLocal = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(desktop.client)
      .mockResolvedValueOnce(pluginLocal.client)
      .mockImplementation(async () => {
        throw new Error("unexpected duplicate start");
      });
    const startOptions = configureManagedDesktopFallback();

    const firstAcquire = getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });
    await sendInitializeResult(desktop, "openclaw/0.148.0 (macOS; test)");
    await sendInitializeResult(pluginLocal, "openclaw/0.149.0 (macOS; test)");
    const firstClient = await firstAcquire;

    const secondClient = await getSharedCodexAppServerClient({ startOptions, timeoutMs: 1_000 });

    expect(secondClient).toBe(firstClient);
    expect(desktop.process.stdin.destroyed).toBe(true);
    expect(pluginLocal.process.stdin.destroyed).toBe(false);
    expect(
      retireSharedCodexAppServerClientIfCurrent(desktop.client, { failActiveLeases: true }),
    ).toBeUndefined();
    expect(pluginLocal.process.stdin.destroyed).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(2);
    const retained = await retainSharedCodexAppServerClientByInstanceId(
      firstClient.getInstanceId(),
    );
    expect(retained?.client).toBe(firstClient);
    await retained?.release();
    expect(startSpy.mock.calls[0]?.[0]).toMatchObject({
      command: "/Applications/Codex.app/Contents/Resources/codex",
      commandSource: "resolved-managed",
      managedFallbackCommandPaths: ["/cache/openclaw/codex"],
    });
    expect(startSpy.mock.calls[1]?.[0]).toMatchObject({
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed",
    });
    expect(startSpy.mock.calls[1]?.[0]).not.toHaveProperty("managedFallbackCommandPaths");

    expect(
      retireSharedCodexAppServerClientIfCurrent(pluginLocal.client, { failActiveLeases: true }),
    ).toEqual({ activeLeases: 0, closed: true });
    expect(
      retireSharedCodexAppServerClientIfCurrent(desktop.client, { failActiveLeases: true }),
    ).toBeUndefined();
    await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
    expect(pluginLocal.process.stdin.destroyed).toBe(true);
  });

  registerSharedClientManagedFallbackTests({
    configureManagedDesktopFallback,
    resolveManagedStart: mocks.resolveManagedCodexAppServerStartOptions,
    sendInitializeResult,
    warn: mocks.embeddedAgentLog.warn,
  });

  it("shares a managed fallback with a waiter that arrives during fallback initialize", async () => {
    const desktop = createClientHarness();
    const fallback = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(desktop.client)
      .mockResolvedValueOnce(fallback.client)
      .mockImplementation(async () => {
        throw new Error("unexpected duplicate start");
      });
    const options = {
      timeoutMs: 1_000,
      startOptions: configureManagedDesktopFallback(),
    };

    const firstAcquire = getSharedCodexAppServerClient(options);
    await sendInitializeResult(desktop, "openclaw/0.148.0 (macOS; test)");
    await vi.waitFor(() => expect(fallback.writes.length).toBeGreaterThanOrEqual(1));
    const secondAcquire = getSharedCodexAppServerClient(options);
    await sendInitializeResult(fallback, "openclaw/0.149.0 (macOS; test)");

    const [firstClient, secondClient] = await Promise.all([firstAcquire, secondAcquire]);
    expect(secondClient).toBe(firstClient);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(desktop.process.stdin.destroyed).toBe(true);
    expect(fallback.process.stdin.destroyed).toBe(false);
  });

  it("keeps capture clients separate from ordinary shared clients", async () => {
    await withTempDir("openclaw-codex-capture-client-", async (root) => {
      const command = path.join(root, "codex");
      await fs.writeFile(command, "native-v1");
      const normal = createInitializingClientHarness("openclaw/0.149.0 (Linux; test)");
      const captured = createInitializingClientHarness("openclaw/0.149.0 (Linux; test)");
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(normal.client)
        .mockResolvedValueOnce(captured.client);
      const startOptions: CodexAppServerStartOptions = {
        transport: "stdio",
        command,
        commandSource: "config",
        args: ["app-server"],
        headers: {},
      };

      try {
        const normalClient = await getLeasedSharedCodexAppServerClient({ startOptions });
        const capturedClient = await getLeasedSharedCodexAppServerClient({
          startOptions,
          runtimeArtifactMode: "capture",
        });

        expect(capturedClient).not.toBe(normalClient);
        expect(startSpy).toHaveBeenCalledTimes(2);
        const { readCodexAppServerClientRuntimeArtifact } = await import("./runtime-artifact.js");
        expect(readCodexAppServerClientRuntimeArtifact(normalClient)).toBeUndefined();
        expect(readCodexAppServerClientRuntimeArtifact(capturedClient)).toEqual({
          id: expect.stringMatching(/^codex-app-server:v1:/u),
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        expect(releaseLeasedSharedCodexAppServerClient(normalClient)).toBe(true);
        expect(releaseLeasedSharedCodexAppServerClient(capturedClient)).toBe(true);
      } finally {
        await Promise.all([normal.client.closeAndWait(), captured.client.closeAndWait()]);
      }
    });
  });

  it("binds the managed fallback candidate that actually initialized", async () => {
    await withTempDir("openclaw-codex-capture-fallback-", async (root) => {
      const desktopCommand = path.join(root, "desktop-codex");
      const fallbackCommand = path.join(root, "package-codex");
      await Promise.all([
        fs.writeFile(desktopCommand, "desktop-launcher"),
        fs.writeFile(`${desktopCommand}.native`, "desktop-native"),
        fs.writeFile(fallbackCommand, "package-launcher"),
        fs.writeFile(`${fallbackCommand}.native`, "package-native"),
      ]);
      const desktop = createInitializingClientHarness("openclaw/0.124.9 (macOS; test)");
      const fallback = createInitializingClientHarness("openclaw/0.149.0 (macOS; test)");
      vi.spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(desktop.client)
        .mockResolvedValueOnce(fallback.client);
      mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
        async (startOptions) => ({
          ...startOptions,
          command: desktopCommand,
          commandSource: "resolved-managed" as const,
          managedFallbackCommandPaths: [fallbackCommand],
        }),
      );
      const requested: CodexAppServerStartOptions = createStartOptions({
        commandSource: "managed",
      });

      try {
        const client = await getLeasedSharedCodexAppServerClient({
          startOptions: requested,
          runtimeArtifactMode: "capture",
        });
        const { readCodexAppServerClientRuntimeArtifact, validateCodexAppServerRuntimeArtifact } =
          await import("./runtime-artifact.js");
        const binding = readCodexAppServerClientRuntimeArtifact(client);
        if (!binding) {
          throw new Error("expected captured Codex runtime artifact");
        }

        await fs.writeFile(`${desktopCommand}.native`, "desktop-native-updated");
        await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(true);
        await fs.writeFile(`${fallbackCommand}.native`, "package-native-updated");
        await expect(validateCodexAppServerRuntimeArtifact(binding)).resolves.toBe(false);
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      } finally {
        await Promise.all([desktop.client.closeAndWait(), fallback.client.closeAndWait()]);
      }
    });
  });

  registerSharedClientConnectionArtifactTests();

  it.each(["shared", "isolated"] as const)(
    "preserves the elapsed startup budget across a wall-clock jump for a %s client",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const harness = createInitializingClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const entered = createDeferred<void>();
      const released = createDeferred<void>();
      mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
        async (startOptions) => {
          entered.resolve();
          await released.promise;
          return startOptions;
        },
      );
      const acquire =
        kind === "shared" ? getSharedCodexAppServerClient : createIsolatedCodexAppServerClient;
      const pending = acquire({ timeoutMs: 1_000 });
      const accepted = expect(pending).resolves.toBe(harness.client);
      try {
        await entered.promise;
        vi.setSystemTime(Date.now() + 300_100);
        released.resolve();
        await accepted;
        expect(harness.process.stdin.destroyed).toBe(false);
      } finally {
        released.resolve();
        vi.useRealTimers();
        await harness.client.closeAndWait();
      }
    },
  );

  it.each(["shared", "isolated"])(
    "closes a stalled %s initialize and settles acquisition",
    async (kind) => {
      vi.useFakeTimers();
      const first = createClientHarness();
      const second = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(second.client);
      const started = createDeferred<void>();
      const acquire =
        kind === "shared" ? getSharedCodexAppServerClient : createIsolatedCodexAppServerClient;
      const pending = acquire({ timeoutMs: 5, onStartedClient: () => started.resolve() });
      const rejection = expect(pending).rejects.toThrow("codex app-server initialize timed out");
      await started.promise;
      await vi.advanceTimersByTimeAsync(5);
      first.emitExit();
      await rejection;
      expect(first.process.stdin.destroyed).toBe(true);
      if (kind === "shared") {
        vi.useRealTimers();
        const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
        await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
        await sendEmptyModelList(second);
        await expect(secondList).resolves.toEqual({ models: [] });
        expect(startSpy).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each([
    {
      kind: "shared",
      stderr: 'Error: failed to initialize sqlite state runtime token="secret-value"',
      diagnostic: 'Error: failed to initialize sqlite state runtime token="<redacted>"',
    },
    {
      kind: "isolated",
      stderr: "state database is locked access_token=secret-value",
      diagnostic: "state database is locked access_token=<redacted>",
    },
  ])(
    "includes redacted stderr when $kind initialize times out",
    async ({ kind, stderr, diagnostic }) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const acquire =
        kind === "shared" ? listCodexAppServerModels : createIsolatedCodexAppServerClient;
      const pending = acquire({ timeoutMs: 100 });
      await harness.waitForWrite(0);
      harness.process.stderr.write(`${stderr}\n`);
      await expect(pending).rejects.toThrow(
        `codex app-server initialize timed out; stderr=${JSON.stringify(diagnostic)}`,
      );
      expect(harness.process.stdin.destroyed).toBe(true);
    },
  );

  it.each(["initialize", "authentication"])(
    "keeps shared %s alive for a caller with a longer timeout",
    async (phase) => {
      const harness = createClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const releaseAuth =
        phase === "authentication" ? deferNextAuthProfileApplication() : undefined;
      const shortAcquire = getSharedCodexAppServerClient({
        timeoutMs: phase === "initialize" ? 5 : 100,
      });
      const longAcquire = getSharedCodexAppServerClient({ timeoutMs: 1000 });
      if (releaseAuth) {
        await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      }
      await expect(shortAcquire).rejects.toThrow(`codex app-server ${phase} timed out`);
      expect(harness.process.stdin.destroyed).toBe(false);
      if (releaseAuth) {
        releaseAuth();
      } else {
        await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      }
      await expect(longAcquire).resolves.toBe(harness.client);
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(harness.process.stdin.destroyed).toBe(false);
    },
  );

  it.each(["shared", "isolated"])(
    "bounds %s auth application by its startup deadline",
    async (kind) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const releaseAuth = deferNextAuthProfileApplication();
      const acquire =
        kind === "shared" ? getSharedCodexAppServerClient : createIsolatedCodexAppServerClient;
      const pending = acquire({ timeoutMs: 100 });
      const rejection = expect(pending).rejects.toThrow(
        `codex app-server ${kind === "shared" ? "authentication" : "initialize"} timed out`,
      );
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      await rejection;
      expect(harness.process.stdin.destroyed).toBe(true);
      releaseAuth();
    },
  );

  it.each(["deadline", "retirement"])(
    "does not start isolated auth after caller %s during initialization",
    async (reason) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const retired = new Error("isolated client caller retired");
      let now = 0;
      let current = true;
      if (reason === "deadline") {
        vi.spyOn(performance, "now").mockImplementation(() => now);
      }
      const pending = createIsolatedCodexAppServerClient({
        timeoutMs: reason === "deadline" ? 100 : 1_000,
        ...(reason === "retirement"
          ? {
              assertCurrent: () => {
                if (!current) {
                  throw retired;
                }
              },
            }
          : {}),
      });
      const rejection =
        reason === "retirement"
          ? expect(pending).rejects.toBe(retired)
          : expect(pending).rejects.toThrow("codex app-server initialize timed out");
      try {
        await harness.waitForWrite(0);
        now = 101;
        current = false;
        await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
        await rejection;
        expect(mocks.applyCodexAppServerAuthProfile).not.toHaveBeenCalled();
        expect(harness.process.stdin.destroyed).toBe(true);
      } finally {
        harness.client.close();
      }
    },
  );

  it.each(["selected store", "prepared store", "persisted handoff"])(
    "preserves %s authority through startup and token refresh",
    async (selection) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const suppliedStore = { version: 1, profiles: {} };
      const authProfileStore = {
        version: 1 as const,
        profiles: {
          "openai:scoped": { type: "token" as const, provider: "openai", token: "prepared-token" },
        },
        ...(selection === "prepared store" ? { order: { openai: ["openai:scoped"] } } : {}),
      };
      const authHandoff = {
        accessFingerprint: "token:startup-access",
        chatgptAccountId: "persisted-account",
      };
      const persisted = selection === "persisted handoff";
      const authProfileId = persisted ? "openai:persisted" : "openai:scoped";
      const agentDir = persisted ? "/tmp/openclaw-persisted-agent" : "/tmp/openclaw-agent";
      if (selection === "selected store") {
        mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue(authProfileId);
        mocks.resolveCodexAppServerAuthProfileStore.mockReturnValue(authProfileStore);
      } else if (persisted) {
        mocks.applyCodexAppServerAuthProfile.mockResolvedValueOnce(authHandoff);
      }
      const pending =
        selection === "prepared store"
          ? getSharedCodexAppServerClient({
              timeoutMs: 1000,
              preparedAuth: { kind: "profile", profileId: authProfileId, store: authProfileStore },
            })
          : createIsolatedCodexAppServerClient({
              timeoutMs: 1000,
              ...(persisted ? { authProfileId, agentDir } : { authProfileStore: suppliedStore }),
            });
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      await expect(pending).resolves.toBe(harness.client);
      if (selection === "selected store") {
        expect(mocks.resolveCodexAppServerAuthProfileStore).toHaveBeenCalledWith({
          agentDir,
          authProfileId: undefined,
          authProfileStore: suppliedStore,
          config: undefined,
        });
        expect(resolveAuthProfileCall().authProfileStore).toBe(authProfileStore);
        expect(bridgeStartOptionsCall().authProfileStore).toBe(authProfileStore);
        expect(applyAuthProfileCall().authProfileStore).toBe(authProfileStore);
      } else if (selection === "prepared store") {
        expect(mocks.resolveCodexAppServerAuthProfileStore).not.toHaveBeenCalled();
        expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
        expect(mocks.resolveCodexAppServerPreparedAuthProfileSnapshot).toHaveBeenCalledOnce();
        expect(bridgeStartOptionsCall()).toMatchObject({
          authProfileId,
          authProfileStore,
          preparedAuth: { kind: "profile", profileId: authProfileId },
        });
        expect(applyAuthProfileCall()).toMatchObject({
          authProfileId,
          authProfileStore,
          preparedAuth: {
            kind: "profile",
            snapshot: { loginParams: { type: "chatgptAuthTokens", accessToken: "prepared-token" } },
          },
        });
      }
      const account = persisted ? "persisted-account" : "scoped-account";
      const response = {
        accessToken: "refreshed-access",
        chatgptAccountId: account,
        chatgptPlanType: null,
      };
      mocks.refreshCodexAppServerAuthTokens.mockResolvedValueOnce(response);
      const responseIndex = harness.writes.length;
      harness.send({
        id: "refresh-1",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: account },
      });
      expect(JSON.parse(await harness.waitForWrite(responseIndex))).toEqual({
        id: "refresh-1",
        result: response,
      });
      expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
        agentDir,
        authProfileId,
        ...(persisted ? { authHandoff } : { authProfileStore }),
        previousAccountId: account,
        config: undefined,
      });
    },
  );

  it.each(["failure", "workspace-change"] as const)(
    "retires a shared client after token refresh %s while existing leases drain",
    async (failure) => {
      const first = createClientHarness();
      const replacement = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(replacement.client);
      const options = { timeoutMs: 1_000, authProfileId: "openai:work" };
      const acquired = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(first, "openclaw/0.149.0 (Linux; test)");
      await acquired;
      const failureMessage =
        failure === "failure"
          ? "refresh failed"
          : "ChatGPT workspace changed during Codex token refresh. Retry to start a client for the selected workspace.";
      mocks.refreshCodexAppServerAuthTokens.mockRejectedValueOnce(new Error(failureMessage));
      const responseIndex = first.writes.length;
      first.send({
        id: "failed-refresh",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: "original-account" },
      });
      expect(JSON.parse(await first.waitForWrite(responseIndex))).toEqual({
        id: "failed-refresh",
        error: {
          code: -32603,
          message: failureMessage,
        },
      });
      expect(first.stdinDestroyed).toBe(false);
      const nextAcquire = getLeasedSharedCodexAppServerClient(options);
      await sendInitializeResult(replacement, "openclaw/0.149.0 (Linux; test)");
      expect(startSpy).toHaveBeenCalledTimes(2);
      await expect(nextAcquire).resolves.toBe(replacement.client);
      expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
      expect(first.stdinDestroyed).toBe(true);
      expect(replacement.stdinDestroyed).toBe(false);
      expect(releaseLeasedSharedCodexAppServerClient(replacement.client)).toBe(true);
      expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(replacement.client)).toEqual({
        found: true,
        closed: true,
        activeLeases: 0,
        pendingAcquires: 0,
      });
      expect(replacement.stdinDestroyed).toBe(true);
    },
  );

  it.each(["prepared", "selected"] as const)(
    "separates %s profile clients by secret-free account identity",
    async (selection) => {
      const firstHarness = createClientHarness();
      const secondHarness = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(firstHarness.client)
        .mockResolvedValueOnce(secondHarness.client);
      const resolvedCacheKeys: string[] = [];
      mocks.resolveCodexAppServerPreparedAuthProfileSnapshot.mockImplementation(
        async (params?: {
          authProfileStore?: {
            profiles?: Record<string, { token?: string }>;
          };
        }) => {
          const token = params?.authProfileStore?.profiles?.["openai:scoped"]?.token;
          const key =
            token === "first-secret-token" ? "account:sha256:first" : "account:sha256:second";
          resolvedCacheKeys.push(key);
          return {
            loginParams: {
              type: "chatgptAuthTokens" as const,
              accessToken: token ?? "",
              chatgptAccountId: "prepared-account",
              chatgptPlanType: null,
            },
            secretFreeCacheKey: key,
          };
        },
      );
      const firstStore = {
        version: 1 as const,
        profiles: {
          "openai:scoped": {
            type: "token" as const,
            provider: "openai",
            token: "first-secret-token",
          },
        },
      };
      const secondStore = {
        version: 1 as const,
        profiles: {
          "openai:scoped": {
            type: "token" as const,
            provider: "openai",
            token: "second-secret-token",
          },
        },
      };

      const firstPromise = getSharedCodexAppServerClient({
        timeoutMs: 1000,
        ...(selection === "prepared"
          ? {
              preparedAuth: {
                kind: "profile" as const,
                profileId: "openai:scoped",
                store: firstStore,
              },
            }
          : { authProfileId: "openai:scoped", authProfileStore: firstStore }),
      });
      await sendInitializeResult(firstHarness, "openclaw/0.149.0 (macOS; test)");
      await expect(firstPromise).resolves.toBe(firstHarness.client);

      const secondPromise = getSharedCodexAppServerClient({
        timeoutMs: 1000,
        ...(selection === "prepared"
          ? {
              preparedAuth: {
                kind: "profile" as const,
                profileId: "openai:scoped",
                store: secondStore,
              },
            }
          : { authProfileId: "openai:scoped", authProfileStore: secondStore }),
      });
      await sendInitializeResult(secondHarness, "openclaw/0.149.0 (macOS; test)");
      expect(startSpy).toHaveBeenCalledTimes(2);
      await expect(secondPromise).resolves.toBe(secondHarness.client);

      expect(resolvedCacheKeys).toEqual(["account:sha256:first", "account:sha256:second"]);
      expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          preparedAuth: expect.objectContaining({
            snapshot: expect.objectContaining({
              loginParams: expect.objectContaining({ accessToken: "first-secret-token" }),
            }),
          }),
        }),
      );
      expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          preparedAuth: expect.objectContaining({
            snapshot: expect.objectContaining({
              loginParams: expect.objectContaining({ accessToken: "second-secret-token" }),
            }),
          }),
        }),
      );
      expect(resolvedCacheKeys.join("\n")).not.toContain("first-secret-token");
      expect(resolvedCacheKeys.join("\n")).not.toContain("second-secret-token");
    },
  );

  it.each(["api-key", "subscription"] as const)(
    "reuses a turn's %s physical client for a control resume",
    async (authRequirement) => {
      const harness = createClientHarness();
      const start = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(harness.client)
        .mockImplementation(async () => {
          throw new Error("control resume opened a second physical client");
        });
      const preparedAuth: CodexAppServerPreparedAuth =
        authRequirement === "api-key"
          ? { kind: "api-key", apiKey: "platform-key" }
          : {
              kind: "profile",
              profileId: "openai:scoped",
              store: {
                version: 1,
                profiles: {
                  "openai:scoped": { type: "token", provider: "openai", token: "prepared-token" },
                },
              },
            };
      const options = {
        timeoutMs: 1000,
        agentDir: "/tmp/openclaw-agent",
        preparedAuth,
        authRequirement,
        authBindingFingerprint:
          authRequirement === "subscription" ? "profile-credential-fingerprint" : undefined,
      };
      const producer = getSharedCodexAppServerClient(options);
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      await expect(producer).resolves.toBe(harness.client);
      const response = { thread: { id: "thread-resume" } };
      const request = vi.spyOn(harness.client, "request").mockResolvedValue(response as never);

      await expect(
        withCodexAppServerJsonClient(options, async (send, client) => {
          expect(client).toBe(harness.client);
          return await send({
            method: "thread/resume",
            requestParams: { threadId: "thread-resume" },
          });
        }),
      ).resolves.toEqual(response);

      expect(start).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "thread/resume",
        { threadId: "thread-resume" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it.each([
    {
      options: { authProfileId: "openai:legacy" },
      error: "Prepared Codex auth cannot also select a legacy auth profile",
    },
    {
      options: { authRequirement: "subscription" as const },
      error: "Prepared Codex auth does not satisfy the requested auth requirement.",
    },
  ])("rejects invalid prepared auth before startup: $error", async ({ options, error }) => {
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    await expect(
      getSharedCodexAppServerClient({
        ...options,
        preparedAuth: { kind: "api-key", apiKey: "platform-key" },
      }),
    ).rejects.toThrow(error);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("rotates prepared API keys onto distinct shared clients", async () => {
    const firstHarness = createClientHarness();
    const secondHarness = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(firstHarness.client)
      .mockResolvedValueOnce(secondHarness.client);
    const cacheKeys: string[] = [];
    mocks.resolveCodexAppServerPreparedApiKeyCacheKey.mockImplementation((apiKey: string) => {
      const cacheKey =
        apiKey === "first-platform-key" ? "api_key:sha256:first" : "api_key:sha256:second";
      cacheKeys.push(cacheKey);
      return cacheKey;
    });

    const firstPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "api-key", apiKey: "first-platform-key" },
    });
    await sendInitializeResult(firstHarness, "openclaw/0.149.0 (macOS; test)");
    await expect(firstPromise).resolves.toBe(firstHarness.client);
    expect(mocks.resolveCodexAppServerAuthProfileStore).not.toHaveBeenCalled();
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    expect(bridgeStartOptionsCall().authProfileId).toBeNull();
    expect(bridgeStartOptionsCall().preparedAuth).toEqual({
      kind: "api-key",
      apiKey: "first-platform-key",
    });
    expect(applyAuthProfileCall()).toMatchObject({
      authProfileId: null,
      preparedAuth: { kind: "api-key", apiKey: "first-platform-key" },
    });
    expect(mocks.resolveCodexAppServerPreparedApiKeyCacheKey).toHaveBeenCalledWith(
      "first-platform-key",
    );

    const secondPromise = getSharedCodexAppServerClient({
      timeoutMs: 1000,
      preparedAuth: { kind: "api-key", apiKey: "second-platform-key" },
    });
    await sendInitializeResult(secondHarness, "openclaw/0.149.0 (macOS; test)");
    expect(startSpy).toHaveBeenCalledTimes(2);
    await expect(secondPromise).resolves.toBe(secondHarness.client);

    expect(cacheKeys).toEqual(["api_key:sha256:first", "api_key:sha256:second"]);
    expect(cacheKeys.join("\n")).not.toContain("platform-key");
    expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "first-platform-key" },
      }),
    );
    expect(mocks.applyCodexAppServerAuthProfile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "second-platform-key" },
      }),
    );
  });

  it.each(["explicit native", "user home"])(
    "skips target auth resolution for %s clients",
    async (selection) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const config = { auth: { order: { openai: ["openai:target"] } } };
      const clientPromise =
        selection === "explicit native"
          ? getSharedCodexAppServerClient({
              timeoutMs: 1000,
              authProfileId: null,
              agentDir: "/tmp/openclaw-target-agent",
              agentId: "research",
              config,
            })
          : createIsolatedCodexAppServerClient({
              timeoutMs: 1000,
              authProfileId: "openai:target",
              startOptions: createStartOptions({ homeScope: "user" }),
            });
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      await expect(clientPromise).resolves.toBe(harness.client);
      expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
      const bridgeCall = bridgeStartOptionsCall();
      const applyCall = applyAuthProfileCall();
      expect(bridgeCall.authProfileId).toBeNull();
      expect(applyCall.authProfileId).toBeNull();
      if (selection === "explicit native") {
        expect(bridgeCall.agentDir).toBe("/tmp/openclaw-target-agent");
        expect(bridgeCall.agentId).toBe("research");
        expect(bridgeCall.config).toBe(config);
        expect(applyCall.agentDir).toBe("/tmp/openclaw-target-agent");
        expect(applyCall.config).toBe(config);
      }
    },
  );

  it.each(["implicit profile", "selected agent", "managed binary"])(
    "carries resolved %s context through catalog startup",
    async (selection) => {
      const harness = createClientHarness();
      const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const config = { auth: { order: { openai: ["openai:work"] } } };
      if (selection === "implicit profile") {
        mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:work");
      } else if (selection === "managed binary") {
        mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(
          async (startOptions) => ({
            ...startOptions,
            command: "/cache/openclaw/codex",
            commandSource: "resolved-managed",
          }),
        );
      }
      const listPromise = listCodexAppServerModels({
        timeoutMs: 1000,
        ...(selection === "implicit profile"
          ? { config }
          : selection === "selected agent"
            ? { authProfileId: "openai:work", agentDir: "/tmp/openclaw-agent-nova" }
            : {}),
      });
      await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
      await sendEmptyModelList(harness);
      await expect(listPromise).resolves.toEqual({ models: [] });
      const bridgeCall = bridgeStartOptionsCall();
      const applyCall = applyAuthProfileCall();
      if (selection === "implicit profile") {
        expect(resolveAuthProfileCall()).toStrictEqual({
          authProfileId: undefined,
          agentDir: "/tmp/openclaw-agent",
          config,
        });
        expect(bridgeCall.authProfileId).toBe("openai:work");
        expect(bridgeCall.config).toBe(config);
        expect(applyCall.authProfileId).toBe("openai:work");
        expect(applyCall.config).toBe(config);
      } else if (selection === "selected agent") {
        expect(bridgeCall.agentDir).toBe("/tmp/openclaw-agent-nova");
        expect(bridgeCall.authProfileId).toBe("openai:work");
        expect(applyCall.agentDir).toBe("/tmp/openclaw-agent-nova");
        expect(applyCall.authProfileId).toBe("openai:work");
      } else {
        expect(managedStartOptionsCall().command).toBe("codex");
        expect(managedStartOptionsCall().commandSource).toBe("managed");
        expect(bridgeCall.startOptions.command).toBe("/cache/openclaw/codex");
        expect(bridgeCall.startOptions.commandSource).toBe("resolved-managed");
        expect(clientStartCall(startSpy).command).toBe("/cache/openclaw/codex");
        expect(clientStartCall(startSpy).commandSource).toBe("resolved-managed");
      }
    },
  );

  it("rechecks persisted native Computer Use before managed binary resolution", async () => {
    await withTempDir("openclaw-codex-shared-native-", async (agentDir) => {
      const codexHome = path.join(agentDir, "codex-home");
      await fs.mkdir(codexHome);
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);

      const clientPromise = createIsolatedCodexAppServerClient({
        agentDir,
        timeoutMs: 1000,
        startOptions: createStartOptions({
          homeScope: "agent",
          commandSource: "managed",
          managedComputerUsePluginNames: ["computer-use"],
          args: ["app-server", "--listen", "stdio://"],
        }),
      });
      await sendInitializeResult(harness, `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)`);

      await expect(clientPromise).resolves.toBe(harness.client);
      expect(managedStartOptionsCall().managedCommandOrder).toBe("desktop-first");
    });
  });

  it.each(["fallback API key", "auth requirement"])(
    "starts independent shared clients when the %s changes",
    async (selector) => {
      const first = createClientHarness();
      const second = createClientHarness();
      const startSpy = vi
        .spyOn(CodexAppServerClient, "start")
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(second.client);
      if (selector === "fallback API key") {
        mocks.resolveCodexAppServerFallbackApiKeyCacheKey
          .mockReturnValueOnce("api-key:first")
          .mockReturnValueOnce("api-key:second");
      }
      const firstList = listCodexAppServerModels({
        timeoutMs: 1000,
        authRequirement: "api-key",
        ...(selector === "auth requirement" ? { authProfileId: "openai:work" } : {}),
      });
      await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
      await sendEmptyModelList(first);
      await expect(firstList).resolves.toEqual({ models: [] });
      const secondList = listCodexAppServerModels({
        timeoutMs: 1000,
        authRequirement: selector === "auth requirement" ? "subscription" : "api-key",
        ...(selector === "auth requirement" ? { authProfileId: "openai:work" } : {}),
      });
      await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
      await sendEmptyModelList(second);
      await expect(secondList).resolves.toEqual({ models: [] });
      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(first.process.stdin.destroyed).toBe(false);
      expect(second.process.stdin.destroyed).toBe(false);
    },
  );

  it("does not let one shared-client failure tear down another keyed client", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: createStartOptions({
        transport: "websocket",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-first",
      }),
    });
    const firstFailure = firstList.catch((error: unknown) => error);
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(1));

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: createStartOptions({
        transport: "websocket",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-second",
      }),
    });
    await vi.waitFor(() => expect(second.writes.length).toBeGreaterThanOrEqual(1));

    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    first.client.close();
    await expect(firstFailure).resolves.toBeInstanceOf(Error);

    expect(second.process.kill).not.toHaveBeenCalled();
  });

  it("clears only an unclaimed current shared client", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: true,
      closed: true,
      activeLeases: 0,
      pendingAcquires: 0,
    });
    expect(first.process.stdin.destroyed).toBe(true);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: false,
      closed: false,
      activeLeases: 0,
      pendingAcquires: 0,
    });
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(second.client)).toEqual({
      found: true,
      closed: true,
      activeLeases: 0,
      pendingAcquires: 0,
    });
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("closes a retired shared app-server and forces active leases onto the retryable close path", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const releaseFirst = retainSharedCodexAppServerClientIfCurrent(first.client);
    const releaseSecond = retainSharedCodexAppServerClientIfCurrent(first.client);
    expect(releaseFirst).toBeTypeOf("function");
    expect(releaseSecond).toBeTypeOf("function");
    const activeRequest = first.client.request("test/pending", {});
    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 2,
      closed: true,
    });
    expect(first.process.stdin.destroyed).toBe(true);
    await expect(activeRequest).rejects.toThrow("codex app-server client is closed");

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    releaseFirst?.();
    releaseSecond?.();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.kill).not.toHaveBeenCalled();
    expect(retireSharedCodexAppServerClientIfCurrent(second.client)).toEqual({
      activeLeases: 0,
      closed: true,
    });
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("leases shared app-server clients before returning concurrent acquirers", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(first.client);

    const firstLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    const secondLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(firstLease).resolves.toBe(first.client);
    await expect(secondLease).resolves.toBe(first.client);

    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 2,
      closed: true,
    });
    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 2,
      closed: false,
    });
    expect(first.process.stdin.destroyed).toBe(true);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(false);
  });

  it("keeps the current client registered while a staggered sibling lease is active", async () => {
    const first = createClientHarness();
    const replacement = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(replacement.client);

    const completedRunLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    const siblingRunLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await expect(completedRunLease).resolves.toBe(first.client);
    await expect(siblingRunLease).resolves.toBe(first.client);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: true,
      closed: false,
      activeLeases: 1,
      pendingAcquires: 0,
    });
    expect(first.process.stdin.destroyed).toBe(false);

    const staggeredLease = await getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    expect(staggeredLease).toBe(first.client);
    expect(startSpy).toHaveBeenCalledTimes(1);

    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first.client)).toBe(true);
    expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(first.client)).toEqual({
      found: true,
      closed: true,
      activeLeases: 0,
      pendingAcquires: 0,
    });
    expect(first.process.stdin.destroyed).toBe(true);
  });

  it("rejects pending acquires during shared-client retirement", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);

    const firstLease = getLeasedSharedCodexAppServerClient();
    const pendingLease = getLeasedSharedCodexAppServerClient();
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(1));

    expect(
      retireSharedCodexAppServerClientIfCurrent(first.client, { failActiveLeases: true }),
    ).toEqual({
      activeLeases: 0,
      closed: true,
    });
    await expect(firstLease).rejects.toThrow("codex app-server client is closed");
    await expect(pendingLease).rejects.toThrow("codex app-server client is closed");

    const freshLease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await expect(freshLease).resolves.toBe(second.client);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it.each(["release", "suspect retirement", "global disposal"])(
    "settles a gracefully detached client through %s",
    async (settlement) => {
      const harness = createClientHarness();
      vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
      const lease = getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 });
      await sendInitializeResult(harness, "openclaw/0.149.0 (Linux; test)");
      await expect(lease).resolves.toBe(harness.client);
      const client = await lease;
      const current =
        settlement === "release" ? captureSharedCodexAppServerCatalogLifetime(client) : undefined;
      let releaseRetain: (() => void) | undefined;
      if (settlement === "global disposal") {
        releaseRetain = retainSharedCodexAppServerClientIfCurrent(client);
        expect(releaseRetain).toBeTypeOf("function");
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
      } else if (current) {
        expect(current()).toBe(true);
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
        expect(current()).toBe(true);
        await expect(getLeasedSharedCodexAppServerClient({ timeoutMs: 1000 })).resolves.toBe(
          client,
        );
        expect(current()).toBe(true);
      }
      expect(retireSharedCodexAppServerClientIfCurrent(client)).toEqual({
        activeLeases: 1,
        closed: false,
      });
      expect(harness.process.stdin.destroyed).toBe(false);
      if (current) {
        expect(current()).toBe(false);
      }
      if (settlement === "suspect retirement") {
        expect(
          retireSharedCodexAppServerClientIfCurrent(client, { failActiveLeases: true }),
        ).toEqual({ activeLeases: 1, closed: true });
        expect(harness.process.stdin.destroyed).toBe(true);
      }
      if (settlement === "global disposal") {
        await clearSharedCodexAppServerClientAndWait({ exitTimeoutMs: 25, forceKillDelayMs: 5 });
        expect(harness.process.stdin.destroyed).toBe(true);
        releaseRetain?.();
      } else {
        expect(releaseLeasedSharedCodexAppServerClient(client)).toBe(true);
        expect(harness.process.stdin.destroyed).toBe(true);
      }
    },
  );

  it("waits for a dirty desktop generation before reusing a warm managed client", async () => {
    const generation = { epoch: 1, fingerprint: "desktop-x" };
    mocks.desktopGeneration = generation;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    const config = {};
    const startOptions: CodexAppServerStartOptions = createStartOptions({
      homeScope: "agent",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
    });
    const options = { config, startOptions, agentDir: "/tmp/openclaw-agent" };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(harness, "openclaw/0.149.0 (macOS; test)");
    const first = await firstAcquire;
    const dirty = createDeferred<typeof generation>();
    mocks.waitForCodexDesktopGeneration.mockReturnValue(dirty.promise);
    let settled = false;
    const secondAcquire = getLeasedSharedCodexAppServerClient(options).then((client) => {
      settled = true;
      return client;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(startSpy).toHaveBeenCalledOnce();
    dirty.resolve(generation);
    await expect(secondAcquire).resolves.toBe(first);
    expect(startSpy).toHaveBeenCalledOnce();
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(first)).toBe(true);
  });

  it("bounds a dirty desktop generation wait by the acquisition abort signal", async () => {
    mocks.desktopGeneration = { epoch: 1, fingerprint: "desktop-x" };
    mocks.waitForCodexDesktopGeneration.mockReturnValue(new Promise(() => {}));
    const abort = new AbortController();
    const acquire = getLeasedSharedCodexAppServerClient({
      timeoutMs: 1_000,
      abandonSignal: abort.signal,
      startOptions: createStartOptions({
        homeScope: "agent",
        commandSource: "managed",
        managedCommandOrder: "desktop-first",
      }),
    });

    abort.abort();

    await expect(acquire).rejects.toThrow("codex app-server initialize aborted");
  });

  it.each(["during reconciliation", "after currentness check"])(
    "does not start an abandoned client %s",
    async (phase) => {
      const reconcileStarted = createDeferred<void>();
      const releaseReconcile = createDeferred<void>();
      const reconcileFinished = createDeferred<void>();
      const abort = new AbortController();
      mocks.reconcileCodexComputerUseStartArtifacts.mockImplementationOnce(
        async (value?: unknown) => {
          const params = value as { assertCurrent?: () => void };
          try {
            if (phase === "during reconciliation") {
              reconcileStarted.resolve();
              await releaseReconcile.promise;
              params.assertCurrent?.();
            } else {
              params.assertCurrent?.();
              abort.abort();
            }
          } finally {
            reconcileFinished.resolve();
          }
        },
      );
      const startSpy = vi.spyOn(CodexAppServerClient, "start");
      const acquire = getLeasedSharedCodexAppServerClient({
        config: {},
        agentDir: "/tmp/openclaw-agent",
        startOptions: createStartOptions({ homeScope: "agent", commandSource: "managed" }),
        timeoutMs: 1_000,
        abandonSignal: abort.signal,
      });
      if (phase === "during reconciliation") {
        await reconcileStarted.promise;
        abort.abort();
      }
      await expect(acquire).rejects.toThrow("codex app-server initialize aborted");
      releaseReconcile.resolve();
      await reconcileFinished.promise;
      await Promise.resolve();
      expect(startSpy).not.toHaveBeenCalled();
    },
  );

  it("keeps active leases alive while a desktop replacement initializes", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness({ autoEmitExit: false });
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const config = {};
    const startOptions: CodexAppServerStartOptions = createStartOptions({
      homeScope: "agent",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
    });
    const options = {
      config,
      startOptions,
      agentDir: "/tmp/openclaw-agent",
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    const siblingAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;
    await expect(siblingAcquire).resolves.toBe(clientX);
    const pending = clientX.request("test/pending", {});
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(2));

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const replacementAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await replacementAcquire;
    expect(clientY).toBe(second.client);
    expect(clientY).not.toBe(clientX);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(mocks.reconcileCodexComputerUseStartArtifacts).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);

    const pendingRequest = JSON.parse(first.writes.at(-1) ?? "{}") as { id?: number };
    first.send({ id: pendingRequest.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
    first.emitExit();
    expect(second.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it("does not block generation Y artifacts on an older client for another home", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      commandSource: "resolved-managed" as const,
    }));
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const startOptions: CodexAppServerStartOptions = createStartOptions({
      homeScope: "agent",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
    });
    const common = {
      config: {},
      startOptions,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient({
      ...common,
      agentDir: "/tmp/openclaw-agent-a",
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const secondAcquire = getLeasedSharedCodexAppServerClient({
      ...common,
      agentDir: "/tmp/openclaw-agent-b",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    const clientY = await secondAcquire;

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(first.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it("tracks a package-first client whose Computer Use artifacts come from the desktop", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed" as const,
      managedFallbackCommandPaths: ["/Applications/Codex.app/Contents/Resources/codex"],
    }));
    const packageX = createClientHarness();
    const packageY = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(packageX.client)
      .mockResolvedValueOnce(packageY.client);
    const options = {
      config: {},
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      agentDir: "/tmp/openclaw-agent",
      startOptions: createStartOptions({
        homeScope: "agent" as const,
        commandSource: "managed" as const,
        managedCommandOrder: "package-first" as const,
      }),
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageX, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const replacementAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageY, "openclaw/0.149.0 (macOS; test)");
    const clientY = await replacementAcquire;
    expect(packageX.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(packageX.process.stdin.destroyed).toBe(true);
    expect(clientY).not.toBe(clientX);
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(
      mocks.reconcileCodexComputerUseStartArtifacts.mock.calls.map(
        ([params]) => params?.desktopGeneration,
      ),
    ).toEqual([generationX, generationY]);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it("does not generation-bind an env-selected custom Computer Use app-server", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    const packageX = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(packageX.client);
    const options = {
      config: {},
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      agentDir: "/tmp/openclaw-agent",
      startOptions: createStartOptions({
        homeScope: "agent" as const,
        command: "/opt/codex/bin/codex",
        commandSource: "env",
      }),
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageX, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;
    expect(readCodexAppServerClientDesktopGeneration(clientX)).toBeUndefined();

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const clientAfterDesktopUpdate = await getLeasedSharedCodexAppServerClient(options);

    expect(clientAfterDesktopUpdate).toBe(clientX);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(
      mocks.reconcileCodexComputerUseStartArtifacts.mock.calls.map(
        ([params]) => params?.desktopGeneration,
      ),
    ).toEqual([undefined]);
    expect(releaseLeasedSharedCodexAppServerClient(clientAfterDesktopUpdate)).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
  });

  it("binds a package-first acquisition when its actual fallback is a desktop app", async () => {
    const generationX = { epoch: 1, fingerprint: "desktop-x" };
    const generationY = { epoch: 2, fingerprint: "desktop-y" };
    mocks.desktopGeneration = generationX;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed" as const,
      managedFallbackCommandPaths: ["/Applications/Codex.app/Contents/Resources/codex"],
    }));
    const packageX = createClientHarness();
    const desktopX = createClientHarness();
    const packageY = createClientHarness();
    const desktopY = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(packageX.client)
      .mockResolvedValueOnce(desktopX.client)
      .mockResolvedValueOnce(packageY.client)
      .mockResolvedValueOnce(desktopY.client);
    const options = {
      config: {},
      agentDir: "/tmp/openclaw-agent",
      startOptions: createStartOptions({
        homeScope: "agent" as const,
        commandSource: "managed" as const,
        managedCommandOrder: "package-first" as const,
      }),
    };

    const firstAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageX, "openclaw/0.124.9 (macOS; test)");
    await sendInitializeResult(desktopX, "openclaw/0.149.0 (macOS; test)");
    const clientX = await firstAcquire;

    mocks.desktopGeneration = generationY;
    retireSharedCodexAppServerClientsBeforeDesktopGeneration(generationY);
    const replacementAcquire = getLeasedSharedCodexAppServerClient(options);
    await sendInitializeResult(packageY, "openclaw/0.124.9 (macOS; test)");
    await sendInitializeResult(desktopY, "openclaw/0.149.0 (macOS; test)");
    const clientY = await replacementAcquire;

    expect(clientX).toBe(desktopX.client);
    expect(clientY).toBe(desktopY.client);
    expect(
      mocks.reconcileCodexComputerUseStartArtifacts.mock.calls.map(
        ([params]) => params?.startOptions.command,
      ),
    ).toEqual([
      "/cache/openclaw/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/cache/openclaw/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ]);
    expect(desktopX.process.stdin.destroyed).toBe(false);
    expect(releaseLeasedSharedCodexAppServerClient(clientX)).toBe(true);
    expect(desktopX.process.stdin.destroyed).toBe(true);
    expect(releaseLeasedSharedCodexAppServerClient(clientY)).toBe(true);
  });

  it.each(["context preparation", "artifact reconciliation"] as const)(
    "drains catalog startup during harness disposal at %s",
    async (phase) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const park = async () => {
        entered.resolve();
        await release.promise;
      };
      if (phase === "context preparation") {
        mocks.bridgeCodexAppServerStartOptions.mockImplementationOnce(async ({ startOptions }) => {
          await park();
          return startOptions;
        });
      } else {
        mocks.reconcileCodexComputerUseStartArtifacts.mockImplementationOnce(park);
      }
      const transport = createClientHarness({
        onWrite(line, send) {
          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.id === undefined) {
            return;
          }
          const result =
            message.method === "initialize"
              ? { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` }
              : message.method === "model/list"
                ? { data: [], nextCursor: null }
                : { account: null, requiresOpenaiAuth: false };
          send({ id: message.id, result });
        },
      });
      const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(transport.client);
      const harness = createCodexAppServerAgentHarness({
        bindingStore: createCodexTestBindingStore(),
        pluginConfig: {
          appServer: { homeScope: "agent" },
          discovery: { timeoutMs: 1_000 },
        },
      });
      const load = harness.loadModelCatalog!({
        config: {},
        agentId: "main",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/workspace",
      }).catch((error: unknown) => error);
      let disposal: Promise<void> | undefined;
      try {
        await entered.promise;
        let disposed = false;
        disposal = Promise.resolve(harness.dispose!()).then(() => {
          disposed = true;
        });
        // Observe a whole event-loop turn while the admitted startup is still parked.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(disposed).toBe(false);
        release.resolve();
        await disposal;
        await load;
        expect(start).not.toHaveBeenCalled();
        expect(transport.writes).toEqual([]);
      } finally {
        release.resolve();
        await load;
        await disposal;
        await transport.client.closeAndWait();
        await harness.dispose?.();
      }
    },
  );

  it("closes shared transports despite a failing close observer and reopens admission", async () => {
    const first = createInitializingClientHarness();
    const second = createInitializingClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const client = await getSharedCodexAppServerClient({ timeoutMs: 1_000 });
    const closeError = new Error("close observer failed");
    const removeHandler = client.addCloseHandler(() => {
      throw closeError;
    });
    const laterObserver = vi.fn();
    client.addCloseHandler(laterObserver);
    try {
      await expect(clearSharedCodexAppServerClientAndWait()).resolves.toBeUndefined();
      expect(first.stdinDestroyed).toBe(true);
      expect(first.process.stdout.destroyed).toBe(true);
      expect(first.process.stderr.destroyed).toBe(true);
      expect(laterObserver).toHaveBeenCalledExactlyOnceWith(client);
      expect(mocks.embeddedAgentLog.warn).toHaveBeenCalledWith(
        "codex app-server close handler failed",
        { error: closeError },
      );
      await expect(getSharedCodexAppServerClient({ timeoutMs: 1_000 })).resolves.toBe(
        second.client,
      );
    } finally {
      removeHandler();
      await Promise.all([first, second].map(({ client: owned }) => owned.closeAndWait()));
    }
  });

  it("joins sibling transports before reporting a close failure and reopening admission", async () => {
    const first = createInitializingClientHarness();
    const second = createInitializingClientHarness();
    const replacement = createInitializingClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client)
      .mockResolvedValueOnce(replacement.client);
    await getSharedCodexAppServerClient({ agentDir: "/tmp/close-first", timeoutMs: 1_000 });
    await getSharedCodexAppServerClient({ agentDir: "/tmp/close-second", timeoutMs: 1_000 });
    const firstClose = first.client.closeAndWait.bind(first.client);
    const secondClose = second.client.closeAndWait.bind(second.client);
    const firstClosed = createDeferred<void>();
    const releaseSecond = createDeferred<void>();
    const closeError = new Error("transport close failed after exit");
    vi.spyOn(first.client, "closeAndWait").mockImplementationOnce(async (options) => {
      await firstClose(options);
      firstClosed.resolve();
      throw closeError;
    });
    vi.spyOn(second.client, "closeAndWait").mockImplementationOnce(async (options) => {
      await releaseSecond.promise;
      return secondClose(options);
    });
    let settled = false;
    const disposal = clearSharedCodexAppServerClientAndWait()
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await firstClosed.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      await expect(getSharedCodexAppServerClient()).rejects.toThrow("initialize aborted");
      releaseSecond.resolve();
      expect(await disposal).toBe(closeError);
      expect(second.stdinDestroyed).toBe(true);
      await expect(getSharedCodexAppServerClient({ timeoutMs: 1_000 })).resolves.toBe(
        replacement.client,
      );
    } finally {
      releaseSecond.resolve();
      await disposal;
      await Promise.all(
        [first, second, replacement].map(({ client: owned }) => owned.closeAndWait()),
      );
    }
  });

  it("leaves a ready isolated client with its caller during shared disposal", async () => {
    const transport = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(transport.client);
    const acquire = createIsolatedCodexAppServerClient({ timeoutMs: 1_000 });
    await sendInitializeResult(transport, `codex-cli/${CODEX_APP_SERVER_VERSION}`);
    const client = await acquire;
    try {
      await clearSharedCodexAppServerClientAndWait();
      expect(transport.stdinDestroyed).toBe(false);
      const request = client.request("model/list", { limit: null });
      await sendEmptyModelList(transport);
      await expect(request).resolves.toEqual({ data: [] });
    } finally {
      await client.closeAndWait();
    }
  });

  it("waits only for the shared client that is still current", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const firstCloseAndWait = vi.spyOn(first.client, "closeAndWait");
    const secondCloseAndWait = vi.spyOn(second.client, "closeAndWait");

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.149.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    await expect(
      clearSharedCodexAppServerClientIfCurrentAndWait(first.client, {
        exitTimeoutMs: 25,
        forceKillDelayMs: 5,
      }),
    ).resolves.toBe(true);

    expect(firstCloseAndWait).toHaveBeenCalledTimes(1);
    expect(secondCloseAndWait).not.toHaveBeenCalled();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("uses a fresh websocket Authorization header after shared-client token rotation", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const authHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.149.0" } }),
          );
          return;
        }
        if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });

    try {
      await new Promise<void>((resolve) => {
        server.once("listening", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected websocket test server port");
      }
      const url = `ws://127.0.0.1:${address.port}`;

      await expect(
        listCodexAppServerModels({
          timeoutMs: 1000,
          startOptions: createStartOptions({
            transport: "websocket",
            args: [],
            url,
            authToken: "tok-first",
          }),
        }),
      ).resolves.toEqual({ models: [] });
      await expect(
        listCodexAppServerModels({
          timeoutMs: 1000,
          startOptions: createStartOptions({
            transport: "websocket",
            args: [],
            url,
            authToken: "tok-second",
          }),
        }),
      ).resolves.toEqual({ models: [] });

      expect(authHeaders).toEqual(["Bearer tok-first", "Bearer tok-second"]);
    } finally {
      await clearSharedCodexAppServerClientAndWait();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
