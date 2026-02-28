import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDiscordSubagentHooks } from "./subagent-hooks.js";

type ThreadBindingRecord = {
  accountId: string;
  threadId: string;
};

type MockResolvedDiscordAccount = {
  accountId: string;
  config: {
    threadBindings?: {
      enabled?: boolean;
      spawnSubagentSessions?: boolean;
    };
  };
};

const hookMocks = vi.hoisted(() => ({
  resolveDiscordAccount: vi.fn(
    (params?: { accountId?: string }): MockResolvedDiscordAccount => ({
      accountId: params?.accountId?.trim() || "default",
      config: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    }),
  ),
  autoBindSpawnedDiscordSubagent: vi.fn(
    async (): Promise<{ threadId: string } | null> => ({ threadId: "thread-1" }),
  ),
  listThreadBindingsBySessionKey: vi.fn((_params?: unknown): ThreadBindingRecord[] => []),
  unbindThreadBindingsBySessionKey: vi.fn(() => []),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  resolveDiscordAccount: hookMocks.resolveDiscordAccount,
  autoBindSpawnedDiscordSubagent: hookMocks.autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey: hookMocks.listThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKey: hookMocks.unbindThreadBindingsBySessionKey,
}));

function registerHandlersForTest(
  config: Record<string, unknown> = {
    channels: {
      discord: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    },
  },
) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    config,
    on: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(hookName, handler);
    },
  } as unknown as OpenClawPluginApi;
  registerDiscordSubagentHooks(api);
  return handlers;
}

function getRequiredHandler(
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  hookName: string,
): (event: unknown, ctx: unknown) => unknown {
  const handler = handlers.get(hookName);
  if (!handler) {
    throw new Error(`expected ${hookName} hook handler`);
  }
  return handler;
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
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "456",
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
  const handler = getRequiredHandler(handlers, "subagent_spawning");
  return await handler(event, {});
}

async function expectSubagentSpawningError(params?: {
  config?: Record<string, unknown>;
  errorContains?: string;
  event?: ReturnType<typeof createSpawnEvent>;
}) {
  const result = await runSubagentSpawning(params?.config, params?.event);
  expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: "error" });
  if (params?.errorContains) {
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toContain(params.errorContains);
  }
}

describe("discord subagent hook handlers", () => {
  beforeEach(() => {
    hookMocks.resolveDiscordAccount.mockClear();
    hookMocks.resolveDiscordAccount.mockImplementation((params?: { accountId?: string }) => ({
      accountId: params?.accountId?.trim() || "default",
      config: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    }));
    hookMocks.autoBindSpawnedDiscordSubagent.mockClear();
    hookMocks.listThreadBindingsBySessionKey.mockClear();
    hookMocks.unbindThreadBindingsBySessionKey.mockClear();
  });

  it("registers subagent hooks", () => {
    const handlers = registerHandlersForTest();
    expect(handlers.has("subagent_spawning")).toBe(true);
    expect(handlers.has("subagent_delivery_target")).toBe(true);
    expect(handlers.has("subagent_spawned")).toBe(false);
    expect(handlers.has("subagent_ended")).toBe(true);
  });

  it("binds thread routing on subagent_spawning", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_spawning");

    const result = await handler(createSpawnEvent(), {});

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledWith({
      accountId: "work",
      channel: "discord",
      to: "channel:123",
      threadId: "456",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "banana",
      boundBy: "system",
    });
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("returns error when thread-bound subagent spawn is disabled", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          discord: {
            threadBindings: {
              spawnSubagentSessions: false,
            },
          },
        },
      },
      errorContains: "spawnSubagentSessions=true",
    });
  });

  it("returns error when global thread bindings are disabled", async () => {
    await expectSubagentSpawningError({
      config: {
        session: {
          threadBindings: {
            enabled: false,
          },
        },
        channels: {
          discord: {
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
    const result = await runSubagentSpawning({
      session: {
        threadBindings: {
          enabled: false,
        },
      },
      channels: {
        discord: {
          accounts: {
            work: {
              threadBindings: {
                enabled: true,
                spawnSubagentSessions: true,
              },
            },
          },
        },
      },
    });

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("defaults thread-bound subagent spawn to disabled when unset", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          discord: {
            threadBindings: {},
          },
        },
      },
    });
  });

  it("no-ops when thread binding is requested on non-discord channel", async () => {
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

    expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("returns error when thread bind fails", async () => {
    hookMocks.autoBindSpawnedDiscordSubagent.mockResolvedValueOnce(null);
    const result = await runSubagentSpawning();

    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toMatch(/unable to create or bind/i);
  });

  it("unbinds thread routing on subagent_ended", () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_ended");

    handler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
      },
      {},
    );

    expect(hookMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(hookMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
      reason: "subagent-complete",
      sendFarewell: true,
    });
  });

  it("resolves delivery target from matching bound thread", () => {
    hookMocks.listThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadId: "777" },
    ]);
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_delivery_target");

    const result = handler(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
          threadId: "777",
        },
        childRunId: "run-1",
        spawnMode: "session",
        expectsCompletionMessage: true,
      },
      {},
    );

    expect(hookMocks.listThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
    });
    expect(result).toEqual({
      origin: {
        channel: "discord",
        accountId: "work",
        to: "channel:777",
        threadId: "777",
      },
    });
  });

  it("keeps original routing when delivery target is ambiguous", () => {
    hookMocks.listThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadId: "777" },
      { accountId: "work", threadId: "888" },
    ]);
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_delivery_target");

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
