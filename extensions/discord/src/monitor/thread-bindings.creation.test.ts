import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import {
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  createNonSweepingTestManager,
  createTestThreadBindingManager,
  expectFields,
  hoisted,
  installThreadBindingLifecycleTestHooks,
  mockCallArg,
  requireRecord,
} from "./thread-bindings.lifecycle.test-support.js";

const { autoBindSpawnedDiscordSubagent } = await import("./thread-bindings.lifecycle.js");

function expectThreadCreateOptionsWithoutArchiveOverride(value: unknown): void {
  const options = requireRecord(value, "thread options");
  expect(options.name).toBeTypeOf("string");
  expect(options).not.toHaveProperty("autoArchiveMinutes");
}

describe("thread binding creation", () => {
  installThreadBindingLifecycleTestHooks();

  it("reuses webhook credentials after unbind when rebinding in the same channel", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    const first = await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      agentId: "main",
    });
    expectFields(first, "first binding", {
      threadId: "thread-1",
      targetSessionKey: "agent:main:subagent:child-1",
    });
    expect(hoisted.restPost).toHaveBeenCalledTimes(1);

    await manager.unbindThread({
      threadId: "thread-1",
      sendFarewell: false,
    });

    const second = await manager.bindTarget({
      threadId: "thread-2",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-2",
      agentId: "main",
    });
    expectFields(second, "second binding", {
      webhookId: "wh-created",
      webhookToken: "tok-created",
    });
    expect(hoisted.restPost).toHaveBeenCalledTimes(1);
  });

  it("creates a new thread when spawning from an already bound thread", async () => {
    const manager = await createNonSweepingTestManager({
      accountId: "default",
    });

    await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:parent",
      agentId: "main",
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-2" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      channel: "discord",
      to: "channel:thread-1",
      threadId: "thread-1",
      childSessionKey: "agent:main:subagent:child-2",
      agentId: "main",
    });

    expectFields(childBinding, "child binding", {
      threadId: "thread-created-2",
      targetSessionKey: "agent:main:subagent:child-2",
    });
    expect(hoisted.createThreadDiscord).toHaveBeenCalledTimes(1);
    expect(mockCallArg(hoisted.createThreadDiscord, 0, 0, "createThreadDiscord")).toBe("parent-1");
    expectThreadCreateOptionsWithoutArchiveOverride(
      mockCallArg(hoisted.createThreadDiscord, 0, 1, "createThreadDiscord"),
    );
    expectFields(
      mockCallArg(hoisted.createThreadDiscord, 0, 2, "createThreadDiscord"),
      "thread context",
      {
        accountId: "default",
      },
    );
    expect(manager.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:parent");
    expect(manager.getByThreadId("thread-created-2")?.targetSessionKey).toBe(
      "agent:main:subagent:child-2",
    );
  });

  it("resolves parent channel when thread target is passed via to without threadId", async () => {
    await createNonSweepingTestManager({
      accountId: "default",
    });

    hoisted.restGet.mockClear();
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-lookup",
      type: 11,
      parent_id: "parent-1",
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-lookup" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      accountId: "default",
      channel: "discord",
      to: "channel:thread-lookup",
      childSessionKey: "agent:main:subagent:child-lookup",
      agentId: "main",
    });

    expectFields(childBinding, "child binding", { channelId: "parent-1" });
    expect(hoisted.restGet).toHaveBeenCalledTimes(1);
    expect(mockCallArg(hoisted.createThreadDiscord, 0, 0, "createThreadDiscord")).toBe("parent-1");
    expectThreadCreateOptionsWithoutArchiveOverride(
      mockCallArg(hoisted.createThreadDiscord, 0, 1, "createThreadDiscord"),
    );
    expectFields(
      mockCallArg(hoisted.createThreadDiscord, 0, 2, "createThreadDiscord"),
      "thread context",
      {
        accountId: "default",
      },
    );
  });

  it("passes manager token when resolving parent channels for auto-bind", async () => {
    const cfg = {
      channels: { discord: { token: "tok" } },
    } as OpenClawConfig;
    await createNonSweepingTestManager({
      accountId: "runtime",
      token: "runtime-token",
      cfg,
    });

    hoisted.createDiscordRestClient.mockClear();
    hoisted.restGet.mockClear();
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-runtime",
      type: 11,
      parent_id: "parent-runtime",
    });
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-runtime" });

    const childBinding = await autoBindSpawnedDiscordSubagent({
      cfg,
      accountId: "runtime",
      channel: "discord",
      to: "channel:thread-runtime",
      childSessionKey: "agent:main:subagent:child-runtime",
      agentId: "main",
    });

    expectFields(childBinding, "child binding", {
      threadId: "thread-created-runtime",
      targetSessionKey: "agent:main:subagent:child-runtime",
    });
    const firstClientArgs = mockCallArg(
      hoisted.createDiscordRestClient,
      0,
      0,
      "createDiscordRestClient",
    ) as { accountId?: string; token?: string } | undefined;
    expectFields(firstClientArgs, "first client args", {
      accountId: "runtime",
      token: "runtime-token",
    });
    const usedCfg = hoisted.createDiscordRestClient.mock.calls.some((call) => {
      if (call?.[1] === cfg) {
        return true;
      }
      const first = call?.[0];
      return (
        typeof first === "object" && first !== null && (first as { cfg?: unknown }).cfg === cfg
      );
    });
    expect(usedCfg).toBe(true);
  });

  it("uses the active runtime snapshot cfg for manager operations", async () => {
    const startupCfg = {
      channels: { discord: { token: "startup-token" } },
    } as OpenClawConfig;
    const refreshedCfg = {
      channels: { discord: { token: "refreshed-token" } },
    } as OpenClawConfig;
    const manager = await createNonSweepingTestManager({
      accountId: "runtime",
      token: "runtime-token",
      cfg: startupCfg,
    });

    setRuntimeConfigSnapshot(refreshedCfg);
    hoisted.createDiscordRestClient.mockClear();
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-runtime-cfg" });

    const bound = await manager.bindTarget({
      createThread: true,
      channelId: "parent-runtime",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:runtime-cfg",
      agentId: "main",
    });

    expectFields(bound, "bound thread", {
      threadId: "thread-created-runtime-cfg",
      targetSessionKey: "agent:main:subagent:runtime-cfg",
    });
    const usedRefreshedCfg = hoisted.createDiscordRestClient.mock.calls.some((call) => {
      if (call?.[1] === refreshedCfg) {
        return true;
      }
      const first = call?.[0];
      return (
        typeof first === "object" &&
        first !== null &&
        (first as { cfg?: unknown }).cfg === refreshedCfg
      );
    });
    expect(usedRefreshedCfg).toBe(true);
    const usedStartupCfg = hoisted.createDiscordRestClient.mock.calls.some((call) => {
      if (call?.[1] === startupCfg) {
        return true;
      }
      const first = call?.[0];
      return (
        typeof first === "object" &&
        first !== null &&
        (first as { cfg?: unknown }).cfg === startupCfg
      );
    });
    expect(usedStartupCfg).toBe(false);
  });

  it.each([false, true])("keeps refreshed tokens after stale cleanup=%s", async (lateStop) => {
    const initialOptions = {
      accountId: "runtime",
      token: "token-old",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    };
    const initial = await createTestThreadBindingManager(initialOptions);
    if (lateStop) {
      await initial.stop();
      await createTestThreadBindingManager(initialOptions);
    }
    const manager = await createTestThreadBindingManager({
      ...initialOptions,
      token: "token-new",
    });
    if (lateStop) {
      await initial.stop();
    }

    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-token-refresh" });
    hoisted.createDiscordRestClient.mockClear();

    const bound = await manager.bindTarget({
      createThread: true,
      channelId: "parent-runtime",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:token-refresh",
      agentId: "main",
    });

    expectFields(bound, "bound thread", {
      threadId: "thread-created-token-refresh",
      targetSessionKey: "agent:main:subagent:token-refresh",
    });
    expect(mockCallArg(hoisted.createThreadDiscord, 0, 0, "createThreadDiscord")).toBe(
      "parent-runtime",
    );
    expectThreadCreateOptionsWithoutArchiveOverride(
      mockCallArg(hoisted.createThreadDiscord, 0, 1, "createThreadDiscord"),
    );
    expectFields(
      mockCallArg(hoisted.createThreadDiscord, 0, 2, "createThreadDiscord"),
      "thread context",
      {
        accountId: "runtime",
        token: "token-new",
      },
    );
    const usedTokenNew = hoisted.createDiscordRestClient.mock.calls.some(
      (call) => (call?.[0] as { token?: string } | undefined)?.token === "token-new",
    );
    expect(usedTokenNew).toBe(true);
  });

  it("normalizes prefixed parentConversationId before creating child thread bindings", async () => {
    await createNonSweepingTestManager({
      accountId: "default",
    });

    hoisted.restGet.mockClear();
    hoisted.createThreadDiscord.mockClear();
    hoisted.createThreadDiscord.mockResolvedValueOnce({ id: "thread-created-parent-normalized" });

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:test-parent-normalized",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1491611525914558668",
        parentConversationId: "channel:1491611525914558667",
      },
      placement: "child",
      metadata: {
        agentId: "codex",
        label: "Codex ACP bind test",
        threadName: "Codex ACP bind test",
      },
    });

    const boundConversation = requireRecord(
      requireRecord(bound, "bound session").conversation,
      "bound conversation",
    );
    expectFields(boundConversation, "bound conversation", {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-created-parent-normalized",
    });
    expect(mockCallArg(hoisted.createThreadDiscord, 0, 0, "createThreadDiscord")).toBe(
      "1491611525914558667",
    );
    expectThreadCreateOptionsWithoutArchiveOverride(
      mockCallArg(hoisted.createThreadDiscord, 0, 1, "createThreadDiscord"),
    );
    expectFields(
      mockCallArg(hoisted.createThreadDiscord, 0, 2, "createThreadDiscord"),
      "thread context",
      {
        accountId: "default",
      },
    );
    expect(hoisted.restGet).not.toHaveBeenCalled();
  });

  it("preserves prefixed current channel conversation ids as binding keys", async () => {
    await createNonSweepingTestManager({
      accountId: "default",
      cfg: {
        agents: { list: [{ id: "main" }, { id: "codex" }] },
      },
    });

    hoisted.restGet.mockClear();
    hoisted.restPost.mockClear();

    const service = getSessionBindingService();
    const bound = await service.bind({
      targetSessionKey: "agent:codex:acp:current-channel",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1491611525914558667",
      },
      placement: "current",
    });

    const boundConversation = requireRecord(
      requireRecord(bound, "bound session").conversation,
      "bound conversation",
    );
    expectFields(boundConversation, "bound conversation", {
      channel: "discord",
      accountId: "default",
      conversationId: "channel:1491611525914558667",
    });
    expectFields(requireRecord(bound, "bound session").metadata, "bound metadata", {
      agentId: "codex",
    });
    expectFields(
      service.resolveByConversation({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1491611525914558667",
      }),
      "resolved binding",
      {
        targetSessionKey: "agent:codex:acp:current-channel",
      },
    );
    expect(
      service.resolveByConversation({
        channel: "discord",
        accountId: "default",
        conversationId: "1491611525914558667",
      }),
    ).toBeNull();
    expect(hoisted.restGet).not.toHaveBeenCalled();
    expect(hoisted.restPost).not.toHaveBeenCalled();
  });

  it("binds current Discord DMs as direct conversation bindings", async () => {
    await createNonSweepingTestManager({
      accountId: "default",
      cfg: {
        agents: { list: [{ id: "codex", default: true }] },
      },
    });

    hoisted.restGet.mockClear();
    hoisted.restPost.mockClear();

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:dm",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      placement: "current",
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    });

    const boundConversation = requireRecord(
      requireRecord(bound, "bound session").conversation,
      "bound conversation",
    );
    expectFields(boundConversation, "bound conversation", {
      channel: "discord",
      accountId: "default",
      conversationId: "user:1177378744822943744",
      parentConversationId: "user:1177378744822943744",
    });
    expectFields(requireRecord(bound, "bound session").metadata, "bound metadata", {
      agentId: "codex",
    });
    const resolved = requireRecord(
      getSessionBindingService().resolveByConversation({
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      }),
      "resolved binding",
    );
    expect(requireRecord(resolved.conversation, "resolved conversation").conversationId).toBe(
      "user:1177378744822943744",
    );
    expect(hoisted.restGet).not.toHaveBeenCalled();
    expect(hoisted.restPost).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "inherits runtime metadata only when refreshing the same target (replace=%s)",
    async (replace) => {
      await createNonSweepingTestManager({
        accountId: "default",
      });

      await getSessionBindingService().bind({
        targetSessionKey: "plugin-binding:owner-plugin:dm",
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "user:1177378744822943744",
        },
        placement: "current",
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "owner-plugin",
          pluginRoot: "/plugins/owner-plugin",
          agentId: "previous-agent",
          boundBy: "system",
        },
      });

      await getSessionBindingService().bind({
        targetSessionKey: replace ? "agent:main:acp:replacement" : "plugin-binding:owner-plugin:dm",
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "user:1177378744822943744",
        },
        placement: "current",
        metadata: {
          label: "updated",
        },
      });

      const resolved = requireRecord(
        getSessionBindingService().resolveByConversation({
          channel: "discord",
          accountId: "default",
          conversationId: "user:1177378744822943744",
        }),
        "resolved binding",
      );
      expectFields(requireRecord(resolved.metadata, "resolved metadata"), "resolved metadata", {
        pluginBindingOwner: replace ? undefined : "plugin",
        pluginId: replace ? undefined : "owner-plugin",
        pluginRoot: replace ? undefined : "/plugins/owner-plugin",
        agentId: replace ? "main" : "previous-agent",
        boundBy: "system",
        label: "updated",
      });
      expect(hoisted.restGet).not.toHaveBeenCalled();
      expect(hoisted.restPost).not.toHaveBeenCalled();
    },
  );

  it("keeps overlapping thread ids isolated per account", async () => {
    const a = await createNonSweepingTestManager({
      accountId: "a",
    });
    const b = await createNonSweepingTestManager({
      accountId: "b",
    });

    const aBinding = await a.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:a",
      agentId: "main",
    });
    const bBinding = await b.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:b",
      agentId: "main",
    });

    expect(aBinding?.accountId).toBe("a");
    expect(bBinding?.accountId).toBe("b");
    expect(a.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:a");
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");

    const removedA = await a.unbindBySessionKey({
      targetSessionKey: "agent:main:subagent:a",
      sendFarewell: false,
    });
    expect(removedA).toHaveLength(1);
    expect(a.getByThreadId("thread-1")).toBeUndefined();
    expect(b.getByThreadId("thread-1")?.targetSessionKey).toBe("agent:main:subagent:b");
  });
});
