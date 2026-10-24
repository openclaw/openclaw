import { expect, it } from "vitest";
import {
  CaptionNode,
  createCaptionPage,
  onlyLine,
  onlySourcedLine,
} from "./google-meet-captions.test-support.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES as maxLines } from "./types.js";

const words = "Please share the recap";
const caption = (text = words, marker?: string) =>
  new CaptionNode(`Alice\n${text}`, marker === undefined ? {} : { "data-is-self": marker });
type Page = ReturnType<typeof createCaptionPage>;
const pending = (page: Page) => onlySourcedLine(page.read().pendingLines);
const lines = (page: Page) => page.read().lines;
function settle(page: Page) {
  page.show([]);
  page.settle();
}
function revise(page: Page, row: CaptionNode, text: string, rows = [row]) {
  row.textContent = `Alice\n${text}`;
  page.show(rows);
}
function historical(page: Page, text: string) {
  const line = onlyLine(page.read().pendingLines);
  expect(line.text).toBe(text);
  expect(line.source).toBeUndefined();
  return line;
}
async function observe(row = caption()) {
  const page = createCaptionPage([row]);
  await page.poll();
  return { row, page, first: pending(page) };
}

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
  expect(pending(page)).toEqual(first);
  revise(page, row, "Actually, wait for approval");
  const retired = onlyLine(lines(page));
  expect(retired).toMatchObject({ text: words, provenance: first.provenance });
  expect(retired.source).toBeUndefined();
  const corrected = pending(page);
  expect(corrected.text).toBe("Actually, wait for approval");
  expect(corrected.source).toEqual({ ...first.source, revision: "2" });
  expect(corrected.provenance?.observationId).not.toBe(first.provenance?.observationId);
  const committed = page.read(true).lines;
  expect(committed.at(-1)?.provenance).toEqual(corrected.provenance);
  page.show([caption()]);
  await page.poll();
  expect(lines(page)).toEqual(committed);
  const replay = historical(page, words);
  expect(replay.provenance?.observationId).not.toBe(first.provenance?.observationId);
  expect(page.read(true).lines).toEqual([...committed, replay]);
});

it("retires stale duplicates without advancing their shared source", async () => {
  const row = caption();
  const stale = caption();
  const page = createCaptionPage([row, stale]);
  await page.poll();
  const source = onlySourcedLine(page.read().pendingLines.slice(0, 1)).source;
  expect(page.read().pendingLines.map((line) => line.source)).toEqual([source, source]);
  revise(page, row, words + " after review", [row, stale]);
  expect(page.read().pendingLines[0]?.source).toEqual({ ...source, revision: "2" });
  // Expire cross-node matching so the survivor keeps its stale lifecycle.
  page.advance(2_000);
  page.show([stale]);
  const committed = onlySourcedLine(lines(page));
  expect(committed).toMatchObject({
    text: words + " after review",
    source: { ...source, revision: "3", finalized: true },
  });
  historical(page, words);
  settle(page);
  expect(page.read().pendingLines).toEqual([]);
  expect(lines(page).map((line) => line.text)).toEqual([words + " after review", words]);
  expect(lines(page)[0]).toEqual(committed);
  expect(lines(page)[1]?.source).toBeUndefined();
});

it("does not revive a finalized source from a historical prefix in its DOM row", async () => {
  const { row, page, first } = await observe();
  revise(page, row, words + " after review");
  const committed = onlySourcedLine(page.read(true).lines);
  expect(committed.source).toEqual({ ...first.source, revision: "3", finalized: true });
  revise(page, row, words);
  await page.poll();
  expect(lines(page)).toEqual([committed]);
  const replay = historical(page, words);
  expect(page.read(true).lines).toEqual([committed, replay]);
});

it("preserves old identities at capacity without granting authority to new captions", async () => {
  const texts = Array.from({ length: maxLines + 1 }, (_, i) => `Caption ${i}`);
  const page = createCaptionPage(texts.map((text) => caption(text)));
  await page.poll();
  const visible = page.read().pendingLines;
  expect(visible).toHaveLength(texts.length);
  const ids = visible.slice(0, maxLines).map((line) => line.source?.id);
  expect(ids).not.toContain(undefined);
  expect(new Set(ids).size).toBe(maxLines);
  expect(visible.at(-1)?.source).toBeUndefined();
  expect(visible.every((line) => line.provenance?.self === "unknown")).toBe(true);
  const first = onlySourcedLine(visible.slice(0, 1));
  const committed = page.read(true);
  expect(committed.pendingLines).toEqual([]);
  expect(committed.lines.map((line) => line.text)).toEqual(texts.slice(1));
  expect(committed.lines.at(-1)?.source).toBeUndefined();
  page.show([caption(first.text)]);
  expect(lines(page)).toEqual(committed.lines);
  expect(pending(page).source).toEqual({ ...first.source, revision: "2", finalized: true });
  page.show([caption("Final thought")]);
  const last = historical(page, "Final thought");
  expect(last.provenance).toMatchObject({ speaker: "Alice", self: "unknown" });
  const final = page.read(true);
  expect(final.lines).toHaveLength(maxLines);
  expect(final.lines.at(-1)).toEqual(last);
});

it("separates document epochs and meeting sessions", async () => {
  const { page, first } = await observe();
  page.reload();
  await page.poll();
  const reloaded = pending(page).source;
  expect(reloaded.id).not.toBe(first.source.id);
  expect(reloaded.epoch).not.toBe(first.source.epoch);
  await page.poll("session-2");
  const next = onlySourcedLine(page.read(false, "session-2").pendingLines).source;
  expect(next.id).toMatch(/^session-2:/);
  expect(next.id).not.toBe(reloaded.id);
  expect(page.read(false, "session-1").sessionMatched).toBe(false);
});

it("separates native self and other observations when a DOM row is reused", async () => {
  const parent = new CaptionNode("", { "data-is-self": "true" });
  const row = new CaptionNode(`Assistant\n${words}`, {}, parent);
  const { page, first } = await observe(row);
  expect(first.source.ownEcho).toBe(true);
  settle(page);
  row.textContent = `Alice\n${words}`;
  row.setAttribute("data-is-self", "false");
  page.advance(5_000);
  page.show([row]);
  const next = pending(page);
  expect(next.source.id).not.toBe(first.source.id);
  expect(next.source.ownEcho).toBe(false);
  expect(next.provenance).toMatchObject({ speaker: "Alice", self: "other" });
  expect(lines(page)[0]?.provenance).toEqual(first.provenance);
});

it("does not borrow an earlier non-self marker when attribution is missing", async () => {
  const { page, first } = await observe(caption(words, "false"));
  settle(page);
  page.show([caption()]);
  const unknown = historical(page, words);
  expect(unknown.provenance).toMatchObject({ speaker: "Alice", self: "unknown" });
  expect(lines(page)[0]?.provenance).toEqual(first.provenance);
});

it("suppresses superseded unknown observations even after attribution appears", async () => {
  const { row, page, first } = await observe();
  revise(page, row, words + " only after approval");
  settle(page);
  const corrected = onlySourcedLine(lines(page));
  expect(corrected.source.id).toBe(first.source.id);
  expect(corrected.provenance?.self).toBe("unknown");
  page.advance(5_000);
  page.show([caption(words, "false")]);
  const replay = historical(page, words);
  expect(replay.provenance).toMatchObject({ speaker: "Alice", self: "other" });
  expect(page.read(true).lines.at(-1)).toEqual(replay);
});

it("keeps own-echo authority sticky through marker changes and settled rerenders", async () => {
  const { row, page, first } = await observe();
  const id = first.source.id;
  expect(first.provenance?.self).toBe("unknown");
  page.markSelf(row, "true");
  const self = pending(page);
  expect(self.source).toMatchObject({ id, ownEcho: true });
  expect(self.provenance?.self).toBe("self");
  page.markSelf(row, "false");
  const other = pending(page);
  expect(other.source).toMatchObject({ id, ownEcho: true });
  expect(other.provenance?.self).toBe("other");
  expect(self.provenance?.self).toBe("self");
  expect(first.provenance?.self).toBe("unknown");
  settle(page);
  page.show([caption(words, "false")]);
  const replacement = pending(page);
  expect(replacement.source).toMatchObject({ id, ownEcho: true });
  expect(replacement.provenance?.self).toBe("other");
  expect(replacement.provenance?.observationId).not.toBe(other.provenance?.observationId);
  const finalized = page.read(true).lines.at(-1);
  expect(finalized?.source).toMatchObject({ id, ownEcho: true, finalized: true });
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
  const retired = onlySourcedLine(lines(page));
  const live = pending(page);
  expect(retired.source).toMatchObject({ id: live.source.id, revision: "1", finalized: false });
  expect(retired.provenance).toEqual(initial[0]?.provenance);
  expect(live.provenance).toEqual(initial[1]?.provenance);
  revise(page, survivor, words + " only after approval");
  const edited = pending(page);
  expect(edited.source).toMatchObject({ id: live.source.id, revision: "2", finalized: false });
  expect(edited.text).toContain("only after approval");
  expect(edited.provenance?.observationId).not.toBe(live.provenance?.observationId);
  settle(page);
  expect(page.read().pendingLines).toEqual([]);
  expect(lines(page).at(-1)?.source).toMatchObject({ id: live.source.id, finalized: true });
  expect(lines(page).at(-1)?.provenance).toEqual(edited.provenance);
});
