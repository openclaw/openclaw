// Imessage test support covers coalesce plugin behavior.
import { describe, expect, it } from "vitest";
import { combineIMessagePayloads } from "./coalesce.js";
import type { IMessagePayload } from "./types.js";

const makePayload = (overrides: Partial<IMessagePayload> = {}): IMessagePayload => ({
  guid: `msg-${Math.random().toString(36).slice(2, 10)}`,
  chat_id: 1,
  sender: "+15555550100",
  is_from_me: false,
  is_group: false,
  text: null,
  attachments: null,
  created_at: new Date(2025, 0, 1).toISOString(),
  ...overrides,
});

describe("combineIMessagePayloads", () => {
  it("throws on empty input", () => {
    expect(() => combineIMessagePayloads([])).toThrow(
      "combineIMessagePayloads: cannot combine empty payloads",
    );
  });

  it("returns the lone payload unchanged when only one entry", () => {
    const payload = makePayload({ text: "alone", guid: "solo" });
    const result = combineIMessagePayloads([payload]);
    expect(result).toBe(payload);
    expect(result.guid).toBe("solo");
  });

  it("merges two same-sender rows into one payload anchored on the first GUID", () => {
    const first = makePayload({
      id: 41,
      text: "summarize",
      guid: "row-1",
      created_at: "2025-01-01T00:00:00Z",
    });
    const second = makePayload({
      id: 42,
      text: "https://example.com/article",
      guid: "row-2",
      created_at: "2025-01-01T00:00:01.500Z",
    });
    const merged = combineIMessagePayloads([first, second]);

    expect(merged.text).toBe("summarize https://example.com/article");
    expect(merged.guid).toBe("row-1");
    expect(merged.created_at).toBe("2025-01-01T00:00:01.500Z");
    expect(merged.coalescedMessageGuids).toEqual(["row-1", "row-2"]);
    expect(merged.coalescedCatchupCursor).toEqual({
      lastSeenMs: Date.parse("2025-01-01T00:00:01.500Z"),
      lastSeenRowid: 42,
    });
  });

  it("preserves attachments instead of dropping them on merge", () => {
    const text = makePayload({ text: "Save", guid: "row-1" });
    const image = makePayload({
      text: "caption",
      guid: "row-2",
      attachments: [{ original_path: "/tmp/a.jpg", mime_type: "image/jpeg" }],
    });
    const merged = combineIMessagePayloads([text, image]);

    expect(merged.attachments).toEqual([{ original_path: "/tmp/a.jpg", mime_type: "image/jpeg" }]);
  });

  it.each([
    {
      label: "identical URL text and balloon",
      texts: ["https://example.com", "https://example.com"],
      expected: "https://example.com",
    },
    {
      label: "trimmed case variants and distinct suffixes",
      texts: ["  MIXED ", "mixed", "Mixed suffix", "mIxEd"],
      expected: "MIXED Mixed suffix",
    },
    {
      label: "Unicode lowercase expansion",
      texts: ["\u0130", "i\u0307", "tail"],
      expected: "\u0130 tail",
    },
  ])("dedupes full message text: $label", ({ texts, expected }) => {
    const merged = combineIMessagePayloads(
      texts.map((text, index) => makePayload({ text, guid: `row-${index}` })),
    );

    expect(merged.text).toBe(expected);
    expect(merged.coalescedMessageGuids).toEqual(texts.map((_, index) => `row-${index}`));
  });

  it.each([
    {
      label: "part of a later distinct message",
      texts: ["A".repeat(3000), "B".repeat(3000)],
      expected: `${"A".repeat(3000)} ${"B".repeat(999)}…[truncated]`,
    },
    {
      label: "exactly full text followed only by blanks and duplicates",
      texts: ["A".repeat(4000), " \t\n", "a".repeat(4000)],
      expected: "A".repeat(4000),
    },
    {
      label: "a distinct message after an exactly full prefix and its duplicate",
      texts: ["A".repeat(4000), "a".repeat(4000), "later"],
      expected: `${"A".repeat(4000)}…[truncated]`,
    },
    {
      label: "a surrogate pair crossing the limit",
      texts: [`${"A".repeat(3999)}😀`, "tail"],
      expected: `${"A".repeat(3999)}…[truncated]`,
    },
    {
      label: "a separator at the limit",
      texts: ["A".repeat(3999), "tail"],
      expected: `${"A".repeat(3999)} …[truncated]`,
    },
  ])("preserves the exact bounded text for $label", ({ texts, expected }) => {
    const guids = texts.map((_, index) => `row-${index}`);
    const merged = combineIMessagePayloads(
      texts.map((text, index) => makePayload({ text, guid: guids[index] })),
    );

    expect(merged.text).toBe(expected);
    expect(merged.coalescedMessageGuids).toEqual(guids);
  });

  it("keeps the first 20 attachments from the first nine and final entries", () => {
    const firstAttachment = { original_path: "/tmp/first.jpg", mime_type: "image/jpeg" };
    const latestAttachments = Array.from({ length: 25 }, (_, index) => ({
      original_path: `/tmp/latest-${index}.jpg`,
      mime_type: "image/jpeg",
    }));
    const attachmentsByRow: Record<number, IMessagePayload["attachments"]> = {
      8: [firstAttachment],
      9: [{ original_path: "/tmp/dropped.jpg", mime_type: "image/jpeg" }],
      11: latestAttachments,
    };
    const payloads = Array.from({ length: 12 }, (_, i) =>
      makePayload({
        guid: `row-${i}`,
        attachments: attachmentsByRow[i] ?? null,
      }),
    );
    const merged = combineIMessagePayloads(payloads);

    expect(merged.attachments).toEqual([firstAttachment, ...latestAttachments.slice(0, 19)]);
  });

  it("keeps first nine plus last content while preserving metadata from dropped entries", () => {
    const metadataByRow: Record<number, Partial<IMessagePayload>> = {
      9: {
        created_at: "2025-01-02T02:00:00+14:00",
        thread_originator_guid: "first-thread-parent",
        reply_to_guid: "first-reply-parent",
        reply_to_text: "first parent quote",
        reply_to_sender: "+15555550199",
      },
      10: {
        created_at: "2025-01-02T01:00:00Z",
        reply_to_guid: "later-parent",
        reply_to_text: "later parent quote",
      },
      11: { id: 999, guid: " row-0 " },
      12: { guid: " row-12 " },
    };
    const payloads = Array.from({ length: 25 }, (_, i) =>
      makePayload({
        id: i,
        text: `msg ${i}`,
        guid: `row-${i}`,
        created_at: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
        ...metadataByRow[i],
      }),
    );
    const merged = combineIMessagePayloads(payloads);

    expect(merged).toMatchObject({
      guid: "row-0",
      text: "msg 0 msg 1 msg 2 msg 3 msg 4 msg 5 msg 6 msg 7 msg 8 msg 24",
      created_at: "2025-01-02T02:00:00+14:00",
      thread_originator_guid: "first-thread-parent",
      reply_to_guid: "first-reply-parent",
      reply_to_text: "first parent quote",
      reply_to_sender: "+15555550199",
      coalescedCatchupCursor: {
        lastSeenMs: Date.parse("2025-01-02T01:00:00Z"),
        lastSeenRowid: 999,
      },
    });
    expect(merged.coalescedMessageGuids).toEqual(
      Array.from({ length: 25 }, (_, i) => `row-${i}`).filter((guid) => guid !== "row-11"),
    );
  });

  it("preserves reply context from any entry that carries one", () => {
    const noReply = makePayload({ text: "hello", guid: "row-1" });
    const reply = makePayload({
      text: "follow-up",
      guid: "row-2",
      reply_to_guid: "parent-msg",
      reply_to_text: "earlier",
      reply_to_sender: "+15555550199",
    });
    const merged = combineIMessagePayloads([noReply, reply]);

    expect(merged.reply_to_guid).toBe("parent-msg");
    expect(merged.reply_to_text).toBe("earlier");
    expect(merged.reply_to_sender).toBe("+15555550199");
  });

  it.each([
    { reply_to_guid: "reply-parent" },
    { thread_originator_guid: "thread-parent" },
    { reply_to_guid: "reply-parent", thread_originator_guid: "thread-parent" },
  ])("preserves the complete real provider reply tuple from a later row", (parent) => {
    const first = makePayload({ text: "hello", guid: "row-1" });
    const reply = makePayload({
      text: "follow-up",
      guid: "row-2",
      ...parent,
      reply_to_text: "the original question",
      reply_to_sender: "+15555550199",
    });
    const merged = combineIMessagePayloads([first, reply]);

    expect(merged).toMatchObject({
      ...parent,
      reply_to_text: "the original question",
      reply_to_sender: "+15555550199",
    });
  });

  it("keeps the parent GUID and quote metadata from the same reply row", () => {
    const first = makePayload({
      text: "first",
      guid: "row-1",
      reply_to_text: "unrelated stale quote",
      reply_to_sender: "+15555550001",
    });
    const reply = makePayload({
      text: "second",
      guid: "row-2",
      thread_originator_guid: "thread-parent",
      reply_to_guid: "reply-parent",
      reply_to_text: "actual parent question",
      reply_to_sender: "+15555550199",
    });

    expect(combineIMessagePayloads([first, reply])).toMatchObject({
      thread_originator_guid: "thread-parent",
      reply_to_guid: "reply-parent",
      reply_to_text: "actual parent question",
      reply_to_sender: "+15555550199",
    });
  });

  it("does not set coalescedMessageGuids when no entry carries a GUID", () => {
    const a = makePayload({ text: "a", guid: null });
    const b = makePayload({ text: "b", guid: null });
    const merged = combineIMessagePayloads([a, b]);

    expect(merged.coalescedMessageGuids).toBeUndefined();
  });
});
