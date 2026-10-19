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
const combineTexts = (texts: string[]) =>
  combineIMessagePayloads(texts.map((text, i) => makePayload({ text, guid: `row-${i}` }))).text;
const attachment = (name: string) => ({
  original_path: `/tmp/${name}.jpg`,
  mime_type: "image/jpeg",
});
const a = (length: number) => "A".repeat(length);
const quote = { reply_to_text: "the original question", reply_to_sender: "+15555550199" };

describe("combineIMessagePayloads", () => {
  it("throws on empty input", () => {
    expect(() => combineIMessagePayloads([])).toThrow(
      "combineIMessagePayloads: cannot combine empty payloads",
    );
  });

  it("returns the lone payload unchanged when only one entry", () => {
    const payload = makePayload({ text: "alone", guid: "solo" });
    expect(combineIMessagePayloads([payload])).toBe(payload);
  });

  it("merges two same-sender rows into one payload anchored on the first GUID", () => {
    const first = makePayload({
      text: "summarize",
      guid: "row-1",
      created_at: "2025-01-01T00:00:00Z",
    });
    const second = makePayload({
      text: "https://example.com/article",
      guid: "row-2",
      created_at: "2025-01-01T00:00:01.500Z",
    });
    expect(combineIMessagePayloads([first, second])).toMatchObject({
      text: "summarize https://example.com/article",
      guid: "row-1",
      created_at: "2025-01-01T00:00:01.500Z",
    });
  });

  it("preserves attachments instead of dropping them on merge", () => {
    const text = makePayload({ text: "Save", guid: "row-1" });
    const image = makePayload({
      text: "caption",
      guid: "row-2",
      attachments: [attachment("a")],
    });
    expect(combineIMessagePayloads([text, image]).attachments).toEqual([attachment("a")]);
  });

  it.each([
    ["URL balloon", ["https://example.com", "https://example.com"], "https://example.com"],
    ["case/trim, not suffix", ["  MIXED ", "mixed", "Mixed suffix", "mIxEd"], "MIXED Mixed suffix"],
    ["Unicode lowercase expansion", ["\u0130", "i\u0307", "tail"], "\u0130 tail"],
  ] satisfies [string, string[], string][])(
    "dedupes full message text: %s",
    (_, texts, expected) => {
      expect(combineTexts(texts)).toBe(expected);
    },
  );

  it.each([
    [
      "partial later text",
      [a(3000), "B".repeat(3000)],
      `${a(3000)} ${"B".repeat(999)}…[truncated]`,
    ],
    ["full, blanks, duplicate", [a(4000), " \t\n", "a".repeat(4000)], a(4000)],
    ["full, duplicate, later", [a(4000), "a".repeat(4000), "later"], `${a(4000)}…[truncated]`],
    ["surrogate at limit", [`${a(3999)}😀`, "tail"], `${a(3999)}…[truncated]`],
    ["separator at limit", [a(3999), "tail"], `${a(3999)} …[truncated]`],
  ] satisfies [string, string[], string][])(
    "preserves the exact bounded text for %s",
    (_, texts, expected) => {
      expect(combineTexts(texts)).toBe(expected);
    },
  );

  it("keeps the first 20 attachments from the first nine and final entries", () => {
    const firstAttachment = attachment("first");
    const latestAttachments = Array.from({ length: 25 }, (_, index) =>
      attachment(`latest-${index}`),
    );
    const attachmentsByRow: Record<number, IMessagePayload["attachments"]> = {
      8: [firstAttachment],
      9: [attachment("dropped")],
      11: latestAttachments,
    };
    const payloads = Array.from({ length: 12 }, (_, i) =>
      makePayload({ guid: `row-${i}`, attachments: attachmentsByRow[i] ?? null }),
    );
    expect(combineIMessagePayloads(payloads).attachments).toEqual([
      firstAttachment,
      ...latestAttachments.slice(0, 19),
    ]);
  });

  it("keeps first nine plus last content while preserving metadata from dropped entries", () => {
    const metadataByRow: Record<number, Partial<IMessagePayload>> = {
      9: {
        created_at: "2025-01-02T02:00:00+14:00",
        thread_originator_guid: "first-thread-parent",
        reply_to_guid: "first-reply-parent",
        ...quote,
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
    expect(combineIMessagePayloads(payloads)).toMatchObject({
      guid: "row-0",
      text: "msg 0 msg 1 msg 2 msg 3 msg 4 msg 5 msg 6 msg 7 msg 8 msg 24",
      created_at: "2025-01-02T02:00:00+14:00",
      thread_originator_guid: "first-thread-parent",
      reply_to_guid: "first-reply-parent",
      ...quote,
    });
  });

  it.each([{ reply_to_guid: "reply-parent" }, { thread_originator_guid: "thread-parent" }])(
    "preserves the complete real provider reply tuple from a later row",
    (parent) => {
      const first = makePayload({ text: "hello", guid: "row-1" });
      const reply = makePayload({ text: "follow-up", guid: "row-2", ...parent, ...quote });
      expect(combineIMessagePayloads([first, reply])).toMatchObject({ ...parent, ...quote });
    },
  );

  it("keeps the parent GUID and quote metadata from the same reply row", () => {
    const first = makePayload({
      text: "first",
      guid: "row-1",
      reply_to_text: "unrelated stale quote",
      reply_to_sender: "+15555550001",
    });
    const parent = {
      thread_originator_guid: "thread-parent",
      reply_to_guid: "reply-parent",
      ...quote,
    };
    const reply = makePayload({ text: "second", guid: "row-2", ...parent });
    expect(combineIMessagePayloads([first, reply])).toMatchObject(parent);
  });
});
