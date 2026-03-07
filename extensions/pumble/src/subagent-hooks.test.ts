import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPumbleSubagentHooks } from "./subagent-hooks.js";

type PumbleThreadBindingRecord = {
  accountId: string;
  threadRootId: string;
  channelId: string;
};

type MockResolvedPumbleAccount = {
  accountId: string;
  config: {
    threadBindings?: {
      enabled?: boolean;
      spawnSubagentSessions?: boolean;
    };
  };
};

const hookMocks = vi.hoisted(() => ({
  resolvePumbleAccount: vi.fn(
    (params?: { accountId?: string }): MockResolvedPumbleAccount => ({
      accountId: params?.accountId?.trim() || "default",
      config: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    }),
  ),
  autoBindSpawnedPumbleSubagent: vi.fn(
    async (): Promise<PumbleThreadBindingRecord | null> => ({
      accountId: "work",
      threadRootId: "root-msg-1",
      channelId: "chan-1",
    }),
  ),
  listPumbleThreadBindingsBySessionKey: vi.fn(
    (_params?: unknown): PumbleThreadBindingRecord[] => [],
  ),
  unbindPumbleThreadBindingsBySessionKey: vi.fn(() => []),
}));

vi.mock("./pumble/accounts.js", () => ({
  resolvePumbleAccount: hookMocks.resolvePumbleAccount,
}));

vi.mock("./pumble/thread-bindings.lifecycle.js", () => ({
  autoBindSpawnedPumbleSubagent: hookMocks.autoBindSpawnedPumbleSubagent,
  listPumbleThreadBindingsBySessionKey: hookMocks.listPumbleThreadBindingsBySessionKey,
  unbindPumbleThreadBindingsBySessionKey: hookMocks.unbindPumbleThreadBindingsBySessionKey,
}));

function registerHandlersForTest(
  config: Record<string, unknown> = {
    channels: {
      pumble: {
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
  registerPumbleSubagentHooks(api);
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
      channel: "pumble",
      accountId: "work",
      to: "channel:chan-1",
      threadId: "root-456",
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
  expect(hookMocks.autoBindSpawnedPumbleSubagent).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: "error" });
  if (params?.errorContains) {
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toContain(params.errorContains);
  }
}

describe("pumble subagent hook handlers", () => {
  beforeEach(() => {
    hookMocks.resolvePumbleAccount.mockClear();
    hookMocks.resolvePumbleAccount.mockImplementation((params?: { accountId?: string }) => ({
      accountId: params?.accountId?.trim() || "default",
      config: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    }));
    hookMocks.autoBindSpawnedPumbleSubagent.mockClear();
    hookMocks.listPumbleThreadBindingsBySessionKey.mockClear();
    hookMocks.unbindPumbleThreadBindingsBySessionKey.mockClear();
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

    expect(hookMocks.autoBindSpawnedPumbleSubagent).toHaveBeenCalledTimes(1);
    expect(hookMocks.autoBindSpawnedPumbleSubagent).toHaveBeenCalledWith({
      accountId: "work",
      to: "channel:chan-1",
      threadId: "root-456",
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
          pumble: {
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
          pumble: {
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
        pumble: {
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

    expect(hookMocks.autoBindSpawnedPumbleSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("defaults thread-bound subagent spawn to disabled when unset", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          pumble: {
            threadBindings: {},
          },
        },
      },
    });
  });

  it("no-ops when thread binding is requested on non-pumble channel", async () => {
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

    expect(hookMocks.autoBindSpawnedPumbleSubagent).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("returns error when thread bind fails", async () => {
    hookMocks.autoBindSpawnedPumbleSubagent.mockResolvedValueOnce(null);
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

    expect(hookMocks.unbindPumbleThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(hookMocks.unbindPumbleThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      reason: "subagent-complete",
      sendFarewell: false,
    });
  });

  it("resolves delivery target from matching bound thread", () => {
    hookMocks.listPumbleThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadRootId: "root-777", channelId: "chan-1" },
    ]);
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_delivery_target");

    const result = handler(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "pumble",
          accountId: "work",
          to: "channel:chan-1",
          threadId: "root-777",
        },
        childRunId: "run-1",
        spawnMode: "session",
        expectsCompletionMessage: true,
      },
      {},
    );

    expect(hookMocks.listPumbleThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
    });
    expect(result).toEqual({
      origin: {
        channel: "pumble",
        accountId: "work",
        to: "channel:chan-1",
        threadId: "root-777",
      },
    });
  });

  it("keeps original routing when delivery target is ambiguous", () => {
    hookMocks.listPumbleThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadRootId: "root-777", channelId: "chan-1" },
      { accountId: "work", threadRootId: "root-888", channelId: "chan-2" },
    ]);
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_delivery_target");

    const result = handler(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "pumble",
          accountId: "work",
          to: "channel:chan-1",
        },
        childRunId: "run-1",
        spawnMode: "session",
        expectsCompletionMessage: true,
      },
      {},
    );

    expect(result).toBeUndefined();
  });

  it("no-ops delivery target when expectsCompletionMessage is false", () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_delivery_target");

    const result = handler(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: {
          channel: "pumble",
          accountId: "work",
          to: "channel:chan-1",
        },
        expectsCompletionMessage: false,
      },
      {},
    );

    expect(hookMocks.listPumbleThreadBindingsBySessionKey).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("no-ops delivery target for non-pumble channel", () => {
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
        expectsCompletionMessage: true,
      },
      {},
    );

    expect(hookMocks.listPumbleThreadBindingsBySessionKey).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
