import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";

const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const callGatewayMock = vi.fn();
const loadCombinedSessionStoreForGatewayMock = vi.fn();

const createMockConfig = () => ({
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {},
    },
  },
  tools: {
    agentToAgent: { enabled: false },
  },
});

let mockConfig: Record<string, unknown> = createMockConfig();

function createScopedSessionStores() {
  return new Map<string, Record<string, unknown>>([
    [
      "/tmp/main/sessions.json",
      {
        "agent:main:main": { sessionId: "s-main", updatedAt: 10 },
      },
    ],
    [
      "/tmp/support/sessions.json",
      {
        main: { sessionId: "s-support", updatedAt: 20 },
      },
    ],
  ]);
}

function installScopedSessionStores(syncUpdates = false) {
  const stores = createScopedSessionStores();
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadCombinedSessionStoreForGatewayMock.mockClear();
  loadSessionStoreMock.mockImplementation((storePath: string) => stores.get(storePath) ?? {});
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(multiple)",
    store: Object.fromEntries([...stores.values()].flatMap((store) => Object.entries(store))),
  });
  if (syncUpdates) {
    updateSessionStoreMock.mockImplementation(
      (storePath: string, store: Record<string, unknown>) => {
        if (storePath) {
          stores.set(storePath, store);
        }
      },
    );
  }
  return stores;
}

async function createSessionsModuleMock(
  importOriginal: () => Promise<typeof import("../config/sessions.js")>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    updateSessionStore: async (
      storePath: string,
      mutator: (store: Record<string, unknown>) => Promise<void> | void,
    ) => {
      const store = loadSessionStoreMock(storePath) as Record<string, unknown>;
      await mutator(store);
      updateSessionStoreMock(storePath, store);
      return store;
    },
    resolveStorePath: (_store: string | undefined, opts?: { agentId?: string }) =>
      opts?.agentId === "support" ? "/tmp/support/sessions.json" : "/tmp/main/sessions.json",
  };
}

function createGatewayCallModuleMock() {
  return {
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
}

async function createGatewaySessionUtilsModuleMock(
  importOriginal: () => Promise<typeof import("../gateway/session-utils.js")>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: (cfg: unknown) =>
      loadCombinedSessionStoreForGatewayMock(cfg),
  };
}

async function createConfigModuleMock(
  importOriginal: () => Promise<typeof import("../config/config.js")>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => mockConfig,
  };
}

function createModelCatalogModuleMock() {
  return {
    loadModelCatalog: async () => [
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextWindow: 200000,
      },
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 400000,
      },
    ],
  };
}

function createAuthProfilesModuleMock() {
  return {
    ensureAuthProfileStore: () => ({ profiles: {} }),
    resolveAuthProfileDisplayLabel: () => undefined,
    resolveAuthProfileOrder: () => [],
  };
}

function createModelAuthModuleMock() {
  return {
    resolveEnvApiKey: () => null,
    resolveUsableCustomProviderApiKey: () => null,
    resolveModelAuthMode: () => "api-key",
  };
}

function createProviderUsageModuleMock() {
  return {
    resolveUsageProviderId: () => undefined,
    loadProviderUsageSummary: async () => ({
      updatedAt: Date.now(),
      providers: [],
    }),
    formatUsageSummaryLine: () => null,
  };
}

vi.mock("../config/sessions.js", createSessionsModuleMock);
vi.mock("../gateway/call.js", createGatewayCallModuleMock);
vi.mock("../gateway/session-utils.js", createGatewaySessionUtilsModuleMock);
vi.mock("../config/config.js", createConfigModuleMock);
vi.mock("../agents/model-catalog.js", createModelCatalogModuleMock);
vi.mock("../agents/auth-profiles.js", createAuthProfilesModuleMock);
vi.mock("../agents/model-auth.js", createModelAuthModuleMock);
vi.mock("../infra/provider-usage.js", createProviderUsageModuleMock);

let createSessionStatusTool: typeof import("./tools/session-status-tool.js").createSessionStatusTool;

async function loadFreshOpenClawToolsForSessionStatusTest() {
  vi.resetModules();
  vi.doMock("../config/sessions.js", createSessionsModuleMock);
  vi.doMock("../gateway/call.js", createGatewayCallModuleMock);
  vi.doMock("../gateway/session-utils.js", createGatewaySessionUtilsModuleMock);
  vi.doMock("../config/config.js", createConfigModuleMock);
  vi.doMock("../agents/model-catalog.js", createModelCatalogModuleMock);
  vi.doMock("../agents/auth-profiles.js", createAuthProfilesModuleMock);
  vi.doMock("../agents/model-auth.js", createModelAuthModuleMock);
  vi.doMock("../infra/provider-usage.js", createProviderUsageModuleMock);
  vi.doMock("../auto-reply/group-activation.js", () => ({
    normalizeGroupActivation: (value: unknown) => value ?? "always",
  }));
  vi.doMock("../auto-reply/reply/queue.js", () => ({
    getFollowupQueueDepth: () => 0,
    resolveQueueSettings: () => ({ mode: "interrupt" }),
  }));
  vi.doMock("../auto-reply/status.js", () => ({
    buildStatusMessage: () => "OpenClaw\n🧠 Model: GPT-5.4",
  }));
  ({ createSessionStatusTool } = await import("./tools/session-status-tool.js"));
}

function resetSessionStore(store: Record<string, SessionEntry>) {
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadCombinedSessionStoreForGatewayMock.mockClear();
  loadSessionStoreMock.mockReturnValue(store);
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(multiple)",
    store,
  });
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.resolve") {
      const key = typeof request.params?.key === "string" ? request.params.key.trim() : "";
      if (key && store[key]) {
        return { key };
      }
      const sessionId =
        typeof request.params?.sessionId === "string" ? request.params.sessionId.trim() : "";
      if (!sessionId) {
        return {};
      }
      const spawnedBy =
        typeof request.params?.spawnedBy === "string" ? request.params.spawnedBy.trim() : "";
      const matches = Object.entries(store).filter((entry): entry is [string, SessionEntry] => {
        return (
          entry[1].sessionId === sessionId &&
          (!spawnedBy ||
            entry[1].spawnedBy === spawnedBy ||
            entry[1].parentSessionKey === spawnedBy)
        );
      });
      return { key: resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId) };
    }
    if (request.method === "sessions.list") {
      return { sessions: [] };
    }
    return {};
  });
  mockConfig = createMockConfig();
}

function installSandboxedSessionStatusConfig() {
  mockConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["*"] },
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {},
        sandbox: { sessionToolsVisibility: "spawned" },
      },
    },
  };
}

function mockSpawnedSessionList(
  resolveSessions: (spawnedBy: string | undefined) => Array<Record<string, unknown>>,
) {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.list") {
      return { sessions: resolveSessions(request.params?.spawnedBy as string | undefined) };
    }
    return {};
  });
}

function expectSpawnedSessionLookupCalls(spawnedBy: string) {
  const expectedCall = {
    method: "sessions.list",
    params: {
      includeGlobal: false,
      includeUnknown: false,
      spawnedBy,
    },
  };
  expect(callGatewayMock).toHaveBeenCalledTimes(2);
  expect(callGatewayMock).toHaveBeenNthCalledWith(1, expectedCall);
  expect(callGatewayMock).toHaveBeenNthCalledWith(2, expectedCall);
}

function getSessionStatusTool(agentSessionKey = "main", options?: { sandboxed?: boolean }) {
  const tool = createSessionStatusTool({
    agentSessionKey,
    sandboxed: options?.sandboxed,
    config: mockConfig as never,
  });
  expect(tool.name).toBe("session_status");
  return tool;
}

describe("session_status tool", () => {
  beforeEach(async () => {
    await loadFreshOpenClawToolsForSessionStatusTest();
  });

  it("returns a status card for the current session", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call1", {});
    const details = result.details as { ok?: boolean; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.statusText).toContain("OpenClaw");
    expect(details.statusText).toContain("🧠 Model:");
    expect(details.statusText).not.toContain("OAuth/token status");
  });

  it("errors for unknown session keys", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSessionStatusTool();

    await expect(tool.execute("call2", { sessionKey: "nope" })).rejects.toThrow(
      "Unknown sessionId",
    );
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("resolves sessionKey=current to the requester session", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("resolves sessionKey=current to the requester agent session", async () => {
    installScopedSessionStores();

    const tool = getSessionStatusTool("agent:support:main");

    // "current" resolves to the support agent's own session via the "main" alias.
    const result = await tool.execute("call-current-child", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("prefers a literal current session key in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:current": {
        sessionId: "s-current",
        updatedAt: 20,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current-literal-key", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:current");
  });

  it("resolves a literal current sessionId in session_status", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:other": {
        sessionId: "current",
        updatedAt: 20,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-current-literal-id", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:other");
  });

  it("keeps sessionKey=current bound to the requester subagent session", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      },
    });

    const tool = getSessionStatusTool("agent:main:subagent:child");

    const result = await tool.execute("call-current-subagent", {
      sessionKey: "current",
      model: "anthropic/claude-sonnet-4-6",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:subagent:child");
    expect(updateSessionStoreMock).toHaveBeenCalledWith(
      "/tmp/main/sessions.json",
      expect.objectContaining({
        "agent:main:subagent:child": expect.objectContaining({
          modelOverride: "claude-sonnet-4-6",
        }),
      }),
    );
  });

  it("resolves sessionId inputs", async () => {
    const sessionId = "sess-main";
    resetSessionStore({
      "agent:main:main": {
        sessionId,
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call3", { sessionKey: sessionId });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:main");
  });

  it("resolves duplicate sessionId inputs deterministically", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "current",
        updatedAt: 10,
      },
      "agent:main:other": {
        sessionId: "run-dup",
        updatedAt: 999,
      },
      "agent:main:acp:run-dup": {
        sessionId: "run-dup",
        updatedAt: 100,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call-dup", { sessionKey: "run-dup" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:acp:run-dup");
  });

  it("uses non-standard session keys without sessionId resolution", async () => {
    resetSessionStore({
      "temp:slug-generator": {
        sessionId: "sess-temp",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool();

    const result = await tool.execute("call4", { sessionKey: "temp:slug-generator" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("temp:slug-generator");
  });

  it("blocks cross-agent session_status without agent-to-agent access", async () => {
    resetSessionStore({
      "agent:other:main": {
        sessionId: "s2",
        updatedAt: 10,
      },
    });

    const tool = getSessionStatusTool("agent:main:main");

    await expect(tool.execute("call5", { sessionKey: "agent:other:main" })).rejects.toThrow(
      "Agent-to-agent status is disabled",
    );
  });

  it("blocks sandboxed child session_status access outside its tree before store lookup", async () => {
    resetSessionStore({
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child", {
      sandboxed: true,
    });
    const expectedError = "Session status visibility is restricted to the current session tree";

    await expect(
      tool.execute("call6", {
        sessionKey: "agent:main:main",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow(expectedError);

    await expect(
      tool.execute("call7", {
        sessionKey: "agent:main:subagent:missing",
      }),
    ).rejects.toThrow(expectedError);

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expectSpawnedSessionLookupCalls("agent:main:subagent:child");
  });

  it("blocks sandboxed child session_status sessionId access outside its tree before store lookup", async () => {
    resetSessionStore({
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
      "agent:main:main": {
        sessionId: "s-parent",
        updatedAt: 10,
      },
      "agent:other:main": {
        sessionId: "s-other",
        updatedAt: 30,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool("agent:main:subagent:child", {
      sandboxed: true,
    });
    const expectedError = "Session status visibility is restricted to the current session tree";

    await expect(
      tool.execute("call6-session-id", {
        sessionKey: "s-other",
      }),
    ).rejects.toThrow(expectedError);

    expect(loadSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(loadSessionStoreMock).toHaveBeenCalledWith("/tmp/main/sessions.json");
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(3);
    expect(callGatewayMock.mock.calls).toContainEqual([
      {
        method: "sessions.resolve",
        params: {
          sessionId: "s-other",
          spawnedBy: "agent:main:subagent:child",
          includeGlobal: false,
          includeUnknown: false,
        },
      },
    ]);
    expect(callGatewayMock.mock.calls).toContainEqual([
      {
        method: "sessions.list",
        params: {
          includeGlobal: false,
          includeUnknown: false,
          spawnedBy: "agent:main:subagent:child",
        },
      },
    ]);
  });

  it("keeps legacy main requester keys for sandboxed session tree checks", async () => {
    resetSessionStore({
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 10,
      },
      "agent:main:subagent:child": {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList((spawnedBy) =>
      spawnedBy === "main" ? [{ key: "agent:main:subagent:child" }] : [],
    );

    const tool = getSessionStatusTool("main", {
      sandboxed: true,
    });

    const mainResult = await tool.execute("call8", {});
    const mainDetails = mainResult.details as { ok?: boolean; sessionKey?: string };
    expect(mainDetails.ok).toBe(true);
    expect(mainDetails.sessionKey).toBe("agent:main:main");

    const childResult = await tool.execute("call9", {
      sessionKey: "agent:main:subagent:child",
    });
    const childDetails = childResult.details as { ok?: boolean; sessionKey?: string };
    expect(childDetails.ok).toBe(true);
    expect(childDetails.sessionKey).toBe("agent:main:subagent:child");

    expectSpawnedSessionLookupCalls("main");
  });

  it("scopes bare session keys to the requester agent", async () => {
    installScopedSessionStores(true);

    const tool = getSessionStatusTool("agent:support:main");

    const result = await tool.execute("call6", { sessionKey: "main" });
    const details = result.details as { ok?: boolean; sessionKey?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("main");
  });

  it("resets per-session model override via model=default", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        authProfileOverride: "p1",
      },
    });

    const tool = getSessionStatusTool();

    await tool.execute("call3", { model: "default" });
    expect(updateSessionStoreMock).toHaveBeenCalled();
    const [, savedStore] = updateSessionStoreMock.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    const saved = savedStore.main as Record<string, unknown>;
    expect(saved.providerOverride).toBeUndefined();
    expect(saved.modelOverride).toBeUndefined();
    expect(saved.authProfileOverride).toBeUndefined();
  });
});
