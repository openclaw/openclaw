import { describe, expect, it } from "vitest";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { createFeishuTestEvent } from "./bot.test-support.js";

const bot = "ou_bot";
type Mention = NonNullable<FeishuMessageEvent["message"]["mentions"]>[number];
const mention = (key: string, name: string, open_id: string): Mention => ({
  key,
  name,
  id: { open_id },
});
function parse(
  text: string,
  mentions?: Mention[],
  chatType: "p2p" | "group" = "group",
  botId = bot,
) {
  return parseFeishuMessageEvent(
    createFeishuTestEvent({
      messageId: "message",
      chatType,
      text,
      message: { mentions },
    }),
    botId,
  );
}
function post(content: unknown, botId = bot) {
  return parseFeishuMessageEvent(
    createFeishuTestEvent({
      messageId: "post",
      chatType: "group",
      messageType: "post",
      content: JSON.stringify(content),
    }),
    botId,
  );
}

describe("Feishu inbound mentions", () => {
  it.each(["p2p", "group"] as const)(
    "preserves mention identities and literal names in %s",
    (chatType) => {
      const mentions = [
        mention("@_user_1", "Bot", bot),
        mention("@_user_10", "Alice @_user_1", "ou_alice"),
        mention("@_user_11", "$& <Bob>", "ou_bob"),
        mention("@_all", "all", "all"),
      ];
      const before = structuredClone(mentions);
      const ctx = parse("@_user_1 @_user_10 @_user_11thanks @_all", mentions, chatType);
      expect(ctx.content).toBe(
        '<at user_id="ou_alice">Alice @_user_1</at> <at user_id="ou_bob">$& &lt;Bob&gt;</at>thanks <at user_id="all">all</at>',
      );
      expect(ctx.mentionedBot).toBe(true);
      expect(ctx.mentionTargets).toEqual([
        { openId: "ou_alice", name: "Alice @_user_1", key: "@_user_10" },
        { openId: "ou_bob", name: "$& <Bob>", key: "@_user_11" },
      ]);
      expect(mentions).toEqual(before);
    },
  );

  it("strips bot addressing without consuming slash commands (#35994)", () => {
    expect(parse("@_bot /model", [mention("@_bot", "Alias", bot)]).content).toBe("/model");
  });

  it("treats mention keys and names as literal text", () => {
    expect(parse("@NotBot hello", [mention(".*", ".*", bot)]).content).toBe("@NotBot hello");
  });

  it("falls back to display name when the mention has no open ID", () => {
    expect(
      parse("@_user hi", [{ key: "@_user", name: "Alice", id: { user_id: "uid_alice" } }], "p2p")
        .content,
    ).toBe("@Alice hi");
  });

  it("does not create forward targets without a known bot identity", () => {
    const ctx = parse("@_alice hi", [mention("@_alice", "Alice", "ou_alice")], "p2p", "  ");
    expect(ctx.mentionedBot).toBe(false);
    expect(ctx.mentionTargets).toBeUndefined();
  });

  it("does not treat broadcast metadata as a bot mention", () => {
    expect(parse("@_all", [mention("@_all", "all", "all")], "group", "all").mentionedBot).toBe(
      false,
    );
  });

  it("parses empty text with mention metadata", () => {
    const event = createFeishuTestEvent({
      messageId: "empty",
      chatType: "group",
      content: "",
      message: { mentions: [mention("@_bot", "Bot", bot)] },
    });
    expect(parseFeishuMessageEvent(event, bot)).toMatchObject({
      content: "",
      chatType: "group",
      mentionedBot: true,
      hasAnyMention: true,
    });
  });

  it("preserves post code while ignoring broadcast-only addressing", () => {
    const ctx = post(
      {
        content: [
          [
            { tag: "at", user_id: "ou_other", user_name: "Other" },
            { tag: "at", user_id: "all", user_name: "all" },
            { tag: "text", text: "before " },
            { tag: "code", text: "inline()" },
          ],
          [{ tag: "code_block", language: "ts", text: "const x = 1;" }],
        ],
      },
      "all",
    );
    expect(ctx.mentionedBot).toBe(false);
    expect(ctx.content).toContain("before `inline()`");
    expect(ctx.content).toContain("```ts\nconst x = 1;\n```");
  });

  it("detects a post bot mention alongside broadcast addressing", () => {
    expect(
      post({
        content: [
          [
            { tag: "at", user_id: "all", user_name: "all" },
            { tag: "at", user_id: bot, user_name: "Bot" },
          ],
        ],
      }).mentionedBot,
    ).toBe(true);
  });

  it.each([
    [{ body: "Merged message", share_chat_id: "sc_123" }, "Merged message"],
    [{ share_chat_id: "sc_123" }, "[Forwarded message: sc_123]"],
  ])("parses shared conversations: %j", (content, expected) => {
    const event = createFeishuTestEvent({
      messageId: "share",
      messageType: "share_chat",
      content: JSON.stringify(content),
    });
    expect(parseFeishuMessageEvent(event).content).toBe(expected);
  });
});
