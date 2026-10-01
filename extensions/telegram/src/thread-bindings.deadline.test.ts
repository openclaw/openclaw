import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it, vi } from "vitest";
import { useTelegramThreadBindingsFixture } from "./thread-bindings.test-support.js";

describe("Telegram restored binding deadline", () => {
  const fixture = useTelegramThreadBindingsFixture();

  it("persists an absolute cap across activity and manager restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    const accountId = "fork-deadline";
    const conversation = {
      channel: "telegram",
      accountId,
      conversationId: "-100123:topic:42",
    };
    const expiresAt = Date.now() + 60_000;
    const manager = await fixture.createManager({
      accountId,
      persist: true,
      enableSweeper: false,
    });
    const service = getSessionBindingService();
    const bound = await service.bind({
      targetSessionKey: "agent:main:source",
      targetKind: "session",
      conversation,
      placement: "current",
      expiresAt,
    });
    expect(bound.expiresAt).toBe(expiresAt);

    vi.setSystemTime(Date.now() + 30_000);
    await manager.touchConversation(conversation.conversationId);
    expect((await service.resolveByConversationAsync(conversation))?.expiresAt).toBe(expiresAt);
    await manager.stop();
    await fixture.createManager({ accountId, persist: true, enableSweeper: false });
    expect((await service.resolveByConversationAsync(conversation))?.expiresAt).toBe(expiresAt);
    expect(
      (await fixture.storedBindings()).find(
        (entry) =>
          entry.accountId === accountId && entry.conversationId === conversation.conversationId,
      )?.expiresAt,
    ).toBe(expiresAt);
  });
});
