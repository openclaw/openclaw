import { describe, expect, it } from "vitest";
import { resolveFeishuReplyRouting } from "./bot-content.js";

const BASE = {
  isGroup: true,
  isTopicSession: false,
  configReplyInThread: false,
  messageId: "om_msg",
  rootId: "om_root",
  replyTargetMessageId: undefined,
  suppressReplyTarget: false,
  groupThreadReply: true,
  groupReplyInThread: true,
} as const;

describe("resolveFeishuReplyRouting", () => {
  it("keeps the quote target but never threads for a bot-authored trigger in a normal group", () => {
    const r = resolveFeishuReplyRouting({ ...BASE, senderType: "bot" });
    // quote/reply target preserved → inline quote + typing reaction stay
    expect(r.replyTargetMessageId).toBe("om_msg");
    // thread flags forced off → no Feishu topic collapse
    expect(r.dispatchRootId).toBeUndefined();
    expect(r.dispatchReplyInThread).toBe(false);
    expect(r.threadReply).toBe(false);
  });

  it("uses the inbound reply target over the message id when present (bot trigger)", () => {
    const r = resolveFeishuReplyRouting({
      ...BASE,
      senderType: "bot",
      replyTargetMessageId: "om_explicit",
    });
    expect(r.replyTargetMessageId).toBe("om_explicit");
    expect(r.dispatchReplyInThread).toBe(false);
  });

  it("keeps the reply-target for a user trigger (unchanged behavior)", () => {
    const r = resolveFeishuReplyRouting({ ...BASE, senderType: "user" });
    expect(r.replyTargetMessageId).toBe("om_msg");
    expect(r.dispatchRootId).toBe("om_root");
    expect(r.dispatchReplyInThread).toBe(true);
    expect(r.threadReply).toBe(true);
  });

  it("does NOT suppress a bot trigger when topic-session scope is active", () => {
    const r = resolveFeishuReplyRouting({ ...BASE, senderType: "bot", isTopicSession: true });
    // topic path replies to the root so the bot stays in the thread
    expect(r.replyTargetMessageId).toBe("om_root");
    expect(r.dispatchRootId).toBe("om_root");
    expect(r.dispatchReplyInThread).toBe(true);
  });

  it("does NOT suppress a bot trigger when replyInThread config is enabled", () => {
    const r = resolveFeishuReplyRouting({ ...BASE, senderType: "bot", configReplyInThread: true });
    expect(r.replyTargetMessageId).toBe("om_root");
    expect(r.dispatchReplyInThread).toBe(true);
  });

  it("honors suppressReplyTarget for a user trigger", () => {
    const r = resolveFeishuReplyRouting({ ...BASE, senderType: "user", suppressReplyTarget: true });
    expect(r.replyTargetMessageId).toBeUndefined();
  });

  it("never threads in a DM regardless of sender", () => {
    const r = resolveFeishuReplyRouting({ ...BASE, isGroup: false, senderType: "bot" });
    expect(r.replyTargetMessageId).toBe("om_msg");
    expect(r.dispatchReplyInThread).toBe(false);
    expect(r.threadReply).toBe(false);
  });
});
