import os from "node:os";
import { expect, vi } from "vitest";

type MockFn = (...args: unknown[]) => unknown;
type MockImplementationTarget = {
  mockImplementation: (implementation: (opts: { method?: string }) => Promise<unknown>) => unknown;
};
type SessionStore = Record<string, Record<string, unknown>>;
type SessionStoreMutator = (store: SessionStore) => unknown;
type HookRunner = {
  hasHooks: (name?: string) => boolean;
  runSubagentSpawning?: (...args: unknown[]) => Promise<unknown>;
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

export function identityDeliveryContext(value: unknown) {
  return value;
}

export function createDefaultSessionHelperMocks() {
  return {
    resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
    resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
    resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  };
}

export function installSessionStoreCaptureMock(
  updateSessionStoreMock: {
    mockImplementation: (
      implementation: (storePath: string, mutator: SessionStoreMutator) => Promise<SessionStore>,
    ) => unknown;
  },
  params?: {
    operations?: string[];
    onStore?: (store: SessionStore) => void;
  },
) {
  updateSessionStoreMock.mockImplementation(
    async (_storePath: string, mutator: SessionStoreMutator) => {
      params?.operations?.push("store:update");
      const store: SessionStore = {};
      await mutator(store);
      params?.onStore?.(store);
      return store;
    },
  );
}

export function expectPersistedRuntimeModel(params: {
  persistedStore: SessionStore | undefined;
  sessionKey: string | RegExp;
  provider: string;
  model: string;
}) {
  const [persistedKey, persistedEntry] = Object.entries(params.persistedStore ?? {})[0] ?? [];
  if (typeof params.sessionKey === "string") {
    expect(persistedKey).toBe(params.sessionKey);
  } else {
    expect(persistedKey).toMatch(params.sessionKey);
  }
  expect(persistedEntry).toMatchObject({
    modelProvider: params.provider,
    model: params.model,
  });
}

export async function loadSubagentSpawnModuleForTest(params: {
  callGatewayMock: MockFn;
  loadConfig?: () => Record<string, unknown>;
  updateSessionStoreMock?: MockFn;
  pruneLegacyStoreKeysMock?: MockFn;
  registerSubagentRunMock?: MockFn;
  emitSessionLifecycleEventMock?: MockFn;
  hookRunner?: HookRunner;
  resolveAgentConfig?: (cfg: Record<string, unknown>, agentId: string) => unknown;
  resolveAgentWorkspaceDir?: (cfg: Record<string, unknown>, agentId: string) => string;
  resolveSubagentSpawnModelSelection?: () => string | undefined;
  resolveSandboxRuntimeStatus?: () => { sandboxed: boolean };
  workspaceDir?: string;
  sessionStorePath?: string;
}) {
  vi.resetModules();

  vi.doMock("../gateway/call.js", () => ({
    callGateway: (opts: unknown) => params.callGatewayMock(opts),
  }));

  vi.doMock("../config/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../config/config.js")>();
    return {
      ...actual,
      loadConfig: () =>
        params.loadConfig?.() ?? createSubagentSpawnTestConfig(params.workspaceDir ?? os.tmpdir()),
    };
  });

  if (params.updateSessionStoreMock) {
    vi.doMock("../config/sessions.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../config/sessions.js")>();
      return {
        ...actual,
        updateSessionStore: (...args: unknown[]) => params.updateSessionStoreMock?.(...args),
      };
    });
  }

  if (params.pruneLegacyStoreKeysMock) {
    vi.doMock("../gateway/session-utils.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../gateway/session-utils.js")>();
      return {
        ...actual,
        resolveGatewaySessionStoreTarget: (targetParams: { key: string }) => ({
          agentId: "main",
          storePath: params.sessionStorePath ?? "/tmp/subagent-spawn-model-session.json",
          canonicalKey: targetParams.key,
          storeKeys: [targetParams.key],
        }),
        pruneLegacyStoreKeys: (...args: unknown[]) => params.pruneLegacyStoreKeysMock?.(...args),
      };
    });
  }

  if (params.emitSessionLifecycleEventMock) {
    vi.doMock("../sessions/session-lifecycle-events.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../sessions/session-lifecycle-events.js")>();
      return {
        ...actual,
        emitSessionLifecycleEvent: (...args: unknown[]) =>
          params.emitSessionLifecycleEventMock?.(...args),
      };
    });
  }

  vi.doMock("./subagent-announce.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./subagent-announce.js")>();
    return {
      ...actual,
      buildSubagentSystemPrompt: () => "system-prompt",
    };
  });

  vi.doMock("./agent-scope.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./agent-scope.js")>();
    return {
      ...actual,
      resolveAgentConfig: params.resolveAgentConfig ?? actual.resolveAgentConfig,
      resolveAgentWorkspaceDir:
        params.resolveAgentWorkspaceDir ?? (() => params.workspaceDir ?? os.tmpdir()),
    };
  });

  vi.doMock("./subagent-depth.js", () => ({
    getSubagentDepthFromSessionStore: () => 0,
  }));

  vi.doMock("./model-selection.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./model-selection.js")>();
    return {
      ...actual,
      resolveSubagentSpawnModelSelection:
        params.resolveSubagentSpawnModelSelection ?? actual.resolveSubagentSpawnModelSelection,
    };
  });

  vi.doMock("./sandbox/runtime-status.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./sandbox/runtime-status.js")>();
    return {
      ...actual,
      resolveSandboxRuntimeStatus:
        params.resolveSandboxRuntimeStatus ?? actual.resolveSandboxRuntimeStatus,
    };
  });

  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => params.hookRunner ?? { hasHooks: () => false },
  }));

  vi.doMock("../utils/delivery-context.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../utils/delivery-context.js")>();
    return {
      ...actual,
      normalizeDeliveryContext: identityDeliveryContext,
    };
  });

  vi.doMock("./tools/sessions-helpers.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./tools/sessions-helpers.js")>();
    return {
      ...actual,
      ...createDefaultSessionHelperMocks(),
    };
  });

  const subagentRegistry = await import("./subagent-registry.js");
  if (params.registerSubagentRunMock) {
    vi.spyOn(subagentRegistry, "registerSubagentRun").mockImplementation(
      (...args: Parameters<typeof subagentRegistry.registerSubagentRun>) =>
        params.registerSubagentRunMock?.(...args) as ReturnType<
          typeof subagentRegistry.registerSubagentRun
        >,
    );
  }
  return {
    ...(await import("./subagent-spawn.js")),
    resetSubagentRegistryForTests: subagentRegistry.resetSubagentRegistryForTests,
  };
}
