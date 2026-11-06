import assert from "node:assert/strict";
import {
  IncognitoSessionEndedError,
  rethrowIncognitoSessionError,
} from "openclaw/plugin-sdk/acp-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, it, vi } from "vitest";
import { getDiscordRuntime } from "../runtime.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  bindTestThread,
  createTestThreadBindingManager,
  hoisted,
  installThreadBindingLifecycleTestHooks,
  useRealAcpSessionEntryRead,
} from "./thread-bindings.lifecycle.test-support.js";
import { resetThreadBindingsForTests } from "./thread-bindings.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const { autoBindSpawnedDiscordSubagent, reconcileAcpThreadBindingsOnStartup } =
  await import("./thread-bindings.lifecycle.js");
const service = getSessionBindingService();
const conversation = { channel: "discord", accountId: "default", conversationId: "user:123" };
const childSessionKey = "agent:main:subagent:child";
type Manager = Awaited<ReturnType<typeof createTestThreadBindingManager>>;

function expectThreadCreate(channelId: string, context: Record<string, unknown>) {
  expect(hoisted.createThreadDiscord).toHaveBeenCalledOnce();
  const [channel, options, actualContext] = hoisted.createThreadDiscord.mock.calls[0]!;
  expect(channel).toBe(channelId);
  expect(options).toMatchObject({ name: expect.any(String) });
  expect(options).not.toHaveProperty("autoArchiveMinutes");
  expect(actualContext).toMatchObject(context);
}

const reconcileOptions = { cfg: EMPTY_DISCORD_TEST_CONFIG, accountId: "default" };
const reconcile = (
  options: Partial<Parameters<typeof reconcileAcpThreadBindingsOnStartup>[0]> = {},
) => reconcileAcpThreadBindingsOnStartup({ ...reconcileOptions, ...options });
const sessionKey = (name: string) => `agent:codex:acp:${name}`;
const session = (key: string) => ({
  sessionKey: key,
  storeSessionKey: key,
  acp: { state: "running" },
});

async function bindAcp(manager: Manager, name: string) {
  return bindTestThread(manager, {
    threadId: name,
    targetKind: "acp",
    targetSessionKey: sessionKey(name),
    agentId: "codex",
  });
}
const expectTarget = (manager: Manager, thread: string, target: string | undefined) =>
  expect(manager.getByThreadId(thread)?.targetSessionKey).toBe(target);

installThreadBindingLifecycleTestHooks();

it("reuses a restored channel webhook after unbinding without sharing it across accounts", async () => {
  let manager = await createTestThreadBindingManager({ persist: true });
  let other: Manager | undefined;
  try {
    await bindTestThread(manager);
    await resetThreadBindingsForTests();
    manager = await createTestThreadBindingManager({ persist: true });
    await manager.unbindThread({ threadId: "thread-1", sendFarewell: false });
    const withoutWebhook = { webhookId: undefined, webhookToken: undefined };
    await expect(
      bindTestThread(manager, { threadId: "thread-2", ...withoutWebhook }),
    ).resolves.toMatchObject({ webhookId: "wh-1", webhookToken: "tok-1" });
    expect(hoisted.restPost).not.toHaveBeenCalled();

    other = await createTestThreadBindingManager({ accountId: "other", persist: true });
    await expect(bindTestThread(other, withoutWebhook)).resolves.toMatchObject({
      webhookId: "wh-created",
      webhookToken: "tok-created",
    });
    expect(hoisted.restPost).toHaveBeenCalledOnce();
  } finally {
    await other?.unbindBySessionKey({ targetSessionKey: childSessionKey, sendFarewell: false });
    await manager.unbindBySessionKey({ targetSessionKey: childSessionKey, sendFarewell: false });
  }
});

it.each([false, true])(
  "creates a child using the parent channel (REST lookup=%s)",
  async (lookup) => {
    const cfg = lookup
      ? { channels: { discord: { token: "config-token" } } }
      : EMPTY_DISCORD_TEST_CONFIG;
    const accountId = lookup ? "runtime" : "default";
    const token = lookup ? "runtime-token" : undefined;
    const parentId = lookup ? "parent-runtime" : "parent-1";
    const manager = await createTestThreadBindingManager({ accountId, token, cfg });
    if (lookup) {
      hoisted.restGet.mockResolvedValueOnce({ id: "thread-1", type: 11, parent_id: parentId });
    } else {
      await bindTestThread(manager, { targetSessionKey: "agent:main:subagent:parent" });
    }
    const binding = await autoBindSpawnedDiscordSubagent({
      cfg,
      accountId,
      channel: "discord",
      to: "channel:thread-1",
      threadId: lookup ? undefined : "thread-1",
      childSessionKey,
      agentId: "main",
    });
    expect(binding).toMatchObject({
      threadId: "thread-created",
      channelId: parentId,
      targetSessionKey: childSessionKey,
    });
    expectThreadCreate(parentId, { accountId, token });
    if (lookup) {
      expect(hoisted.restGet).toHaveBeenCalledOnce();
      expect(hoisted.createDiscordRestClient.mock.calls[0]).toEqual([{ accountId, token }, cfg]);
    } else {
      expectTarget(manager, "thread-1", "agent:main:subagent:parent");
      expect(manager.getByThreadId("thread-created")).toEqual(binding);
    }
  },
);

it("keeps approved opaque plugin ownership through refresh and persistent reload", async () => {
  const { createInteractiveConversationBindingHelpers } =
    await import("openclaw/plugin-sdk/plugin-runtime");
  const { resolvePluginConversationBindingApproval } =
    await import("openclaw/plugin-sdk/conversation-runtime");
  useRealAcpSessionEntryRead();
  const cfg = { agents: { entries: { alpha: {}, beta: {} } } };
  let manager = await createTestThreadBindingManager({ cfg, persist: true });
  const owner = { pluginId: "fixture-runtime", pluginRoot: "/plugins/fixture-runtime" };
  const helpers = createInteractiveConversationBindingHelpers({
    registration: owner,
    senderId: "user-1",
    conversation,
  });
  const requested = await helpers.requestConversationBinding();
  expect(requested.status).toBe("pending");
  if (requested.status !== "pending") {
    throw new Error("Expected plugin binding approval");
  }
  await expect(
    resolvePluginConversationBindingApproval({
      approvalId: requested.approvalId,
      decision: "allow-once",
      senderId: "user-1",
    }),
  ).resolves.toMatchObject({ status: "approved", binding: owner });
  expect(manager.getByThreadId(conversation.conversationId)).toMatchObject({
    targetKind: "session",
    targetSessionKey: expect.stringMatching(/^plugin-binding:fixture-runtime:/),
  });
  const record = await service.resolveByConversationAsync(conversation);
  expect(record?.metadata?.agentId).toBeUndefined();
  if (!record) {
    throw new Error("Expected approved plugin binding");
  }
  await expect(
    service.bind({
      conversation,
      targetSessionKey: record.targetSessionKey,
      targetKind: "session",
      metadata: { label: "updated" },
    }),
  ).resolves.toMatchObject({
    metadata: { pluginBindingOwner: "plugin", ...owner, label: "updated" },
  });
  await expect(
    service.bind({
      conversation,
      targetSessionKey: "plugin-binding:fixture-runtime:replacement",
      targetKind: "session",
      metadata: { label: "replacement" },
    }),
  ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
  await expect(helpers.requestConversationBinding()).resolves.toMatchObject({
    status: "bound",
    binding: owner,
  });
  await resetThreadBindingsForTests();
  manager = await createTestThreadBindingManager({ cfg, persist: true });
  expect(manager.getByThreadId(conversation.conversationId)?.agentId).toBeUndefined();
  await expect(helpers.getCurrentConversationBinding()).resolves.toMatchObject(owner);
  await expect(helpers.detachConversationBinding()).resolves.toEqual({ removed: true });
  expect(manager.listBindings()).toEqual([]);
  const subagentKey = "agent:alpha:subagent:kind-change";
  await service.bind({
    conversation,
    targetSessionKey: subagentKey,
    targetKind: "session",
    metadata: { pluginBindingOwner: "plugin", ...owner },
  });
  const changedKind = await service.bind({
    conversation,
    targetSessionKey: subagentKey,
    targetKind: "subagent",
    metadata: { label: "new kind" },
  });
  expect(changedKind.targetKind).toBe("subagent");
  expect(changedKind.metadata?.pluginBindingOwner).toBeUndefined();
  await expect(helpers.getCurrentConversationBinding()).resolves.toBeNull();
  await service.unbind({
    bindingId: changedKind.bindingId,
    scope: conversation,
    reason: "manual",
  });
  await manager.stop();
});

it.each([
  ["agent:main:fork:ordinary", "session"],
  ["agent:main:discord:channel:acp:ordinary", "session"],
  ["agent:codex:acp:binding:discord:default:configured", "acp"],
  ["global", "acp"],
  ["agent:main:subagent:child", "subagent"],
] as const)(
  "preserves classified %s through child creation, reload, and ACP cleanup",
  async (targetSessionKey, targetKind) => {
    let manager = await createTestThreadBindingManager({ persist: true });
    hoisted.resolveThreadBindingTargetKind.mockResolvedValueOnce(targetKind);
    const binding = await service.bind({
      targetSessionKey,
      targetKind: targetKind === "subagent" ? "subagent" : "session",
      conversation: { channel: "discord", accountId: "default", conversationId: "parent-1" },
      placement: "child",
    });
    try {
      expect(hoisted.resolveThreadBindingTargetKind).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: EMPTY_DISCORD_TEST_CONFIG,
          targetSessionKey,
          targetKind: targetKind === "subagent" ? "subagent" : "session",
          metadata: {},
          agentId: undefined,
          channel: "Discord",
          assertCurrent: expect.any(Function),
        }),
      );
      expect(binding.conversation.conversationId).toBe("thread-created");
      expect(manager.getByThreadId("thread-created")?.targetKind).toBe(targetKind);
      await resetThreadBindingsForTests();
      manager = await createTestThreadBindingManager({ persist: true });
      expect(manager.getByThreadId("thread-created")?.targetKind).toBe(targetKind);
      expect(await reconcile()).toMatchObject({
        checked: targetKind === "acp" ? 1 : 0,
        removed: targetKind === "acp" ? 1 : 0,
      });
      const resolved = await service.resolveByConversationAsync(binding.conversation);
      if (targetKind === "acp") {
        expect(resolved).toBeNull();
      } else {
        expect(resolved).toMatchObject({ targetSessionKey });
      }
    } finally {
      await manager.unbindBySessionKey({ targetSessionKey, sendFarewell: false });
    }
  },
);

it("refreshes legacy ACP-coerced ordinary bindings without dropping target metadata", async () => {
  const manager = await createTestThreadBindingManager();
  const targetSessionKey = "agent:main:fork:legacy";
  await bindTestThread(manager, {
    threadId: "user:123",
    channelId: "user:123",
    targetSessionKey,
    targetKind: "acp",
    label: "retained",
    metadata: { opaque: "retained" },
  });
  await service.bind({
    targetSessionKey,
    targetKind: "session",
    conversation,
    placement: "current",
  });
  expect(manager.getByThreadId("user:123")).toMatchObject({
    targetKind: "session",
    label: "retained",
    metadata: { opaque: "retained" },
  });
});

it("forwards classification facts/current authority and refuses native creation on failure", async () => {
  await createTestThreadBindingManager();
  const assertCurrent = vi.fn();
  let forwardedAuthorityCalls = 0;
  const metadata = { agentId: "main", label: "classify this target" };
  hoisted.resolveThreadBindingTargetKind.mockImplementationOnce(async (input) => {
    const calls = assertCurrent.mock.calls.length;
    input.assertCurrent();
    forwardedAuthorityCalls = assertCurrent.mock.calls.length - calls;
    throw new Error("Classification refused");
  });
  await expect(
    service.bind({
      targetSessionKey: "global",
      targetKind: "session",
      conversation: { ...conversation, conversationId: "parent-1" },
      placement: "child",
      metadata,
      assertCurrent,
    }),
  ).rejects.toThrow("Classification refused");
  expect(hoisted.resolveThreadBindingTargetKind).toHaveBeenCalledOnce();
  expect(hoisted.resolveThreadBindingTargetKind).toHaveBeenCalledWith(
    expect.objectContaining({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      targetSessionKey: "global",
      targetKind: "session",
      metadata,
      agentId: "main",
      channel: "Discord",
    }),
  );
  expect(forwardedAuthorityCalls).toBe(1);
  expect(hoisted.createThreadDiscord).not.toHaveBeenCalled();
});

it("keeps current config and refreshed tokens after a retired manager stops again", async () => {
  const startupCfg = { channels: { discord: { token: "startup-token" } } };
  const cfg = { channels: { discord: { token: "refreshed-token" } } };
  const options = { accountId: "runtime", token: "token-old", cfg: startupCfg };
  const retired = await createTestThreadBindingManager(options);
  await retired.stop();
  await createTestThreadBindingManager(options);
  const manager = await createTestThreadBindingManager({ ...options, token: "token-new" });
  await retired.stop();
  setRuntimeConfigSnapshot(cfg);
  const binding = await bindTestThread(manager, {
    threadId: undefined,
    createThread: true,
    webhookId: undefined,
    webhookToken: undefined,
  });
  expect(binding).toMatchObject({ threadId: "thread-created" });
  expectThreadCreate("parent-1", { accountId: "runtime", token: "token-new", cfg });
  expect(hoisted.createDiscordRestClient.mock.calls).toEqual([
    [{ accountId: "runtime", token: "token-new" }, cfg],
  ]);
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
    expect([hoisted.restGet.mock.calls, hoisted.restPost.mock.calls]).toEqual([[], []]);
  },
);

it("isolates overlapping thread ids across accounts", async () => {
  const a = await createTestThreadBindingManager({ accountId: "a" });
  const b = await createTestThreadBindingManager({ accountId: "b" });
  const accounts = [
    [a, "a"],
    [b, "b"],
  ] as const;
  for (const [manager, accountId] of accounts) {
    const targetSessionKey = `agent:main:subagent:${accountId}`;
    expect(await bindTestThread(manager, { targetSessionKey })).toMatchObject({ accountId });
  }
  expectTarget(a, "thread-1", "agent:main:subagent:a");
  expectTarget(b, "thread-1", "agent:main:subagent:b");
  expect(
    await a.unbindBySessionKey({
      targetSessionKey: "agent:main:subagent:a",
      sendFarewell: false,
    }),
  ).toHaveLength(1);
  expect(a.getByThreadId("thread-1")).toBeUndefined();
  expectTarget(b, "thread-1", "agent:main:subagent:b");
});

it("removes missing ACP sessions while preserving valid and plugin-owned bindings", async () => {
  const manager = await createTestThreadBindingManager();
  await bindAcp(manager, "healthy");
  await bindAcp(manager, "stale");
  await bindTestThread(manager);
  await bindTestThread(manager, {
    threadId: "user:123",
    channelId: "user:123",
    targetKind: "acp",
    targetSessionKey: "plugin-binding:owner:dm",
    metadata: { pluginBindingOwner: "plugin", pluginId: "owner" },
  });
  hoisted.readAcpSessionEntryAsync.mockImplementation(
    async ({ sessionKey: key }: { sessionKey: string }) => {
      const entry = session(key);
      return key === sessionKey("healthy")
        ? { ...entry, acp: { ...entry.acp, state: "error" } }
        : { ...entry, acp: undefined };
    },
  );
  expect(await reconcile()).toEqual({
    checked: 2,
    removed: 1,
    staleSessionKeys: [sessionKey("stale")],
  });
  expect(manager.getByThreadId("stale")).toBeUndefined();
  expect(manager.getByThreadId("healthy")).toMatchObject({
    targetKind: "acp",
    targetSessionKey: sessionKey("healthy"),
  });
  expect(manager.getByThreadId("thread-1")).toMatchObject({
    targetKind: "subagent",
    targetSessionKey: childSessionKey,
  });
  expect(manager.getByThreadId("user:123")).toMatchObject({
    metadata: { pluginBindingOwner: "plugin", pluginId: "owner" },
  });
  expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
  expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
});

it.each(["unreadable store", "refused read", "stale verdict", "refused probe"])(
  "reconciles ACP bindings with %s",
  async (outcome) => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "target");
    const entry = session(sessionKey("target"));
    const error =
      outcome === "refused probe"
        ? new AggregateError([new IncognitoSessionEndedError()], "ACP probe failed")
        : new IncognitoSessionEndedError();
    hoisted.readAcpSessionEntryAsync.mockResolvedValue(
      outcome === "unreadable store" ? { ...entry, acp: undefined, storeReadFailed: true } : entry,
    );
    if (outcome === "refused read") {
      hoisted.readAcpSessionEntryAsync.mockRejectedValue(error);
    }
    const pending = reconcile({
      healthProbe: async () => {
        if (outcome === "refused probe") {
          throw error;
        }
        return { status: "stale", reason: "status-timeout-running-stale" };
      },
    });
    if (outcome.startsWith("refused")) {
      await expect(pending).rejects.toBe(error);
    } else {
      const stale = outcome === "stale verdict";
      await expect(pending).resolves.toEqual({
        checked: 1,
        removed: stale ? 1 : 0,
        staleSessionKeys: stale ? [sessionKey("target")] : [],
      });
    }
    if (outcome === "stale verdict") {
      expect(manager.getByThreadId("target")).toBeUndefined();
    } else {
      expectTarget(manager, "target", sessionKey("target"));
    }
  },
);

it.each(["before-delete", "after-commit"] as const)(
  "propagates prepared cleanup refusal at %s while preserving acknowledged deletion",
  async (phase) => {
    const manager = await createTestThreadBindingManager({ persist: true });
    await bindAcp(manager, "prepared");
    const runtime = getDiscordRuntime();
    const open = runtime.state.openKeyedStoreV2.bind(runtime.state);
    const persisted = open<ThreadBindingRecord>({
      namespace: "thread-bindings",
      maxEntries: 10_000,
    });
    const orphanKey = "zz-orphan";
    if (phase === "after-commit") {
      const binding = (await persisted.entries()).find(
        ({ value }) => value.threadId === "prepared",
      )?.value;
      assert(binding);
      await persisted.register(orphanKey, {
        ...binding,
        threadId: "orphan",
        targetSessionKey: sessionKey("orphan"),
      });
    }
    const error = new IncognitoSessionEndedError();
    let current = true;
    const opened = vi
      .spyOn(runtime.state, "openKeyedStoreV2")
      .mockImplementation(<T>(options: Parameters<typeof open>[0]) => {
        const store = open<T>(options);
        const remove = store.delete.bind(store);
        vi.spyOn(store, "delete").mockImplementation(async (...args) => {
          if (phase === "before-delete") {
            current = false;
          } else if (args[0] === orphanKey) {
            current = false;
            throw new Error("Orphan cleanup failed after target deletion");
          }
          return remove(...args);
        });
        return store;
      });
    const release = vi.fn();
    try {
      const failure = await reconcile({
        prepareSession: async ({ sessionKey: key }) => ({
          session: {
            cfg: EMPTY_DISCORD_TEST_CONFIG,
            storePath: "/fixture",
            ...session(key),
            acp: undefined,
          },
          assertCurrent() {
            if (!current) {
              throw error;
            }
          },
          release,
        }),
      }).catch((caught: unknown) => caught);
      expect(() => rethrowIncognitoSessionError(failure)).toThrow();
      const stored = (await persisted.entries()).map(({ value }) => value.targetSessionKey);
      if (phase === "before-delete") {
        expectTarget(manager, "prepared", sessionKey("prepared"));
        expect(stored).toContain(sessionKey("prepared"));
      } else {
        expect(manager.getByThreadId("prepared")).toBeUndefined();
        expect(stored).toEqual([sessionKey("orphan")]);
      }
      expect(release).toHaveBeenCalledOnce();
    } finally {
      opened.mockRestore();
      await manager.stop();
    }
  },
);
