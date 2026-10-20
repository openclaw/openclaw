import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createForumTopicMock = vi.hoisted(() =>
  vi.fn<typeof import("./send-forum-topics.js").createForumTopicTelegram>(),
);

vi.mock("./send-runtime.js", () => ({
  loadTelegramSendModule: async () => ({ createForumTopicTelegram: createForumTopicMock }),
}));

import {
  TELEGRAM_THREAD_BINDINGS_TEST_CFG,
  useTelegramThreadBindingsFixture,
} from "./thread-bindings.test-support.js";

const {
  getTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey: setLegacyIdleTimeout,
  setTelegramThreadBindingIdleTimeoutBySessionKeyAsync: setIdleTimeout,
  setTelegramThreadBindingMaxAgeBySessionKey: setLegacyMaxAge,
  setTelegramThreadBindingMaxAgeBySessionKeyAsync: setMaxAge,
} = await import("./thread-bindings.js");

describe("telegram thread bindings", () => {
  const fixture = useTelegramThreadBindingsFixture();
  const { installStore: installThreadBindingStore, storedBindings } = fixture;
  const createManager = (options: Parameters<typeof fixture.createManager>[0]) =>
    fixture.createManager({ persist: true, enableSweeper: false, ...options });
  const conversationFor = (accountId: string, conversationId = "thread") => ({
    channel: "telegram",
    accountId,
    conversationId,
  });
  type BindOptions = Partial<Parameters<ReturnType<typeof getSessionBindingService>["bind"]>[0]>;
  const bind = (accountId: string, targetSessionKey: string, options: BindOptions = {}) =>
    getSessionBindingService().bind({
      targetSessionKey,
      targetKind: "subagent",
      conversation: conversationFor(accountId),
      ...options,
    });
  const pauseRegistration = (commitFirst = false) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const register = fixture.store.register.bind(fixture.store);
    vi.spyOn(fixture.store, "register").mockImplementationOnce(async (...args) => {
      if (commitFirst) {
        await register(...args);
      }
      entered.resolve();
      await release.promise;
      if (!commitFirst) {
        await register(...args);
      }
    });
    return { entered, release };
  };

  beforeEach(() => {
    createForumTopicMock.mockReset();
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
    const first = createManager(params);
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
    await bind(params.accountId, "agent:main:subagent:child-shared", { placement: "current" });
    expect(
      other.getTelegramThreadBindingManager(params.accountId)?.getByConversationId("thread")
        ?.targetSessionKey,
    ).toBe("agent:main:subagent:child-shared");
  });

  it("drains accepted mutations in order before restart and rejects retired writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const params = { accountId: "drain", persist: true, enableSweeper: false };
    const manager = await createManager(params);
    const { entered, release } = pauseRegistration();
    const binding = bind(params.accountId, "agent:main:subagent:drained");
    await entered.promise;
    expect(manager.getByConversationId("thread")).toBeUndefined();
    const metadata = { label: "requested", payload: { value: "submitted" }, values: ["original"] };
    const replacementBind = bind(params.accountId, "agent:main:subagent:replacement", { metadata });
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
    const restart = createManager(params);
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
    const manager = await createManager({ accountId: "authority", persist });
    const service = getSessionBindingService();
    const conversation = conversationFor(manager.accountId);
    const targetSessionKey = "agent:main:subagent:refused";
    const paused = persist ? pauseRegistration() : undefined;
    let current = true;
    expect(service.resolveByConversation(conversation)).toBeNull();
    const binding = bind(manager.accountId, targetSessionKey, {
      assertCurrent: () => {
        if (!current) {
          throw new Error("Command revoked");
        }
      },
    });
    const publishedBeforeRevocation = service.resolveByConversation(conversation);
    if (paused) {
      await paused.entered.promise;
    }
    current = false;
    paused?.release.resolve();
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
      const manager = await createManager({ accountId: "legacy" });
      const service = getSessionBindingService();
      const conversation = conversationFor(manager.accountId);
      const original = "agent:main:subagent:original";
      const replacement = "agent:main:subagent:replacement";
      const bound = await bind(manager.accountId, original);
      const { entered, release } = pauseRegistration(phase !== "before-commit");
      const pending = bind(manager.accountId, replacement);
      const settled =
        phase === "before-commit"
          ? expect(pending).rejects.toThrow("changed before persistence")
          : expect(pending).resolves.toMatchObject({ targetSessionKey: replacement });
      await entered.promise;
      const readOnly = phase === "after-commit-readonly";
      const native = readOnly ? openOpenClawStateDatabase().db : undefined;
      try {
        native?.exec("PRAGMA query_only = ON");
        service.touch(bound.bindingId, 42, conversation);
      } finally {
        native?.exec("PRAGMA query_only = OFF");
      }
      const targetAfterTouch = phase === "after-commit" ? replacement : original;
      expect(manager.getByConversationId("thread")).toMatchObject({
        targetSessionKey: targetAfterTouch,
        ...(!readOnly ? { lastActivityAt: 42 } : {}),
      });
      release.resolve();
      await settled;
      const targetSessionKey = phase === "before-commit" ? original : replacement;
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
    const manager = await createManager({ accountId: "queued-activity" });
    const service = getSessionBindingService();
    const conversation = conversationFor(manager.accountId);
    const bound = await bind(manager.accountId, "agent:main:subagent:active");
    const { entered, release } = pauseRegistration();
    const pending: Promise<unknown>[] = [];
    try {
      pending.push(
        bind(manager.accountId, "agent:main:subagent:queue-blocker", {
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
    const manager = await createManager({ accountId: "legacy-lifecycle" });
    const targetSessionKey = "agent:main:subagent:legacy-lifecycle";
    const target = { accountId: manager.accountId, targetSessionKey };
    const bound = await bind(manager.accountId, targetSessionKey);
    vi.spyOn(fixture.store, "register").mockRejectedValueOnce(new Error("temporary write failure"));
    await setIdleTimeout({ ...target, idleTimeoutMs: 321 });
    getSessionBindingService().touch(bound.bindingId, 42, bound.conversation);
    expect(await storedBindings()).toMatchObject([{ idleTimeoutMs: 321, lastActivityAt: 42 }]);
    const idle = setLegacyIdleTimeout({ ...target, idleTimeoutMs: 123 });
    expect(idle).toMatchObject([{ idleTimeoutMs: 123 }]);
    const lifecycle = { idleTimeoutMs: 123, maxAgeMs: 456 };
    expect(setLegacyMaxAge({ ...target, maxAgeMs: 456 })).toMatchObject([lifecycle]);
    expect(manager.getByConversationId("thread")).toMatchObject(lifecycle);
    expect(await storedBindings()).toMatchObject([lifecycle]);
  });

  it("rechecks later expiry candidates after a synchronous SDK touch", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    installThreadBindingStore(fixture.store, true);
    const manager = await createManager({
      accountId: "expiry",
      idleTimeoutMs: 1,
      enableSweeper: true,
    });
    const service = getSessionBindingService();
    const bindExpiry = (conversationId: string) =>
      bind(manager.accountId, "agent:main:subagent:expiry", {
        conversation: conversationFor(manager.accountId, conversationId),
      });
    await bindExpiry("first");
    const second = await bindExpiry("second");
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

  it.each(["before-create", "after-create"] as const)("topic admission: %s", async (revokeAt) => {
    const manager = await createManager({ accountId: "default", persist: false });
    const targetSessionKey = "agent:main:created-topic";
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
    const result = bind("default", targetSessionKey, {
      targetKind: "session",
      conversation: conversationFor("default", "-100200300"),
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
      await expect(result).resolves.toMatchObject({ targetSessionKey });
      expect(nativeCreates).toBe(1);
      expect(manager.getByConversationId("-100200300:topic:88")).toMatchObject({
        targetSessionKey,
      });
    }
  });

  it("drops stopped-manager bindings without clearing a replacement generation", async () => {
    const stopped = await createManager({
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

    const replacement = await createManager({
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

  it("persists only the changed binding without scanning or rewriting its siblings", async () => {
    const manager = await createManager({ accountId: "row-writes" });
    const entries = vi.spyOn(fixture.store, "entries");
    const register = vi.spyOn(fixture.store, "register");
    const remove = vi.spyOn(fixture.store, "delete");
    const first = await bind(manager.accountId, "agent:main:subagent:first-row", {
      conversation: conversationFor(manager.accountId, "first-thread"),
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(entries).not.toHaveBeenCalled();
    register.mockClear();
    await bind(manager.accountId, "agent:main:subagent:second-row", {
      conversation: conversationFor(manager.accountId, "second-thread"),
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
    const reloaded = await createManager({ accountId: manager.accountId });
    expect(reloaded.getByConversationId("first-thread")).toBeUndefined();
    expect(reloaded.getByConversationId("second-thread")).toBeDefined();
  });

  it.each([false, true])("refreshes same-target metadata (replace=%s)", async (replace) => {
    const manager = await createManager({ accountId: "replacement-owner" });
    const service = getSessionBindingService();
    const conversation = conversationFor(manager.accountId, "replacement-thread");
    const originalTarget = "plugin-binding:owner-plugin:original";
    const runtimeMetadata = {
      pluginBindingOwner: "plugin",
      pluginId: "owner-plugin",
      pluginRoot: "/plugins/owner-plugin",
      agentId: "previous-agent",
      boundBy: "previous-user",
      opaque: { runtimeId: "original" },
    };
    await bind(manager.accountId, originalTarget, {
      targetKind: "session",
      conversation,
      metadata: { ...runtimeMetadata, idleTimeoutMs: 90_000 },
    });
    const targetSessionKey = replace ? "agent:main:subagent:replacement" : originalTarget;

    await bind(manager.accountId, targetSessionKey, {
      targetKind: replace ? "subagent" : "session",
      conversation,
      metadata: { label: "updated" },
    });
    await manager.stop();
    await createManager({ accountId: manager.accountId });

    const binding = service.resolveByConversation(conversation);
    expect(binding?.targetSessionKey).toBe(targetSessionKey);
    expect(binding?.metadata).toMatchObject({ label: "updated", idleTimeoutMs: 90_000 });
    for (const [key, value] of Object.entries(runtimeMetadata)) {
      expect(binding?.metadata?.[key]).toEqual(replace ? undefined : value);
    }
  });

  it("starts with empty bindings when the plugin-state store cannot be read", async () => {
    installThreadBindingStore({
      ...fixture.store,
      entries() {
        throw new Error("state unavailable");
      },
    });
    const manager = await createManager({ accountId: "read-failure" });
    expect(manager.listBindings()).toStrictEqual([]);
  });

  it.each([
    { persist: false, idleTimeoutMs: 60 * 60 * 1000, maxAgeMs: 2 * 60 * 60 * 1000 },
    { persist: true, idleTimeoutMs: 90_000, maxAgeMs: 6 * 60 * 60 * 1000 },
  ])("durable lifecycle (persist=$persist)", async ({ persist, idleTimeoutMs, maxAgeMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T10:00:00.000Z"));
    const options = { accountId: "lifecycle", persist, enableSweeper: false };
    const manager = await createManager(options);
    const targetSessionKey = "agent:main:subagent:child";
    const target = { accountId: manager.accountId, targetSessionKey };
    await bind(manager.accountId, targetSessionKey, {
      metadata: { retained: "yes", omitted: undefined },
    });
    await setIdleTimeout({ ...target, idleTimeoutMs });
    vi.setSystemTime(new Date("2026-03-06T12:00:00.000Z"));
    await setMaxAge({ ...target, maxAgeMs });
    await manager.stop();
    const reloaded = await createManager(options);
    const stored = (await storedBindings()).filter((row) => row.accountId === manager.accountId);
    if (persist) {
      expect(reloaded.getByConversationId("thread")).toMatchObject({
        idleTimeoutMs,
        maxAgeMs,
        boundAt: Date.parse("2026-03-06T10:00:00.000Z"),
        lastActivityAt: Date.parse("2026-03-06T12:00:00.000Z"),
      });
      expect(reloaded.getByConversationId("thread")?.metadata).toStrictEqual({ retained: "yes" });
      expect(stored[0]?.idleTimeoutMs).toBe(90_000);
      expect(stored[0]?.metadata).toStrictEqual({ retained: "yes" });
    } else {
      expect(reloaded.getByConversationId("thread")).toBeUndefined();
      expect(stored).toStrictEqual([]);
    }
  });
});
