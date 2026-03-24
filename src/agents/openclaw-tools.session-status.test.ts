import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
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
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../gateway/session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/session-utils.js")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: (cfg: unknown) =>
      loadCombinedSessionStoreForGatewayMock(cfg),
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockConfig,
  };
});

vi.mock("../agents/model-catalog.js", () => ({
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
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
  resolveAuthProfileDisplayLabel: () => undefined,
  resolveAuthProfileOrder: () => [],
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey: () => null,
  resolveUsableCustomProviderApiKey: () => null,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../infra/provider-usage.js", () => ({
  resolveUsageProviderId: () => undefined,
  loadProviderUsageSummary: async () => ({
    updatedAt: Date.now(),
    providers: [],
  }),
  formatUsageSummaryLine: () => null,
}));

let createOpenClawTools: typeof import("./openclaw-tools.js").createOpenClawTools;

async function loadFreshOpenClawToolsForSessionStatusTest() {
  vi.resetModules();
  vi.doMock("../config/sessions.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../config/sessions.js")>();
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
  });
  vi.doMock("../gateway/call.js", () => ({
    callGateway: (opts: unknown) => callGatewayMock(opts),
  }));
  vi.doMock("../gateway/session-utils.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../gateway/session-utils.js")>();
    return {
      ...actual,
      loadCombinedSessionStoreForGateway: (cfg: unknown) =>
        loadCombinedSessionStoreForGatewayMock(cfg),
    };
  });
  vi.doMock("../config/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../config/config.js")>();
    return {
      ...actual,
      loadConfig: () => mockConfig,
    };
  });
  vi.doMock("../agents/model-catalog.js", () => ({
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
  }));
  vi.doMock("../agents/auth-profiles.js", () => ({
    ensureAuthProfileStore: () => ({ profiles: {} }),
    resolveAuthProfileDisplayLabel: () => undefined,
    resolveAuthProfileOrder: () => [],
  }));
  vi.doMock("../agents/model-auth.js", () => ({
    resolveEnvApiKey: () => null,
    resolveUsableCustomProviderApiKey: () => null,
    resolveModelAuthMode: () => "api-key",
  }));
  vi.doMock("../infra/provider-usage.js", () => ({
    resolveUsageProviderId: () => undefined,
    loadProviderUsageSummary: async () => ({
      updatedAt: Date.now(),
      providers: [],
    }),
    formatUsageSummaryLine: () => null,
  }));
  await import("./test-helpers/fast-core-tools.js");
  ({ createOpenClawTools } = await import("./openclaw-tools.js"));
}

function resetSessionStore(store: Record<string, unknown>) {
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  loadCombinedSessionStoreForGatewayMock.mockClear();
  loadSessionStoreMock.mockReturnValue(store);
  loadCombinedSessionStoreForGatewayMock.mockReturnValue({
    storePath: "(multiple)",
    store,
  });
  callGatewayMock.mockResolvedValue({});
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
      limit: 500,
      spawnedBy,
    },
  };
  expect(callGatewayMock).toHaveBeenCalledTimes(2);
  expect(callGatewayMock).toHaveBeenNthCalledWith(1, expectedCall);
  expect(callGatewayMock).toHaveBeenNthCalledWith(2, expectedCall);
}

function getSessionStatusTool(agentSessionKey = "main", options?: { sandboxed?: boolean }) {
  const tool = createOpenClawTools({
    agentSessionKey,
    sandboxed: options?.sandboxed,
  }).find((candidate) => candidate.name === "session_status");
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error("missing session_status tool");
  }
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
    loadSessionStoreMock.mockClear();
    updateSessionStoreMock.mockClear();
    callGatewayMock.mockClear();
    loadCombinedSessionStoreForGatewayMock.mockClear();
    const stores = new Map<string, Record<string, unknown>>([
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
    loadSessionStoreMock.mockImplementation((storePath: string) => {
      return stores.get(storePath) ?? {};
    });
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: Object.fromEntries([...stores.values()].flatMap((s) => Object.entries(s))),
    });

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
    loadSessionStoreMock.mockClear();
    updateSessionStoreMock.mockClear();
    const stores = new Map<string, Record<string, unknown>>([
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
    loadSessionStoreMock.mockImplementation((storePath: string) => {
      return stores.get(storePath) ?? {};
    });
    updateSessionStoreMock.mockImplementation(
      (_storePath: string, store: Record<string, unknown>) => {
        // Keep map in sync for resolveSessionEntry fallbacks if needed.
        if (_storePath) {
          stores.set(_storePath, store);
        }
      },
    );

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
