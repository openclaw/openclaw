import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  bindTestThread,
  createTestThreadBindingManager,
  hoisted,
  installThreadBindingLifecycleTestHooks,
} from "./thread-bindings.lifecycle.test-support.js";

const { autoBindSpawnedDiscordSubagent } = await import("./thread-bindings.lifecycle.js");
const service = getSessionBindingService();
const conversation = { channel: "discord", accountId: "default", conversationId: "user:123" };

function expectThreadCreate(channelId: string, context: Record<string, unknown>) {
  expect(hoisted.createThreadDiscord).toHaveBeenCalledOnce();
  const [channel, options, actualContext] = hoisted.createThreadDiscord.mock.calls[0]!;
  expect(channel).toBe(channelId);
  expect(options).toMatchObject({ name: expect.any(String) });
  expect(options).not.toHaveProperty("autoArchiveMinutes");
  expect(actualContext).toMatchObject(context);
}

describe("thread binding creation", () => {
  installThreadBindingLifecycleTestHooks();

  it("creates a child of the parent channel without replacing the requesting thread", async () => {
    const manager = await createTestThreadBindingManager();
    await bindTestThread(manager, { targetSessionKey: "agent:main:subagent:parent" });
    const binding = await autoBindSpawnedDiscordSubagent({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      channel: "discord",
      to: "channel:thread-1",
      threadId: "thread-1",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
    });
    expect(binding).toMatchObject({
      threadId: "thread-created",
      targetSessionKey: "agent:main:subagent:child",
    });
    expectThreadCreate("parent-1", { accountId: "default" });
    expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:parent");
    expect(manager.getByThreadId("thread-created")).toEqual(binding);
  });

  it("resolves a to-only thread using the manager token and config", async () => {
    const cfg = { channels: { discord: { token: "config-token" } } };
    await createTestThreadBindingManager({ accountId: "runtime", token: "runtime-token", cfg });
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-runtime",
      type: 11,
      parent_id: "parent-runtime",
    });
    const binding = await autoBindSpawnedDiscordSubagent({
      cfg,
      accountId: "runtime",
      channel: "discord",
      to: "channel:thread-runtime",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
    });
    expect(binding).toMatchObject({
      threadId: "thread-created",
      channelId: "parent-runtime",
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(hoisted.restGet).toHaveBeenCalledOnce();
    expect(hoisted.createDiscordRestClient.mock.calls[0]).toEqual([
      { accountId: "runtime", token: "runtime-token" },
      cfg,
    ]);
    expectThreadCreate("parent-runtime", { accountId: "runtime", token: "runtime-token" });
  });

  it("uses the active runtime config snapshot", async () => {
    const startupCfg = { channels: { discord: { token: "startup-token" } } };
    const cfg = { channels: { discord: { token: "refreshed-token" } } };
    const manager = await createTestThreadBindingManager({ cfg: startupCfg });
    setRuntimeConfigSnapshot(cfg);
    const binding = await bindTestThread(manager, {
      threadId: undefined,
      createThread: true,
      webhookId: undefined,
      webhookToken: undefined,
    });
    expect(binding).toMatchObject({ threadId: "thread-created" });
    expectThreadCreate("parent-1", { cfg });
    expect(hoisted.createDiscordRestClient.mock.calls).toEqual([
      [{ accountId: "default", token: undefined }, cfg],
    ]);
  });

  it("keeps refreshed tokens after a retired manager stops again", async () => {
    const options = { accountId: "runtime", token: "token-old" };
    const retired = await createTestThreadBindingManager(options);
    await retired.stop();
    await createTestThreadBindingManager(options);
    const manager = await createTestThreadBindingManager({ ...options, token: "token-new" });
    await retired.stop();
    const binding = await bindTestThread(manager, {
      threadId: undefined,
      createThread: true,
      webhookId: undefined,
      webhookToken: undefined,
    });
    expect(binding).toMatchObject({ threadId: "thread-created" });
    expectThreadCreate("parent-1", { accountId: "runtime", token: "token-new" });
    expect(hoisted.createDiscordRestClient.mock.calls[0]?.[0]).toMatchObject({
      token: "token-new",
    });
  });

  it("normalizes a prefixed parent before creating a child", async () => {
    await createTestThreadBindingManager();
    const binding = await service.bind({
      targetSessionKey: "agent:codex:acp:child",
      targetKind: "session",
      conversation: {
        ...conversation,
        conversationId: "channel:1491611525914558668",
        parentConversationId: "channel:1491611525914558667",
      },
      placement: "child",
      metadata: { agentId: "codex", label: "ACP bind test", threadName: "ACP bind test" },
    });
    expect(binding).toMatchObject({
      conversation: { ...conversation, conversationId: "thread-created" },
    });
    expectThreadCreate("1491611525914558667", { accountId: "default" });
    expect(hoisted.restGet).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "inherits direct-binding metadata only for the same target (replace=%s)",
    async (replace) => {
      await createTestThreadBindingManager();
      const original = {
        targetSessionKey: "plugin-binding:owner-plugin:dm",
        targetKind: "session" as const,
        conversation,
        placement: "current" as const,
      };
      await service.bind({
        ...original,
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "owner-plugin",
          pluginRoot: "/plugins/owner-plugin",
          agentId: "previous-agent",
          boundBy: "system",
        },
      });
      await service.bind({
        ...original,
        targetSessionKey: replace ? "agent:main:acp:replacement" : original.targetSessionKey,
        metadata: { label: "updated" },
      });
      const resolved = service.resolveByConversation(conversation);
      expect(resolved).toMatchObject({
        conversation: { ...conversation, parentConversationId: conversation.conversationId },
        metadata: {
          agentId: replace ? "main" : "previous-agent",
          boundBy: "system",
          label: "updated",
        },
      });
      expect(resolved?.metadata?.pluginBindingOwner).toBe(replace ? undefined : "plugin");
      expect(resolved?.metadata?.pluginId).toBe(replace ? undefined : "owner-plugin");
      expect(resolved?.metadata?.pluginRoot).toBe(replace ? undefined : "/plugins/owner-plugin");
      expect(hoisted.restGet).not.toHaveBeenCalled();
      expect(hoisted.restPost).not.toHaveBeenCalled();
    },
  );

  it("isolates overlapping thread ids across accounts", async () => {
    const a = await createTestThreadBindingManager({ accountId: "a" });
    const b = await createTestThreadBindingManager({ accountId: "b" });
    expect(await bindTestThread(a, { targetSessionKey: "agent:main:subagent:a" })).toMatchObject({
      accountId: "a",
    });
    expect(await bindTestThread(b, { targetSessionKey: "agent:main:subagent:b" })).toMatchObject({
      accountId: "b",
    });
    expect(a.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:a");
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");
    expect(
      await a.unbindBySessionKey({
        targetSessionKey: "agent:main:subagent:a",
        sendFarewell: false,
      }),
    ).toHaveLength(1);
    expect(a.getByThreadId("thread-1")).toBeUndefined();
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");
  });
});
