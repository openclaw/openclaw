import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStoreEntryCore } from "../config/sessions/store-entry.js";
import { mergeSessionEntry, type SessionEntry } from "../config/sessions/types.js";
import { clearInternalHooks } from "../hooks/internal-hooks.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { prepareSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import {
  createMockConfig,
  expectSpawnedSessionLookupCalls,
  fixedStoreConfig,
} from "./openclaw-tools.session-status.test-support.js";

const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const callGatewayMock = vi.fn();
const agentToolGatewayCallMock = vi.fn();
const buildStatusMessageMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => "OpenClaw\n🧠 Model: GPT-5.4"),
);
const getSessionStateVersionMock = vi.hoisted(() =>
  vi.fn((_sessionKey: string, _agentId: string) => 0),
);
const listSessionStateEventsSinceMock = vi.hoisted(() =>
  vi.fn((_sessionKey: string, _agentId: string, _after: number, _limit: number) => ({
    events: [] as Array<Record<string, unknown>>,
    truncated: false,
    earliestAvailableSequence: 0,
    historyGap: false,
  })),
);
const emptyPluginMetadataSnapshot = {
  configFingerprint: "session-status-test-empty-plugin-metadata",
  ...createPluginMetadataSnapshotFixture(),
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let mockConfig: Record<string, unknown> = createMockConfig();

function createSessionsModuleMock() {
  const resolveMockStorePath = (_store: string | undefined, opts?: { agentId?: string }) =>
    opts?.agentId === "support" ? "/tmp/support/sessions.json" : "/tmp/main/sessions.json";
  const cloneEntry = (entry: SessionEntry): SessionEntry => structuredClone(entry);
  return {
    patchSessionEntryWithKey: async (
      scope: { agentId?: string; sessionKey: string; storePath?: string },
      update: (
        entry: SessionEntry,
        context: { existingEntry?: SessionEntry },
      ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
      options?: { fallbackEntry?: SessionEntry; replaceEntry?: boolean },
    ) => {
      const storePath =
        scope.storePath ?? resolveMockStorePath(undefined, { agentId: scope.agentId });
      const store = loadSessionStoreMock(storePath) as Record<string, SessionEntry>;
      const resolved = resolveSessionStoreEntryCore({ store, sessionKey: scope.sessionKey });
      const existing = resolved.existing ?? options?.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await update(cloneEntry(existing), {
        existingEntry: resolved.existing ? cloneEntry(resolved.existing) : undefined,
      });
      if (!patch) {
        return { sessionKey: resolved.normalizedKey, entry: cloneEntry(existing) };
      }
      const next = options?.replaceEntry
        ? cloneEntry(patch as SessionEntry)
        : mergeSessionEntry(existing, patch);
      store[resolved.normalizedKey] = next;
      updateSessionStoreMock(storePath, store);
      return { sessionKey: resolved.normalizedKey, entry: cloneEntry(next) };
    },
    resolveSessionEntryCandidateTarget: (scope: {
      agentId: string;
      candidateKeys: readonly string[];
      cfg: { session?: { store?: string } };
      fallback?: { sessionKey: string; entry: SessionEntry };
    }) => {
      const storePath = resolveMockStorePath(scope.cfg.session?.store, { agentId: scope.agentId });
      const store = loadSessionStoreMock(storePath) as Record<string, SessionEntry>;
      const target = (key: string, entry: SessionEntry, persisted: boolean, sessionKey = key) => ({
        agentId: scope.agentId,
        candidateKey: key,
        entry: cloneEntry(entry),
        persisted,
        sessionKey,
      });
      const candidates = [...new Set(scope.candidateKeys.map((key) => key.trim()))];
      for (const candidateKey of candidates) {
        if (!candidateKey) {
          continue;
        }
        const resolved = resolveSessionStoreEntryCore({ store, sessionKey: candidateKey });
        if (!resolved.existing) {
          continue;
        }
        return target(candidateKey, resolved.existing, true, resolved.normalizedKey);
      }
      const fallbackKey = scope.fallback?.sessionKey.trim();
      return fallbackKey && scope.fallback
        ? target(fallbackKey, scope.fallback.entry, false)
        : null;
    },
    resolveSessionStorePathCore: resolveMockStorePath,
  };
}

function createModelCatalogModuleMock() {
  return {
    loadProviderScopedThinkingCatalog: async () => [],
    // A run's captured config goes stale after any Gateway config republish; the exact
    // loader then throws, and session_status must read the published owner instead.
    readPreparedModelCatalog: async () => {
      throw new Error("prepared model catalog owner config was replaced during the read (/tmp)");
    },
    loadPublishedPreparedModelCatalog: async () => [
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
        reasoning: true,
        contextWindow: 400000,
      },
    ],
  };
}

function createCommandsStatusRuntimeModuleMock() {
  // Status text mock keeps model and session routing observable in one place.
  return {
    buildStatusText: async (
      params: Parameters<typeof import("../status/status-text.js").buildStatusText>[0],
    ) => {
      const parsed = params.sessionKey.startsWith("agent:") ? params.sessionKey.split(":") : null;
      const agentId = parsed?.[1] || "main";
      const primary =
        params.primaryModelLabelOverride ??
        (params.provider ? `${params.provider}/${params.model}` : params.model);
      buildStatusMessageMock({
        agentId,
        agent: {
          model: { primary },
          thinkingDefault: await params.resolveDefaultThinkingLevel?.(),
        },
        sessionEntry: params.sessionEntry,
        modelAuth: undefined,
        thinkingCatalog: params.thinkingCatalog,
        includeTranscriptUsage: params.includeTranscriptUsage,
        workspaceDir: params.workspaceDir,
      });
      return `OpenClaw\n🧠 Model: ${primary}`;
    },
  };
}

// mock-isolation: Session status reads and mutations use the suite's in-memory session entries.
vi.mock("../config/sessions.js", createSessionsModuleMock);
vi.mock("../config/sessions/session-accessor.entry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.entry.js")>()),
  resolveSessionEntryCandidateTargetForRuntime:
    createSessionsModuleMock().resolveSessionEntryCandidateTarget,
}));
// mock-isolation: Gateway requests are observed without connecting to an operator Gateway.
vi.mock("../gateway/call.js", () => ({ callGateway: (opts: unknown) => callGatewayMock(opts) }));
vi.mock("./tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: (opts: unknown) => agentToolGatewayCallMock(opts),
  hasGatewayToolRoutingContext: () => false,
}));
// mock-isolation: Each scenario supplies its own runtime config instead of reading host state.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => mockConfig }));
vi.mock("../agents/prepared-model-catalog.js", createModelCatalogModuleMock);
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));
vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  isPluginMetadataSnapshotCompatible: () => true,
  resolvePluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveProviderBinaryThinking: () => undefined,
  resolveProviderDefaultThinkingLevel: () => undefined,
  resolveEffectiveThinkingProfile: () => undefined,
  resolveProviderXHighThinking: () => undefined,
}));
// Keep provider-runtime/plugin activation out of this focused tool test. The
// session_status surface only needs model selection semantics here, not real
// bundled provider registration.
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: () => [],
}));
// mock-isolation: Auth profiles are synthetic labels; host credentials must not be discovered.
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
  resolveAuthProfileDisplayLabel: () => undefined,
  resolveAuthProfileOrder: () => [],
}));
// mock-isolation: Session status uses fixture auth labels without discovering host keys or accounts.
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey: () => null,
  resolveUsableCustomProviderApiKey: () => null,
  resolveModelAuthModeAsync: () => "api-key",
}));
// mock-isolation: Provider usage is a fixed empty response without remote quota requests.
vi.mock("../infra/provider-usage.js", () => ({
  resolveUsageProviderId: () => undefined,
  loadProviderUsageSummary: async () => ({ updatedAt: Date.now(), providers: [] }),
}));
// mock-isolation: Observe status rendering inputs without loading unrelated status providers.
vi.mock("../status/status-text.js", createCommandsStatusRuntimeModuleMock);
vi.mock("../auto-reply/group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value ?? "always",
}));
// mock-isolation: Session status observes fixed queue metrics without opening live queues.
vi.mock("../auto-reply/reply/queue.js", () => ({
  getFollowupQueueDepth: () => 0,
  resolveQueueSettings: () => ({ mode: "interrupt" }),
}));
vi.mock("../sessions/session-state-events.js", () => ({
  getSessionStateVersion: (sessionKey: string, agentId: string) =>
    getSessionStateVersionMock(sessionKey, agentId),
  listSessionStateEventsSince: (
    sessionKey: string,
    agentId: string,
    after: number,
    limit: number,
  ) => listSessionStateEventsSinceMock(sessionKey, agentId, after, limit),
}));

let createSessionStatusTool: typeof import("./tools/session-status-tool.js").createSessionStatusTool;

beforeAll(async () => {
  await prepareSharedAuthStoreOwnership();
  ({ createSessionStatusTool } = await import("./tools/session-status-tool.js"));
});

function resetSessionStore(inputStore: Record<string, SessionEntry>) {
  const store = Object.fromEntries(
    Object.entries(inputStore).map(([key, entry]) => [
      key,
      normalizeLegacySessionEntryDelivery(entry),
    ]),
  ) as Record<string, SessionEntry>;
  buildStatusMessageMock.mockClear();
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  callGatewayMock.mockClear();
  agentToolGatewayCallMock.mockReset();
  agentToolGatewayCallMock.mockImplementation((opts: unknown) => callGatewayMock(opts));
  getSessionStateVersionMock.mockReset();
  getSessionStateVersionMock.mockReturnValue(0);
  listSessionStateEventsSinceMock.mockReset();
  listSessionStateEventsSinceMock.mockReturnValue({
    events: [],
    truncated: false,
    earliestAvailableSequence: 0,
    historyGap: false,
  });
  loadSessionStoreMock.mockReturnValue(store);
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.resolve") {
      const param = (key: string) => {
        const value = request.params?.[key];
        return typeof value === "string" ? value.trim() : "";
      };
      const key = param("key");
      const spawnedBy = param("spawnedBy");
      const owned = (entry: SessionEntry) =>
        !spawnedBy || entry.spawnedBy === spawnedBy || entry.parentSessionKey === spawnedBy;
      if (key && store[key]) {
        return owned(store[key]) ? { key } : {};
      }
      const sessionId = param("sessionId");
      if (!sessionId) {
        return {};
      }
      const matches = Object.entries(store).filter(
        ([, entry]) => entry.sessionId === sessionId && owned(entry),
      );
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
  installVisibility("all", { sessionToolsVisibility: "spawned" });
}

function installVisibility(
  visibility: "self" | "tree" | "agent" | "all",
  sandbox?: { sessionToolsVisibility: "spawned" },
) {
  mockConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: { sessions: { visibility }, agentToAgent: { enabled: true, allow: ["*"] } },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        models: {},
        ...(sandbox ? { sandbox } : {}),
      },
    },
  };
}

function installSameAgentVisibility(visibility: "self" | "tree" | "agent") {
  resetSessionStore({
    "agent:main:main": fixtureSession("s-parent", {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    }),
    "agent:main:subagent:child": fixtureSession("s-child", { updatedAt: 20 }),
  });
  installVisibility(visibility);
}

function mockSpawnedSessionList(
  resolveSessions: (spawnedBy: string | undefined) => Array<Record<string, unknown>>,
  resolveSessionId?: (sessionId: string) => string | undefined,
) {
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string; params?: Record<string, unknown> };
    if (request.method === "sessions.resolve") {
      const key = typeof request.params?.key === "string" ? request.params.key.trim() : "";
      const spawnedBy = request.params?.spawnedBy as string | undefined;
      if (key && resolveSessions(spawnedBy).some((session) => session.key === key)) {
        return { key };
      }
      const sessionId =
        typeof request.params?.sessionId === "string" ? request.params.sessionId.trim() : "";
      if (sessionId && !spawnedBy) {
        return { key: resolveSessionId?.(sessionId) };
      }
      return {};
    }
    if (request.method === "sessions.list") {
      return { sessions: resolveSessions(request.params?.spawnedBy as string | undefined) };
    }
    return {};
  });
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function latestMockCallArg(mock: ReturnType<typeof vi.fn>, argIndex = 0) {
  return mockCallArg(mock, mock.mock.calls.length - 1, argIndex);
}

function getSessionStatusTool(
  agentSessionKey = "main",
  options?: Omit<
    NonNullable<Parameters<typeof createSessionStatusTool>[0]>,
    "agentSessionKey" | "config"
  >,
) {
  return createSessionStatusTool({ ...options, agentSessionKey, config: mockConfig as never });
}

function fixtureSession(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 10, ...fields };
}

function status(
  params: Record<string, unknown> = {},
  requester = "main",
  options?: Parameters<typeof getSessionStatusTool>[1],
) {
  return getSessionStatusTool(requester, options).execute("status", params);
}

function runSessionTool(persisted = true, thinking = false, treeVisibility = false) {
  resetSessionStore({
    [liveKey]: fixtureSession("s-tg-direct", {
      updatedAt: 5,
      status: "done",
      ...(thinking ? { thinkingLevel: "off" } : {}),
    }),
    ...(persisted
      ? { [mainKey]: fixtureSession("s-main", thinking ? { thinkingLevel: "high" } : {}) }
      : {}),
  });
  if (treeVisibility) {
    mockConfig = { ...mockConfig, tools: { sessions: { visibility: "tree" } } };
  }
  return getSessionStatusTool(liveKey, { runSessionKey: mainKey });
}

const mainKey = "agent:main:main";
const childKey = "agent:main:subagent:child";
const liveKey = "agent:main:telegram:default:direct:1234";
const channelKey = "agent:main:scope:scopy:direct:scopy";

describe("session_status tool", () => {
  beforeEach(() => {
    buildStatusMessageMock.mockClear();
    clearInternalHooks();
  });

  it("resets the fixed-store owner's model without reusing the active model", async () => {
    resetSessionStore({
      global: fixtureSession("ops-global", {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      }),
    });
    mockConfig = fixedStoreConfig();
    const tool = getSessionStatusTool("global", {
      activeModelProvider: "openai",
      activeModelId: "gpt-5.2",
    });
    const result = await tool.execute("owned-global", { model: "default" });
    expect(result.details).toMatchObject({
      ok: true,
      sessionKey: "global",
      agentId: "ops",
      changedModel: true,
      model: "gpt-5.4",
      modelOverride: null,
    });
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(getSessionStateVersionMock).toHaveBeenCalledWith("global", "ops");
  });

  it("does not treat another agent's fixed-store bare key as self", async () => {
    resetSessionStore({
      global: fixtureSession("ops-global"),
    });
    mockConfig = fixedStoreConfig();

    await expect(
      status({ sessionKey: "global" }, "agent:research:main", {
        requesterAgentIdOverride: "research",
      }),
    ).rejects.toThrow("Agent-to-agent status is disabled");
  });

  it("returns read-only state changes and the signal-log head", async () => {
    resetSessionStore({
      main: fixtureSession("s1"),
    });
    const expectedStateChanges = {
      events: [
        {
          sequence: 11,
          kind: "run_failed",
          actorType: "agent",
          occurredAt: 90,
          summary: "child run timed out",
          actorId: "worker-1",
          runId: "run-11",
          payload: { outcome: "timeout", channel: "codex", turns: 2 },
        },
        {
          sequence: 12,
          kind: "upstream_missing",
          actorType: "system",
          occurredAt: 100,
          summary: "upstream missing via codex",
          payload: { channel: "codex" },
        },
      ],
      truncated: false,
      earliestAvailableSequence: 11,
      historyGap: true,
    };
    getSessionStateVersionMock.mockReturnValue(12);
    listSessionStateEventsSinceMock.mockReturnValue({
      ...expectedStateChanges,
      events: expectedStateChanges.events.map((event) => ({
        ...event,
        sessionKey: "main",
        sessionId: "s1",
        agentId: "main",
        payload: { ...event.payload, catalogId: "internal-catalog", nested: { drop: true } },
      })),
    });

    const tool = getSessionStatusTool();
    const result = await tool.execute("call-state", { changesSince: 3 });
    const details = result.details as Record<string, unknown>;
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";

    expect(getSessionStateVersionMock).toHaveBeenCalledWith("main", "main");
    expect(listSessionStateEventsSinceMock).toHaveBeenCalledWith("main", "main", 3, 200);
    expect(details.stateVersion).toBe(12);
    expect(details.stateChanges).toEqual(expectedStateChanges);
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(details.statusText).toBe(text);
    const stateChangesMarker = "Session state changes:\n```json\n";
    const stateChangesStart = text.indexOf(stateChangesMarker);
    expect(stateChangesStart).toBeGreaterThanOrEqual(0);
    const stateChangesJsonStart = stateChangesStart + stateChangesMarker.length;
    const stateChangesJsonEnd = text.indexOf("\n```", stateChangesJsonStart);
    expect(stateChangesJsonEnd).toBeGreaterThan(stateChangesJsonStart);
    const visibleStateChangesText = text.slice(stateChangesJsonStart, stateChangesJsonEnd);
    expect(JSON.parse(visibleStateChangesText)).toEqual({
      stateVersion: 12,
      stateChanges: expectedStateChanges,
    });
    for (const omittedField of [
      '"sessionKey"',
      '"sessionId"',
      '"agentId"',
      '"catalogId"',
      '"nested"',
      "internal-catalog",
    ]) {
      expect(visibleStateChangesText).not.toContain(omittedField);
      expect(String(details.statusText)).not.toContain(omittedField);
    }
  });

  it("reports session capabilities from the Gateway tool inventory on request", async () => {
    resetSessionStore({ main: fixtureSession("s1") });
    agentToolGatewayCallMock.mockImplementation((opts: { method?: string }) =>
      opts.method === "tools.effective"
        ? Promise.resolve({
            agentId: "main",
            profile: "coding",
            groups: [
              {
                id: "core",
                label: "Built-in tools",
                source: "core",
                tools: [
                  {
                    id: "exec",
                    label: "Exec",
                    description: "",
                    rawDescription: "",
                    source: "core",
                  },
                ],
              },
            ],
            toolAccess: {
              checked: "live-session",
              profiles: [],
              tools: [
                { id: "exec", status: "available", reasons: [] },
                {
                  id: "browser",
                  status: "excluded",
                  reasons: [{ kind: "deny", label: "Denied by tools.deny", source: "tools.deny" }],
                },
              ],
            },
          })
        : callGatewayMock(opts),
    );

    const tool = getSessionStatusTool();
    const plain = await tool.execute("call-plain", {});
    expect((plain.details as Record<string, unknown>).capabilities).toBeUndefined();
    expect(agentToolGatewayCallMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "tools.effective" }),
    );

    const result = await tool.execute("call-capabilities", { capabilities: true });
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(agentToolGatewayCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tools.effective",
        params: { agentId: "main", sessionKey: "main" },
      }),
    );
    expect(result.details).toMatchObject({
      capabilities: {
        checked: "live-session",
        available: ["exec"],
        unavailable: [{ reason: "Denied by tools.deny", tools: ["browser"] }],
      },
    });
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(text).toContain("Capabilities (this session only");
    expect(text).toContain("- Denied by tools.deny: browser");
  });

  it("keeps status usable when the capability inventory cannot be read", async () => {
    resetSessionStore({ main: fixtureSession("s1") });
    agentToolGatewayCallMock.mockImplementation((opts: { method?: string }) =>
      opts.method === "tools.effective"
        ? Promise.reject(new Error("missing scope: operator.read"))
        : callGatewayMock(opts),
    );

    const tool = getSessionStatusTool();
    const result = await tool.execute("call-capabilities-error", { capabilities: true });
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(result.details).toMatchObject({
      ok: true,
      capabilities: { checked: "unavailable", error: "missing scope: operator.read" },
    });
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(text).toContain("not evidence that OpenClaw lacks a capability");
  });

  it("returns same-agent group changesSince from main under tree visibility", async () => {
    const groupSessionKey = "agent:main:telegram:group:unspawned";
    resetSessionStore({
      [mainKey]: { sessionId: "s-main", updatedAt: 10 },
      [groupSessionKey]: {
        sessionId: "s-group",
        updatedAt: 20,
        chatType: "group",
      },
    });
    mockConfig = {
      ...createMockConfig(),
      tools: {
        sessions: { visibility: "tree" },
        agentToAgent: { enabled: false },
      },
    };
    getSessionStateVersionMock.mockReturnValue(9);
    listSessionStateEventsSinceMock.mockReturnValue({
      events: [
        { sequence: 9, kind: "human_direct_message", summary: "human message via telegram" },
      ],
      truncated: false,
      earliestAvailableSequence: 9,
      historyGap: false,
    });

    const result = await getSessionStatusTool(mainKey).execute("call-group-state", {
      sessionKey: groupSessionKey,
      changesSince: 4,
    });

    expect(listSessionStateEventsSinceMock).toHaveBeenCalledWith(groupSessionKey, "main", 4, 200);
    expect(result.details).toMatchObject({
      ok: true,
      sessionKey: groupSessionKey,
      stateVersion: 9,
    });
  });

  it("resolves whitespace-decorated current to the webchat requester (#89773, #89800)", async () => {
    resetSessionStore({
      main: {
        sessionId: "s-fallback-main",
        updatedAt: 5,
        thinkingLevel: "high",
      },
      "agent:admin:main": fixtureSession("s-admin-main", {
        thinkingLevel: "low",
      }),
    });

    const result = await status({ sessionKey: " current " }, "agent:admin:main", {
      activeDeliveryContext: {
        channel: "webchat",
        to: "control-ui-conversation",
      },
    });

    expect(result.details).toMatchObject({ ok: true, sessionKey: "agent:admin:main" });

    expect(mockCallArg(buildStatusMessageMock)).toMatchObject({
      sessionEntry: { sessionId: "s-admin-main", thinkingLevel: "low" },
    });
  });

  it.each([
    { name: "implicit thinking (#82669)", persisted: true, thinking: true, tree: false },
    {
      name: "explicit current under tree visibility (#76708)",
      persisted: true,
      thinking: false,
      tree: true,
    },
    { name: "unpersisted semantic current", persisted: false, thinking: false, tree: false },
  ])("resolves the live run for $name", async ({ persisted, thinking, tree }) => {
    const result = await runSessionTool(persisted, thinking, tree).execute(
      "current",
      thinking ? {} : { sessionKey: "current" },
    );
    expect(result.details).toMatchObject({
      ok: true,
      sessionKey: mainKey,
      ...(!persisted ? { statusText: expect.stringContaining("OpenClaw") } : {}),
    });
    if (thinking) {
      expect(mockCallArg(buildStatusMessageMock)).toMatchObject({
        sessionEntry: { thinkingLevel: "high" },
      });
    }
  });

  it("reports origin, active, and persisted delivery route metadata for semantic current", async () => {
    const sessionKey = "agent:main:discord:channel:1489550370136129537";
    const origin = { provider: "discord", accountId: "bot-primary" };
    const delivery = {
      channel: "discord",
      to: "channel:1489550370136129537",
      accountId: "bot-primary",
      threadId: "thread-origin",
    };
    const active = {
      channel: "webchat",
      to: "control-ui-conversation",
      accountId: "browser",
      threadId: "webchat-thread",
    };
    resetSessionStore({
      [sessionKey]: fixtureSession("s-discord-origin-webchat-active", {
        delivery: normalizeSessionDeliveryState({ origin, context: delivery }),
      }),
    });
    const result = await getSessionStatusTool(sessionKey, {
      runSessionKey: sessionKey,
      activeDeliveryContext: active,
    }).execute("current-route", { sessionKey: "current" });
    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        sessionKey,
        origin: { ...origin, threadId: "thread-origin" },
        active,
        deliveryContext: delivery,
        statusText: expect.stringContaining('"active"'),
      }),
    );
    const text =
      result.content.find((item): item is { type: "text"; text: string } => item.type === "text")
        ?.text ?? "";
    for (const marker of ["Route context:", '"origin"', '"active"', '"deliveryContext"']) {
      expect(text).toContain(marker);
    }
  });

  it("does not report an active route for an explicit stale policy-key lookup", async () => {
    const policyKey = liveKey;
    const runKey = mainKey;
    resetSessionStore({
      [policyKey]: {
        sessionId: "s-policy",
        updatedAt: 5,
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: "telegram:direct:1234",
          },
        }),
      },
      [runKey]: fixtureSession("s-run"),
    });

    const result = await status({ sessionKey: policyKey }, policyKey, {
      runSessionKey: runKey,
      activeDeliveryContext: {
        channel: "webchat",
        to: "control-ui-conversation",
      },
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        sessionKey: policyKey,
        deliveryContext: { channel: "telegram", to: "telegram:direct:1234" },
      }),
    );
    expect(result.details).not.toHaveProperty("active");
  });

  it("rejects explicit cross-session key under tree visibility even when it equals runSessionKey (#76708)", async () => {
    const tool = runSessionTool(true, false, true);

    await expect(tool.execute("call-explicit-key", { sessionKey: mainKey })).rejects.toThrow(
      /visibility is restricted/,
    );
  });

  it("falls back from implicit default-account direct policy keys to persisted direct sessions", async () => {
    resetSessionStore({
      "agent:main:telegram:direct:1053274893": fixtureSession("s-direct"),
    });

    const result = await status({}, "agent:main:telegram:default:direct:1053274893");
    expect(result.details).toMatchObject({
      ok: true,
      sessionKey: "agent:main:telegram:direct:1053274893",
    });
  });

  it("keeps explicit default-account direct session lookups strict", async () => {
    resetSessionStore({
      [mainKey]: fixtureSession("s-main"),
    });

    const key = "agent:main:telegram:default:direct:1053274893";
    await expect(status({ sessionKey: key }, key)).rejects.toThrow(
      "Unknown sessionKey: agent:main:telegram:default:direct:1053274893",
    );
  });

  it.each([false, true])(
    "applies the active run model only to semantic current (literal=%s)",
    async (literal) => {
      const key = literal ? "agent:main:current" : channelKey;
      const overrides = { providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6" };
      resetSessionStore({
        ...(literal ? { main: fixtureSession("s-main") } : {}),
        [key]: fixtureSession("s-current", { ...overrides, updatedAt: literal ? 20 : 10 }),
      });
      const result = await getSessionStatusTool(literal ? "main" : key, {
        activeModelProvider: "openai",
        activeModelId: "gpt-5.2",
      }).execute("current-model", { sessionKey: "current" });
      const statusArg = mockCallArg(buildStatusMessageMock) as {
        sessionEntry: SessionEntry;
        agent: { model: { primary: string } };
      };
      if (literal) {
        expect(result.details).toMatchObject({ ok: true, sessionKey: key });
        expect(statusArg).toMatchObject({ sessionEntry: overrides });
        expect(statusArg.agent.model.primary).not.toBe("openai/gpt-5.2");
      } else {
        expect(statusArg.sessionEntry.providerOverride).toBeUndefined();
        expect(statusArg.sessionEntry.modelOverride).toBeUndefined();
        expect(statusArg.agent.model.primary).toBe("openai/gpt-5.2");
      }
    },
  );

  it("resolves sandboxed sessionKey=current to the requester when no run session override exists", async () => {
    resetSessionStore({});

    const result = await status(
      { sessionKey: "current" },
      "agent:main:telegram:group:-5096326138",
      { sandboxed: true },
    );
    expect(result.details).toMatchObject({
      ok: true,
      sessionKey: "agent:main:telegram:group:-5096326138",
      statusText: expect.stringContaining("OpenClaw"),
    });
    expect(result.details).toMatchObject({ statusText: expect.stringContaining("🧠 Model:") });
    expect(callGatewayMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({ key: "current" }),
      }),
    );
  });

  it("materializes a valid persisted session entry when implicit current fallback mutates model state", async () => {
    resetSessionStore({});

    const result = await status(
      {
        sessionKey: "current",
        model: "anthropic/claude-sonnet-4-6",
      },
      channelKey,
    );
    expect(result.details).toMatchObject({
      ok: true,
      sessionKey: channelKey,
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
      modelOverride: "anthropic/claude-sonnet-4-6",
    });
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    const savedStore = latestMockCallArg(updateSessionStoreMock, 1) as Record<string, SessionEntry>;
    const saved = expectDefined(savedStore[channelKey], "savedStore[channelKey] test invariant");
    expect(saved).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      liveModelSwitchPending: true,
    });
    expect(saved.sessionId).toMatch(UUID_RE);
  });

  it("rejects model changes for model-locked sessions", async () => {
    const store: Record<string, SessionEntry> = {
      main: fixtureSession("s1", {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelSelectionLocked: true,
      }),
    };
    resetSessionStore(store);

    await expect(
      status({
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(store.main).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelSelectionLocked: true,
    });
  });

  it("preserves an unknown runtime provider in the selected status card model", async () => {
    resetSessionStore({
      main: fixtureSession("legacy-runtime-model", {
        model: "legacy-runtime-model",
      }),
    });

    await status();

    expect(mockCallArg(buildStatusMessageMock)).toMatchObject({
      agent: { model: { primary: "legacy-runtime-model" } },
      sessionEntry: { model: "legacy-runtime-model", providerOverride: "" },
      modelAuth: undefined,
    });
  });

  it("defers fixed-store ownership until a requester-owned sessionId resolves", async () => {
    const sessionId = "research-session-id";
    resetSessionStore({
      "agent:research:incident": {
        sessionId,
        updatedAt: 10,
      },
    });
    mockConfig = {
      ...fixedStoreConfig(),
      tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" } },
    };
    callGatewayMock.mockImplementation(async (requestValue: unknown) => {
      const request = requestValue as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        if (request.params?.key) {
          return {};
        }
        expect(request.params?.agentId).toBeUndefined();
        return { agentId: "research", key: "agent:research:incident" };
      }
      return {};
    });

    const result = await getSessionStatusTool("agent:research:requester", {
      requesterAgentIdOverride: "research",
    }).execute("research-session-id", { sessionKey: sessionId });

    expect(result.details).toMatchObject({ ok: true, sessionKey: "agent:research:incident" });
  });

  it("blocks same-agent status outside self visibility before reading or mutating", async () => {
    installSameAgentVisibility("self");
    await expect(
      getSessionStatusTool(childKey).execute("self-denied", {
        sessionKey: mainKey,
        model: "default",
      }),
    ).rejects.toThrow(
      "Session status visibility is restricted to the current session (tools.sessions.visibility=self).",
    );
    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "blocks incognito status before opening its store (implicit=%s)",
    async (implicit) => {
      const requesterSessionKey = implicit ? liveKey : mainKey;
      const incognitoSessionKey = `agent:main:dashboard:incognito-${implicit ? "live-run" : "private"}`;
      resetSessionStore({
        [requesterSessionKey]: fixtureSession("s-requester"),
        [incognitoSessionKey]: fixtureSession("s-incognito", { updatedAt: 20, incognito: true }),
      });
      installVisibility("agent");
      const tool = getSessionStatusTool(
        requesterSessionKey,
        implicit ? { runSessionKey: incognitoSessionKey } : {},
      );
      await expect(
        tool.execute(
          "incognito",
          implicit
            ? {}
            : {
                sessionKey: incognitoSessionKey,
                model: "default",
              },
        ),
      ).rejects.toThrow(`Session not visible from session tools: ${incognitoSessionKey}`);
      expect(loadSessionStoreMock).not.toHaveBeenCalled();
      expect(updateSessionStoreMock).not.toHaveBeenCalled();
      expect(callGatewayMock).not.toHaveBeenCalled();
      expect(buildStatusMessageMock).not.toHaveBeenCalled();
    },
  );

  it("blocks sandboxed child bare main session_status access outside its tree", async () => {
    resetSessionStore({
      [childKey]: {
        sessionId: "s-child",
        updatedAt: 20,
      },
      [mainKey]: fixtureSession("s-parent", {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      }),
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(() => []);

    const tool = getSessionStatusTool(childKey, {
      sandboxed: true,
    });
    const expectedError = "Session status visibility is restricted to the current session tree";

    await expect(
      tool.execute("call6-bare-main", {
        sessionKey: "main",
        model: "default",
      }),
    ).rejects.toThrow(expectedError);

    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        agentId: "main",
        allowMissing: true,
        key: "main",
        spawnedBy: childKey,
      },
    });
  });

  it.each([
    {
      name: "blocks sandboxed child session_status access to another agent sessionId before store lookup",
      sessionId: "s-other",
      callId: "call6-session-id",
      expectedError: "Session status visibility is restricted.",
    },
    {
      name: "blocks sandboxed child session_status parent sessionId access outside its tree",
      sessionId: "s-parent",
      callId: "call7-parent-session-id",
      expectedError: "Session status visibility is restricted to the current session tree",
    },
  ])("$name", async ({ sessionId, callId, expectedError }) => {
    resetSessionStore({
      [childKey]: {
        sessionId: "s-child",
        updatedAt: 20,
      },
      [mainKey]: fixtureSession("s-parent"),
      ...(sessionId === "s-other"
        ? { "agent:other:main": { sessionId: "s-other", updatedAt: 30 } }
        : {}),
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList(
      () => [],
      (value) =>
        value === sessionId ? (sessionId === "s-other" ? "agent:other:main" : mainKey) : undefined,
    );

    const tool = getSessionStatusTool(childKey, {
      sandboxed: true,
    });

    await expect(
      tool.execute(callId, {
        sessionKey: sessionId,
      }),
    ).rejects.toThrow(expectedError);

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("keeps legacy main requester keys for sandboxed session tree checks", async () => {
    resetSessionStore({
      [mainKey]: fixtureSession("s-main"),
      [childKey]: {
        sessionId: "s-child",
        updatedAt: 20,
      },
    });
    installSandboxedSessionStatusConfig();
    mockSpawnedSessionList((spawnedBy) => (spawnedBy === "main" ? [{ key: childKey }] : []));

    const tool = getSessionStatusTool("main", {
      sandboxed: true,
    });

    const mainResult = await tool.execute("call8", {});
    expect(mainResult.details).toMatchObject({ ok: true, sessionKey: mainKey });

    const childResult = await tool.execute("call9", {
      sessionKey: childKey,
    });
    expect(childResult.details).toMatchObject({ ok: true, sessionKey: childKey });

    expectSpawnedSessionLookupCalls(callGatewayMock, "main", [childKey]);
  });

  it("rejects a colliding provider-wildcard model change without writing the session", async () => {
    resetSessionStore({
      main: fixtureSession("s1", {
        providerOverride: "custom/team",
        modelOverride: "Reader",
        modelOverrideSource: "user",
      }),
    });
    mockConfig = {
      ...createMockConfig(),
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {},
          modelPolicy: { allow: ["custom/*"] },
        },
      },
    };

    await expect(
      getSessionStatusTool().execute("literal-denied", { model: "Reader" }),
    ).rejects.toThrow('Model "custom/team/Reader" is not allowed.');
    expect(updateSessionStoreMock).not.toHaveBeenCalled();

    await getSessionStatusTool().execute("literal-allowed", { model: "custom/team/Reader" });
    const saved = latestMockCallArg(updateSessionStoreMock, 1) as Record<string, SessionEntry>;
    expect(saved.main).toMatchObject({
      providerOverride: "custom",
      modelOverride: "team/Reader",
      modelOverrideSource: "user",
    });
  });

  it("preserves a compatible auth profile when changing the session model", async () => {
    resetSessionStore({
      main: fixtureSession("s1", {
        providerOverride: "openai",
        modelOverride: "gpt-4o",
        authProfileOverride: "session-status-team:prod",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      }),
    });
    mockConfig = {
      ...createMockConfig(),
      auth: {
        profiles: { "session-status-team:prod": { provider: "openai", mode: "api_key" } },
      },
    };
    const result = await getSessionStatusTool().execute("call4", { model: "openai/gpt-5.4" });

    expect(result.details).toMatchObject({ modelOverride: null });
    const saved = latestMockCallArg(updateSessionStoreMock, 1) as Record<string, SessionEntry>;
    expect(saved.main).toMatchObject({
      authProfileOverride: "session-status-team:prod",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
