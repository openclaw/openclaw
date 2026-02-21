import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDiscordSubagentHooks } from "./subagent-hooks.js";

const hookMocks = vi.hoisted(() => ({
  autoBindSpawnedDiscordSubagent: vi.fn(
    async (): Promise<{ threadId: string } | null> => ({ threadId: "thread-1" }),
  ),
  unbindThreadBindingsBySessionKey: vi.fn(() => []),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  autoBindSpawnedDiscordSubagent: hookMocks.autoBindSpawnedDiscordSubagent,
  unbindThreadBindingsBySessionKey: hookMocks.unbindThreadBindingsBySessionKey,
}));

function registerHandlersForTest() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    on: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(hookName, handler);
    },
  } as unknown as OpenClawPluginApi;
  registerDiscordSubagentHooks(api);
  return handlers;
}

describe("discord subagent hook handlers", () => {
  beforeEach(() => {
    hookMocks.autoBindSpawnedDiscordSubagent.mockClear();
    hookMocks.unbindThreadBindingsBySessionKey.mockClear();
  });

  it("registers subagent_spawning and subagent_ended hooks", () => {
    const handlers = registerHandlersForTest();
    expect(handlers.has("subagent_spawning")).toBe(true);
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

  it("returns channel support error when thread binding is requested on non-discord channel", async () => {
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
    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toMatch(/only discord/i);
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
});
