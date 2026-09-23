// Telegram tests cover thread bindings plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

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

import {
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
} from "./thread-bindings-store.js";
import {
  createTelegramThreadBindingManager as createTelegramThreadBindingManagerImpl,
  getTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";

type ThreadBindingStoreEntry = ReturnType<
  ReturnType<typeof createTelegramThreadBindingManagerImpl>["listBindings"]
>[number];

const TELEGRAM_THREAD_BINDINGS_TEST_CFG: OpenClawConfig = {
  channels: {
    telegram: {
      botToken: "test-token",
    },
  },
};

type TelegramThreadBindingManagerParams = Parameters<
  typeof createTelegramThreadBindingManagerImpl
>[0];
type TelegramThreadBindingManager = ReturnType<typeof createTelegramThreadBindingManagerImpl>;

const trackedManagers = new Set<TelegramThreadBindingManager>();

function createTelegramThreadBindingManager(
  params: Omit<TelegramThreadBindingManagerParams, "cfg">,
) {
  const manager = createTelegramThreadBindingManagerImpl({
    cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
    ...params,
  });
  trackedManagers.add(manager);
  return manager;
}

function stopTrackedManagers(): void {
  for (const manager of trackedManagers) {
    manager.stop();
  }
  trackedManagers.clear();
}

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
  let openClawState: OpenClawTestState;
  let threadBindingStore: PluginStateSyncKeyedStore<ThreadBindingStoreEntry>;

  function createThreadBindingStore(): PluginStateSyncKeyedStore<ThreadBindingStoreEntry> {
    return createPluginStateSyncKeyedStoreForTests("telegram", {
      namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
      maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
    });
  }

  function installThreadBindingStore(
    store: PluginStateSyncKeyedStore<ThreadBindingStoreEntry>,
  ): void {
    threadBindingStore = store;
    setTelegramRuntime({
      state: {
        openSyncKeyedStore: (() =>
          threadBindingStore) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
  }

  function storedBindings(): ThreadBindingStoreEntry[] {
    return threadBindingStore.entries().map((entry) => entry.value);
  }

  beforeEach(async () => {
    stopTrackedManagers();
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-telegram-bindings-",
    });
    resetPluginStateStoreForTests({ closeDatabase: false });
    installThreadBindingStore(createThreadBindingStore());
    threadBindingStore.clear();
    readAcpSessionEntryMock.mockReset();
    createForumTopicMock.mockReset();
    const acpRuntime = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
      "openclaw/plugin-sdk/acp-runtime",
    );
    readAcpSessionEntryMock.mockImplementation(acpRuntime.readAcpSessionEntry);
  });

  afterEach(async () => {
    vi.useRealTimers();
    stopTrackedManagers();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
    await openClawState.cleanup();
  });

  it.each(["before-create", "after-create"] as const)(
    "settles forum-topic binding only after native create admission (%s revocation)",
    async (revokeAt) => {
      const manager = createTelegramThreadBindingManager({
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
    const stopped = createTelegramThreadBindingManager({
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

    stopped.stop();

    const replacement = createTelegramThreadBindingManager({
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

    stopped.stop();

    expect(getTelegramThreadBindingManager("manager-lifecycle")).toBe(replacement);
    expect(replacement.getByConversationId("replacement-thread")?.targetSessionKey).toBe(
      "agent:main:subagent:replacement",
    );
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
    const managerA = bindingsA.createTelegramThreadBindingManager({
      cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
      accountId: "shared-runtime",
      persist: false,
      enableSweeper: false,
    });

    try {
      const managerB = bindingsB.createTelegramThreadBindingManager({
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
      managerA.stop();
    }
  });

  it("does not persist lifecycle updates when manager persistence is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
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

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      idleTimeoutMs: 60 * 60 * 1000,
    });
    setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "no-persist",
      targetSessionKey: "agent:main:subagent:child-2",
      maxAgeMs: 2 * 60 * 60 * 1000,
    });

    expect(storedBindings().filter((binding) => binding.accountId === "no-persist")).toStrictEqual(
      [],
    );
  });

  it("persists unbinds before restart so removed bindings do not come back", async () => {
    const manager = createTelegramThreadBindingManager({
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

    manager.stop();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("8460800771")).toBeUndefined();
  });

  it("persists only the changed binding without scanning or rewriting its siblings", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "row-writes",
      persist: true,
      enableSweeper: false,
    });
    const entries = vi.spyOn(threadBindingStore, "entries");
    const register = vi.spyOn(threadBindingStore, "register");
    const remove = vi.spyOn(threadBindingStore, "delete");

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
    manager.touchConversation("first-thread");
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
    const manager = createTelegramThreadBindingManager({
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

    manager.stop();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "metadata",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("metadata-thread")?.metadata).toStrictEqual({
      retained: "yes",
    });
    expect(
      storedBindings().find((binding) => binding.accountId === "metadata")?.metadata,
    ).toStrictEqual({
      retained: "yes",
    });
  });

  it.each([false, true])(
    "inherits runtime metadata only when refreshing the same target (replace=%s)",
    async (replace) => {
      const manager = createTelegramThreadBindingManager({
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
      manager.stop();
      createTelegramThreadBindingManager({
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

  it("starts with empty bindings when the plugin-state store cannot be read", () => {
    installThreadBindingStore({
      ...threadBindingStore,
      entries() {
        throw new Error("state unavailable");
      },
    });

    const manager = createTelegramThreadBindingManager({
      accountId: "read-failure",
      persist: true,
      enableSweeper: false,
    });

    expect(manager.listBindings()).toStrictEqual([]);
  });

  it("cleans up stale ACP bindings before restart routing can reuse them", async () => {
    const manager = createTelegramThreadBindingManager({
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

    manager.stop();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:stale-1",
      storeSessionKey: "agent:main:acp:stale-1",
      entry: undefined,
      acp: undefined,
      storeReadFailed: false,
    });

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("cleanup-me")).toBeUndefined();
    expect(storedBindings().map((binding) => binding.conversationId)).not.toContain("cleanup-me");
  });

  it("keeps plugin-owned bindings when ACP cleanup runs on startup", async () => {
    const manager = createTelegramThreadBindingManager({
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

    manager.stop();

    const reloaded = createTelegramThreadBindingManager({
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
    const manager = createTelegramThreadBindingManager({
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

    manager.stop();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:read-failed",
      storeSessionKey: "agent:main:acp:read-failed",
      entry: undefined,
      acp: undefined,
      storeReadFailed: true,
    });

    const reloaded = createTelegramThreadBindingManager({
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

    const manager = createTelegramThreadBindingManager({
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

    setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "persist-reset",
      targetSessionKey: "agent:main:subagent:child-3",
      idleTimeoutMs: 90_000,
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "persist-reset",
      targetSessionKey: "agent:main:subagent:child-3",
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    manager.stop();

    const reloaded = createTelegramThreadBindingManager({
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
  });

  it("does not leak unhandled rejections when a persist write fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const manager = createTelegramThreadBindingManager({
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
        ...threadBindingStore,
        register() {
          throw new Error("persist boom");
        },
      });
      manager.touchConversation("-100200300:topic:100");

      manager.stop();
      await flushMicrotasks();
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
