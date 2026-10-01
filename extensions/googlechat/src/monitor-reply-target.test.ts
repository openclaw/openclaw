// Googlechat tests cover monitor reply target behavior.
import { describe, expect, it } from "vitest";
import { normalizeGoogleChatReplyTarget } from "./monitor-reply-target.js";

const SOURCE_MESSAGE = "spaces/AAA/messages/1";
const REPLY_THREAD = "spaces/AAA/threads/1";

describe("normalizeGoogleChatReplyTarget", () => {
  // A failure in this group means the reconciliation stopped firing, so automatic
  // replies are being delivered against the inbound message resource again.
  describe("retargets the inbound source message", () => {
    it("replaces the inbound message resource with the inbound thread", () => {
      expect(
        normalizeGoogleChatReplyTarget({
          payload: { replyToId: SOURCE_MESSAGE },
          sourceMessageName: SOURCE_MESSAGE,
          replyThreadName: REPLY_THREAD,
        }),
      ).toEqual({ replyToId: REPLY_THREAD });
    });

    it("replaces it with a top-level target when there is no inbound thread", () => {
      expect(
        normalizeGoogleChatReplyTarget({
          payload: { replyToId: SOURCE_MESSAGE },
          sourceMessageName: SOURCE_MESSAGE,
          replyThreadName: undefined,
        }),
      ).toEqual({ replyToId: undefined });
    });

    it("preserves every unrelated payload field", () => {
      expect(
        normalizeGoogleChatReplyTarget({
          payload: { text: "hello", replyToTag: true, replyToId: SOURCE_MESSAGE },
          sourceMessageName: SOURCE_MESSAGE,
          replyThreadName: REPLY_THREAD,
        }),
      ).toEqual({ text: "hello", replyToTag: true, replyToId: REPLY_THREAD });
    });

    it("does not mutate the caller's payload", () => {
      const payload = { replyToId: SOURCE_MESSAGE };
      normalizeGoogleChatReplyTarget({
        payload,
        sourceMessageName: SOURCE_MESSAGE,
        replyThreadName: REPLY_THREAD,
      });
      expect(payload.replyToId).toBe(SOURCE_MESSAGE);
    });
  });

  // A failure in this group means the reconciliation became too aggressive and is
  // rewriting targets it must not own, which silently redirects replies.
  describe("returns the original payload for every other target", () => {
    it("keeps an explicit thread retarget", () => {
      const payload = { replyToId: "spaces/AAA/threads/other" };
      expect(
        normalizeGoogleChatReplyTarget({
          payload,
          sourceMessageName: SOURCE_MESSAGE,
          replyThreadName: REPLY_THREAD,
        }),
      ).toBe(payload);
    });

    it("keeps a different message resource", () => {
      const payload = { replyToId: "spaces/AAA/messages/other" };
      expect(
        normalizeGoogleChatReplyTarget({
          payload,
          sourceMessageName: SOURCE_MESSAGE,
          replyThreadName: REPLY_THREAD,
        }),
      ).toBe(payload);
    });

    it("keeps a whitespace-padded source message, because the match is exact", () => {
      const payload = { replyToId: ` ${SOURCE_MESSAGE} ` };
      expect(
        normalizeGoogleChatReplyTarget({
          payload,
          sourceMessageName: SOURCE_MESSAGE,
          replyThreadName: REPLY_THREAD,
        }),
      ).toBe(payload);
    });

    it("keeps a payload that carries no reply target", () => {
      const payload = { text: "hello" };
      expect(
        normalizeGoogleChatReplyTarget({
          payload,
          sourceMessageName: SOURCE_MESSAGE,
          replyThreadName: REPLY_THREAD,
        }),
      ).toBe(payload);
    });

    it("keeps the target when the inbound message name is unknown", () => {
      const payload = { replyToId: SOURCE_MESSAGE };
      expect(
        normalizeGoogleChatReplyTarget({
          payload,
          sourceMessageName: undefined,
          replyThreadName: REPLY_THREAD,
        }),
      ).toBe(payload);
    });

    it("keeps the target when the inbound message name is empty", () => {
      const payload = { replyToId: SOURCE_MESSAGE };
      expect(
        normalizeGoogleChatReplyTarget({
          payload,
          sourceMessageName: "",
          replyThreadName: REPLY_THREAD,
        }),
      ).toBe(payload);
    });
  });
});
