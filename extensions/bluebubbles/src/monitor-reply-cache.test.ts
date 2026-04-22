import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetBlueBubblesShortIdState,
  rememberBlueBubblesReplyCache,
  resolveBlueBubblesMessageId,
} from "./monitor-reply-cache.js";
import { buildBlueBubblesChatContextFromTarget } from "./targets.js";

describe("resolveBlueBubblesMessageId chat-scoped short-id guard", () => {
  beforeEach(() => {
    _resetBlueBubblesShortIdState();
  });

  afterEach(() => {
    _resetBlueBubblesShortIdState();
  });

  function seedMessage(args: {
    accountId: string;
    messageId: string;
    chatGuid?: string;
    chatIdentifier?: string;
    chatId?: number;
  }) {
    return rememberBlueBubblesReplyCache({
      accountId: args.accountId,
      messageId: args.messageId,
      chatGuid: args.chatGuid,
      chatIdentifier: args.chatIdentifier,
      chatId: args.chatId,
      timestamp: Date.now(),
    });
  }

  it("returns the cached uuid when the short id resolves within the same chatGuid", () => {
    const entry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    const resolved = resolveBlueBubblesMessageId(entry.shortId, {
      requireKnownShortId: true,
      chatContext: { chatGuid: "iMessage;+;chat240698944142298252" },
    });

    expect(resolved).toBe("uuid-in-group");
  });

  it("throws when a short id points at a message in a different chatGuid", () => {
    const groupEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    // Agent tries to react in a DM but passes a short id that was allocated
    // for a group message. Should throw instead of silently letting BB
    // server route the tapback to the group (or worse, to an old DM that
    // happens to share the short id slot).
    expect(() =>
      resolveBlueBubblesMessageId(groupEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;-;+8618621181874" },
      }),
    ).toThrow(/different chat/);
  });

  it("fails open when caller cannot supply any chat identifier", () => {
    const entry = seedMessage({
      accountId: "default",
      messageId: "uuid-no-ctx",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    // Empty context means "caller could not derive any chat hint" (e.g.
    // tool invocation with only messageId). Permit resolution; downstream
    // API will still carry whatever chatGuid the call site provides.
    const resolved = resolveBlueBubblesMessageId(entry.shortId, {
      requireKnownShortId: true,
      chatContext: {},
    });
    expect(resolved).toBe("uuid-no-ctx");
  });

  it("falls back to chatIdentifier comparison when the caller has no chatGuid", () => {
    const dmEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-dm-1",
      chatIdentifier: "+8618621181874",
    });

    expect(
      resolveBlueBubblesMessageId(dmEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+8618621181874" },
      }),
    ).toBe("uuid-dm-1");

    expect(() =>
      resolveBlueBubblesMessageId(dmEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+8618621185125" },
      }),
    ).toThrow(/different chat/);
  });

  it("catches a handle-only caller against a cached entry that carries chatGuid", () => {
    // Real-world failure mode: inbound webhooks populate cached entries with
    // chatGuid (group or DM). A caller that only resolved a handle supplies
    // ctx.chatIdentifier without ctx.chatGuid. The guard must still catch
    // the mismatch so a group short-id cannot slip through when the call is
    // for a DM, which is exactly how group reactions were leaking into DMs.
    const groupEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
      chatIdentifier: "chat240698944142298252",
    });

    expect(() =>
      resolveBlueBubblesMessageId(groupEntry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatIdentifier: "+8618621181874" },
      }),
    ).toThrow(/different chat/);
  });

  it("falls back to chatId comparison when neither chatGuid nor chatIdentifier is available", () => {
    const entry = seedMessage({
      accountId: "default",
      messageId: "uuid-with-id",
      chatId: 42,
    });

    expect(
      resolveBlueBubblesMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatId: 42 },
      }),
    ).toBe("uuid-with-id");

    expect(() =>
      resolveBlueBubblesMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatId: 99 },
      }),
    ).toThrow(/different chat/);
  });

  it("accepts a full uuid input unchanged regardless of chat context", () => {
    // Non-numeric input is treated as a full GUID already; the guard does
    // not apply. Callers supplying the full GUID have presumably resolved
    // the chat themselves.
    const resolved = resolveBlueBubblesMessageId("1E7E6B6A-0000-4C6C-BCA7-000000000001", {
      requireKnownShortId: true,
      chatContext: { chatGuid: "iMessage;+;anything" },
    });
    expect(resolved).toBe("1E7E6B6A-0000-4C6C-BCA7-000000000001");
  });

  it("reports the conflicting chats in the error message for debugability", () => {
    const entry = seedMessage({
      accountId: "default",
      messageId: "uuid-in-group",
      chatGuid: "iMessage;+;chat240698944142298252",
    });

    try {
      resolveBlueBubblesMessageId(entry.shortId, {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;-;+8618621181874" },
      });
      expect.fail("expected cross-chat guard to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("iMessage;+;chat240698944142298252");
      expect(message).toContain("iMessage;-;+8618621181874");
      expect(message).toContain("full message GUID");
    }
  });

  it("still throws requireKnownShortId for unknown numeric inputs", () => {
    expect(() =>
      resolveBlueBubblesMessageId("999", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;anything" },
      }),
    ).toThrow(/no longer available/);
  });

  it("accepts same-chat short ids when the caller's target uses a non-canonical handle format", () => {
    // Real-world: a cached entry carries the BlueBubbles-normalized handle
    // (`+15551234567`) as its chatIdentifier. A tool call like
    // `react to: "imessage:(555) 123-4567"` has to project into the same
    // chatIdentifier before the guard compares — otherwise the raw handle
    // `(555) 123-4567` would fail the mismatch check against the cached
    // `+15551234567` and legitimate same-chat reactions/replies would be
    // blocked.
    const dmEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-dm-handle",
      chatIdentifier: "+15551234567",
    });
    const cachedChatIdentifier = dmEntry.chatIdentifier;

    for (const target of ["imessage:+15551234567", "sms:+15551234567", "+15551234567"]) {
      const ctx = buildBlueBubblesChatContextFromTarget(target);
      expect(ctx.chatIdentifier, `ctx.chatIdentifier for ${target}`).toBe(cachedChatIdentifier);
      expect(
        resolveBlueBubblesMessageId(dmEntry.shortId, {
          requireKnownShortId: true,
          chatContext: ctx,
        }),
        `resolve for ${target}`,
      ).toBe("uuid-dm-handle");
    }

    // Mixed-case email handle: cached as lowercase; caller supplies mixed
    // case. Still resolves.
    const emailEntry = seedMessage({
      accountId: "default",
      messageId: "uuid-email",
      chatIdentifier: "user@example.com",
    });
    const emailCtx = buildBlueBubblesChatContextFromTarget("imessage:User@Example.COM");
    expect(emailCtx.chatIdentifier).toBe("user@example.com");
    expect(
      resolveBlueBubblesMessageId(emailEntry.shortId, {
        requireKnownShortId: true,
        chatContext: emailCtx,
      }),
    ).toBe("uuid-email");
  });
});
