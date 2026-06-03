// Feishu tests cover bot.stripBotMention plugin behavior.
import { describe, expect, it } from "vitest";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

function makeEvent(
  text: string,
  mentions?: Array<{ key: string; name: string; id: { open_id?: string; user_id?: string } }>,
  chatType: "p2p" | "group" = "p2p",
): FeishuMessageEvent {
  return {
    sender: { sender_id: { user_id: "u1", open_id: "ou_sender" } },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  };
}

const BOT_OPEN_ID = "ou_bot";

describe("normalizeMentions (via parseFeishuMessageEvent)", () => {
  it("returns original text when mentions are missing", () => {
    const ctx = parseFeishuMessageEvent(makeEvent("hello world", undefined), BOT_OPEN_ID);
    expect(ctx.content).toBe("hello world");
  });

  it("strips bot mention in p2p (addressing prefix, not semantic content)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hello", [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello");
  });

  it("strips bot mention in group so slash commands work (#35994)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 hello",
        [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello");
  });

  it("strips bot mention in group preserving slash command prefix (#35994)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent(
        "@_bot_1 /model",
        [{ key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } }],
        "group",
      ),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("/model");
  });

  it("strips bot mention but normalizes other mentions in p2p (mention-forward)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 @_user_alice hello", [
        { key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } },
        { key: "@_user_alice", name: "Alice", id: { open_id: "ou_alice" } },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_alice">Alice</at> hello');
  });

  it("falls back to @name when open_id is absent", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ key: "@_user_1", name: "Alice", id: { user_id: "uid_alice" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Alice hi");
  });

  it("falls back to plain @name when no id is present", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_unknown hey", [{ key: "@_unknown", name: "Nobody", id: {} }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("@Nobody hey");
  });

  it("treats mention key regex metacharacters as literal text", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("hello world", [{ key: ".*", name: "Bot", id: { open_id: "ou_bot" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe("hello world");
  });

  it("normalizes multiple mentions in one pass", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 hi @_user_2", [
        { key: "@_bot_1", name: "Bot One", id: { open_id: "ou_bot_1" } },
        { key: "@_user_2", name: "User Two", id: { open_id: "ou_user_2" } },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe(
      '<at user_id="ou_bot_1">Bot One</at> hi <at user_id="ou_user_2">User Two</at>',
    );
  });

  it("treats $ in display name as literal (no replacement-pattern interpolation)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 hi", [{ key: "@_user_1", name: "$& the user", id: { open_id: "ou_x" } }]),
      BOT_OPEN_ID,
    );
    // $ is preserved literally (no $& pattern substitution); & is not escaped in tag body
    expect(ctx.content).toBe('<at user_id="ou_x">$& the user</at> hi');
  });

  it("escapes < and > in mention name to protect tag structure", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 test", [{ key: "@_user_1", name: "<script>", id: { open_id: "ou_x" } }]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('<at user_id="ou_x">&lt;script&gt;</at> test');
  });

  it("preserves non-leading self-mention as <at> tag (semantic reference)", () => {
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_user_1 interview @_bot_1, @_bot_1 answers", [
        { key: "@_user_1", name: "Interviewer", id: { open_id: "ou_interviewer" } },
        { key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } },
      ]),
      BOT_OPEN_ID,
    );
    // Bot self-mention is NOT leading (text starts with @_user_1), so both
    // occurrences are preserved as <at> tags to keep semantic context.
    expect(ctx.content).toBe(
      '<at user_id="ou_interviewer">Interviewer</at> interview <at user_id="ou_bot">Bot</at>, <at user_id="ou_bot">Bot</at> answers',
    );
  });

  it("strips leading self-mention but preserves later same-key occurrence as <at> tag", () => {
    // Feishu may deliver a single mention entry whose key appears twice in text.
    // Only the leading (addressing) occurrence should be stripped; the later one
    // carries semantic meaning and must be converted to an <at> tag.
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 请采访 @_bot_1 的设计思路", [
        { key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } },
      ]),
      BOT_OPEN_ID,
    );
    expect(ctx.content).toBe('请采访 <at user_id="ou_bot">Bot</at> 的设计思路');
  });

  it("strips only the leading self-mention, preserves later one with different key", () => {
    // Feishu gives each mention occurrence a unique key, even for the same person.
    const ctx = parseFeishuMessageEvent(
      makeEvent("@_bot_1 tell @_user_2 about @_bot_3", [
        { key: "@_bot_1", name: "Bot", id: { open_id: "ou_bot" } },
        { key: "@_user_2", name: "Other", id: { open_id: "ou_other" } },
        { key: "@_bot_3", name: "Bot", id: { open_id: "ou_bot" } },
      ]),
      BOT_OPEN_ID,
    );
    // @_bot_1 is leading self-mention → stripped; @_bot_3 is non-leading → preserved
    expect(ctx.content).toBe(
      'tell <at user_id="ou_other">Other</at> about <at user_id="ou_bot">Bot</at>',
    );
  });
});
