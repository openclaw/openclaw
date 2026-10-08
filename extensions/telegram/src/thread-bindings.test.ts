import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramMessageThreadSpec } from "./bot/helpers.js";
import { telegramPlugin } from "./channel.js";
import {
  inspectTelegramConversationRoute,
  resolveTelegramConversationRoute,
  resolveTelegramTargetSession,
} from "./conversation-route.js";

const createForumTopicMock = vi.hoisted(() =>
  vi.fn<typeof import("./send-forum-topics.js").createForumTopicTelegram>(),
);

vi.mock("./send-runtime.js", () => ({
  loadTelegramSendModule: async () => ({ createForumTopicTelegram: createForumTopicMock }),
}));

import type {
  TelegramThreadBindingManager,
  TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import {
  TELEGRAM_THREAD_BINDINGS_TEST_CFG,
  useTelegramThreadBindingsFixture,
} from "./thread-bindings.test-support.js";

const {
  getTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey: setLegacyIdleTimeout,
  setTelegramThreadBindingIdleTimeoutBySessionKeyAsync:
    setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey: setLegacyMaxAge,
  setTelegramThreadBindingMaxAgeBySessionKeyAsync: setTelegramThreadBindingMaxAgeBySessionKey,
} = await import("./thread-bindings.js");

describe("telegram thread bindings", () => {
  const fixture = useTelegramThreadBindingsFixture();
  const { installStore: installThreadBindingStore, storedBindings } = fixture;
  const createTelegramThreadBindingManager = (
    options: Parameters<typeof fixture.createManager>[0],
  ) => fixture.createManager({ persist: true, enableSweeper: false, ...options });

  beforeEach(() => {
    createForumTopicMock.mockReset();
  });

  it("routes private-topic follow-ups and native commands to the exact bound ACP session", async () => {
    await createTelegramThreadBindingManager({ accountId: "default" });
    const cfg = {
      agents: {
        entries: { main: {}, claude: {} },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "*" } }],
    };
    const commandConversation = telegramPlugin.bindings?.resolveCommandConversation?.({
      accountId: "default",
      originatingTo: "telegram:1234",
      threadId: "42",
    });
    expect(commandConversation).toEqual({
      conversationId: "1234:topic:42",
      parentConversationId: "1234",
    });
    if (!commandConversation) {
      throw new Error("Expected a private-topic command conversation");
    }
    const targetSessionKey = "agent:claude:acp:private-topic";
    await getSessionBindingService().bind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        ...commandConversation,
      },
      targetSessionKey,
      targetKind: "session",
      placement: "current",
    });
    const params = {
      cfg,
      accountId: "default",
      chatId: 1234,
      senderId: 1234,
      isGroup: false,
      threadSpec: resolveTelegramMessageThreadSpec({
        message_id: 1,
        date: 1,
        chat: { id: 1234, type: "private", first_name: "Alice" },
        message_thread_id: 42,
      }),
    };
    const inbound = await resolveTelegramConversationRoute(params);
    const command = inspectTelegramConversationRoute(params);
    for (const resolved of [inbound, command]) {
      expect(resolved.bindingMode).toEqual({ kind: "runtime-bound", sessionKey: targetSessionKey });
      expect(resolved.route.agentId).toBe("claude");
      expect(
        resolveTelegramTargetSession({
          ...params,
          ...resolved,
          dmThreadId: 42,
          botHasTopicsEnabled: true,
        }),
      ).toBe(targetSessionKey);
    }
    for (const threadSpec of [
      { scope: "dm", id: 43 },
      { scope: "dm", id: undefined },
    ] as const) {
      const other = await resolveTelegramConversationRoute({ ...params, threadSpec });
      expect(other.bindingMode).toEqual({ kind: "none" });
      expect(other.route.agentId).toBe("main");
      expect(
        resolveTelegramTargetSession({
          ...params,
          ...other,
          dmThreadId: threadSpec.id,
          botHasTopicsEnabled: true,
        }),
      ).toBe(threadSpec.id ? "agent:main:main:thread:1234:43" : "agent:main:main");
    }
  });

  it("joins concurrent startup across module instances before exposing hydrated bindings", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const entries = fixture.store.entries.bind(fixture.store);
    const entriesSpy = vi.spyOn(fixture.store, "entries").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return await entries();
    });
    const params = { accountId: "coalesced", persist: true, enableSweeper: false };
    const first = createTelegramThreadBindingManager(params);
    await entered.promise;
    const other = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=concurrent-startup",
    );
    const second = other.createTelegramThreadBindingManager({
      cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
      ...params,
    });
    expect(getTelegramThreadBindingManager(params.accountId)).toBeNull();
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(entriesSpy).toHaveBeenCalledOnce();
    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-shared",
      targetKind: "subagent",
      conversation: { channel: "telegram", accountId: params.accountId, conversationId: "thread" },
      placement: "current",
    });
    expect(
      other.getTelegramThreadBindingManager(params.accountId)?.getByConversationId("thread")
        ?.targetSessionKey,
    ).toBe("agent:main:subagent:child-shared");
  });

  it("drains accepted mutations in order before restart and rejects retired writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const params = { accountId: "drain", persist: true, enableSweeper: false };
    const manager = await createTelegramThreadBindingManager(params);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const register = fixture.store.register.bind(fixture.store);
    vi.spyOn(fixture.store, "register").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await register(...args);
    });
    const binding = getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:drained",
      targetKind: "subagent",
      conversation: { channel: "telegram", accountId: params.accountId, conversationId: "thread" },
    });
    await entered.promise;
    expect(manager.getByConversationId("thread")).toBeUndefined();
    const metadata = { label: "requested", payload: { value: "submitted" }, values: ["original"] };
    const replacementBind = getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:replacement",
      targetKind: "subagent",
      conversation: { channel: "telegram", accountId: params.accountId, conversationId: "thread" },
      metadata,
    });
    metadata.label = "changed after admission";
    metadata.payload.value = "changed";
    metadata.values.push("changed");
    const requestedActivityAt = Date.now() + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(requestedActivityAt);
    const touch = manager.touchConversation("thread");
    clock.mockRestore();
    const removal = { conversationId: "thread", throwOnPersistError: true };
    const remove = manager.unbindConversation(removal);
    removal.conversationId = "changed-after-admission";
    let stopped = false;
    const stop = manager.stop().then(() => {
      stopped = true;
    });
    const restart = createTelegramThreadBindingManager(params);
    await expect(manager.touchConversation("thread")).rejects.toThrow("stopping");
    expect(stopped).toBe(false);
    release.resolve();
    await binding;
    await expect(replacementBind).resolves.toMatchObject({
      metadata: { label: "requested", payload: { value: "submitted" }, values: ["original"] },
    });
    await expect(touch).resolves.toMatchObject({ lastActivityAt: requestedActivityAt });
    await expect(remove).resolves.toMatchObject({ lastActivityAt: requestedActivityAt });
    await stop;
    const replacement = await restart;
    expect(replacement.listBindings()).toEqual([]);
    expect(await storedBindings()).toEqual([]);
    await manager.stop();
    expect(getTelegramThreadBindingManager(params.accountId)).toBe(replacement);
  });

  it.each([false, true])("does not publish a revoked binding (persist=%s)", async (persist) => {
    const manager = await createTelegramThreadBindingManager({ accountId: "authority", persist });
    const service = getSessionBindingService();
    const conversation = {
      channel: "telegram",
      accountId: manager.accountId,
      conversationId: "thread",
    };
    const targetSessionKey = "agent:main:subagent:refused";
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    if (persist) {
      const register = fixture.store.register.bind(fixture.store);
      vi.spyOn(fixture.store, "register").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await register(...args);
      });
    }
    let current = true;
    expect(service.resolveByConversation(conversation)).toBeNull();
    const binding = service.bind({
      targetSessionKey,
      targetKind: "subagent",
      conversation,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Command revoked");
        }
      },
    });
    const publishedBeforeRevocation = service.resolveByConversation(conversation);
    if (persist) {
      await entered.promise;
    }
    current = false;
    release.resolve();
    // Synchronous memory publication is valid; delayed publication must recheck authority.
    if (!persist && publishedBeforeRevocation) {
      await expect(binding).resolves.toMatchObject({ targetSessionKey });
      expect(service.resolveByConversation(conversation)).toMatchObject({ targetSessionKey });
    } else {
      await expect(binding).rejects.toThrow("Command revoked");
      expect(service.resolveByConversation(conversation)).toBeNull();
      expect(manager.listBindings()).toEqual([]);
    }
    expect(await storedBindings()).toEqual([]);
  });

  it.each(["before-commit", "after-commit", "after-commit-readonly"] as const)(
    "preserves synchronous SDK touch ordering with a worker binding (%s)",
    async (phase) => {
      installThreadBindingStore(fixture.store, true);
      const manager = await createTelegramThreadBindingManager({
        accountId: "legacy",
      });
      const service = getSessionBindingService();
      const conversation = {
        channel: "telegram",
        accountId: manager.accountId,
        conversationId: "thread",
      };
      const bound = await service.bind({
        targetSessionKey: "agent:main:subagent:original",
        targetKind: "subagent",
        conversation,
      });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const register = fixture.store.register.bind(fixture.store);
      vi.spyOn(fixture.store, "register").mockImplementationOnce(async (...args) => {
        if (phase !== "before-commit") {
          await register(...args);
        }
        entered.resolve();
        await release.promise;
        if (phase === "before-commit") {
          await register(...args);
        }
      });
      const pending = service.bind({
        targetSessionKey: "agent:main:subagent:replacement",
        targetKind: "subagent",
        conversation,
      });
      const settled =
        phase === "before-commit"
          ? expect(pending).rejects.toThrow("changed before persistence")
          : expect(pending).resolves.toMatchObject({
              targetSessionKey: "agent:main:subagent:replacement",
            });
      await entered.promise;
      const readOnly = phase === "after-commit-readonly";
      const native = readOnly ? openOpenClawStateDatabase().db : undefined;
      try {
        native?.exec("PRAGMA query_only = ON");
        service.touch(bound.bindingId, 42, conversation);
      } finally {
        native?.exec("PRAGMA query_only = OFF");
      }
      const targetAfterTouch =
        phase === "after-commit"
          ? "agent:main:subagent:replacement"
          : "agent:main:subagent:original";
      expect(manager.getByConversationId("thread")).toMatchObject({
        targetSessionKey: targetAfterTouch,
        ...(!readOnly ? { lastActivityAt: 42 } : {}),
      });
      release.resolve();
      await settled;
      const targetSessionKey =
        phase === "before-commit"
          ? "agent:main:subagent:original"
          : "agent:main:subagent:replacement";
      expect(manager.getByConversationId("thread")).toMatchObject({
        targetSessionKey,
        ...(!readOnly ? { lastActivityAt: 42 } : {}),
      });
      expect(await storedBindings()).toMatchObject([{ targetSessionKey }]);
      await service.touchAsync(bound.bindingId, 43, conversation);
      expect(await storedBindings()).toMatchObject([{ targetSessionKey, lastActivityAt: 43 }]);
    },
  );

  it("preserves a newer synchronous touch while a default async touch is queued", async () => {
    installThreadBindingStore(fixture.store, true);
    const manager = await createTelegramThreadBindingManager({
      accountId: "queued-activity",
    });
    const service = getSessionBindingService();
    const conversation = {
      channel: "telegram",
      accountId: manager.accountId,
      conversationId: "thread",
    };
    const bound = await service.bind({
      targetSessionKey: "agent:main:subagent:active",
      targetKind: "subagent",
      conversation,
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const register = fixture.store.register.bind(fixture.store);
    vi.spyOn(fixture.store, "register").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await register(...args);
    });
    const pending: Promise<unknown>[] = [];
    try {
      pending.push(
        service.bind({
          targetSessionKey: "agent:main:subagent:queue-blocker",
          targetKind: "subagent",
          conversation: { ...conversation, conversationId: "other-thread" },
        }),
      );
      await entered.promise;
      const capturedAt = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValueOnce(capturedAt);
      try {
        pending.push(service.touchAsync(bound.bindingId, undefined, conversation));
      } finally {
        clock.mockRestore();
      }
      const newerActivityAt = capturedAt + 1;
      service.touch(bound.bindingId, newerActivityAt, conversation);
      release.resolve();
      await Promise.all(pending);
      expect(manager.getByConversationId("thread")?.lastActivityAt).toBe(newerActivityAt);
      expect(
        (await storedBindings()).find((binding) => binding.conversationId === "thread")
          ?.lastActivityAt,
      ).toBe(newerActivityAt);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("keeps deprecated lifecycle setters immediately visible and durable", async () => {
    installThreadBindingStore(fixture.store, true);
    const manager = await createTelegramThreadBindingManager({
      accountId: "legacy-lifecycle",
    });
    const targetSessionKey = "agent:main:subagent:legacy-lifecycle";
    const bound = await getSessionBindingService().bind({
      targetSessionKey,
      targetKind: "subagent",
      conversation: { channel: "telegram", accountId: manager.accountId, conversationId: "thread" },
    });
    vi.spyOn(fixture.store, "register").mockRejectedValueOnce(new Error("temporary write failure"));
    await setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: manager.accountId,
      targetSessionKey,
      idleTimeoutMs: 321,
    });
    getSessionBindingService().touch(bound.bindingId, 42, bound.conversation);
    expect(await storedBindings()).toMatchObject([{ idleTimeoutMs: 321, lastActivityAt: 42 }]);
    expect(
      setLegacyIdleTimeout({ accountId: manager.accountId, targetSessionKey, idleTimeoutMs: 123 }),
    ).toMatchObject([{ idleTimeoutMs: 123 }]);
    expect(
      setLegacyMaxAge({ accountId: manager.accountId, targetSessionKey, maxAgeMs: 456 }),
    ).toMatchObject([{ idleTimeoutMs: 123, maxAgeMs: 456 }]);
    expect(manager.getByConversationId("thread")).toMatchObject({
      idleTimeoutMs: 123,
      maxAgeMs: 456,
    });
    expect(await storedBindings()).toMatchObject([{ idleTimeoutMs: 123, maxAgeMs: 456 }]);
  });

  it("rechecks later expiry candidates after a synchronous SDK touch", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    installThreadBindingStore(fixture.store, true);
    const manager = await createTelegramThreadBindingManager({
      accountId: "expiry",
      persist: true,
      idleTimeoutMs: 1,
      enableSweeper: true,
    });
    const service = getSessionBindingService();
    const bind = (conversationId: string) =>
      service.bind({
        targetSessionKey: "agent:main:subagent:expiry",
        targetKind: "subagent",
        conversation: { channel: "telegram", accountId: manager.accountId, conversationId },
      });
    await bind("first");
    const second = await bind("second");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const remove = fixture.store.delete.bind(fixture.store);
    vi.spyOn(fixture.store, "delete").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return await remove(...args);
    });
    vi.advanceTimersByTime(60_000);
    await entered.promise;
    const touchedAt = Date.now();
    service.touch(second.bindingId, touchedAt, second.conversation);
    release.resolve();
    await manager.stop();
    expect(await storedBindings()).toMatchObject([
      { conversationId: "second", lastActivityAt: touchedAt },
    ]);
  });

  it.each(["before-create", "after-create"] as const)(
    "settles forum-topic binding only after native create admission (%s revocation)",
    async (revokeAt) => {
      const manager = await createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      let ownerCurrent = true;
      let nativeCreates = 0;
      createForumTopicMock.mockImplementationOnce(async (_chatId, _name, options) => {
        if (revokeAt === "before-create") {
          ownerCurrent = false;
        }
        options.assertPlatformSendAuthorized?.();
        nativeCreates += 1;
        ownerCurrent = false;
        return { chatId: "-100200300", topicId: 88, name: "Bound topic" };
      });
      const result = getSessionBindingService().bind({
        targetSessionKey: "agent:main:created-topic",
        targetKind: "session",
        conversation: { channel: "telegram", accountId: "default", conversationId: "-100200300" },
        placement: "child",
        assertCurrent: () => {
          if (!ownerCurrent) {
            throw new Error("Command owner was revoked");
          }
        },
      });
      if (revokeAt === "before-create") {
        await expect(result).rejects.toThrow("failed to bind");
        expect(nativeCreates).toBe(0);
        expect(manager.getByConversationId("-100200300:topic:88")).toBeUndefined();
      } else {
        await expect(result).resolves.toMatchObject({
          targetSessionKey: "agent:main:created-topic",
        });
        expect(nativeCreates).toBe(1);
        expect(manager.getByConversationId("-100200300:topic:88")).toMatchObject({
          targetSessionKey: "agent:main:created-topic",
        });
      }
    },
  );

  it("drops stopped-manager bindings without clearing a replacement generation", async () => {
    const stopped = await createTelegramThreadBindingManager({
      accountId: "manager-lifecycle",
      persist: false,
    });
    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:stopped",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "manager-lifecycle",
        conversationId: "stopped-thread",
      },
    });

    await stopped.stop();

    const replacement = await createTelegramThreadBindingManager({
      accountId: "manager-lifecycle",
      persist: false,
    });
    expect(replacement.getByConversationId("stopped-thread")).toBeUndefined();

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:replacement",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "manager-lifecycle",
        conversationId: "replacement-thread",
      },
    });

    await stopped.stop();

    expect(getTelegramThreadBindingManager("manager-lifecycle")).toBe(replacement);
    expect(replacement.getByConversationId("replacement-thread")?.targetSessionKey).toBe(
      "agent:main:subagent:replacement",
    );
  });

  it("initializes queued mutations when source reload retains the old registry shape", async () => {
    const key = Symbol.for("openclaw.telegramThreadBindingsState");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const legacyState = {
      managersByAccountId: new Map<string, TelegramThreadBindingManager>(),
      bindingsByAccountConversation: new Map<string, TelegramThreadBindingRecord>(),
    };
    let manager: TelegramThreadBindingManager | undefined;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: legacyState,
    });
    vi.resetModules();
    try {
      const reloaded = await importFreshModule<typeof import("./thread-bindings.js")>(
        import.meta.url,
        "./thread-bindings.js?scope=legacy-registry-reload",
      );
      manager = await reloaded.createTelegramThreadBindingManager({
        cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
        accountId: "source-reload",
        persist: false,
        enableSweeper: false,
      });
      expect(Object.getOwnPropertyDescriptor(globalThis, key)?.value).toBe(legacyState);
      expect(legacyState.managersByAccountId.get("source-reload")).toBe(manager);
      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:reload",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "source-reload",
          conversationId: "thread",
        },
        placement: "current",
      });
      expect(legacyState.bindingsByAccountConversation.get("source-reload:thread")).toBe(
        manager.getByConversationId("thread"),
      );
      expect(manager.getByConversationId("thread")?.targetSessionKey).toBe(
        "agent:main:subagent:reload",
      );
    } finally {
      try {
        await manager?.stop();
      } finally {
        if (previous) {
          Object.defineProperty(globalThis, key, previous);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
        vi.resetModules();
      }
    }
  });

  it("persists only the changed binding without scanning or rewriting its siblings", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "row-writes",
    });
    const entries = vi.spyOn(fixture.store, "entries");
    const register = vi.spyOn(fixture.store, "register");
    const remove = vi.spyOn(fixture.store, "delete");

    const first = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:first-row",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "row-writes",
        conversationId: "first-thread",
      },
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(entries).not.toHaveBeenCalled();

    register.mockClear();
    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:second-row",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "row-writes",
        conversationId: "second-thread",
      },
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[1].conversationId).toBe("second-thread");
    expect(entries).not.toHaveBeenCalled();

    register.mockClear();
    await manager.touchConversation("first-thread");
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[1].conversationId).toBe("first-thread");
    expect(entries).not.toHaveBeenCalled();

    register.mockClear();
    await getSessionBindingService().unbind({
      bindingId: first.bindingId,
      reason: "test-row-delete",
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
    expect(manager.getByConversationId("second-thread")).toBeDefined();
    await manager.stop();
    const reloaded = await createTelegramThreadBindingManager({
      accountId: manager.accountId,
      persist: true,
      enableSweeper: false,
    });
    expect(reloaded.getByConversationId("first-thread")).toBeUndefined();
    expect(reloaded.getByConversationId("second-thread")).toBeDefined();
  });

  it.each([false, true])(
    "inherits runtime metadata only when refreshing the same target (replace=%s)",
    async (replace) => {
      const manager = await createTelegramThreadBindingManager({
        accountId: "replacement-owner",
      });
      const service = getSessionBindingService();
      const conversation = {
        channel: "telegram",
        accountId: manager.accountId,
        conversationId: "replacement-thread",
      };
      const originalTarget = "plugin-binding:owner-plugin:original";
      const metadata = {
        pluginBindingOwner: "plugin",
        pluginId: "owner-plugin",
        pluginRoot: "/plugins/owner-plugin",
        agentId: "previous-agent",
        boundBy: "previous-user",
        idleTimeoutMs: 90_000,
        opaque: { runtimeId: "original" },
      };
      await service.bind({
        targetSessionKey: originalTarget,
        targetKind: "session",
        conversation,
        metadata,
      });
      const targetSessionKey = replace ? "agent:main:subagent:replacement" : originalTarget;

      await service.bind({
        targetSessionKey,
        targetKind: replace ? "subagent" : "session",
        conversation,
        metadata: { label: "updated" },
      });
      await manager.stop();
      await createTelegramThreadBindingManager({
        accountId: manager.accountId,
      });

      const binding = service.resolveByConversation(conversation);
      expect(binding?.targetSessionKey).toBe(targetSessionKey);
      expect(binding?.metadata).toMatchObject({ label: "updated", idleTimeoutMs: 90_000 });
      for (const key of [
        "pluginBindingOwner",
        "pluginId",
        "pluginRoot",
        "agentId",
        "boundBy",
        "opaque",
      ] as const) {
        expect(binding?.metadata?.[key]).toEqual(replace ? undefined : metadata[key]);
      }
    },
  );

  it("starts with empty bindings when the plugin-state store cannot be read", async () => {
    installThreadBindingStore({
      ...fixture.store,
      entries() {
        throw new Error("state unavailable");
      },
    });

    const manager = await createTelegramThreadBindingManager({
      accountId: "read-failure",
    });

    expect(manager.listBindings()).toStrictEqual([]);
  });

  it.each([
    { persist: false, idleTimeoutMs: 60 * 60 * 1000, maxAgeMs: 2 * 60 * 60 * 1000 },
    { persist: true, idleTimeoutMs: 90_000, maxAgeMs: 6 * 60 * 60 * 1000 },
  ])(
    "keeps lifecycle updates and clean metadata across restart only with persist=$persist",
    async ({ persist, idleTimeoutMs, maxAgeMs }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
      const options = { accountId: "lifecycle", persist, enableSweeper: false };
      const manager = await createTelegramThreadBindingManager(options);
      const targetSessionKey = "agent:main:subagent:child";
      await getSessionBindingService().bind({
        targetSessionKey,
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: manager.accountId,
          conversationId: "thread",
        },
        metadata: { retained: "yes", omitted: undefined },
      });
      await setTelegramThreadBindingIdleTimeoutBySessionKey({
        accountId: manager.accountId,
        targetSessionKey,
        idleTimeoutMs,
      });
      vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
      await setTelegramThreadBindingMaxAgeBySessionKey({
        accountId: manager.accountId,
        targetSessionKey,
        maxAgeMs,
      });
      await manager.stop();
      const reloaded = await createTelegramThreadBindingManager(options);
      if (persist) {
        expect(reloaded.getByConversationId("thread")).toMatchObject({
          idleTimeoutMs,
          maxAgeMs,
          boundAt: Date.parse("2026-03-06T10:00:00.000Z"),
          lastActivityAt: Date.parse("2026-03-06T12:00:00.000Z"),
        });
        expect(reloaded.getByConversationId("thread")?.metadata).toStrictEqual({ retained: "yes" });
        const stored = (await storedBindings()).find(
          (binding) => binding.accountId === manager.accountId,
        );
        expect(stored?.idleTimeoutMs).toBe(90_000);
        expect(stored?.metadata).toStrictEqual({ retained: "yes" });
      } else {
        expect(reloaded.getByConversationId("thread")).toBeUndefined();
        expect(
          (await storedBindings()).filter((binding) => binding.accountId === manager.accountId),
        ).toStrictEqual([]);
      }
    },
  );
});
