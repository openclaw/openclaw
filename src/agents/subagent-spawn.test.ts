import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  pruneLegacyStoreKeysMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => hoisted.callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => hoisted.configOverride,
  };
});

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    updateSessionStore: (...args: unknown[]) => hoisted.updateSessionStoreMock(...args),
  };
});

vi.mock("../gateway/session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/session-utils.js")>();
  return {
    ...actual,
    resolveGatewaySessionStoreTarget: (params: { key: string }) => ({
      agentId: "main",
      storePath: "/tmp/subagent-spawn-session-store.json",
      canonicalKey: params.key,
      storeKeys: [params.key],
    }),
    pruneLegacyStoreKeys: (...args: unknown[]) => hoisted.pruneLegacyStoreKeysMock(...args),
  };
});

vi.mock("./subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry.js")>();
  return {
    ...actual,
    countActiveRunsForSession: () => 0,
    registerSubagentRun: (args: unknown) => hoisted.registerSubagentRunMock(args),
  };
});

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: (args: unknown) => hoisted.emitSessionLifecycleEventMock(args),
}));

vi.mock("./subagent-announce.js", () => ({
  buildSubagentSystemPrompt: () => "system-prompt",
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("./model-selection.js", () => ({
  resolveSubagentSpawnModelSelection: () => "openai-codex/gpt-5.4",
}));

vi.mock("./sandbox/runtime-status.js", () => ({
  resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (value: unknown) => value,
}));

vi.mock("./tools/sessions-helpers.js", () => ({
  resolveMainSessionAlias: () => ({ mainKey: "main", alias: "main" }),
  resolveInternalSessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
  resolveDisplaySessionKey: ({ key }: { key?: string }) => key ?? "agent:main:main",
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentConfig: () => undefined,
}));

function createConfigOverride(overrides?: Record<string, unknown>) {
  return {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  };
}

describe("spawnSubagentDirect seam flow", () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.pruneLegacyStoreKeysMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const { spawnSubagentDirect } = await import("./subagent-spawn.js");
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        operations.push("store:update");
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        persistedStore = store;
        return store;
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      mode: "run",
      modelApplied: true,
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(1);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          accountId: "acct-1",
          to: "user-1",
          threadId: undefined,
        },
        task: "inspect the spawn seam",
        cleanup: "keep",
        model: "openai-codex/gpt-5.4",
        workspaceDir: "/tmp/requester-workspace",
        expectsCompletionMessage: true,
        spawnMode: "run",
      }),
    );
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    const [persistedKey, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedKey).toBe(childSessionKey);
    expect(persistedEntry).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(operations.indexOf("gateway:sessions.patch")).toBeGreaterThan(-1);
    expect(operations.indexOf("store:update")).toBeGreaterThan(
      operations.indexOf("gateway:sessions.patch"),
    );
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(operations.indexOf("store:update"));
  });
});
