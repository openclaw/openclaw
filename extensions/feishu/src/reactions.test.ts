import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addReactionFeishu,
  listReactionsFeishu,
  normalizeFeishuEmoji,
  removeReactionFeishu,
} from "./reactions.js";

const resolveFeishuRuntimeAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: resolveFeishuRuntimeAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const cfg = {} as Parameters<typeof addReactionFeishu>[0]["cfg"];

beforeEach(() => {
  resolveFeishuRuntimeAccountMock.mockReset().mockReturnValue({
    accountId: "default",
    configured: true,
  });
  createFeishuClientMock.mockReset();
});

describe("normalizeFeishuEmoji", () => {
  it("passes through known Feishu emoji type strings", () => {
    expect(normalizeFeishuEmoji("THUMBSUP")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji("HEART")).toBe("HEART");
    expect(normalizeFeishuEmoji("FIRE")).toBe("FIRE");
  });

  it("normalizes case-insensitive Feishu type strings", () => {
    expect(normalizeFeishuEmoji("thumbsup")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji("Heart")).toBe("HEART");
    expect(normalizeFeishuEmoji("fire")).toBe("FIRE");
  });

  it("converts common unicode emojis to Feishu types", () => {
    expect(normalizeFeishuEmoji("\u{1F44D}")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji("\u{1F44E}")).toBe("THUMBSDOWN");
    expect(normalizeFeishuEmoji("\u{2764}\u{FE0F}")).toBe("HEART");
    expect(normalizeFeishuEmoji("\u{2764}")).toBe("HEART");
    expect(normalizeFeishuEmoji("\u{1F525}")).toBe("FIRE");
    expect(normalizeFeishuEmoji("\u{1F389}")).toBe("PARTY");
    expect(normalizeFeishuEmoji("\u{1F44F}")).toBe("CLAP");
    expect(normalizeFeishuEmoji("\u{1F64F}")).toBe("PRAY");
    expect(normalizeFeishuEmoji("\u{274C}")).toBe("CROSS");
    expect(normalizeFeishuEmoji("\u{2705}")).toBe("CHECK");
  });

  it("trims whitespace before normalizing", () => {
    expect(normalizeFeishuEmoji("  THUMBSUP  ")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji(" \u{1F525} ")).toBe("FIRE");
  });

  it("returns unknown values unchanged for API-level error reporting", () => {
    expect(normalizeFeishuEmoji("UNKNOWN_EMOJI")).toBe("UNKNOWN_EMOJI");
    expect(normalizeFeishuEmoji("\u{1F923}")).toBe("\u{1F923}");
  });
});

describe("Feishu reaction API helpers", () => {
  it("normalizes unicode emoji before adding a reaction", async () => {
    const create = vi.fn().mockResolvedValue({
      code: 0,
      data: { reaction_id: "reaction-1" },
    });
    createFeishuClientMock.mockReturnValue({
      im: { messageReaction: { create } },
    });

    await addReactionFeishu({
      cfg,
      messageId: "om_msg1",
      emojiType: "\u{1F44D}",
    });

    expect(create).toHaveBeenCalledWith({
      path: { message_id: "om_msg1" },
      data: { reaction_type: { emoji_type: "THUMBSUP" } },
    });
  });

  it("normalizes unicode emoji before list filtering for removal", async () => {
    const list = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "reaction-1",
            reaction_type: { emoji_type: "HEART" },
            operator_type: "app",
            operator_id: { open_id: "ou_bot" },
          },
        ],
      },
    });
    createFeishuClientMock.mockReturnValue({
      im: { messageReaction: { list } },
    });

    const reactions = await listReactionsFeishu({
      cfg,
      messageId: "om_msg1",
      emojiType: "\u{2764}",
    });

    expect(list).toHaveBeenCalledWith({
      path: { message_id: "om_msg1" },
      params: { reaction_type: "HEART" },
    });
    expect(reactions).toEqual([
      {
        reactionId: "reaction-1",
        emojiType: "HEART",
        operatorType: "app",
        operatorId: "ou_bot",
      },
    ]);
  });

  it("passes reaction ids through to the remove API", async () => {
    const deleteReaction = vi.fn().mockResolvedValue({ code: 0 });
    createFeishuClientMock.mockReturnValue({
      im: { messageReaction: { delete: deleteReaction } },
    });

    await removeReactionFeishu({
      cfg,
      messageId: "om_msg1",
      reactionId: "reaction-1",
    });

    expect(deleteReaction).toHaveBeenCalledWith({
      path: {
        message_id: "om_msg1",
        reaction_id: "reaction-1",
      },
    });
  });
});
