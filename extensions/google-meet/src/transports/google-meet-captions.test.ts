import { describe, expect, it } from "vitest";
import {
  CaptionNode,
  createCaptionPage,
  GUEST_NAME,
  onlyLine,
  onlySourcedLine,
} from "./google-meet-captions.test-support.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./types.js";

describe("Google Meet caption source identity", () => {
  it("retains identity through polls and a non-prefix correction in the same row", async () => {
    const row = new CaptionNode("Alice\nPlease use the blue version");
    const page = createCaptionPage([row]);
    await page.poll();
    const initial = page.read();
    const source = onlySourcedLine(initial.pendingLines).source;
    expect(initial.lines).toEqual([]);
    expect(source).toEqual({
      id: expect.stringMatching(/^session-1:epoch-1:\d+$/),
      epoch: initial.epoch,
      revision: "1",
      finalized: false,
    });

    await page.poll();
    expect(onlySourcedLine(page.read().pendingLines).source).toEqual(source);

    row.textContent = "Alice\nActually, use the green version";
    page.show([row]);
    const corrected = page.read();
    const previous = onlyLine(corrected.lines);
    const line = onlySourcedLine(corrected.pendingLines);
    expect(previous.text).toBe("Please use the blue version");
    expect(previous.source).toBeUndefined();
    expect(previous.provenance).toEqual(initial.pendingLines[0]?.provenance);
    expect(line.text).toBe("Actually, use the green version");
    expect(line.source).toEqual({ ...source, revision: "2", finalized: false });
    await page.poll();
    expect(onlySourcedLine(page.read().pendingLines).source).toEqual(line.source);
    expect(page.read().lines).toEqual(corrected.lines);
  });

  it.each(["explicit", "settle"] as const)(
    "advances the same source revision when %s finalization commits a caption",
    async (method) => {
      const row = new CaptionNode("Alice\nThe recap is ready");
      const page = createCaptionPage([row]);
      await page.poll();
      const source = onlySourcedLine(page.read().pendingLines).source;
      if (method === "settle") {
        page.show([]);
        expect(onlySourcedLine(page.read().pendingLines).source).toEqual(source);
        page.settle();
      }
      const committed = page.read(method === "explicit");
      const line = onlySourcedLine(committed.lines);
      expect(committed.pendingLines).toEqual([]);
      expect(line.source).toMatchObject({ id: source.id, epoch: source.epoch, finalized: true });
      expect(line.source.revision).not.toBe(source.revision);
      expect(page.read(true).lines).toEqual(committed.lines);
    },
  );

  it.each(["explicit", "settle"] as const)(
    "keeps identity when a caption extends after %s finalization",
    async (method) => {
      const row = new CaptionNode("Alice\nPlease share the recap");
      const page = createCaptionPage([row]);
      await page.poll();
      if (method === "settle") {
        page.show([]);
        page.settle();
      }
      const committed = onlySourcedLine(page.read(method === "explicit").lines);
      row.textContent = "Alice (guest)\nPlease share the recap after the meeting";
      page.show([row]);
      const extended = page.read();
      const pending = onlySourcedLine(extended.pendingLines);
      expect(extended.lines).toEqual([committed]);
      expect(pending.speaker).toBe("Alice (guest)");
      expect(pending.text).toBe("Please share the recap after the meeting");
      expect(pending.source).toEqual({
        ...committed.source,
        revision: "3",
        finalized: false,
      });
      await page.poll();
      expect(onlySourcedLine(page.read().pendingLines).source).toEqual(pending.source);
    },
  );

  it.each(["same", "replacement"] as const)(
    "does not issue a new source when a committed caption returns in a %s DOM node",
    async (nodeKind) => {
      const row = new CaptionNode("Alice\nPlease share the recap");
      const page = createCaptionPage([row]);
      await page.poll();
      page.show([]);
      page.settle();
      const committed = onlySourcedLine(page.read().lines);
      const reinserted = nodeKind === "same" ? row : new CaptionNode("Bob\nPlease share the recap");
      page.show([reinserted]);
      await page.poll();
      const returning = page.read();
      const pending = onlySourcedLine(returning.pendingLines);
      expect(pending.speaker).toBe(nodeKind === "same" ? "Alice" : "Bob");
      expect(pending.source).toEqual(committed.source);
      expect(returning.lines).toEqual([committed]);
      const finalized = page.read(true);
      expect(finalized.pendingLines).toEqual([]);
      expect(finalized.lines.length).toBeGreaterThanOrEqual(1);
      expect(finalized.lines.every((line) => line.source?.id === committed.source.id)).toBe(true);
      expect(
        finalized.lines.every((line) => line.source?.revision === committed.source.revision),
      ).toBe(true);
    },
  );

  it("preserves stale historical text without reviving its superseded source revision", async () => {
    const originalText = "Alice\nPlease use the blue version";
    const row = new CaptionNode(originalText);
    const page = createCaptionPage([row]);
    await page.poll();
    const original = onlySourcedLine(page.read().pendingLines);
    row.textContent = "Alice\nActually, use the green version";
    page.show([row]);
    const corrected = page.read();
    const previous = onlyLine(corrected.lines);
    const pending = onlySourcedLine(corrected.pendingLines);
    expect(previous.source).toBeUndefined();
    expect(previous.provenance).toEqual(original.provenance);
    expect(pending.source.id).toBe(original.source.id);
    expect(pending.source.revision).not.toBe(original.source.revision);
    const committed = page.read(true).lines;

    page.show([new CaptionNode(originalText)]);
    const returning = page.read();
    expect(returning.lines).toEqual(committed);
    expect(onlyLine(returning.pendingLines).text).toBe("Please use the blue version");
    expect(onlyLine(returning.pendingLines)).not.toHaveProperty("source");
    await page.poll();
    expect(onlyLine(page.read().pendingLines)).not.toHaveProperty("source");
    const final = page.read(true);
    expect(final.pendingLines).toEqual([]);
    expect(final.lines.slice(0, -1)).toEqual(committed);
    expect(final.lines.at(-1)).toMatchObject({ text: "Please use the blue version" });
    expect(final.lines.at(-1)).not.toHaveProperty("source");
  });

  it("commits a stale duplicate as transcript text without advancing its shared source", async () => {
    const firstRow = new CaptionNode("Alice\nPlease share");
    const staleRow = new CaptionNode("Alice\nPlease share");
    const page = createCaptionPage([firstRow, staleRow]);
    await page.poll();
    const initial = page.read();
    const source = onlySourcedLine(initial.pendingLines.slice(0, 1)).source;
    expect(initial.pendingLines).toHaveLength(2);
    expect(initial.pendingLines.map((line) => line.source)).toEqual([source, source]);
    expect(source.revision).toBe("1");

    firstRow.textContent = "Alice\nPlease share after review";
    page.show([firstRow, staleRow]);
    const extended = page.read();
    expect(onlySourcedLine(extended.pendingLines.slice(0, 1)).source).toEqual({
      ...source,
      revision: "2",
    });
    // Expire cross-node matching so the surviving row keeps its own stale lifecycle.
    page.advance(2_000);
    page.show([staleRow]);
    const remaining = page.read();
    const committed = onlySourcedLine(remaining.lines);
    expect(committed.text).toBe("Please share after review");
    expect(committed.source).toEqual({ ...source, revision: "3", finalized: true });
    expect(onlyLine(remaining.pendingLines).text).toBe("Please share");
    expect(onlyLine(remaining.pendingLines)).not.toHaveProperty("source");

    page.show([]);
    page.settle();
    const finalized = page.read();
    expect(finalized.pendingLines).toEqual([]);
    expect(finalized.lines.map((line) => line.text)).toEqual([
      "Please share after review",
      "Please share",
    ]);
    expect(finalized.lines[0]).toEqual(committed);
    expect(finalized.lines[1]).not.toHaveProperty("source");
  });

  it("does not revive a finalized source when its DOM row returns with a historical prefix", async () => {
    const row = new CaptionNode("Alice\nPlease share");
    const page = createCaptionPage([row]);
    await page.poll();
    const original = onlySourcedLine(page.read().pendingLines).source;
    row.textContent = "Alice\nPlease share after review";
    page.show([row]);
    const committed = onlySourcedLine(page.read(true).lines);
    expect(committed.source).toEqual({ ...original, revision: "3", finalized: true });

    row.textContent = "Alice\nPlease share";
    page.show([row]);
    const returning = page.read();
    expect(returning.lines).toEqual([committed]);
    expect(onlyLine(returning.pendingLines).text).toBe("Please share");
    expect(onlyLine(returning.pendingLines)).not.toHaveProperty("source");
    await page.poll();
    expect(onlyLine(page.read().pendingLines)).not.toHaveProperty("source");
    const finalized = page.read(true);
    expect(finalized.lines.map((line) => line.text)).toEqual([
      "Please share after review",
      "Please share",
    ]);
    expect(finalized.lines[0]).toEqual(committed);
    expect(finalized.lines[1]).not.toHaveProperty("source");
  });

  it("retains old identities at capacity while preserving new captions without source authority", async () => {
    const texts = Array.from(
      { length: GOOGLE_MEET_TRANSCRIPT_MAX_LINES + 1 },
      (_, index) => `Caption number ${index}`,
    );
    const page = createCaptionPage(texts.map((text) => new CaptionNode(`Alice\n${text}`)));
    await page.poll();
    const initial = page.read();
    expect(initial.pendingLines).toHaveLength(texts.length);
    const sourceIds = initial.pendingLines
      .slice(0, GOOGLE_MEET_TRANSCRIPT_MAX_LINES)
      .map((line) => line.source?.id);
    expect(sourceIds).not.toContain(undefined);
    expect(new Set(sourceIds).size).toBe(GOOGLE_MEET_TRANSCRIPT_MAX_LINES);
    expect(initial.pendingLines.at(-1)).not.toHaveProperty("source");
    expect(initial.pendingLines.every((line) => line.provenance?.self === "unknown")).toBe(true);
    const original = onlySourcedLine(initial.pendingLines.slice(0, 1));

    const committed = page.read(true);
    expect(committed.pendingLines).toEqual([]);
    expect(committed.lines).toHaveLength(GOOGLE_MEET_TRANSCRIPT_MAX_LINES);
    expect(committed.lines.map((line) => line.text)).toEqual(texts.slice(1));
    expect(committed.lines.at(-1)).not.toHaveProperty("source");

    page.show([new CaptionNode(`Alice\n${original.text}`)]);
    const returning = page.read();
    expect(returning.lines).toEqual(committed.lines);
    expect(onlySourcedLine(returning.pendingLines).source).toEqual({
      ...original.source,
      revision: "2",
      finalized: true,
    });

    const nextText = "A separate final thought";
    page.show([new CaptionNode(`Alice\n${nextText}`)]);
    const pending = onlyLine(page.read().pendingLines);
    expect(pending.text).toBe(nextText);
    expect(pending).not.toHaveProperty("source");
    expect(pending.provenance).toMatchObject({ speaker: "Alice", self: "unknown" });
    const finalized = page.read(true);
    expect(finalized.lines).toHaveLength(GOOGLE_MEET_TRANSCRIPT_MAX_LINES);
    expect(finalized.lines.at(-1)).toMatchObject({ text: nextText });
    expect(finalized.lines.at(-1)).not.toHaveProperty("source");
  });

  it.each([
    { text: "Please share the recap", repeated: true },
    { text: "The next discussion is about staffing", repeated: false },
  ])("distinguishes settled text with repeated=$repeated", async ({ text, repeated }) => {
    const row = new CaptionNode("Alice\nPlease share the recap");
    const page = createCaptionPage([row]);
    await page.poll();
    page.show([]);
    page.settle();
    const committed = onlySourcedLine(page.read().lines);
    row.textContent = `Alice\n${text}`;
    page.show([row]);
    const returning = page.read();
    const pending = onlySourcedLine(returning.pendingLines);
    expect(returning.lines).toEqual([committed]);
    expect(pending.text).toBe(text);
    if (repeated) {
      expect(pending.source).toEqual(committed.source);
    } else {
      expect(pending.source.id).not.toBe(committed.source.id);
      expect(pending.source).toMatchObject({
        epoch: committed.source.epoch,
        revision: "1",
        finalized: false,
      });
    }
  });

  it("does not reuse source identity across document epochs or meeting sessions", async () => {
    const page = createCaptionPage([new CaptionNode("Alice\nPlease share the recap")]);
    await page.poll();
    const original = onlySourcedLine(page.read().pendingLines).source;
    page.reload();
    await page.poll();
    const reloaded = onlySourcedLine(page.read().pendingLines).source;
    expect(reloaded.id).not.toBe(original.id);
    expect(reloaded.epoch).not.toBe(original.epoch);
    await page.poll("session-2");
    const nextSession = onlySourcedLine(page.read(false, "session-2").pendingLines).source;
    expect(nextSession.id).toMatch(/^session-2:/);
    expect(nextSession.id).not.toBe(reloaded.id);
    expect(page.read(false, "session-1").sessionMatched).toBe(false);
  });

  it.each([
    { placement: "row", marker: "true", expected: true },
    { placement: "row", marker: "false", expected: false },
    { placement: "ancestor", marker: "true", expected: true },
    { placement: "ancestor", marker: "false", expected: false },
  ])("reads native self identity from a $placement marked $marker", async (params) => {
    const attributes = { "data-is-self": params.marker };
    const row =
      params.placement === "row"
        ? new CaptionNode("Alice\nPlease share the recap", attributes)
        : new CaptionNode(
            "Alice\nPlease share the recap",
            {},
            new CaptionNode("", { ...attributes, "data-participant-id": "participant-1" }),
          );
    const page = createCaptionPage([row]);
    await page.poll();
    expect(onlySourcedLine(page.read().pendingLines).source.ownEcho).toBe(params.expected);
    expect(onlySourcedLine(page.read(true).lines).source.ownEcho).toBe(params.expected);
  });

  it.each([
    { speaker: "You", marker: undefined },
    { speaker: GUEST_NAME, marker: undefined },
    { speaker: "Alice", marker: "TRUE" },
    { speaker: "Alice", marker: "1" },
  ])(
    "leaves self identity unknown for $speaker with marker $marker",
    async ({ speaker, marker }) => {
      const row = new CaptionNode(
        `${speaker}\nPlease share the recap`,
        marker === undefined ? {} : { "data-is-self": marker },
      );
      const page = createCaptionPage([row]);
      await page.poll();
      expect(onlySourcedLine(page.read().pendingLines).source).not.toHaveProperty("ownEcho");
      expect(onlySourcedLine(page.read(true).lines).source).not.toHaveProperty("ownEcho");
    },
  );
});
