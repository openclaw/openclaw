import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAcpSessionEntryMock = vi.hoisted(() => vi.fn());

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
  __testing,
  createTelegramThreadBindingManager as createTelegramThreadBindingManagerImpl,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.js";

const TELEGRAM_THREAD_BINDINGS_TEST_CFG = {
  channels: {
    telegram: {
      token: "test-token",
    },
  },
} as OpenClawConfig;

type TelegramThreadBindingManagerParams = Parameters<
  typeof createTelegramThreadBindingManagerImpl
>[0];

function createTelegramThreadBindingManager(
  params: Omit<TelegramThreadBindingManagerParams, "cfg">,
) {
  return createTelegramThreadBindingManagerImpl({
    cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
    ...params,
  });
}

describe("telegram thread bindings", () => {
  beforeEach(async () => {
    readAcpSessionEntryMock.mockReset();
    const acpRuntime = await vi.importActual<typeof import("openclaw/plugin-sdk/acp-runtime")>(
      "openclaw/plugin-sdk/acp-runtime",
    );
    readAcpSessionEntryMock.mockImplementation(acpRuntime.readAcpSessionEntry);
    await __testing.resetTelegramThreadBindingsForTests({ clearStore: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await __testing.resetTelegramThreadBindingsForTests({ clearStore: true });
  });

  it("registers a telegram binding adapter and binds current conversations", async () => {
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
      idleTimeoutMs: 30_000,
      maxAgeMs: 0,
    });
    const bound = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-100200300:topic:77",
      },
      placement: "current",
      metadata: {
        boundBy: "user-1",
      },
    });

    expect(bound.conversation.channel).toBe("telegram");
    expect(bound.conversation.accountId).toBe("work");
    expect(bound.conversation.conversationId).toBe("-100200300:topic:77");
    expect(bound.targetSessionKey).toBe("agent:main:subagent:child-1");
    expect(manager.getByConversationId("-100200300:topic:77")?.boundBy).toBe("user-1");
  });

  it("rejects child placement when conversationId is a bare topic ID with no group context", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "77",
        },
        placement: "child",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
  });

  it("rejects child placement when parentConversationId is also a bare topic ID", async () => {
    createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });

    await expect(
      getSessionBindingService().bind({
        targetSessionKey: "agent:main:acp:child-acp-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "77",
          parentConversationId: "99",
        },
        placement: "child",
      }),
    ).rejects.toMatchObject({
      code: "BINDING_CREATE_FAILED",
    });
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

    await bindingsA.__testing.resetTelegramThreadBindingsForTests();

    try {
      const managerA = bindingsA.createTelegramThreadBindingManager({
        cfg: TELEGRAM_THREAD_BINDINGS_TEST_CFG,
        accountId: "shared-runtime",
        persist: false,
        enableSweeper: false,
      });
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
      await bindingsA.__testing.resetTelegramThreadBindingsForTests();
    }
  });

  it("updates lifecycle windows by session key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const manager = createTelegramThreadBindingManager({
      accountId: "work",
      persist: false,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "work",
        conversationId: "1234",
      },
    });
    const original = manager.listBySessionKey("agent:main:subagent:child-1")[0];
    if (!original) {
      throw new Error("expected original subagent thread binding");
    }

    const idleUpdated = setTelegramThreadBindingIdleTimeoutBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    const maxAgeUpdated = setTelegramThreadBindingMaxAgeBySessionKey({
      accountId: "work",
      targetSessionKey: "agent:main:subagent:child-1",
      maxAgeMs: 6 * 60 * 60 * 1000,
    });

    expect(idleUpdated).toHaveLength(1);
    expect(idleUpdated[0]?.idleTimeoutMs).toBe(2 * 60 * 60 * 1000);
    expect(maxAgeUpdated).toHaveLength(1);
    expect(maxAgeUpdated[0]?.maxAgeMs).toBe(6 * 60 * 60 * 1000);
    expect(maxAgeUpdated[0]?.boundAt).toBe(original?.boundAt);
    expect(maxAgeUpdated[0]?.lastActivityAt).toBe(Date.parse("2026-03-06T12:00:00.000Z"));
    expect(manager.listBySessionKey("agent:main:subagent:child-1")[0]?.maxAgeMs).toBe(
      6 * 60 * 60 * 1000,
    );
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

    await __testing.resetTelegramThreadBindingsForTests();
    const reloaded = createTelegramThreadBindingManager({
      accountId: "no-persist",
      persist: true,
      enableSweeper: false,
    });
    expect(reloaded.getByConversationId("-100200300:topic:88")).toBeUndefined();
  });

  it("persists unbinds before restart so removed bindings do not come back", async () => {
    createTelegramThreadBindingManager({
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

    await __testing.resetTelegramThreadBindingsForTests();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("8460800771")).toBeUndefined();
  });

  it("cleans up stale ACP bindings before restart routing can reuse them", async () => {
    createTelegramThreadBindingManager({
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

    await __testing.resetTelegramThreadBindingsForTests();
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
    await __testing.resetTelegramThreadBindingsForTests();
    const reloadedAgain = createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });
    expect(reloadedAgain.getByConversationId("cleanup-me")).toBeUndefined();
  });

  it("keeps plugin-owned bindings when ACP cleanup runs on startup", async () => {
    createTelegramThreadBindingManager({
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

    await __testing.resetTelegramThreadBindingsForTests();

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
    createTelegramThreadBindingManager({
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

    await __testing.resetTelegramThreadBindingsForTests();
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

  it("flushes pending lifecycle update persists before test reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));

    createTelegramThreadBindingManager({
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

    await __testing.resetTelegramThreadBindingsForTests();

    const reloaded = createTelegramThreadBindingManager({
      accountId: "persist-reset",
      persist: true,
      enableSweeper: false,
    });
    expect(reloaded.getByConversationId("-100200300:topic:99")?.idleTimeoutMs).toBe(90_000);
  });
});
