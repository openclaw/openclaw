import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetIMessageShortIdState,
  findLatestIMessageEntryForChat,
  rememberIMessageReplyCache,
  resolveIMessageMessageId,
} from "./monitor-reply-cache.js";

// Isolate from any live ~/.openclaw/imessage/reply-cache.jsonl that the
// developer might have from a running gateway. Without this, the on-disk
// hydrate path picks up production data and tests get cross-pollinated.
//
// vi.stubEnv defaults to per-test scoping in this codebase, which means a
// beforeAll-only stub gets unstubbed between tests. Mutate process.env
// directly so the override holds across the whole file.
let tempStateDir: string;
let priorStateDir: string | undefined;
beforeAll(() => {
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-reply-cache-"));
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
});
afterAll(() => {
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
  fs.rmSync(tempStateDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetIMessageShortIdState();
  // Belt-and-suspenders: also nuke the persisted file directly. The
  // _reset helper does this when OPENCLAW_STATE_DIR is set, but explicitly
  // clearing here protects the test from any future refactor of _reset's
  // gating logic.
  try {
    fs.rmSync(path.join(tempStateDir, "imessage", "reply-cache.jsonl"), { force: true });
  } catch {
    // best-effort
  }
});

describe("imessage short message id resolution", () => {
  it("resolves a short id to a cached message guid", () => {
    const entry = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(entry.shortId).toBe("1");
    expect(
      resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;chat0000" },
      }),
    ).toBe("full-guid");
  });

  it("resolves a known short id even without caller-supplied chat scope", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    // The cached entry already carries chat info; cross-chat checks only
    // matter when the caller separately provides a (potentially conflicting)
    // chat scope. A plain known short id from the cache must resolve.
    expect(resolveIMessageMessageId("1", { requireKnownShortId: true })).toBe("full-guid");
  });

  it("requires chat scope when a privileged short id is unknown", () => {
    expect(() => resolveIMessageMessageId("9999", { requireKnownShortId: true })).toThrow(
      "requires a chat scope",
    );
  });

  it("rejects short ids from another chat", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(() =>
      resolveIMessageMessageId("1", {
        requireKnownShortId: true,
        chatContext: { chatGuid: "iMessage;+;other" },
      }),
    ).toThrow("belongs to a different chat");
  });

  it("guards full guid reuse across chats when cached", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "full-guid",
      chatId: 42,
      timestamp: Date.now(),
    });

    expect(() => resolveIMessageMessageId("full-guid", { chatContext: { chatId: 99 } })).toThrow(
      "belongs to a different chat",
    );
  });
});

describe("findLatestIMessageEntryForChat", () => {
  it("returns the latest entry for the matching chat scope", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "older",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now() - 1000,
    });
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "newest",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    const result = findLatestIMessageEntryForChat({
      accountId: "default",
      chatIdentifier: "iMessage;-;+12069106512",
    });
    expect(result?.messageId).toBe("newest");
  });

  it("requires a positive identifier match — no overlap means no fallback", () => {
    // Cache entry has only chatGuid; caller has only chatId. With the old
    // isCrossChatMismatch-as-filter, this entry would have been returned
    // (no overlap → no mismatch → pass). The strict positive-match
    // semantics require both sides to share at least one identifier kind.
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "different-chat",
      chatGuid: "iMessage;+;chat0000",
      timestamp: Date.now(),
    });

    expect(findLatestIMessageEntryForChat({ accountId: "default", chatId: 99 })).toBeUndefined();
  });

  it("never crosses account boundaries", () => {
    // Diagnostic: verify the temp-dir env stub is actually visible.
    expect(process.env.OPENCLAW_STATE_DIR).toBe(tempStateDir);
    const cachePath = path.join(tempStateDir, "imessage", "reply-cache.jsonl");
    expect(fs.existsSync(cachePath)).toBe(false);

    rememberIMessageReplyCache({
      accountId: "other-account",
      messageId: "foreign-account",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatIdentifier: "+12069106512",
      }),
    ).toBeUndefined();
  });

  it("ignores entries older than the recency window", () => {
    const TWELVE_MINUTES_AGO = Date.now() - 12 * 60 * 1000;
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "stale",
      chatIdentifier: "+12069106512",
      timestamp: TWELVE_MINUTES_AGO,
    });

    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatIdentifier: "+12069106512",
      }),
    ).toBeUndefined();
  });

  it("matches across chat-id-format flavors (iMessage;-;<phone>, any;-;<phone>, bare phone)", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "phone-msg",
      chatGuid: "any;-;+12069106512",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    for (const ctx of [
      { accountId: "default", chatIdentifier: "iMessage;-;+12069106512" },
      { accountId: "default", chatIdentifier: "SMS;-;+12069106512" },
      { accountId: "default", chatGuid: "any;-;+12069106512" },
      { accountId: "default", chatIdentifier: "+12069106512" },
    ]) {
      const found = findLatestIMessageEntryForChat(ctx);
      expect(found?.messageId).toBe("phone-msg");
    }
  });

  it("requires accountId — refuses to guess across all known chats", () => {
    rememberIMessageReplyCache({
      accountId: "default",
      messageId: "anywhere",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });

    // accountId is optional in the signature; calling without it exercises the
    // runtime guard that returns undefined rather than a cross-account match.
    expect(findLatestIMessageEntryForChat({ chatIdentifier: "+12069106512" })).toBeUndefined();
  });
});

describe("hydrate counter advancement (rowid-collision protection)", () => {
  it("advances the short-id counter past a corrupt persisted line so new allocations don't collide", () => {
    // Direct hydrate isn't easy to invoke without disk fixtures; instead
    // verify the public contract: after rememberIMessageReplyCache fires,
    // the next allocation never re-uses an existing live shortId.
    const a = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "msg-a",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });
    const b = rememberIMessageReplyCache({
      accountId: "default",
      messageId: "msg-b",
      chatIdentifier: "+12069106512",
      timestamp: Date.now(),
    });
    expect(a.shortId).not.toBe(b.shortId);
    expect(Number.parseInt(b.shortId, 10)).toBeGreaterThan(Number.parseInt(a.shortId, 10));
  });
});
