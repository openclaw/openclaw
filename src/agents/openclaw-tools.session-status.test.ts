// Verifies session status output across scoped stores, tasks, and runtime hooks.

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
import {
  createMockConfig,
  fixedStoreConfig,
} from "./openclaw-tools.session-status.test-support.js";

const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const callGatewayMock = vi.fn();
const agentToolGatewayCallMock = vi.fn();
const buildStatusMessageMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => "OpenClaw\n🧠 Model: GPT-5.4"),
);
const resolveQueueSettingsMock = vi.hoisted(() =>
  vi.fn((_params?: unknown) => ({ mode: "interrupt" })),
);
const resolveEnvApiKeyMock = vi.hoisted(() =>
  vi.fn((_provider?: string, _env?: NodeJS.ProcessEnv) => null),
);
const resolveUsableCustomProviderApiKeyMock = vi.hoisted(() =>
  vi.fn((_params?: { provider?: string }) => null as { apiKey: string; source: string } | null),
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
      const candidates = [...new Set(scope.candidateKeys.map((key) => key.trim()))];
      for (const candidateKey of candidates) {
        if (!candidateKey) {
          continue;
        }
        const resolved = resolveSessionStoreEntryCore({ store, sessionKey: candidateKey });
        if (!resolved.existing) {
          continue;
        }
        return {
          agentId: scope.agentId,
          candidateKey,
          entry: cloneEntry(resolved.existing),
          persisted: true,
          sessionKey: resolved.normalizedKey,
        };
      }
      const fallbackKey = scope.fallback?.sessionKey.trim();
      return fallbackKey && scope.fallback
        ? {
            agentId: scope.agentId,
            candidateKey: fallbackKey,
            entry: cloneEntry(scope.fallback.entry),
            persisted: false,
            sessionKey: fallbackKey,
          }
        : null;
    },
    resolveSessionStorePathCore: resolveMockStorePath,
  };
}

function createGatewayCallModuleMock() {
  return {
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
}

function createConfigModuleMock() {
  return {
    getRuntimeConfig: () => mockConfig,
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

function createAuthProfilesModuleMock() {
  return {
    ensureAuthProfileStore: () => ({ profiles: {} }),
    resolveAuthProfileDisplayLabel: () => undefined,
    resolveAuthProfileOrder: () => [],
  };
}

function createModelAuthModuleMock() {
  return {
    resolveEnvApiKey: resolveEnvApiKeyMock,
    resolveUsableCustomProviderApiKey: resolveUsableCustomProviderApiKeyMock,
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
  };
}

function formatPrimaryModelLabel(provider: string | undefined, model: string): string {
  return provider ? `${provider}/${model}` : model;
}

function createCommandsStatusRuntimeModuleMock() {
  // Status text mock keeps model and session routing observable in one place.
  return {
    buildStatusText: async (params: {
      sessionKey: string;
      sessionEntry: SessionEntry;
      statusChannel: string;
      provider?: string;
      model: string;
      thinkingCatalog?: Array<{ provider: string; id: string; contextWindow?: number }>;
      workspaceDir?: string;
      primaryModelLabelOverride?: string;
      includeTranscriptUsage?: boolean;
      resolveDefaultThinkingLevel?: () => unknown;
    }) => {
      resolveQueueSettingsMock({
        channel: params.statusChannel,
        sessionEntry: params.sessionEntry,
      });
      const parsed = params.sessionKey.startsWith("agent:") ? params.sessionKey.split(":") : null;
      const agentId = parsed?.[1] || "main";
      const primary =
        params.primaryModelLabelOverride ?? formatPrimaryModelLabel(params.provider, params.model);
      const customAuth = params.provider
        ? resolveUsableCustomProviderApiKeyMock({ provider: params.provider })
        : null;
      const envAuth =
        !customAuth && params.provider ? resolveEnvApiKeyMock(params.provider, process.env) : null;
      const modelAuth = customAuth
        ? `api-key (${customAuth.source})`
        : envAuth
          ? "api-key (env)"
          : undefined;
      buildStatusMessageMock({
        agentId,
        agent: {
          model: { primary },
          thinkingDefault: await params.resolveDefaultThinkingLevel?.(),
        },
        sessionEntry: params.sessionEntry,
        modelAuth,
        thinkingCatalog: params.thinkingCatalog,
        includeTranscriptUsage: params.includeTranscriptUsage,
        workspaceDir: params.workspaceDir,
      });
      return `OpenClaw\n🧠 Model: ${primary}`;
    },
  };
}

vi.mock("../config/sessions.js", createSessionsModuleMock);
vi.mock("../config/sessions/session-accessor.entry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.entry.js")>()),
  resolveSessionEntryCandidateTargetForRuntime:
    createSessionsModuleMock().resolveSessionEntryCandidateTarget,
}));
vi.mock("../gateway/call.js", createGatewayCallModuleMock);
vi.mock("./tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: (opts: unknown) => agentToolGatewayCallMock(opts),
  hasGatewayToolRoutingContext: () => false,
}));
vi.mock("../config/config.js", createConfigModuleMock);
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
vi.mock("../agents/auth-profiles.js", createAuthProfilesModuleMock);
vi.mock("../agents/model-auth.js", createModelAuthModuleMock);
vi.mock("../infra/provider-usage.js", createProviderUsageModuleMock);
vi.mock("../status/status-text.js", createCommandsStatusRuntimeModuleMock);
vi.mock("../auto-reply/group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value ?? "always",
}));
vi.mock("../auto-reply/reply/queue.js", () => ({
  getFollowupQueueDepth: () => 0,
  resolveQueueSettings: resolveQueueSettingsMock,
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
  resolveQueueSettingsMock.mockClear();
  resolveQueueSettingsMock.mockReturnValue({ mode: "interrupt" });
  resolveEnvApiKeyMock.mockReset();
  resolveEnvApiKeyMock.mockReturnValue(null);
  resolveUsableCustomProviderApiKeyMock.mockReset();
  resolveUsableCustomProviderApiKeyMock.mockReturnValue(null);
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
      const key = typeof request.params?.key === "string" ? request.params.key.trim() : "";
      if (key && store[key]) {
        const spawnedBy =
          typeof request.params?.spawnedBy === "string" ? request.params.spawnedBy.trim() : "";
        const entry = store[key];
        if (!spawnedBy || entry.spawnedBy === spawnedBy || entry.parentSessionKey === spawnedBy) {
          return { key };
        }
        return {};
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

function installSameAgentVisibility(visibility: "self" | "tree" | "agent") {
  resetSessionStore({
    "agent:main:main": {
      sessionId: "s-parent",
      updatedAt: 10,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    },
    "agent:main:subagent:child": { sessionId: "s-child", updatedAt: 20 },
  });
  mockConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      sessions: { visibility },
      agentToAgent: { enabled: true, allow: ["*"] },
    },
    agents: { defaults: { model: { primary: "openai/gpt-5.4" }, models: {} } },
  };
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

function expectSpawnedSessionLookupCalls(spawnedBy: string, targetKeys: string[]) {
  expect(callGatewayMock).toHaveBeenCalledTimes(targetKeys.length);
  for (const [index, key] of targetKeys.entries()) {
    expect(callGatewayMock).toHaveBeenNthCalledWith(index + 1, {
      method: "sessions.resolve",
      params: { agentId: "main", allowMissing: true, key, spawnedBy },
    });
  }
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
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

describe("session_status tool", () => {
  const mainKey = "agent:main:main";
  const childKey = "agent:main:subagent:child";
  const liveKey = "agent:main:telegram:default:direct:1234";
  const channelKey = "agent:main:scope:scopy:direct:scopy";

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

    const tool = getSessionStatusTool("agent:research:main", {
      requesterAgentIdOverride: "research",
    });

    await expect(tool.execute("foreign-global", { sessionKey: "global" })).rejects.toThrow(
      "Agent-to-agent status is disabled",
    );
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

    const tool = getSessionStatusTool("agent:admin:main", {
      activeDeliveryContext: {
        channel: "webchat",
        to: "control-ui-conversation",
      },
    });

    const result = await tool.execute("current-webchat", { sessionKey: " current " });
    expect(result.details).toMatchObject({ ok: true, sessionKey: "agent:admin:main" });

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    expectRecordFields(statusArg.sessionEntry, {
      sessionId: "s-admin-main",
      thinkingLevel: "low",
    });
  });

  it("uses runSessionKey thinking level for implicit no-arg status lookups (#82669)", async () => {
    resetSessionStore({
      [liveKey]: {
        sessionId: "s-tg-direct",
        updatedAt: 5,
        status: "done",
        thinkingLevel: "off",
      },
      [mainKey]: fixtureSession("s-main", {
        status: "running",
        thinkingLevel: "high",
      }),
    });

    const tool = getSessionStatusTool(liveKey, {
      runSessionKey: mainKey,
    });

    const result = await tool.execute("call-implicit-run-session-thinking", {});
    expect(result.details).toMatchObject({ ok: true, sessionKey: mainKey });

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const sessionEntry = statusArg.sessionEntry as SessionEntry;
    expect(sessionEntry.thinkingLevel).toBe("high");
  });

  it("resolves sessionKey=current to runSessionKey under explicit tree visibility (#76708)", async () => {
    resetSessionStore({
      [liveKey]: {
        sessionId: "s-tg-direct",
        updatedAt: 5,
        status: "done",
      },
      [mainKey]: fixtureSession("s-main", {
        status: "running",
      }),
    });

    mockConfig = { ...mockConfig, tools: { sessions: { visibility: "tree" } } };

    // Explicit tree visibility protects the semantic-current alias. The tool uses
    // the Telegram key as agentSessionKey and the live run key as runSessionKey.
    // semantic-current must be treated as self for visibility purposes.
    const tool = getSessionStatusTool(liveKey, {
      runSessionKey: mainKey,
    });

    const result = await tool.execute("call-current-run-session", { sessionKey: "current" });
    expect(result.details).toMatchObject({ ok: true, sessionKey: mainKey });
  });

  it("synthesizes semantic current from runSessionKey when the live run is not persisted yet", async () => {
    resetSessionStore({
      [liveKey]: {
        sessionId: "s-tg-direct",
        updatedAt: 5,
        status: "done",
      },
    });

    const tool = getSessionStatusTool(liveKey, {
      runSessionKey: mainKey,
    });

    const result = await tool.execute("call-current-unpersisted-run", { sessionKey: "current" });
    const details = result.details as { ok?: boolean; sessionKey?: string; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe(mainKey);
    expect(details.statusText).toContain("OpenClaw");
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

    const tool = getSessionStatusTool(policyKey, {
      runSessionKey: runKey,
      activeDeliveryContext: {
        channel: "webchat",
        to: "control-ui-conversation",
      },
    });

    const result = await tool.execute("call-explicit-stale-policy-key-route-context", {
      sessionKey: policyKey,
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
    resetSessionStore({
      [liveKey]: {
        sessionId: "s-tg-direct",
        updatedAt: 5,
        status: "done",
      },
      [mainKey]: fixtureSession("s-main", {
        status: "running",
      }),
    });

    mockConfig = { ...mockConfig, tools: { sessions: { visibility: "tree" } } };

    // Same setup but with an explicit key — should NOT bypass visibility.
    const tool = getSessionStatusTool(liveKey, {
      runSessionKey: mainKey,
    });

    await expect(tool.execute("call-explicit-key", { sessionKey: mainKey })).rejects.toThrow(
      /visibility is restricted/,
    );
  });

  it("falls back from implicit default-account direct policy keys to persisted direct sessions", async () => {
    resetSessionStore({
      "agent:main:telegram:direct:1053274893": fixtureSession("s-direct"),
    });

    const tool = getSessionStatusTool("agent:main:telegram:default:direct:1053274893");

    const result = await tool.execute("call-default-direct", {});
    expect(result.details).toMatchObject({
      ok: true,
      sessionKey: "agent:main:telegram:direct:1053274893",
    });
  });

  it("keeps explicit default-account direct session lookups strict", async () => {
    resetSessionStore({
      [mainKey]: fixtureSession("s-main"),
    });

    const tool = getSessionStatusTool("agent:main:telegram:default:direct:1053274893");

    await expect(
      tool.execute("call-default-direct-explicit", {
        sessionKey: "agent:main:telegram:default:direct:1053274893",
      }),
    ).rejects.toThrow("Unknown sessionKey: agent:main:telegram:default:direct:1053274893");
  });

  it("does not apply the active run model to a literal current session key", async () => {
    resetSessionStore({
      main: fixtureSession("s-main"),
      "agent:main:current": {
        sessionId: "s-current",
        updatedAt: 20,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      },
    });

    const tool = getSessionStatusTool("main", {
      activeModelProvider: "openai",
      activeModelId: "gpt-5.2",
    });

    const result = await tool.execute("call-current-literal-key-active-model", {
      sessionKey: "current",
    });
    expect(result.details).toMatchObject({ ok: true, sessionKey: "agent:main:current" });

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    expectRecordFields(statusArg.sessionEntry, {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    });
    const agent = statusArg.agent as Record<string, unknown>;
    const model = agent.model as Record<string, unknown>;
    expect(model.primary).not.toBe("openai/gpt-5.2");
  });

  it("resolves sandboxed sessionKey=current to the requester when no run session override exists", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool("agent:main:telegram:group:-5096326138", {
      sandboxed: true,
    });

    const result = await tool.execute("call-current-sandboxed-channel", {
      sessionKey: "current",
    });
    const details = result.details as { ok?: boolean; sessionKey?: string; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.sessionKey).toBe("agent:main:telegram:group:-5096326138");
    expect(details.statusText).toContain("OpenClaw");
    expect(details.statusText).toContain("🧠 Model:");
    expect(
      callGatewayMock.mock.calls.some(([arg]) => {
        const request = arg as { method?: string; params?: { key?: string } };
        return request.method === "sessions.resolve" && request.params?.key === "current";
      }),
    ).toBe(false);
  });

  it("renders the active run model for current lookups with persisted overrides", async () => {
    resetSessionStore({
      [channelKey]: fixtureSession("current-active-model-with-override", {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      }),
    });

    const tool = getSessionStatusTool(channelKey, {
      activeModelProvider: "openai",
      activeModelId: "gpt-5.2",
    });

    await tool.execute("call-current-active-model-with-override", { sessionKey: "current" });

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const sessionEntry = statusArg.sessionEntry as Record<string, unknown>;
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "openai/gpt-5.2" });
  });

  it("materializes a valid persisted session entry when implicit current fallback mutates model state", async () => {
    resetSessionStore({});

    const tool = getSessionStatusTool(channelKey);

    const result = await tool.execute("call-current-channel-plugin-model", {
      sessionKey: "current",
      model: "anthropic/claude-sonnet-4-6",
    });
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
    expectRecordFields(saved, {
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

    const tool = getSessionStatusTool();
    await expect(
      tool.execute("call-session-status-model-locked", {
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

    const tool = getSessionStatusTool();

    await tool.execute("call-legacy-runtime-model", {});

    const statusArg = mockCallArg(buildStatusMessageMock) as Record<string, unknown>;
    const agent = statusArg.agent as Record<string, unknown>;
    expectRecordFields(agent.model, { primary: "legacy-runtime-model" });
    expectRecordFields(statusArg.sessionEntry, {
      model: "legacy-runtime-model",
      providerOverride: "",
    });
    expect(statusArg.modelAuth).toBeUndefined();
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

  it("blocks explicit incognito session_status before opening its store", async () => {
    const incognitoSessionKey = "agent:main:dashboard:incognito-private";
    resetSessionStore({
      [mainKey]: { sessionId: "s-main", updatedAt: 10 },
      [incognitoSessionKey]: {
        sessionId: "s-incognito",
        updatedAt: 20,
        incognito: true,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "agent" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" }, models: {} } },
    };

    const tool = getSessionStatusTool(mainKey);

    await expect(
      tool.execute("call-incognito-status", {
        sessionKey: incognitoSessionKey,
        model: "default",
      }),
    ).rejects.toThrow(`Session not visible from session tools: ${incognitoSessionKey}`);

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(buildStatusMessageMock).not.toHaveBeenCalled();
  });

  it("blocks implicit incognito live-run status before opening its store", async () => {
    const requesterSessionKey = liveKey;
    const incognitoSessionKey = "agent:main:dashboard:incognito-live-run";
    resetSessionStore({
      [requesterSessionKey]: { sessionId: "s-requester", updatedAt: 10 },
      [incognitoSessionKey]: {
        sessionId: "s-incognito-live-run",
        updatedAt: 20,
        incognito: true,
      },
    });
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "agent" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
      agents: { defaults: { model: { primary: "openai/gpt-5.4" }, models: {} } },
    };

    const tool = getSessionStatusTool(requesterSessionKey, {
      runSessionKey: incognitoSessionKey,
    });

    await expect(tool.execute("call-incognito-implicit", {})).rejects.toThrow(
      `Session not visible from session tools: ${incognitoSessionKey}`,
    );

    expect(loadSessionStoreMock).not.toHaveBeenCalled();
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(buildStatusMessageMock).not.toHaveBeenCalled();
  });

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
    const mainDetails = mainResult.details as { ok?: boolean; sessionKey?: string };
    expect(mainDetails.ok).toBe(true);
    expect(mainDetails.sessionKey).toBe(mainKey);

    const childResult = await tool.execute("call9", {
      sessionKey: childKey,
    });
    const childDetails = childResult.details as { ok?: boolean; sessionKey?: string };
    expect(childDetails.ok).toBe(true);
    expect(childDetails.sessionKey).toBe(childKey);

    expectSpawnedSessionLookupCalls("main", [childKey]);
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
    let persistedStore: Record<string, SessionEntry> | undefined;
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
    updateSessionStoreMock.mockImplementation(
      (_storePath: string, store: Record<string, SessionEntry>) => {
        persistedStore = structuredClone(store);
      },
    );

    const result = await getSessionStatusTool().execute("call4", { model: "openai/gpt-5.4" });

    expect(result.details).toMatchObject({ modelOverride: null });
    const saved = persistedStore?.main;
    if (!saved) {
      throw new Error("Expected session_status to persist the selected model");
    }
    expect(saved.authProfileOverride).toBe("session-status-team:prod");
    expect(saved.authProfileOverrideSource).toBe("user");
    expect(saved.authProfileOverrideCompactionCount).toBe(2);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
