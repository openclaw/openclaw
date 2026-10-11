import assert from "node:assert/strict";
import {
  IncognitoSessionEndedError,
  rethrowIncognitoSessionError,
} from "openclaw/plugin-sdk/acp-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it, vi } from "vitest";
import { getDiscordRuntime } from "../runtime.js";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import {
  bindTestThread,
  createTestThreadBindingManager,
  hoisted,
  installThreadBindingLifecycleTestHooks,
} from "./thread-bindings.lifecycle.test-support.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const { autoBindSpawnedDiscordSubagent, reconcileAcpThreadBindingsOnStartup } =
  await import("./thread-bindings.lifecycle.js");
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

const reconcileOptions = { cfg: EMPTY_DISCORD_TEST_CONFIG, accountId: "default" };
const sessionKey = (name: string) => `agent:codex:acp:${name}`;
const session = (key: string) => ({
  sessionKey: key,
  storeSessionKey: key,
  acp: {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${key}`,
    mode: "persistent",
    state: "running",
    lastActivityAt: 100,
  },
});

async function bindAcp(
  manager: Awaited<ReturnType<typeof createTestThreadBindingManager>>,
  name: string,
) {
  return bindTestThread(manager, {
    threadId: name,
    targetKind: "acp",
    targetSessionKey: sessionKey(name),
    agentId: "codex",
  });
}

describe("thread binding creation and ACP startup reconciliation", () => {
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
    hoisted.readAcpSessionEntry.mockImplementation(
      ({ sessionKey: key }: { sessionKey: string }) => {
        const entry = session(key);
        return key === sessionKey("healthy")
          ? { ...entry, acp: { ...entry.acp, state: "error" } }
          : { ...entry, acp: undefined };
      },
    );
    expect(await reconcileAcpThreadBindingsOnStartup(reconcileOptions)).toEqual({
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
      targetSessionKey: "agent:main:subagent:child",
    });
    expect(manager.getByThreadId("user:123")).toMatchObject({
      metadata: { pluginBindingOwner: "plugin", pluginId: "owner" },
    });
    expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
    expect(hoisted.sendWebhookMessageDiscord).not.toHaveBeenCalled();
  });

  it("keeps bindings when their session store cannot be read", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "uncertain");
    hoisted.readAcpSessionEntry.mockReturnValue({
      ...session(sessionKey("uncertain")),
      acp: undefined,
      storeReadFailed: true,
    });
    expect(await reconcileAcpThreadBindingsOnStartup(reconcileOptions)).toEqual({
      checked: 1,
      removed: 0,
      staleSessionKeys: [],
    });
    expect(manager.getByThreadId("uncertain")?.targetSessionKey).toBe(sessionKey("uncertain"));
  });

  it("propagates a refused session join without deleting its binding", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "refused");
    const error = new IncognitoSessionEndedError();
    hoisted.readAcpSessionEntry.mockImplementation(() => {
      throw error;
    });

    await expect(reconcileAcpThreadBindingsOnStartup(reconcileOptions)).rejects.toBe(error);
    expect(manager.getByThreadId("refused")?.targetSessionKey).toBe(sessionKey("refused"));
  });

  it("removes a running binding after an explicit stale health verdict", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "running");
    hoisted.readAcpSessionEntry.mockReturnValue(session(sessionKey("running")));
    expect(
      await reconcileAcpThreadBindingsOnStartup({
        ...reconcileOptions,
        healthProbe: async () => ({ status: "stale", reason: "status-timeout-running-stale" }),
      }),
    ).toEqual({ checked: 1, removed: 1, staleSessionKeys: [sessionKey("running")] });
    expect(manager.getByThreadId("running")).toBeUndefined();
  });

  it("propagates a nested health-probe refusal and keeps the binding", async () => {
    const manager = await createTestThreadBindingManager();
    await bindAcp(manager, "probe-refused");
    hoisted.readAcpSessionEntry.mockReturnValue(session(sessionKey("probe-refused")));
    const error = new AggregateError([new IncognitoSessionEndedError()], "ACP probe failed");
    await expect(
      reconcileAcpThreadBindingsOnStartup({
        ...reconcileOptions,
        healthProbe: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(manager.getByThreadId("probe-refused")?.targetSessionKey).toBe(
      sessionKey("probe-refused"),
    );
  });

  it.each(["before-delete", "after-commit"] as const)(
    "propagates prepared cleanup refusal at %s while preserving acknowledged deletion",
    async (phase) => {
      const manager = await createTestThreadBindingManager({ persist: true });
      await bindAcp(manager, "prepared");
      const runtime = getDiscordRuntime();
      const open = runtime.state.openKeyedStore.bind(runtime.state);
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
        .spyOn(runtime.state, "openKeyedStore")
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
        const failure = await reconcileAcpThreadBindingsOnStartup({
          ...reconcileOptions,
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
        }).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(() => rethrowIncognitoSessionError(failure)).toThrow();
        const stored = (await persisted.entries()).map(({ value }) => value.targetSessionKey);
        if (phase === "before-delete") {
          expect(manager.getByThreadId("prepared")?.targetSessionKey).toBe(sessionKey("prepared"));
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
});
