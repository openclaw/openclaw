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
  it("passes through documented ALL_CAPS Feishu emoji_type strings unchanged", () => {
    expect(normalizeFeishuEmoji("THUMBSUP")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji("HEART")).toBe("HEART");
    expect(normalizeFeishuEmoji("SMILE")).toBe("SMILE");
    expect(normalizeFeishuEmoji("ANGRY")).toBe("ANGRY");
    expect(normalizeFeishuEmoji("CLAP")).toBe("CLAP");
    expect(normalizeFeishuEmoji("PARTY")).toBe("PARTY");
  });

  it("preserves documented PascalCase Feishu emoji_type strings (the 231001 fix)", () => {
    // Feishu's reaction API rejects uppercased PascalCase values with code 231001.
    // These must be returned exactly as documented.
    expect(normalizeFeishuEmoji("Fire")).toBe("Fire");
    expect(normalizeFeishuEmoji("ThumbsDown")).toBe("ThumbsDown");
    expect(normalizeFeishuEmoji("CheckMark")).toBe("CheckMark");
    expect(normalizeFeishuEmoji("CrossMark")).toBe("CrossMark");
    expect(normalizeFeishuEmoji("Typing")).toBe("Typing");
  });

  it("normalizes case-insensitive input back to documented PascalCase", () => {
    // Users typing `fire` or `FIRE` should still get the API-accepted `Fire`,
    // not the rejected `FIRE`.
    expect(normalizeFeishuEmoji("fire")).toBe("Fire");
    expect(normalizeFeishuEmoji("FIRE")).toBe("Fire");
    expect(normalizeFeishuEmoji("thumbsdown")).toBe("ThumbsDown");
    expect(normalizeFeishuEmoji("THUMBSDOWN")).toBe("ThumbsDown");
    expect(normalizeFeishuEmoji("checkmark")).toBe("CheckMark");
    expect(normalizeFeishuEmoji("CHECKMARK")).toBe("CheckMark");
    expect(normalizeFeishuEmoji("crossmark")).toBe("CrossMark");
    expect(normalizeFeishuEmoji("CROSSMARK")).toBe("CrossMark");
    expect(normalizeFeishuEmoji("typing")).toBe("Typing");
  });

  it("normalizes case-insensitive input back to documented ALL_CAPS", () => {
    expect(normalizeFeishuEmoji("thumbsup")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji("Heart")).toBe("HEART");
    expect(normalizeFeishuEmoji("smile")).toBe("SMILE");
  });

  it("converts common unicode emojis to documented Feishu emoji_type values", () => {
    expect(normalizeFeishuEmoji("\u{1F44D}")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji("\u{1F44E}")).toBe("ThumbsDown");
    expect(normalizeFeishuEmoji("\u{2764}\u{FE0F}")).toBe("HEART");
    expect(normalizeFeishuEmoji("\u{2764}")).toBe("HEART");
    expect(normalizeFeishuEmoji("\u{1F525}")).toBe("Fire");
    expect(normalizeFeishuEmoji("\u{1F389}")).toBe("PARTY");
    expect(normalizeFeishuEmoji("\u{1F44F}")).toBe("CLAP");
    expect(normalizeFeishuEmoji("\u{274C}")).toBe("CrossMark");
    expect(normalizeFeishuEmoji("\u{2705}")).toBe("CheckMark");
  });

  it("trims whitespace before normalizing", () => {
    expect(normalizeFeishuEmoji("  THUMBSUP  ")).toBe("THUMBSUP");
    expect(normalizeFeishuEmoji(" \u{1F525} ")).toBe("Fire");
    expect(normalizeFeishuEmoji("  ThumbsDown  ")).toBe("ThumbsDown");
  });

  it("returns unknown values unchanged so Feishu surfaces a clear 231001 error", () => {
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

  it("preserves PascalCase Fire when caller passes it directly", async () => {
    const create = vi.fn().mockResolvedValue({
      code: 0,
      data: { reaction_id: "reaction-2" },
    });
    createFeishuClientMock.mockReturnValue({
      im: { messageReaction: { create } },
    });

    await addReactionFeishu({
      cfg,
      messageId: "om_msg2",
      emojiType: "Fire",
    });

    expect(create).toHaveBeenCalledWith({
      path: { message_id: "om_msg2" },
      data: { reaction_type: { emoji_type: "Fire" } },
    });
  });

  it("normalizes lowercase fire to documented PascalCase Fire (not FIRE)", async () => {
    const create = vi.fn().mockResolvedValue({
      code: 0,
      data: { reaction_id: "reaction-3" },
    });
    createFeishuClientMock.mockReturnValue({
      im: { messageReaction: { create } },
    });

    await addReactionFeishu({
      cfg,
      messageId: "om_msg3",
      emojiType: "fire",
    });

    expect(create).toHaveBeenCalledWith({
      path: { message_id: "om_msg3" },
      data: { reaction_type: { emoji_type: "Fire" } },
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
