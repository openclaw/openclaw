// Codex tests cover shared client plugin behavior.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./client.js";
import { createClientHarness } from "./test-support.js";

type AuthProfileResolverParams = Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0];

const mocks = vi.hoisted(() => ({
  bridgeCodexAppServerStartOptions: vi.fn(async ({ startOptions }) => startOptions),
  applyCodexAppServerAuthProfile: vi.fn(
    async (_params?: {
      client?: CodexAppServerClient;
      agentDir?: string;
      authProfileId?: string;
      config?: unknown;
    }) => undefined,
  ),
  resolveCodexAppServerAuthProfileIdForAgent: vi.fn(
    (params?: AuthProfileResolverParams) => params?.authProfileId,
  ),
  resolveCodexAppServerAuthProfileStore: vi.fn(
    (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
  ),
  resolveCodexAppServerAuthAccountCacheKey: vi.fn(async () => "account:credential"),
  refreshCodexAppServerAuthTokens: vi.fn(async () => ({
    accessToken: "refreshed-access",
    chatgptAccountId: "refreshed-account",
    chatgptPlanType: null,
  })),
  resolveCodexAppServerFallbackApiKeyCacheKey: vi.fn(() => undefined as string | undefined),
  resolveManagedCodexAppServerStartOptions: vi.fn(async (startOptions) => startOptions),
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  resolveDefaultAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("./auth-bridge.js", () => ({
  applyCodexAppServerAuthProfile: mocks.applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions: mocks.bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent: mocks.resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerAuthProfileStore: mocks.resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerAuthAccountCacheKey: mocks.resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerFallbackApiKeyCacheKey: mocks.resolveCodexAppServerFallbackApiKeyCacheKey,
  refreshCodexAppServerAuthTokens: mocks.refreshCodexAppServerAuthTokens,
}));

vi.mock("./managed-binary.js", () => ({
  resolveManagedCodexAppServerStartOptions: mocks.resolveManagedCodexAppServerStartOptions,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: mocks.embeddedAgentLog,
  OPENCLAW_VERSION: "test",
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveDefaultAgentDir: mocks.resolveDefaultAgentDir,
}));

let listCodexAppServerModels: typeof import("./models.js").listCodexAppServerModels;
let clearSharedCodexAppServerClientAndWait: typeof import("./shared-client.js").clearSharedCodexAppServerClientAndWait;
let createIsolatedCodexAppServerClient: typeof import("./shared-client.js").createIsolatedCodexAppServerClient;
let leaseSharedCodexAppServerClient: typeof import("./shared-client.js").leaseSharedCodexAppServerClient;
let retainSharedCodexAppServerClient: typeof import("./shared-client.js").retainSharedCodexAppServerClient;
let resetSharedCodexAppServerClientForTests: typeof import("./shared-client.js").resetSharedCodexAppServerClientForTests;

async function sendInitializeResult(
  harness: ReturnType<typeof createClientHarness>,
  userAgent: string,
): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
  const initialize = JSON.parse(harness.writes[0] ?? "{}") as { id?: number };
  harness.send({ id: initialize.id, result: { userAgent } });
}

async function sendEmptyModelList(harness: ReturnType<typeof createClientHarness>): Promise<void> {
  await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(3));
  const modelList = JSON.parse(harness.writes[2] ?? "{}") as { id?: number };
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
    authProfileId?: string;
    authProfileStore?: unknown;
    config?: unknown;
    startOptions: { command?: string; commandSource?: string };
  };
}

function applyAuthProfileCall() {
  return firstMockArg(mocks.applyCodexAppServerAuthProfile, "apply auth profile") as {
    agentDir?: string;
    authProfileId?: string;
    authProfileStore?: unknown;
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
  };
}

function clientStartCall(startSpy: unknown) {
  return firstMockArg(startSpy, "CodexAppServerClient.start") as {
    command?: string;
    commandSource?: string;
  };
}

describe("shared Codex app-server client", () => {
  beforeAll(async () => {
    ({ listCodexAppServerModels } = await import("./models.js"));
    ({
      clearSharedCodexAppServerClientAndWait,
      createIsolatedCodexAppServerClient,
      leaseSharedCodexAppServerClient,
      retainSharedCodexAppServerClient,
      resetSharedCodexAppServerClientForTests,
    } = await import("./shared-client.js"));
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    mocks.bridgeCodexAppServerStartOptions.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockClear();
    mocks.applyCodexAppServerAuthProfile.mockImplementation(async () => undefined);
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockClear();
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockImplementation(
      (params?: AuthProfileResolverParams) => params?.authProfileId,
    );
    mocks.resolveCodexAppServerAuthProfileStore.mockClear();
    mocks.resolveCodexAppServerAuthProfileStore.mockImplementation(
      (params?: { authProfileStore?: unknown }) => params?.authProfileStore,
    );
    mocks.resolveCodexAppServerAuthAccountCacheKey.mockClear();
    mocks.resolveCodexAppServerAuthAccountCacheKey.mockResolvedValue("account:credential");
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockClear();
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey.mockReturnValue(undefined);
    mocks.refreshCodexAppServerAuthTokens.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockClear();
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementation(
      async (startOptions) => startOptions,
    );
    mocks.embeddedAgentLog.debug.mockClear();
    mocks.embeddedAgentLog.warn.mockClear();
    mocks.resolveDefaultAgentDir.mockClear();
  });

  it("closes the shared app-server when the version gate fails", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    // Model discovery uses the shared-client path, which owns child teardown
    // when initialize discovers an unsupported app-server.
    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.117.9 (macOS; test)");

    await expect(listPromise).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.process.stdin.destroyed).toBe(true);
    startSpy.mockRestore();
  });

  it("closes and clears a shared app-server when initialize times out", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    await expect(listCodexAppServerModels({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    expect(first.process.stdin.destroyed).toBe(true);

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);

    await expect(secondList).resolves.toEqual({ models: [] });
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps a pending shared app-server alive when another acquire still owns startup", async () => {
    const harness = createClientHarness();
    const abandonController = new AbortController();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const abandonedAcquire = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      abandonSignal: abandonController.signal,
    });
    const abandonedResult = abandonedAcquire.catch((error: unknown) => error);
    const activeAcquire = leaseSharedCodexAppServerClient({ timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));

    abandonController.abort();
    expect(harness.process.stdin.destroyed).toBe(false);

    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(abandonedResult).resolves.toBeInstanceOf(Error);
    const activeLease = await activeAcquire;
    expect(activeLease.client).toBe(harness.client);
    expect(harness.process.stdin.destroyed).toBe(false);
    activeLease.release();
  });

  it("does not let one acquire timeout close startup owned by another caller", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const timedOutAcquire = leaseSharedCodexAppServerClient({ timeoutMs: 5 });
    const activeAcquire = leaseSharedCodexAppServerClient({ timeoutMs: 1000 });

    await expect(timedOutAcquire).rejects.toThrow("codex app-server initialize timed out");
    expect(harness.process.stdin.destroyed).toBe(false);

    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    const activeLease = await activeAcquire;
    expect(activeLease.client).toBe(harness.client);
    expect(harness.process.stdin.destroyed).toBe(false);
    activeLease.release();
  });

  it("does not launch a client after its only acquire times out during preparation", async () => {
    let finishManagedResolution!: () => void;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(async (startOptions) => {
      await new Promise<void>((resolve) => {
        finishManagedResolution = resolve;
      });
      return startOptions;
    });
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    const startOptions = {
      transport: "stdio" as const,
      command: "codex",
      commandSource: "managed" as const,
      args: ["app-server", "--listen", "stdio://"],
      headers: {},
    };

    await expect(
      leaseSharedCodexAppServerClient({
        startOptions,
        authProfileId: "openai:work",
        timeoutMs: 5,
      }),
    ).rejects.toThrow("codex app-server preparation timed out");
    finishManagedResolution();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does not launch an isolated client after preparation times out", async () => {
    let finishManagedResolution!: () => void;
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(async (startOptions) => {
      await new Promise<void>((resolve) => {
        finishManagedResolution = resolve;
      });
      return startOptions;
    });
    const startSpy = vi.spyOn(CodexAppServerClient, "start");

    await expect(createIsolatedCodexAppServerClient({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server preparation timed out",
    );
    finishManagedResolution();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does not create a pool entry when abort wins after preparation resolves", async () => {
    const controller = new AbortController();
    const originalThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
      checks += 1;
      if (checks === 2) {
        controller.abort(new Error("aborted after preparation"));
      }
      originalThrowIfAborted();
    });
    const startSpy = vi.spyOn(CodexAppServerClient, "start");

    await expect(
      leaseSharedCodexAppServerClient({
        timeoutMs: 1000,
        authProfileId: "openai:work",
        abandonSignal: controller.signal,
      }),
    ).rejects.toThrow("aborted after preparation");

    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does not grant a lease when abort wins after initialization resolves", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const controller = new AbortController();
    const originalThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    vi.spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
      checks += 1;
      if (checks === 4) {
        controller.abort(new Error("aborted after initialization"));
      }
      originalThrowIfAborted();
    });

    const leasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      abandonSignal: controller.signal,
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(leasePromise).rejects.toThrow("aborted after initialization");
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("does not wait for isolated initialize after a timeout closes the client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    await expect(createIsolatedCodexAppServerClient({ timeoutMs: 5 })).rejects.toThrow(
      "codex app-server initialize timed out",
    );
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("bounds isolated auth application with the same startup deadline", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    mocks.applyCodexAppServerAuthProfile.mockImplementationOnce(
      async () => await new Promise<undefined>(() => {}),
    );

    const clientPromise = createIsolatedCodexAppServerClient({ timeoutMs: 100 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(clientPromise).rejects.toThrow("codex app-server initialize timed out");
    expect(harness.process.stdin.destroyed).toBe(true);
  });

  it("passes the selected auth profile through the bridge helper", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.authProfileId).toBe("openai:work");
  });

  it("carries a scoped auth store through isolated app-server startup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const authProfileStore = { version: 1, profiles: {} };
    const preparedAuthProfileStore = {
      version: 1,
      profiles: {
        "openai:scoped": { type: "token", provider: "openai", token: "prepared-token" },
      },
    };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:scoped");
    mocks.resolveCodexAppServerAuthProfileStore.mockReturnValue(preparedAuthProfileStore);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileStore,
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileStore).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: undefined,
      authProfileStore,
      config: undefined,
    });
    expect(resolveAuthProfileCall().authProfileStore).toBe(preparedAuthProfileStore);
    expect(bridgeStartOptionsCall().authProfileStore).toBe(preparedAuthProfileStore);
    expect(applyAuthProfileCall().authProfileStore).toBe(preparedAuthProfileStore);

    const priorWriteCount = harness.writes.length;
    harness.send({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "scoped-account" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(priorWriteCount));

    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:scoped",
      authProfileStore: preparedAuthProfileStore,
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-1",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "refreshed-account",
        chatgptPlanType: null,
      },
    });
  });

  it("registers persisted profile refresh for isolated app-server startup", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const clientPromise = createIsolatedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:persisted",
      agentDir: "/tmp/openclaw-persisted-agent",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    await expect(clientPromise).resolves.toBe(harness.client);
    const priorWriteCount = harness.writes.length;
    harness.send({
      id: "refresh-persisted",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "persisted-account" },
    });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThan(priorWriteCount));

    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw-persisted-agent",
      authProfileId: "openai:persisted",
      config: undefined,
    });
    expect(JSON.parse(harness.writes.at(-1) ?? "{}")).toEqual({
      id: "refresh-persisted",
      result: {
        accessToken: "refreshed-access",
        chatgptAccountId: "refreshed-account",
        chatgptPlanType: null,
      },
    });
  });

  it("installs physical-client handlers before initialization completes", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const leasePromise = leaseSharedCodexAppServerClient({ timeoutMs: 1000 });
    await vi.waitFor(() => expect(harness.writes.length).toBeGreaterThanOrEqual(1));
    harness.send({
      id: "refresh-during-initialize",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });
    await vi.waitFor(() =>
      expect(harness.writes.map((line) => JSON.parse(line) as unknown)).toContainEqual({
        id: "refresh-during-initialize",
        result: {
          accessToken: "refreshed-access",
          chatgptAccountId: "refreshed-account",
          chatgptPlanType: null,
        },
      }),
    );
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    const lease = await leasePromise;
    expect(lease.client).toBe(harness.client);
    expect(mocks.refreshCodexAppServerAuthTokens).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it("skips target auth resolution when native source auth is requested", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const config = { auth: { order: { openai: ["openai:target"] } } };

    const leasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-target-agent",
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");

    const lease = await leasePromise;
    expect(lease.client).toBe(harness.client);
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(bridgeCall.authProfileId).toBeNull();
    expect(bridgeCall.config).toBe(config);
    const applyCall = applyAuthProfileCall();
    expect(applyCall.agentDir).toBe("/tmp/openclaw-target-agent");
    expect(applyCall.authProfileId).toBeNull();
    expect(applyCall.config).toBe(config);
    lease.release();
  });

  it("resolves the configured implicit auth profile before sharing a client", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    const config = { auth: { order: { openai: ["openai:work"] } } };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockReturnValue("openai:work");

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      config,
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const resolveCall = resolveAuthProfileCall();
    expect(resolveCall).toStrictEqual({
      agentDir: "/tmp/openclaw-agent",
      config,
    });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    expect(bridgeCall?.config).toBe(config);
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.authProfileId).toBe("openai:work");
    expect(applyCall?.config).toBe(config);
  });

  it("separates shared clients when implicit auth resolves to different profiles", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const firstConfig = { auth: { order: { openai: ["openai:work"] } } };
    const secondConfig = { auth: { order: { openai: ["openai:personal"] } } };
    mocks.resolveCodexAppServerAuthProfileIdForAgent.mockImplementation(
      ({ config }: AuthProfileResolverParams = {}) => config?.auth?.order?.openai?.[0],
    );
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({ timeoutMs: 1000, config: firstConfig });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({ timeoutMs: 1000, config: secondConfig });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it("uses the selected agent dir for shared app-server auth bridging", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const listPromise = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
      agentDir: "/tmp/openclaw-agent-nova",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.agentDir).toBe("/tmp/openclaw-agent-nova");
    expect(bridgeCall?.authProfileId).toBe("openai:work");
    const applyCall = applyAuthProfileCall();
    expect(applyCall?.agentDir).toBe("/tmp/openclaw-agent-nova");
    expect(applyCall?.authProfileId).toBe("openai:work");
  });

  it("keeps an active shared client alive when another agent dir uses a different key", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("bounds idle shared clients and closes the least recently released process", async () => {
    const harnesses = Array.from({ length: 5 }, () => createClientHarness());
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    for (const harness of harnesses) {
      startSpy.mockReturnValueOnce(harness.client);
    }

    for (const [index, harness] of harnesses.slice(0, 4).entries()) {
      const leasePromise = leaseSharedCodexAppServerClient({
        timeoutMs: 1000,
        authProfileId: null,
        agentDir: `/tmp/openclaw-agent-${index}`,
      });
      await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
      const lease = await leasePromise;
      lease.release();
    }
    const refreshed = await leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-agent-0",
    });
    refreshed.release();
    const newestLeasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-agent-4",
    });
    await sendInitializeResult(harnesses[4], "openclaw/0.125.0 (macOS; test)");
    (await newestLeasePromise).release();

    expect(harnesses[0]?.process.stdin.destroyed).toBe(false);
    expect(harnesses[1]?.process.stdin.destroyed).toBe(true);
    for (const harness of harnesses.slice(2)) {
      expect(harness.process.stdin.destroyed).toBe(false);
    }
  });

  it("does not evict a client retained by detached background work", async () => {
    const retained = createClientHarness();
    const idle = Array.from({ length: 5 }, () => createClientHarness());
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    for (const harness of [retained, ...idle]) {
      startSpy.mockReturnValueOnce(harness.client);
    }
    const retainedLeasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: null,
      agentDir: "/tmp/openclaw-retained-agent",
    });
    await sendInitializeResult(retained, "openclaw/0.125.0 (macOS; test)");
    const retainedLease = await retainedLeasePromise;
    const releaseRetention = retainSharedCodexAppServerClient(retained.client);
    retainedLease.release();

    for (const [index, harness] of idle.entries()) {
      const leasePromise = leaseSharedCodexAppServerClient({
        timeoutMs: 1000,
        authProfileId: null,
        agentDir: `/tmp/openclaw-idle-agent-${index}`,
      });
      await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
      (await leasePromise).release();
    }

    expect(retained.process.stdin.destroyed).toBe(false);
    releaseRetention();
    expect(retained.process.stdin.destroyed).toBe(false);
  });

  it("resolves the managed binary before bridging and spawning the shared client", async () => {
    const harness = createClientHarness();
    const startSpy = vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
    mocks.resolveManagedCodexAppServerStartOptions.mockImplementationOnce(async (startOptions) => ({
      ...startOptions,
      command: "/cache/openclaw/codex",
      commandSource: "resolved-managed",
    }));

    const listPromise = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(harness);

    await expect(listPromise).resolves.toEqual({ models: [] });
    const managedCall = managedStartOptionsCall();
    expect(managedCall?.command).toBe("codex");
    expect(managedCall?.commandSource).toBe("managed");
    const bridgeCall = bridgeStartOptionsCall();
    expect(bridgeCall?.startOptions.command).toBe("/cache/openclaw/codex");
    expect(bridgeCall?.startOptions.commandSource).toBe("resolved-managed");
    const startCall = clientStartCall(startSpy);
    expect(startCall?.command).toBe("/cache/openclaw/codex");
    expect(startCall?.commandSource).toBe("resolved-managed");
  });

  it("resolves managed binary metadata once while refreshing credentials per acquire", async () => {
    const harness = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    const firstLeasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
    const firstLease = await firstLeasePromise;
    firstLease.release();

    const secondLease = await leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    secondLease.release();

    expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledOnce();
    expect(mocks.bridgeCodexAppServerStartOptions).toHaveBeenCalledTimes(2);
  });

  it("starts an independent shared client when the bridged auth token changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-first",
        headers: {},
      },
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-second",
        headers: {},
      },
    });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
  });

  it("keeps native and fallback auth in separate shared scopes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const firstList = listCodexAppServerModels({ timeoutMs: 1000, authProfileId: null });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("starts a new shared client when fallback api-key auth changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    mocks.resolveCodexAppServerFallbackApiKeyCacheKey
      .mockReturnValueOnce("api-key:first")
      .mockReturnValueOnce("api-key:second");

    const firstList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
    expect(second.process.stdin.destroyed).toBe(false);
  });

  it("starts a new shared client when an explicit profile credential changes", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    const startSpy = vi
      .spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    mocks.resolveCodexAppServerAuthAccountCacheKey
      .mockResolvedValueOnce("account:credential-1")
      .mockResolvedValueOnce("account:credential-2");

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(first);
    await expect(firstList).resolves.toEqual({ models: [] });

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(first.process.stdin.destroyed).toBe(false);
  });

  it("does not let one shared-client failure tear down another keyed client", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    const firstList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-first",
        headers: {},
      },
    });
    const firstFailure = firstList.catch((error: unknown) => error);
    await vi.waitFor(() => expect(first.writes.length).toBeGreaterThanOrEqual(1));

    const secondList = listCodexAppServerModels({
      timeoutMs: 1000,
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "tok-second",
        headers: {},
      },
    });
    await vi.waitFor(() => expect(second.writes.length).toBeGreaterThanOrEqual(1));

    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    await sendEmptyModelList(second);
    await expect(secondList).resolves.toEqual({ models: [] });

    first.client.close();
    await expect(firstFailure).resolves.toBeInstanceOf(Error);

    expect(second.process.kill).not.toHaveBeenCalled();
  });

  it("abandons a matching shared client without disturbing its replacement", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const firstCloseAndWait = vi.spyOn(first.client, "closeAndWait");

    const firstLeasePromise = leaseSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    const firstLease = await firstLeasePromise;

    await firstLease.abandon();
    expect(first.process.stdin.destroyed).toBe(true);

    const secondLeasePromise = leaseSharedCodexAppServerClient({ timeoutMs: 1000 });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    const secondLease = await secondLeasePromise;

    await firstLease.abandon();
    firstLease.release();
    expect(firstCloseAndWait).toHaveBeenCalledTimes(1);
    expect(second.process.kill).not.toHaveBeenCalled();
    await secondLease.abandon();
    expect(second.process.stdin.destroyed).toBe(true);
  });

  it("closes an abandoned client without removing its idle replacement", async () => {
    const retired = createClientHarness();
    const replacement = createClientHarness();
    const otherIdle = Array.from({ length: 4 }, () => createClientHarness());
    const startSpy = vi.spyOn(CodexAppServerClient, "start");
    for (const harness of [retired, replacement, ...otherIdle]) {
      startSpy.mockReturnValueOnce(harness.client);
    }
    const sharedOptions = {
      timeoutMs: 1000,
      authProfileId: "openai:work",
    };
    const retiringLeasePromise = leaseSharedCodexAppServerClient(sharedOptions);
    const liveLeasePromise = leaseSharedCodexAppServerClient(sharedOptions);
    await sendInitializeResult(retired, "openclaw/0.125.0 (macOS; test)");
    const retiringLease = await retiringLeasePromise;
    const liveLease = await liveLeasePromise;

    await retiringLease.abandon();
    const replacementLeasePromise = leaseSharedCodexAppServerClient(sharedOptions);
    await sendInitializeResult(replacement, "openclaw/0.125.0 (macOS; test)");
    const replacementLease = await replacementLeasePromise;
    replacementLease.release();

    const releaseRetention = retainSharedCodexAppServerClient(retired.client);
    for (const [index, harness] of otherIdle.entries()) {
      const leasePromise = leaseSharedCodexAppServerClient({
        ...sharedOptions,
        agentDir: `/tmp/openclaw-retired-idle-agent-${index}`,
      });
      await sendInitializeResult(harness, "openclaw/0.125.0 (macOS; test)");
      (await leasePromise).release();
    }

    expect(replacement.process.stdin.destroyed).toBe(true);
    expect(retired.process.stdin.destroyed).toBe(true);
    releaseRetention();
    liveLease.release();
    expect(retired.process.stdin.destroyed).toBe(true);
  });

  it("settles each concurrent shared-client lease exactly once", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(first.client);
    const close = vi.spyOn(first.client, "close");
    const closeAndWait = vi.spyOn(first.client, "closeAndWait");

    const firstLeasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    const secondLeasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    const firstLease = await firstLeasePromise;
    const secondLease = await secondLeasePromise;
    expect(firstLease.client).toBe(first.client);
    expect(secondLease.client).toBe(first.client);

    expect(mocks.resolveManagedCodexAppServerStartOptions).toHaveBeenCalledTimes(1);
    expect(mocks.resolveCodexAppServerAuthProfileIdForAgent).not.toHaveBeenCalled();
    expect(mocks.bridgeCodexAppServerStartOptions).toHaveBeenCalledTimes(1);

    await firstLease.abandon();
    await firstLease.abandon();
    firstLease.release();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(closeAndWait).toHaveBeenCalledTimes(1);
    await expect(firstLease.client.request("model/list", {})).rejects.toThrow();

    secondLease.release();
    secondLease.release();
    await secondLease.abandon();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(closeAndWait).toHaveBeenCalledTimes(1);
  });

  it("waits for an already-detached client retirement during clear-all shutdown", async () => {
    const first = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start").mockReturnValueOnce(first.client);
    let finishRetirement!: () => void;
    const retirementBlocked = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    const closeAndWait = vi.spyOn(first.client, "closeAndWait").mockImplementation(async () => {
      first.client.close();
      await retirementBlocked;
    });
    const leasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      authProfileId: "openai:work",
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    const lease = await leasePromise;
    const abandon = lease.abandon();
    await vi.waitFor(() => expect(closeAndWait).toHaveBeenCalledOnce());

    let shutdownSettled = false;
    const shutdown = clearSharedCodexAppServerClientAndWait({
      exitTimeoutMs: 25,
      forceKillDelayMs: 5,
    }).then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(shutdownSettled).toBe(false);

    finishRetirement();
    await Promise.all([abandon, shutdown]);

    expect(closeAndWait).toHaveBeenCalledTimes(1);
    expect(first.process.stdin.destroyed).toBe(true);
  });

  it("abandons only the client owned by the exact lease", async () => {
    const first = createClientHarness();
    const second = createClientHarness();
    vi.spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const firstCloseAndWait = vi.spyOn(first.client, "closeAndWait");
    const secondCloseAndWait = vi.spyOn(second.client, "closeAndWait");

    const firstLeasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-one",
    });
    await sendInitializeResult(first, "openclaw/0.125.0 (macOS; test)");
    const firstLease = await firstLeasePromise;

    const secondLeasePromise = leaseSharedCodexAppServerClient({
      timeoutMs: 1000,
      agentDir: "/tmp/openclaw-agent-two",
    });
    await sendInitializeResult(second, "openclaw/0.125.0 (macOS; test)");
    const secondLease = await secondLeasePromise;

    await firstLease.abandon();

    expect(firstCloseAndWait).toHaveBeenCalledTimes(1);
    expect(secondCloseAndWait).not.toHaveBeenCalled();
    expect(first.process.stdin.destroyed).toBe(true);
    expect(second.process.stdin.destroyed).toBe(false);

    await secondLease.abandon();
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
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.125.0" } }),
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
          startOptions: {
            transport: "websocket",
            command: "codex",
            args: [],
            url,
            authToken: "tok-first",
            headers: {},
          },
        }),
      ).resolves.toEqual({ models: [] });
      await expect(
        listCodexAppServerModels({
          timeoutMs: 1000,
          startOptions: {
            transport: "websocket",
            command: "codex",
            args: [],
            url,
            authToken: "tok-second",
            headers: {},
          },
        }),
      ).resolves.toEqual({ models: [] });

      expect(authHeaders).toEqual(["Bearer tok-first", "Bearer tok-second"]);
    } finally {
      resetSharedCodexAppServerClientForTests();
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
