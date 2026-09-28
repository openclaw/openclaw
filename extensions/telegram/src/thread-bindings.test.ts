// Telegram tests cover thread bindings plugin behavior.
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readAcpSessionEntryMock = vi.hoisted(() => vi.fn());
const createForumTopicMock = vi.hoisted(() =>
  vi.fn<typeof import("./send-forum-topics.js").createForumTopicTelegram>(),
);

vi.mock("./send-runtime.js", () => ({
  loadTelegramSendModule: async () => ({ createForumTopicTelegram: createForumTopicMock }),
}));

vi.mock("openclaw/plugin-sdk/acp-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
    "openclaw/plugin-sdk/acp-runtime",
  );
  readAcpSessionEntryMock.mockImplementation(actual.readAcpSessionEntry);
  return {
    ...actual,
    readAcpSessionEntry: readAcpSessionEntryMock,
  };
});

import type {
  TelegramThreadBindingManager,
  TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import {
  getTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey as setLegacyIdleTimeout,
  setTelegramThreadBindingIdleTimeoutBySessionKeyAsync as setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey as setLegacyMaxAge,
  setTelegramThreadBindingMaxAgeBySessionKeyAsync as setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";
import {
  TELEGRAM_THREAD_BINDINGS_TEST_CFG,
  useTelegramThreadBindingsFixture,
} from "./thread-bindings.test-support.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("telegram thread bindings", () => {
  const fixture = useTelegramThreadBindingsFixture();
  const {
    createManager: createTelegramThreadBindingManager,
    installStore: installThreadBindingStore,
    storedBindings,
  } = fixture;

  beforeEach(async () => {
    readAcpSessionEntryMock.mockReset();
    createForumTopicMock.mockReset();
    const acpRuntime = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
      "openclaw/plugin-sdk/acp-runtime",
    );
    readAcpSessionEntryMock.mockImplementation(acpRuntime.readAcpSessionEntry);
  });

  it("joins concurrent startup before exposing hydrated bindings", async () => {
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
    const second = createTelegramThreadBindingManager(params);
    expect(getTelegramThreadBindingManager(params.accountId)).toBeNull();
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(entriesSpy).toHaveBeenCalledOnce();
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

  it("rechecks command authority at worker admission without publishing a refused binding", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "authority",
      persist: true,
      enableSweeper: false,
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const register = fixture.store.register.bind(fixture.store);
    vi.spyOn(fixture.store, "register").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await register(...args);
    });
    let current = true;
    const binding = getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:refused",
      targetKind: "subagent",
      conversation: { channel: "telegram", accountId: manager.accountId, conversationId: "thread" },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Command revoked");
        }
      },
    });
    const rejected = expect(binding).rejects.toThrow("Command revoked");
    await entered.promise;
    current = false;
    release.resolve();
    await rejected;
    expect(manager.listBindings()).toEqual([]);
    expect(await storedBindings()).toEqual([]);
  });

  it("does not publish a memory binding after its command authority is revoked", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "memory-authority",
      persist: false,
      enableSweeper: false,
    });
    const service = getSessionBindingService();
    const conversation = {
      channel: "telegram",
      accountId: manager.accountId,
      conversationId: "thread",
    };
    const targetSessionKey = "agent:main:subagent:memory-authority";
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
    current = false;
    // Synchronous publication is valid; an unpublished binding must not appear after revocation.
    if (publishedBeforeRevocation) {
      await expect(binding).resolves.toMatchObject({ targetSessionKey });
      expect(service.resolveByConversation(conversation)).toMatchObject({ targetSessionKey });
    } else {
      await expect(binding).rejects.toThrow("Command revoked");
      expect(service.resolveByConversation(conversation)).toBeNull();
    }
    expect(await storedBindings()).toEqual([]);
  });

  it.each(["before-commit", "after-commit", "after-commit-readonly"] as const)(
    "preserves synchronous SDK touch ordering with a worker binding (%s)",
    async (phase) => {
      installThreadBindingStore(fixture.store, true);
      const manager = await createTelegramThreadBindingManager({
        accountId: "legacy",
        persist: true,
        enableSweeper: false,
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
      persist: true,
      enableSweeper: false,
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
      persist: true,
      enableSweeper: false,
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
      enableSweeper: false,
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
      enableSweeper: false,
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

  it("shares binding state across distinct module instances", async () => {
    const bindingsA = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-a",
    );
    const bindingsB = await importFreshModule<typeof import("./thread-bindings.js")>(
      import.meta.url,
      "./thread-bindings.js?scope=shared-b",
    );
    const managerA = await bindingsA.createTelegramThreadBindingManager({
      cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
      accountId: "shared-runtime",
      persist: false,
      enableSweeper: false,
    });

    try {
      const managerB = await bindingsB.createTelegramThreadBindingManager({
        cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });

      expect(managerB).toBe(managerA);

      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-shared",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "shared-runtime",
          conversationId: "-100200300:topic:44",
        },
        placement: "current",
      });

      expect(
        bindingsB
          .getTelegramThreadBindingManager("shared-runtime")
          ?.getByConversationId("-100200300:topic:44")?.targetSessionKey,
      ).toBe("agent:main:subagent:child-shared");
    } finally {
      await managerA.stop();
    }
  });

  it("does not persist lifecycle updates when manager persistence is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    await createTelegramThreadBindingManager({
      accountId: "no-persist",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-2",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "no-persist",
        conversationId: "-100200300:topic:88",
      },
    });

    await setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      idleTimeoutMs: 60 * 60 * 1000,
    });
    await setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      maxAgeMs: 2 * 60 * 60 * 1000,
    });

    expect(
      (await storedBindings()).filter((binding) => binding.accountId === "no-persist"),
    ).toStrictEqual([]);
  });

  it("persists unbinds before restart so removed bindings do not come back", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    const bound = await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:abc123",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
    });

    await getSessionBindingService().unbind({
      bindingId: bound.bindingId,
      reason: "test-detach",
    });

    await manager.stop();

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("8460800771")).toBeUndefined();
  });

  it("persists only the changed binding without scanning or rewriting its siblings", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "row-writes",
      persist: true,
      enableSweeper: false,
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
  });

  it("persists bindings with json-clean metadata", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "metadata",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:metadata-child",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "metadata",
        conversationId: "metadata-thread",
      },
      metadata: {
        retained: "yes",
        omitted: undefined,
      },
    });

    await manager.stop();

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "metadata",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("metadata-thread")?.metadata).toStrictEqual({
      retained: "yes",
    });
    expect(
      (await storedBindings()).find((binding) => binding.accountId === "metadata")?.metadata,
    ).toStrictEqual({
      retained: "yes",
    });
  });

  it.each([false, true])(
    "inherits runtime metadata only when refreshing the same target (replace=%s)",
    async (replace) => {
      const manager = await createTelegramThreadBindingManager({
        accountId: "replacement-owner",
        persist: true,
        enableSweeper: false,
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
        persist: true,
        enableSweeper: false,
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
      persist: true,
      enableSweeper: false,
    });

    expect(manager.listBindings()).toStrictEqual([]);
  });

  it("cleans up stale ACP bindings before restart routing can reuse them", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:acp:stale-1",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "cleanup-me",
      },
    });

    await manager.stop();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:stale-1",
      storeSessionKey: "agent:main:acp:stale-1",
      entry: undefined,
      acp: undefined,
      storeReadFailed: false,
    });

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("cleanup-me")).toBeUndefined();
    expect((await storedBindings()).map((binding) => binding.conversationId)).not.toContain(
      "cleanup-me",
    );
  });

  it("keeps plugin-owned bindings when ACP cleanup runs on startup", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:still-valid",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "plugin-binding-convo",
      },
    });

    await manager.stop();

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("plugin-binding-convo")?.targetSessionKey).toBe(
      "plugin-binding:openclaw-codex-app-server:still-valid",
    );
    expect(readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("keeps ACP bindings when the session store cannot be read during startup cleanup", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:acp:read-failed",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "keep-on-read-failure",
      },
    });

    await manager.stop();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:read-failed",
      storeSessionKey: "agent:main:acp:read-failed",
      entry: undefined,
      acp: undefined,
      storeReadFailed: true,
    });

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("keep-on-read-failure")?.targetSessionKey).toBe(
      "agent:main:acp:read-failed",
    );
  });

  it("reloads persisted lifecycle updates after manager restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    const manager = await createTelegramThreadBindingManager({
      accountId: "persist-reset",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-3",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "persist-reset",
        conversationId: "-100200300:topic:99",
      },
    });

    await setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "persist-reset",
      targetSessionKey: "agent:main:subagent:child-3",
      idleTimeoutMs: 90_000,
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    await setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "persist-reset",
      targetSessionKey: "agent:main:subagent:child-3",
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    await manager.stop();

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "persist-reset",
      persist: true,
      enableSweeper: false,
    });
    expect(reloaded.getByConversationId("-100200300:topic:99")).toMatchObject({
      idleTimeoutMs: 90_000,
      maxAgeMs: 6 * 60 * 60 * 1000,
      boundAt: Date.parse("2026-03-06T10:00:00.000Z"),
      lastActivityAt: Date.parse("2026-03-06T12:00:00.000Z"),
    });
    expect(
      (await storedBindings()).find((binding) => binding.accountId === "persist-reset")
        ?.idleTimeoutMs,
    ).toBe(90_000);
  });

  it("does not leak unhandled rejections when a persist write fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const manager = await createTelegramThreadBindingManager({
        accountId: "persist-failure",
        persist: true,
        enableSweeper: false,
      });

      await getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-persist-failure",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "persist-failure",
          conversationId: "-100200300:topic:100",
        },
      });

      installThreadBindingStore({
        ...fixture.store,
        register() {
          throw new Error("persist boom");
        },
      });
      await manager.touchConversation("-100200300:topic:100");

      await manager.stop();
      await flushMicrotasks();
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
