import { describe, expect, it } from "vitest";
import {
  CaptionNode,
  createCaptionPage,
  onlyLine,
  onlySourcedLine,
} from "./google-meet-captions.test-support.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./types.js";

const words = "Please share the recap";
const caption = (text = words, marker?: string) =>
  new CaptionNode(`Alice\n${text}`, marker === undefined ? {} : { "data-is-self": marker });
async function observe(row = caption()) {
  const page = createCaptionPage([row]);
  await page.poll();
  return { row, page, first: onlySourcedLine(page.read().pendingLines) };
}

describe("Google Meet caption source identity and provenance", () => {
  it("retains correction provenance without reviving superseded source revisions", async () => {
    const { row, page, first } = await observe();
    expect(first.source).toEqual({
      id: expect.stringMatching(/^session-1:epoch-1:\d+$/),
      epoch: page.read().epoch,
      revision: "1",
      finalized: false,
    });
    expect(first.provenance).toMatchObject({
      observer: "google-meet-caption-dom",
      sessionId: "session-1",
      epoch: first.source.epoch,
      speaker: "Alice",
      self: "unknown",
      observationId: expect.stringContaining(":observation:"),
      observedAt: expect.any(String),
    });
    await page.poll();
    expect(onlySourcedLine(page.read().pendingLines)).toEqual(first);
    row.textContent = "Alice\nActually, wait for approval";
    page.show([row]);
    expect(onlyLine(page.read().lines)).toMatchObject({
      text: words,
      provenance: first.provenance,
    });
    expect(onlyLine(page.read().lines).source).toBeUndefined();
    const corrected = onlySourcedLine(page.read().pendingLines);
    expect(corrected.text).toBe("Actually, wait for approval");
    expect(corrected.source).toEqual({ ...first.source, revision: "2" });
    expect(corrected.provenance?.observationId).not.toBe(first.provenance?.observationId);
    const committed = page.read(true).lines;
    expect(committed.at(-1)?.provenance).toEqual(corrected.provenance);
    page.show([caption()]);
    await page.poll();
    expect(page.read().lines).toEqual(committed);
    const historical = onlyLine(page.read().pendingLines);
    expect(historical.text).toBe(words);
    expect(historical.source).toBeUndefined();
    expect(historical.provenance?.observationId).not.toBe(first.provenance?.observationId);
    expect(page.read(true).lines).toEqual([...committed, historical]);
  });

  it("retires stale duplicates without advancing their shared source", async () => {
    const row = caption();
    const stale = caption();
    const page = createCaptionPage([row, stale]);
    await page.poll();
    const source = onlySourcedLine(page.read().pendingLines.slice(0, 1)).source;
    expect(page.read().pendingLines.map((line) => line.source)).toEqual([source, source]);
    row.textContent += " after review";
    page.show([row, stale]);
    expect(page.read().pendingLines[0]?.source).toEqual({ ...source, revision: "2" });
    // Expire cross-node matching so the survivor keeps its stale lifecycle.
    page.advance(2_000);
    page.show([stale]);
    const committed = onlySourcedLine(page.read().lines);
    expect(committed).toMatchObject({
      text: words + " after review",
      source: { ...source, revision: "3", finalized: true },
    });
    expect(onlyLine(page.read().pendingLines)).toMatchObject({ text: words });
    expect(onlyLine(page.read().pendingLines).source).toBeUndefined();
    page.show([]);
    page.settle();
    expect(page.read().pendingLines).toEqual([]);
    expect(page.read().lines.map((line) => line.text)).toEqual([words + " after review", words]);
    expect(page.read().lines[0]).toEqual(committed);
    expect(page.read().lines[1]?.source).toBeUndefined();
  });

  it("does not revive a finalized source from a historical prefix in its DOM row", async () => {
    const { row, page, first } = await observe();
    row.textContent += " after review";
    page.show([row]);
    const committed = onlySourcedLine(page.read(true).lines);
    expect(committed.source).toEqual({ ...first.source, revision: "3", finalized: true });
    row.textContent = `Alice\n${words}`;
    page.show([row]);
    await page.poll();
    expect(page.read().lines).toEqual([committed]);
    const historical = onlyLine(page.read().pendingLines);
    expect(historical.text).toBe(words);
    expect(historical.source).toBeUndefined();
    expect(page.read(true).lines).toEqual([committed, historical]);
  });

  it("preserves old identities at capacity without granting authority to new captions", async () => {
    const texts = Array.from(
      { length: GOOGLE_MEET_TRANSCRIPT_MAX_LINES + 1 },
      (_, i) => `Caption ${i}`,
    );
    const page = createCaptionPage(texts.map((text) => caption(text)));
    await page.poll();
    const lines = page.read().pendingLines;
    expect(lines).toHaveLength(texts.length);
    const ids = lines.slice(0, GOOGLE_MEET_TRANSCRIPT_MAX_LINES).map((line) => line.source?.id);
    expect(ids).not.toContain(undefined);
    expect(new Set(ids).size).toBe(GOOGLE_MEET_TRANSCRIPT_MAX_LINES);
    expect(lines.at(-1)?.source).toBeUndefined();
    expect(lines.every((line) => line.provenance?.self === "unknown")).toBe(true);
    const first = onlySourcedLine(lines.slice(0, 1));
    const committed = page.read(true);
    expect(committed.pendingLines).toEqual([]);
    expect(committed.lines.map((line) => line.text)).toEqual(texts.slice(1));
    expect(committed.lines.at(-1)?.source).toBeUndefined();
    page.show([caption(first.text)]);
    expect(page.read().lines).toEqual(committed.lines);
    expect(onlySourcedLine(page.read().pendingLines).source).toEqual({
      ...first.source,
      revision: "2",
      finalized: true,
    });
    page.show([caption("Final thought")]);
    const last = onlyLine(page.read().pendingLines);
    expect(last).toMatchObject({
      text: "Final thought",
      provenance: { speaker: "Alice", self: "unknown" },
    });
    expect(last.source).toBeUndefined();
    const final = page.read(true);
    expect(final.lines).toHaveLength(GOOGLE_MEET_TRANSCRIPT_MAX_LINES);
    expect(final.lines.at(-1)).toEqual(last);
  });

  it("separates document epochs and meeting sessions", async () => {
    const { page, first } = await observe();
    page.reload();
    await page.poll();
    const reloaded = onlySourcedLine(page.read().pendingLines).source;
    expect(reloaded.id).not.toBe(first.source.id);
    expect(reloaded.epoch).not.toBe(first.source.epoch);
    await page.poll("session-2");
    const next = onlySourcedLine(page.read(false, "session-2").pendingLines).source;
    expect(next.id).toMatch(/^session-2:/);
    expect(next.id).not.toBe(reloaded.id);
    expect(page.read(false, "session-1").sessionMatched).toBe(false);
  });

  it("separates native self and other observations when a DOM row is reused", async () => {
    const row = new CaptionNode(
      `Assistant\n${words}`,
      {},
      new CaptionNode("", { "data-is-self": "true" }),
    );
    const { page, first } = await observe(row);
    expect(first.source.ownEcho).toBe(true);
    page.show([]);
    page.settle();
    row.textContent = `Alice\n${words}`;
    row.setAttribute("data-is-self", "false");
    page.advance(5_000);
    page.show([row]);
    const next = onlySourcedLine(page.read().pendingLines);
    expect(next.source.id).not.toBe(first.source.id);
    expect(next.source.ownEcho).toBe(false);
    expect(next.provenance).toMatchObject({ speaker: "Alice", self: "other" });
    expect(page.read().lines[0]?.provenance).toEqual(first.provenance);
  });

  it("does not borrow an earlier non-self marker when attribution is missing", async () => {
    const { page, first } = await observe(caption(words, "false"));
    page.show([]);
    page.settle();
    page.show([caption()]);
    const unknown = onlyLine(page.read().pendingLines);
    expect(unknown.provenance).toMatchObject({ speaker: "Alice", self: "unknown" });
    expect(unknown.source).toBeUndefined();
    expect(page.read().lines[0]?.provenance).toEqual(first.provenance);
  });

  it("keeps own-echo authority sticky through marker changes and settled rerenders", async () => {
    const { row, page, first } = await observe();
    expect(first.provenance?.self).toBe("unknown");
    page.markSelf(row, "true");
    const self = onlySourcedLine(page.read().pendingLines);
    expect(self.source).toMatchObject({ id: first.source.id, ownEcho: true });
    expect(self.provenance?.self).toBe("self");
    page.markSelf(row, "false");
    const other = onlySourcedLine(page.read().pendingLines);
    expect(other.source).toMatchObject({ id: first.source.id, ownEcho: true });
    expect(other.provenance?.self).toBe("other");
    expect(self.provenance?.self).toBe("self");
    expect(first.provenance?.self).toBe("unknown");
    page.show([]);
    page.settle();
    page.show([caption(words, "false")]);
    const replacement = onlySourcedLine(page.read().pendingLines);
    expect(replacement.source).toMatchObject({ id: first.source.id, ownEcho: true });
    expect(replacement.provenance?.self).toBe("other");
    expect(replacement.provenance?.observationId).not.toBe(other.provenance?.observationId);
    expect(page.read(true).lines.at(-1)?.source).toMatchObject({
      id: first.source.id,
      ownEcho: true,
      finalized: true,
    });
  });

  it("suppresses superseded unknown observations even after attribution appears", async () => {
    const { row, page, first } = await observe();
    row.textContent += " only after approval";
    page.show([row]);
    page.show([]);
    page.settle();
    const corrected = onlySourcedLine(page.read().lines);
    expect(corrected.source.id).toBe(first.source.id);
    expect(corrected.provenance?.self).toBe("unknown");
    page.advance(5_000);
    page.show([caption(words, "false")]);
    const historical = onlyLine(page.read().pendingLines);
    expect(historical.source).toBeUndefined();
    expect(historical.provenance).toMatchObject({ speaker: "Alice", self: "other" });
    expect(page.read(true).lines.at(-1)).toEqual(historical);
  });

  it("does not finalize a shared source while a duplicate row is still visible", async () => {
    const rows = [caption(words, "false"), caption(words, "false")];
    const page = createCaptionPage(rows);
    await page.poll();
    const initial = page.read().pendingLines;
    expect(initial[0]?.source).toEqual(initial[1]?.source);
    expect(initial[0]?.provenance?.observationId).not.toBe(initial[1]?.provenance?.observationId);
    const survivor = rows[1]!;
    page.show([survivor]);
    const retired = onlySourcedLine(page.read().lines);
    const live = onlySourcedLine(page.read().pendingLines);
    expect(retired.source).toMatchObject({ id: live.source.id, revision: "1", finalized: false });
    expect(retired.provenance).toEqual(initial[0]?.provenance);
    expect(live.provenance).toEqual(initial[1]?.provenance);
    survivor.textContent += " only after approval";
    page.show([survivor]);
    const edited = onlySourcedLine(page.read().pendingLines);
    expect(edited.source).toMatchObject({ id: live.source.id, revision: "2", finalized: false });
    expect(edited.text).toContain("only after approval");
    expect(edited.provenance?.observationId).not.toBe(live.provenance?.observationId);
    page.show([]);
    page.settle();
    expect(page.read().pendingLines).toEqual([]);
    expect(page.read().lines.at(-1)?.source).toMatchObject({ id: live.source.id, finalized: true });
    expect(page.read().lines.at(-1)?.provenance).toEqual(edited.provenance);
  });
});
