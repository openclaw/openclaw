// Native fork/topic authority and persisted Back regressions.
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTelegramThreadBindingsFixture } from "./thread-bindings.test-support.js";

const createForumTopicMock = vi.hoisted(() =>
  vi.fn<typeof import("./send-forum-topics.js").createForumTopicTelegram>(),
);
const deleteCreatedForumTopicMock = vi.hoisted(() =>
  vi.fn<typeof import("./send-forum-topics.js").deleteCreatedForumTopicTelegram>(),
);

// mock-isolation: Keep Telegram transport effects synthetic while testing topic compensation.
vi.mock("./send-runtime.js", () => ({
  loadTelegramSendModule: async () => ({
    createForumTopicTelegram: createForumTopicMock,
  }),
}));
// mock-isolation: Keep the direct cleanup import synthetic; no real Telegram API is admitted.
vi.mock("./send-forum-topics.js", () => ({
  deleteCreatedForumTopicTelegram: deleteCreatedForumTopicMock,
}));

describe("telegram native fork bindings", () => {
  const { createManager: createTelegramThreadBindingManager, storedBindings } =
    useTelegramThreadBindingsFixture();

  beforeEach(() => {
    createForumTopicMock.mockReset();
    deleteCreatedForumTopicMock.mockReset();
    deleteCreatedForumTopicMock.mockResolvedValue(undefined);
  });

  it.each(["before-create", "after-create"] as const)(
    "rejects stale forum-topic binding before and after native creation (%s revocation)",
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
      await expect(result).rejects.toThrow("failed to bind");
      expect(nativeCreates).toBe(revokeAt === "before-create" ? 0 : 1);
      expect(deleteCreatedForumTopicMock).toHaveBeenCalledTimes(
        revokeAt === "before-create" ? 0 : 1,
      );
      if (revokeAt === "after-create") {
        expect(deleteCreatedForumTopicMock).toHaveBeenCalledWith(
          "-100200300",
          88,
          expect.objectContaining({ accountId: "default" }),
        );
      }
      expect(manager.getByConversationId("-100200300:topic:88")).toBeUndefined();
    },
  );

  it("bounds failed topic compensation without publishing a revoked route", async () => {
    vi.useFakeTimers();
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    const cleanupEntered = createDeferred<void>();
    let ownerCurrent = true;
    createForumTopicMock.mockImplementationOnce(async () => {
      ownerCurrent = false;
      return { chatId: "-100200300", topicId: 89, name: "Orphan candidate" };
    });
    deleteCreatedForumTopicMock.mockImplementationOnce(() => {
      cleanupEntered.resolve();
      return new Promise<void>(() => {});
    });
    const binding = getSessionBindingService().bind({
      targetSessionKey: "agent:main:orphan-candidate",
      targetKind: "session",
      conversation: { channel: "telegram", accountId: "default", conversationId: "-100200300" },
      placement: "child",
      assertCurrent: () => {
        if (!ownerCurrent) {
          throw new Error("Command owner was revoked");
        }
      },
    });
    const rejectedBinding = expect(binding).rejects.toThrow("failed to bind");
    await cleanupEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejectedBinding;
    expect(deleteCreatedForumTopicMock).toHaveBeenCalledTimes(1);
    expect(manager.getByConversationId("-100200300:topic:89")).toBeUndefined();
  });

  it("assigns a new binding generation even for identical same-millisecond rebinds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T18:00:00.000Z"));
    await createTelegramThreadBindingManager({
      accountId: "same-ms",
      persist: false,
      enableSweeper: false,
    });
    const input = {
      targetSessionKey: "agent:main:source",
      targetKind: "session" as const,
      conversation: {
        channel: "telegram" as const,
        accountId: "same-ms",
        conversationId: "-100200300:topic:99",
      },
      placement: "current" as const,
      metadata: { label: "same target" },
    };
    const first = await getSessionBindingService().bind(input);
    const second = await getSessionBindingService().bind(input);
    expect(first.bindingId).toBe(second.bindingId);
    expect(first.boundAt).toBe(second.boundAt);
    expect(typeof first.metadata?.["__threadBindingGeneration"]).toBe("string");
    expect(second.metadata?.["__threadBindingGeneration"]).not.toBe(
      first.metadata?.["__threadBindingGeneration"],
    );
  });

  it("keeps a restored route's absolute deadline through activity refresh", async () => {
    const accountId = "fork-deadline";
    await createTelegramThreadBindingManager({ accountId, persist: true, enableSweeper: false });
    const conversation = {
      channel: "telegram" as const,
      accountId,
      conversationId: "-100200300:topic:98",
    };
    const deadline = Date.now() + 60_000;
    const restored = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      placement: "current",
      expiresAt: deadline,
    });
    expect(restored.expiresAt).toBe(deadline);
    getSessionBindingService().touch(restored.bindingId, deadline - 1_000);
    expect(getSessionBindingService().resolveByConversation(conversation)?.expiresAt).toBe(
      deadline,
    );
    expect(await storedBindings()).toEqual(
      expect.arrayContaining([expect.objectContaining({ expiresAt: deadline })]),
    );
  });

  it("reloads a native fork Back envelope from the binding store after restart", async () => {
    const accountId = "fork-restart";
    const conversation = {
      channel: "telegram" as const,
      accountId,
      conversationId: "-100200300:topic:199",
    };
    const manager = await createTelegramThreadBindingManager({
      accountId,
      persist: true,
      enableSweeper: false,
    });
    const prior = await getSessionBindingService().bind({
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      placement: "current",
    });
    const previous = {
      bindingId: prior.bindingId,
      targetSessionKey: prior.targetSessionKey,
      targetKind: prior.targetKind,
      conversation: prior.conversation,
      boundAt: prior.boundAt,
      expiresAt: prior.expiresAt,
      metadata: prior.metadata,
    };
    const fork = "agent:main:fork-restarted";
    const envelope = {
      version: 1,
      operationId: "disk-restart-operation",
      sourceSessionKey: "agent:main:source",
      forkSessionKey: fork,
      source: "tip",
      placement: "current",
      sourceConversation: conversation,
      previous,
    };
    await getSessionBindingService().bind({
      targetSessionKey: fork,
      targetKind: "session",
      conversation,
      placement: "current",
      metadata: { conversationFork: envelope },
    });
    expect(
      (await storedBindings()).find((binding) => binding.accountId === accountId)?.metadata
        ?.conversationFork,
    ).toMatchObject({
      operationId: envelope.operationId,
      previous: {
        bindingId: prior.bindingId,
        targetSessionKey: prior.targetSessionKey,
        metadata: { __threadBindingGeneration: prior.metadata?.["__threadBindingGeneration"] },
      },
    });

    await manager.stop();
    await createTelegramThreadBindingManager({ accountId, persist: true, enableSweeper: false });
    const reloaded = await getSessionBindingService().resolveByConversationAsync(conversation);
    expect(reloaded).toMatchObject({
      targetSessionKey: fork,
      metadata: {
        conversationFork: {
          operationId: envelope.operationId,
          previous: {
            bindingId: prior.bindingId,
            targetSessionKey: prior.targetSessionKey,
            metadata: { __threadBindingGeneration: prior.metadata?.["__threadBindingGeneration"] },
          },
        },
      },
    });
    const restored = await getSessionBindingService().bind({
      targetSessionKey: previous.targetSessionKey,
      targetKind: "session",
      conversation,
      placement: "current",
      metadata: previous.metadata,
    });
    expect(restored.targetSessionKey).toBe("agent:main:source");
    expect(restored.metadata?.conversationFork).toBeUndefined();
    expect(restored.metadata?.["__threadBindingGeneration"]).not.toBe(
      previous.metadata?.["__threadBindingGeneration"],
    );
  });
});
