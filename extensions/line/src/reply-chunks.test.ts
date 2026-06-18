// Line tests cover reply chunks plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { sendLineReplyChunks } from "./reply-chunks.js";

const LINE_TEST_CFG = { channels: { line: { channelAccessToken: "line-token" } } };

function createReplyChunksHarness() {
  const replyMessageLine = vi.fn(async () => ({}));
  const pushMessageLine = vi.fn(async () => ({}));
  const pushMessagesLine = vi.fn(async () => ({}));
  const pushTextMessageWithQuickReplies = vi.fn(async () => ({}));
  const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
    type: "text" as const,
    text,
  }));

  return {
    replyMessageLine,
    pushMessageLine,
    pushMessagesLine,
    pushTextMessageWithQuickReplies,
    createTextMessageWithQuickReplies,
  };
}

describe("sendLineReplyChunks", () => {
  it("uses reply token for all chunks when possible", async () => {
    const {
      replyMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    } = createReplyChunksHarness();

    const result = await sendLineReplyChunks({
      to: "line:group:1",
      chunks: ["one", "two", "three"],
      quickReplies: ["A", "B"],
      replyToken: "token",
      replyTokenUsed: false,
      cfg: LINE_TEST_CFG,
      accountId: "default",
      replyMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(createTextMessageWithQuickReplies).toHaveBeenCalledWith("three", ["A", "B"]);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
        { type: "text", text: "three" },
      ],
      { cfg: LINE_TEST_CFG, accountId: "default" },
    );
    expect(pushMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("attaches quick replies to a single reply chunk", async () => {
    const { replyMessageLine, pushMessageLine, pushMessagesLine, pushTextMessageWithQuickReplies } =
      createReplyChunksHarness();
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
      quickReply: { items: [] },
    }));

    const result = await sendLineReplyChunks({
      to: "line:user:1",
      chunks: ["only"],
      quickReplies: ["A"],
      replyToken: "token",
      replyTokenUsed: false,
      cfg: LINE_TEST_CFG,
      replyMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(createTextMessageWithQuickReplies).toHaveBeenCalledWith("only", ["A"]);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("replies with up to five chunks before pushing the rest", async () => {
    const {
      replyMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    } = createReplyChunksHarness();

    const chunks = ["1", "2", "3", "4", "5", "6", "7"];
    const result = await sendLineReplyChunks({
      to: "line:group:1",
      chunks,
      quickReplies: ["A"],
      replyToken: "token",
      replyTokenUsed: false,
      cfg: LINE_TEST_CFG,
      replyMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        { type: "text", text: "1" },
        { type: "text", text: "2" },
        { type: "text", text: "3" },
        { type: "text", text: "4" },
        { type: "text", text: "5" },
      ],
      { cfg: LINE_TEST_CFG, accountId: undefined },
    );
    // Plain chunks before the quick-reply last chunk are now batched via pushMessagesLine
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith("line:group:1", [{ type: "text", text: "6" }], {
      cfg: LINE_TEST_CFG,
      accountId: undefined,
    });
    expect(pushTextMessageWithQuickReplies).toHaveBeenCalledTimes(1);
    expect(pushTextMessageWithQuickReplies).toHaveBeenCalledWith("line:group:1", "7", ["A"], {
      cfg: LINE_TEST_CFG,
      accountId: undefined,
    });
    expect(pushMessageLine).not.toHaveBeenCalled();
    expect(createTextMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("falls back to push flow when replying fails", async () => {
    const {
      replyMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
    } = createReplyChunksHarness();
    const onReplyError = vi.fn();
    const replyError = new Error("reply failed");
    replyMessageLine.mockRejectedValueOnce(replyError);

    const result = await sendLineReplyChunks({
      to: "line:group:1",
      chunks: ["1", "2", "3"],
      quickReplies: ["A"],
      replyToken: "token",
      replyTokenUsed: false,
      cfg: LINE_TEST_CFG,
      accountId: "default",
      replyMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
      onReplyError,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(onReplyError).toHaveBeenCalledWith(replyError);
    // Plain chunks before the quick-reply last chunk are batched via pushMessagesLine
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:group:1",
      [
        { type: "text", text: "1" },
        { type: "text", text: "2" },
      ],
      { cfg: LINE_TEST_CFG, accountId: "default" },
    );
    expect(pushTextMessageWithQuickReplies).toHaveBeenCalledWith("line:group:1", "3", ["A"], {
      cfg: LINE_TEST_CFG,
      accountId: "default",
    });
    expect(pushMessageLine).not.toHaveBeenCalled();
  });
});
