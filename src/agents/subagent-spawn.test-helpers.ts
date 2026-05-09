import os from "node:os";
import { expect, vi } from "vitest";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

type MockFn = (...args: unknown[]) => unknown;
type MockImplementationTarget = {
  mockImplementation: (implementation: (opts: { method?: string }) => Promise<unknown>) => unknown;
};
type SessionStore = Record<string, Record<string, unknown>>;
type HookRunner = Pick<SubagentLifecycleHookRunner, "hasHooks" | "runSubagentSpawning"> &
  Partial<Pick<SubagentLifecycleHookRunner, "runSubagentSpawned" | "runSubagentEnded">>;
type SubagentSpawnModuleForTest = Awaited<typeof import("./subagent-spawn.js")> & {
  resetSubagentRegistryForTests: MockFn;
};

export function createSubagentSpawnTestConfig(
  workspaceDir = os.tmpdir(),
  overrides?: Record<string, unknown>,
) {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    tools: {
      sessions_spawn: {
        attachments: {
          enabled: true,
          maxFiles: 50,
          maxFileBytes: 1 * 1024 * 1024,
          maxTotalBytes: 5 * 1024 * 1024,
        },
      },
    },
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    ...overrides,
  };
}

export function setupAcceptedSubagentGatewayMock(callGatewayMock: MockImplementationTarget) {
  callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "sessions.patch") {
      return { ok: true };
    }
    if (opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
    }
    return {};
  });
}

function identityDeliveryContext(value: unknown) {
  return value;
}

function createDefaultSessionHelperMocks() {
  return {
    resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
    resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
    resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  };
}

export function installSessionEntryCaptureMock(
  upsertSessionEntryMock: {
    mockImplementation: (
      implementation: (options: { sessionKey: string; entry: Record<string, unknown> }) => unknown,
    ) => unknown;
  },
  params?: {
    operations?: string[];
    onStore?: (store: SessionStore) => void;
  },
) {
  const store: SessionStore = {};
  upsertSessionEntryMock.mockImplementation((options) => {
    params?.operations?.push("store:upsert");
    store[options.sessionKey] = options.entry;
    params?.onStore?.(store);
  });
}

export function expectPersistedRuntimeModel(params: {
  persistedStore: SessionStore | undefined;
  sessionKey: string | RegExp;
  provider: string;
  model: string;
  overrideSource?: "auto" | "user";
}) {
  const [persistedKey, persistedEntry] = Object.entries(params.persistedStore ?? {})[0] ?? [];
  if (typeof params.sessionKey === "string") {
    expect(persistedKey).toBe(params.sessionKey);
  } else {
    expect(persistedKey).toMatch(params.sessionKey);
  }
  expect(persistedEntry?.modelProvider).toBe(params.provider);
  expect(persistedEntry?.model).toBe(params.model);
  expect(persistedEntry?.providerOverride).toBe(params.provider);
  expect(persistedEntry?.modelOverride).toBe(params.model);
  if (params.overrideSource) {
    expect(persistedEntry?.modelOverrideSource).toBe(params.overrideSource);
  }
}

export async function loadSubagentSpawnModuleForTest(params: {
  callGatewayMock: MockFn;
  getRuntimeConfig?: () => Record<string, unknown>;
  ensureContextEnginesInitializedMock?: MockFn;
  upsertSessionEntryMock?: MockFn;
  forkSessionFromParentMock?: MockFn;
  resolveContextEngineMock?: MockFn;
  resolveParentForkDecisionMock?: MockFn;
  registerSubagentRunMock?: MockFn;
  emitSessionLifecycleEventMock?: MockFn;
  hookRunner?: HookRunner;
  resolveAgentConfig?: (cfg: Record<string, unknown>, agentId: string) => unknown;
  resolveAgentWorkspaceDir?: (cfg: Record<string, unknown>, agentId: string) => string;
  resolveSubagentSpawnModelSelection?: () => string | undefined;
  getSubagentDepthFromSessionEntries?: (sessionKey: string, opts?: unknown) => number;
  countActiveRunsForSession?: (sessionKey: string) => number;
  resolveSandboxRuntimeStatus?: (params: {
    cfg?: Record<string, unknown>;
    sessionKey?: string;
  }) => { sandboxed: boolean };
  getSessionBindingService?: () => {
    listBySession: (targetSessionKey: string) => Array<{
      status?: string;
      conversation: {
        channel: string;
        accountId?: string;
        conversationId: string;
        parentConversationId?: string;
      };
    }>;
  };
  resolveConversationDeliveryTarget?: (params: {
    channel?: string;
    conversationId?: string | number;
    parentConversationId?: string | number;
  }) => { to?: string; threadId?: string };
  workspaceDir?: string;
  initialSessionStore?: SessionStore;
  getSessionStore?: () => SessionStore;
  resetModules?: boolean;
}): Promise<SubagentSpawnModuleForTest> {
  if (params.resetModules ?? true) {
    vi.resetModules();
  }

  const resetSubagentRegistryForTests = vi.fn();
  const sessionStore: SessionStore = { ...params.initialSessionStore };
  const currentSessionStore = () => params.getSessionStore?.() ?? sessionStore;

  vi.doMock("./subagent-spawn.runtime.js", () => ({
    callGateway: (opts: unknown) => params.callGatewayMock(opts),
    buildSubagentSystemPrompt: () => "system-prompt",
    forkSessionFromParent:
      params.forkSessionFromParentMock ??
      (async () => ({
        sessionId: "forked-session-id",
      })),
    getGlobalHookRunner: () => params.hookRunner ?? { hasHooks: () => false },
    emitSessionLifecycleEvent: (...args: unknown[]) =>
      params.emitSessionLifecycleEventMock?.(...args),
    formatThinkingLevels: (levels: string[]) => levels.join(", "),
    normalizeThinkLevel: (level: unknown) => normalizeOptionalString(level),
    DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT: 5,
    DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH: 3,
    ADMIN_SCOPE: "operator.admin",
    AGENT_LANE_SUBAGENT: "subagent",
    getRuntimeConfig: () =>
      params.getRuntimeConfig?.() ??
      createSubagentSpawnTestConfig(params.workspaceDir ?? os.tmpdir()),
    ensureContextEnginesInitialized:
      params.ensureContextEnginesInitializedMock ?? (() => undefined),
    resolveContextEngine: params.resolveContextEngineMock ?? (async () => ({})),
    resolveParentForkDecision:
      params.resolveParentForkDecisionMock ??
      (async (forkParams: { parentEntry?: { totalTokens?: unknown } }) => {
        const maxTokens = 100_000;
        const parentTokens =
          typeof forkParams.parentEntry?.totalTokens === "number" &&
          Number.isFinite(forkParams.parentEntry.totalTokens)
            ? Math.floor(forkParams.parentEntry.totalTokens)
            : undefined;
        if (maxTokens > 0 && typeof parentTokens === "number" && parentTokens > maxTokens) {
          return {
            status: "skip",
            reason: "parent-too-large",
            maxTokens,
            parentTokens,
            message: `Parent context is too large to fork (${parentTokens}/${maxTokens} tokens); starting with isolated context instead.`,
          };
        }
        return {
          status: "fork",
          maxTokens,
          ...(typeof parentTokens === "number" ? { parentTokens } : {}),
        };
      }),
    mergeSessionEntry: (
      current: Record<string, unknown> | undefined,
      next: Record<string, unknown>,
    ) => ({
      ...current,
      ...next,
    }),
    listSessionEntries: () =>
      Object.entries(currentSessionStore()).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      })),
    upsertSessionEntry: (opts: {
      agentId?: string;
      sessionKey: string;
      entry: Record<string, unknown>;
    }) => {
      currentSessionStore()[opts.sessionKey] = opts.entry;
      return params.upsertSessionEntryMock?.(opts);
    },
    isAdminOnlyMethod: (method: string) =>
      method === "sessions.patch" || method === "sessions.delete",
    getSessionBindingService:
      params.getSessionBindingService ?? (() => ({ listBySession: () => [] })),
    resolveConversationDeliveryTarget:
      params.resolveConversationDeliveryTarget ??
      ((targetParams: { channel?: string; conversationId?: string | number }) => ({
        to: targetParams.conversationId
          ? `channel:${String(targetParams.conversationId)}`
          : undefined,
      })),
    mergeDeliveryContext: (
      primary?: Record<string, unknown>,
      fallback?: Record<string, unknown>,
    ) => ({
      ...fallback,
      ...primary,
    }),
    resolveGatewaySessionDatabaseTarget: (targetParams: { key: string }) => ({
      agentId: "main",
      databasePath: "/tmp/subagent-spawn-model-session.sqlite",
      canonicalKey: targetParams.key,
    }),
    normalizeDeliveryContext: identityDeliveryContext,
    resolveAgentConfig: params.resolveAgentConfig ?? (() => undefined),
    resolveAgentWorkspaceDir:
      params.resolveAgentWorkspaceDir ?? (() => params.workspaceDir ?? os.tmpdir()),
    resolveSubagentSpawnModelSelection:
      params.resolveSubagentSpawnModelSelection ??
      ((spawnParams: { modelOverride?: unknown }) =>
        typeof spawnParams.modelOverride === "string" && spawnParams.modelOverride.trim()
          ? spawnParams.modelOverride.trim()
          : "openai/gpt-4"),
    resolveSandboxRuntimeStatus:
      params.resolveSandboxRuntimeStatus ?? (() => ({ sandboxed: false })),
    ...createDefaultSessionHelperMocks(),
  }));

  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionEntries: params.getSubagentDepthFromSessionEntries ?? (() => 0),
  }));

  vi.doMock("./subagent-registry.js", () => ({
    countActiveRunsForSession: params.countActiveRunsForSession ?? (() => 0),
    registerSubagentRun:
      params.registerSubagentRunMock ?? vi.fn((_record: Record<string, unknown>) => undefined),
    resetSubagentRegistryForTests,
  }));

  const subagentSpawnModule = await import("./subagent-spawn.js");
  return {
    ...subagentSpawnModule,
    resetSubagentRegistryForTests,
  };
}
