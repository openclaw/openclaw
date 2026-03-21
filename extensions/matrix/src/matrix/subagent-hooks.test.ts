import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "../../../../test/helpers/extensions/subagent-hooks.js";
import { registerMatrixSubagentHooks } from "./subagent-hooks.js";

type MockBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  targetKind: "subagent" | "acp";
};

const hookMocks = vi.hoisted(() => ({
  getMatrixThreadBindingManager: vi.fn(
    (): {
      getIdleTimeoutMs: () => number;
      getMaxAgeMs: () => number;
      persist: () => Promise<void>;
    } | null => ({
      getIdleTimeoutMs: () => 3_600_000,
      getMaxAgeMs: () => 86_400_000,
      persist: () => Promise.resolve(),
    }),
  ),
  listBindingsForAccount: vi.fn((_accountId?: string): MockBindingRecord[] => []),
  listAllBindings: vi.fn((): MockBindingRecord[] => []),
  setBindingRecord: vi.fn(),
  removeBindingRecord: vi.fn((): MockBindingRecord | null => null),
  findMatrixAccountConfig: vi.fn((): unknown => undefined),
  resolveMatrixBaseConfig: vi.fn(
    (): { threadBindings?: { enabled?: boolean; spawnSubagentSessions?: boolean } } => ({
      threadBindings: { spawnSubagentSessions: true },
    }),
  ),
}));

vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: hookMocks.getMatrixThreadBindingManager,
  listBindingsForAccount: hookMocks.listBindingsForAccount,
  listAllBindings: hookMocks.listAllBindings,
  setBindingRecord: hookMocks.setBindingRecord,
  removeBindingRecord: hookMocks.removeBindingRecord,
}));

vi.mock("./account-config.js", () => ({
  findMatrixAccountConfig: hookMocks.findMatrixAccountConfig,
  resolveMatrixBaseConfig: hookMocks.resolveMatrixBaseConfig,
}));

function registerHandlersForTest(
  config: Record<string, unknown> = {
    channels: {
      matrix: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    },
  },
) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: registerMatrixSubagentHooks,
  });
}

function createSpawnEvent(overrides?: {
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  mode?: string;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string;
  };
  threadRequested?: boolean;
}): {
  childSessionKey: string;
  agentId: string;
  label: string;
  mode: string;
  requester: {
    channel: string;
    accountId: string;
    to: string;
    threadId?: string;
  };
  threadRequested: boolean;
} {
  const base = {
    childSessionKey: "agent:main:subagent:child",
    agentId: "main",
    label: "banana",
    mode: "session",
    requester: {
      channel: "matrix",
      accountId: "work",
      to: "room:!abc123:example.org",
      threadId: "$thread-event-1",
    },
    threadRequested: true,
  };
  return {
    ...base,
    ...overrides,
    requester: {
      ...base.requester,
      ...(overrides?.requester ?? {}),
    },
  };
}

function createSpawnEventWithoutThread() {
  return createSpawnEvent({
    label: "",
    requester: { threadId: undefined },
  });
}

async function runSubagentSpawning(
  config?: Record<string, unknown>,
  event = createSpawnEventWithoutThread(),
) {
  const handlers = registerHandlersForTest(config);
  const handler = getRequiredHookHandler(handlers, "subagent_spawning");
  return await handler(event, {});
}

async function expectSubagentSpawningError(params?: {
  config?: Record<string, unknown>;
  errorContains?: string;
  event?: ReturnType<typeof createSpawnEvent>;
}) {
  const result = await runSubagentSpawning(params?.config, params?.event);
  expect(hookMocks.setBindingRecord).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: "error" });
  if (params?.errorContains) {
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toContain(params.errorContains);
  }
}

function resolveSubagentDeliveryTargetForTest(requesterOrigin: {
  channel: string;
  accountId: string;
  to: string;
  threadId?: string;
}) {
  const handlers = registerHandlersForTest();
  const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");
  return handler(
    {
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin,
      childRunId: "run-1",
      spawnMode: "session",
      expectsCompletionMessage: true,
    },
    {},
  );
}

describe("matrix subagent hook handlers", () => {
  beforeEach(() => {
    hookMocks.getMatrixThreadBindingManager.mockClear();
    hookMocks.getMatrixThreadBindingManager.mockReturnValue({
      getIdleTimeoutMs: () => 3_600_000,
      getMaxAgeMs: () => 86_400_000,
      persist: () => Promise.resolve(),
    });
    hookMocks.listBindingsForAccount.mockClear();
    hookMocks.listBindingsForAccount.mockReturnValue([]);
    hookMocks.listAllBindings.mockClear();
    hookMocks.listAllBindings.mockReturnValue([]);
    hookMocks.setBindingRecord.mockClear();
    hookMocks.removeBindingRecord.mockClear();
    hookMocks.findMatrixAccountConfig.mockClear();
    hookMocks.findMatrixAccountConfig.mockReturnValue(undefined);
    hookMocks.resolveMatrixBaseConfig.mockClear();
    hookMocks.resolveMatrixBaseConfig.mockReturnValue({
      threadBindings: { spawnSubagentSessions: true },
    });
  });

  it("registers subagent hooks", () => {
    const handlers = registerHandlersForTest();
    expect(handlers.has("subagent_spawning")).toBe(true);
    expect(handlers.has("subagent_delivery_target")).toBe(true);
    expect(handlers.has("subagent_spawned")).toBe(false);
    expect(handlers.has("subagent_ended")).toBe(true);
  });

  it("signals readiness on subagent_spawning (binding delegated to adapter)", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");

    const result = await handler(createSpawnEvent(), {});

    // The hook does NOT call setBindingRecord — the core invokes
    // the SessionBindingAdapter's bind() method after we return
    // threadBindingReady: true. The adapter handles record creation,
    // persistence, and child thread creation atomically.
    expect(hookMocks.setBindingRecord).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("returns error when thread-bound subagent spawn is disabled", async () => {
    hookMocks.resolveMatrixBaseConfig.mockReturnValue({
      threadBindings: { spawnSubagentSessions: false },
    });
    await expectSubagentSpawningError({
      errorContains: "spawnSubagentSessions=true",
    });
  });

  it("returns error when global thread bindings are disabled", async () => {
    hookMocks.resolveMatrixBaseConfig.mockReturnValue({
      threadBindings: { spawnSubagentSessions: true },
    });
    await expectSubagentSpawningError({
      config: {
        session: {
          threadBindings: {
            enabled: false,
          },
        },
        channels: {
          matrix: {
            threadBindings: {
              spawnSubagentSessions: true,
            },
          },
        },
      },
      errorContains: "threadBindings.enabled=true",
    });
  });

  it("allows account-level threadBindings.enabled to override global disable", async () => {
    hookMocks.resolveMatrixBaseConfig.mockReturnValue({
      threadBindings: { spawnSubagentSessions: true },
    });
    hookMocks.findMatrixAccountConfig.mockReturnValue({
      threadBindings: {
        enabled: true,
        spawnSubagentSessions: true,
      },
    });
    const result = await runSubagentSpawning({
      session: {
        threadBindings: {
          enabled: false,
        },
      },
      channels: {
        matrix: {
          threadBindings: {
            spawnSubagentSessions: true,
          },
        },
      },
    });

    expect(hookMocks.setBindingRecord).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("defaults thread-bound subagent spawn to disabled when unset", async () => {
    hookMocks.resolveMatrixBaseConfig.mockReturnValue({
      threadBindings: {},
    });
    await expectSubagentSpawningError();
  });

  it("no-ops when thread binding is requested on non-matrix channel", async () => {
    const result = await runSubagentSpawning(
      undefined,
      createSpawnEvent({
        requester: {
          channel: "signal",
          accountId: "",
          to: "+123",
          threadId: undefined,
        },
      }),
    );

    expect(hookMocks.setBindingRecord).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("returns error when no thread binding manager is available", async () => {
    hookMocks.getMatrixThreadBindingManager.mockReturnValue(null);
    const result = await runSubagentSpawning();

    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toMatch(/no thread binding manager/i);
  });

  it("unbinds room routing on subagent_ended", async () => {
    const mockBindings: MockBindingRecord[] = [
      {
        accountId: "work",
        conversationId: "$thread-1",
        parentConversationId: "!room1:example.org",
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
      },
    ];
    hookMocks.listBindingsForAccount.mockReturnValue(mockBindings);
    hookMocks.removeBindingRecord.mockReturnValue(mockBindings[0]);
    const persistMock = vi.fn(() => Promise.resolve());
    hookMocks.getMatrixThreadBindingManager.mockReturnValue({
      getIdleTimeoutMs: () => 3_600_000,
      getMaxAgeMs: () => 86_400_000,
      persist: persistMock,
    });

    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_ended");

    await handler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
      },
      {},
    );

    expect(hookMocks.removeBindingRecord).toHaveBeenCalledTimes(1);
    expect(hookMocks.removeBindingRecord).toHaveBeenCalledWith(mockBindings[0]);
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("scans all accounts on subagent_ended when accountId is missing", async () => {
    const mockBindings: MockBindingRecord[] = [
      {
        accountId: "personal",
        conversationId: "$thread-1",
        parentConversationId: "!room1:example.org",
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
      },
    ];
    hookMocks.listAllBindings.mockReturnValue(mockBindings);
    hookMocks.removeBindingRecord.mockReturnValue(mockBindings[0]);
    const persistMock = vi.fn(() => Promise.resolve());
    hookMocks.getMatrixThreadBindingManager.mockReturnValue({
      getIdleTimeoutMs: () => 3_600_000,
      getMaxAgeMs: () => 86_400_000,
      persist: persistMock,
    });

    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_ended");

    await handler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        sendFarewell: true,
      },
      {},
    );

    expect(hookMocks.listAllBindings).toHaveBeenCalledTimes(1);
    expect(hookMocks.removeBindingRecord).toHaveBeenCalledTimes(1);
    expect(persistMock).toHaveBeenCalledTimes(1);
  });

  it("resolves delivery target from matching bound room", () => {
    hookMocks.listBindingsForAccount.mockReturnValue([
      {
        accountId: "work",
        conversationId: "$thread-1",
        parentConversationId: "!room1:example.org",
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
      },
    ]);
    const result = resolveSubagentDeliveryTargetForTest({
      channel: "matrix",
      accountId: "work",
      to: "room:!room1:example.org",
      threadId: "$thread-1",
    });

    expect(result).toEqual({
      origin: {
        channel: "matrix",
        accountId: "work",
        to: "room:!room1:example.org",
        threadId: "$thread-1",
      },
    });
  });

  it("keeps original routing when delivery target is ambiguous", () => {
    hookMocks.listBindingsForAccount.mockReturnValue([
      {
        accountId: "work",
        conversationId: "$thread-1",
        parentConversationId: "!room1:example.org",
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
      },
      {
        accountId: "work",
        conversationId: "$thread-2",
        parentConversationId: "!room1:example.org",
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
      },
    ]);
    const result = resolveSubagentDeliveryTargetForTest({
      channel: "matrix",
      accountId: "work",
      to: "room:!room1:example.org",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined for delivery target on non-matrix channel", () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");
    const result = handler(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
        },
        childRunId: "run-1",
        spawnMode: "session",
        expectsCompletionMessage: true,
      },
      {},
    );

    expect(result).toBeUndefined();
  });
});
