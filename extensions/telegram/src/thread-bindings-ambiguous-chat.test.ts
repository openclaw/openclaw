import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it } from "vitest";
import { useTelegramThreadBindingsFixture } from "./thread-bindings.test-support.js";

describe("Telegram child binding ambiguous chat identifiers", () => {
  const fixture = useTelegramThreadBindingsFixture();

  it("refuses a positive ID that could be a bare topic ID instead of a group chat", async () => {
    await fixture.createManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    const service = getSessionBindingService();
    const conversation = {
      channel: "telegram",
      accountId: "default",
      conversationId: "6566057320",
    };
    await expect(
      service.bind({
        targetSessionKey: "agent:main:ambiguous-fork",
        targetKind: "session",
        conversation,
        placement: "child",
        metadata: { threadName: "Ambiguous fork" },
      }),
    ).rejects.toThrow();
    expect(await service.resolveByConversationAsync(conversation)).toBeNull();
  });
});
