import { describe, expect, it, beforeEach } from "vitest";
import { clearMSTeamsSentMessageCache, recordMSTeamsSentMessage } from "../sent-message-cache.js";
import { computeImplicitMention } from "./implicit-mention.js";

describe("implicit mention detection (conversation.id threadRootId fallback)", () => {
  const CONV_ID = "19:group@thread.tacv2";
  const BOT_MSG_ID = "1709000000000";

  beforeEach(() => {
    clearMSTeamsSentMessageCache();
  });

  it("detects implicit mention via replyToId (existing behavior)", () => {
    recordMSTeamsSentMessage(CONV_ID, BOT_MSG_ID);

    const result = computeImplicitMention({
      conversation: { id: CONV_ID },
      replyToId: BOT_MSG_ID,
    });

    expect(result).toBe(true);
  });

  it("detects implicit mention via conversation.id ;messageid= when replyToId is absent", () => {
    recordMSTeamsSentMessage(CONV_ID, BOT_MSG_ID);

    // Thread reply where Teams puts the thread root ID in conversation.id
    // but does NOT set replyToId (the bug scenario this fix addresses)
    const result = computeImplicitMention({
      conversation: { id: `${CONV_ID};messageid=${BOT_MSG_ID}` },
      // no replyToId
    });

    expect(result).toBe(true);
  });

  it("does NOT trigger when conversation.id messageid is not in the sent cache", () => {
    // Bot never sent a message with this ID
    const result = computeImplicitMention({
      conversation: { id: `${CONV_ID};messageid=unknown-msg-id` },
    });

    expect(result).toBe(false);
  });

  it("replyToId match takes precedence (both present, only replyToId in cache)", () => {
    const replyTargetId = "1709000001111";
    recordMSTeamsSentMessage(CONV_ID, replyTargetId);
    // threadRootId (from conversation.id) is NOT in cache

    const result = computeImplicitMention({
      conversation: { id: `${CONV_ID};messageid=${BOT_MSG_ID}` },
      replyToId: replyTargetId,
    });

    expect(result).toBe(true);
  });

  it("threadRootId fallback works when replyToId is present but not in cache", () => {
    recordMSTeamsSentMessage(CONV_ID, BOT_MSG_ID);
    // replyToId points to a message NOT sent by bot

    const result = computeImplicitMention({
      conversation: { id: `${CONV_ID};messageid=${BOT_MSG_ID}` },
      replyToId: "some-other-users-message",
    });

    expect(result).toBe(true);
  });

  it("does NOT trigger for top-level messages (no messageid suffix, no replyToId)", () => {
    recordMSTeamsSentMessage(CONV_ID, BOT_MSG_ID);

    const result = computeImplicitMention({
      conversation: { id: CONV_ID },
      // no replyToId, no ;messageid= suffix
    });

    expect(result).toBe(false);
  });

  it("does NOT trigger when conversation.id is empty", () => {
    const result = computeImplicitMention({
      conversation: { id: "" },
      replyToId: BOT_MSG_ID,
    });

    expect(result).toBe(false);
  });

  it("does NOT trigger when conversation is undefined", () => {
    const result = computeImplicitMention({});

    expect(result).toBe(false);
  });
});
