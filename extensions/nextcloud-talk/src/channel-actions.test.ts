import { describe, expect, it, vi } from "vitest";

const resolveNextcloudTalkAccount = vi.hoisted(() => vi.fn());
const sendReactionNextcloudTalk = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveNextcloudTalkAccount,
}));

vi.mock("./send.js", () => ({
  sendReactionNextcloudTalk,
}));

describe("nextcloudTalkMessageActions", () => {
  it("describes the react action", async () => {
    const { nextcloudTalkMessageActions } = await import("./channel-actions.js");

    expect(nextcloudTalkMessageActions.describeMessageTool({ cfg: {} as never })).toEqual({
      actions: ["react"],
      capabilities: [],
      schema: null,
    });
  });

  it("sends reactions using the resolved account and message context", async () => {
    const { nextcloudTalkMessageActions } = await import("./channel-actions.js");
    resolveNextcloudTalkAccount.mockReturnValue({
      accountId: "work",
    });
    sendReactionNextcloudTalk.mockResolvedValue({ ok: true });

    if (!nextcloudTalkMessageActions.handleAction) {
      throw new Error("Expected handleAction to be defined");
    }

    const result = await nextcloudTalkMessageActions.handleAction({
      action: "react",
      params: {
        to: "room-1",
        emoji: "😆",
      },
      cfg: {},
      accountId: "work",
      toolContext: {
        currentMessageId: "1567",
      },
    } as never);

    expect(resolveNextcloudTalkAccount).toHaveBeenCalledWith({
      cfg: {},
      accountId: "work",
    });
    expect(sendReactionNextcloudTalk).toHaveBeenCalledWith("room-1", "1567", "😆", {
      accountId: "work",
      cfg: {},
    });
    expect(result).toMatchObject({
      details: {
        ok: true,
        added: "😆",
        messageId: "1567",
        roomToken: "room-1",
      },
    });
  });
});
