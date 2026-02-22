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
    const handler = handlers.get("subagent_spawning");
    if (!handler) {
      throw new Error("expected subagent_spawning hook handler");
    }

    const result = await handler(
      {
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
      },
      {},
    );

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
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          threadBindings: {
            spawnSubagentSessions: false,
          },
        },
      },
    });
    const handler = handlers.get("subagent_spawning");
    if (!handler) {
      throw new Error("expected subagent_spawning hook handler");
    }

    const result = await handler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
        },
        threadRequested: true,
      },
      {},
    );

    expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toContain("spawnSubagentSessions=true");
  });

  it("returns error when global thread bindings are disabled", async () => {
    const handlers = registerHandlersForTest({
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
    });
    const handler = handlers.get("subagent_spawning");
    if (!handler) {
      throw new Error("expected subagent_spawning hook handler");
    }

    const result = await handler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
        },
        threadRequested: true,
      },
      {},
    );

    expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toContain("threadBindings.enabled=true");
  });

  it("allows account-level threadBindings.enabled to override global disable", async () => {
    const handlers = registerHandlersForTest({
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
    const handler = handlers.get("subagent_spawning");
    if (!handler) {
      throw new Error("expected subagent_spawning hook handler");
    }

    const result = await handler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
        },
        threadRequested: true,
      },
      {},
    );

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("defaults thread-bound subagent spawn to disabled when unset", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          threadBindings: {},
        },
      },
    });
    const handler = handlers.get("subagent_spawning");
    if (!handler) {
      throw new Error("expected subagent_spawning hook handler");
    }

    const result = await handler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
        },
        threadRequested: true,
      },
      {},
    );

    expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "error" });
  });

  it("no-ops when thread binding is requested on non-discord channel", async () => {
    const handlers = registerHandlersForTest();
    const handler = handlers.get("subagent_spawning");
    if (!handler) {
      throw new Error("expected subagent_spawning hook handler");
    }

    const result = await handler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        mode: "session",
        requester: {
          channel: "signal",
          to: "+123",
        },
        threadRequested: true,
      },
      {},
    );

    expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("returns error when thread bind fails", async () => {
    hookMocks.autoBindSpawnedDiscordSubagent.mockResolvedValueOnce(null);
    const handlers = registerHandlersForTest();
    const handler = handlers.get("subagent_spawning");
    if (!handler) {
      throw new Error("expected subagent_spawning hook handler");
    }

    const result = await handler(
      {
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        mode: "session",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:123",
        },
        threadRequested: true,
      },
      {},
    );

    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toMatch(/unable to create or bind/i);
  });

  it("unbinds thread routing on subagent_ended", () => {
    const handlers = registerHandlersForTest();
    const handler = handlers.get("subagent_ended");
    if (!handler) {
      throw new Error("expected subagent_ended hook handler");
    }

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
    const handler = handlers.get("subagent_delivery_target");
    if (!handler) {
      throw new Error("expected subagent_delivery_target hook handler");
    }

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
    const handler = handlers.get("subagent_delivery_target");
    if (!handler) {
      throw new Error("expected subagent_delivery_target hook handler");
    }

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
