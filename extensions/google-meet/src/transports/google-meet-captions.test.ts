import { expect, it } from "vitest";
import {
  CaptionNode,
  createCaptionPage,
  onlyLine,
  onlySourcedLine,
} from "./google-meet-captions.test-support.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES as maxLines } from "./types.js";

const words = "Please share the recap";
const extended = `${words} after review`;
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
  expect([line.text, line.source]).toEqual([text, undefined]);
  return line;
}
const origin = (marker?: string) => ({ speaker: "Alice", self: marker ? "other" : "unknown" });
async function observe(row = caption()) {
  const page = createCaptionPage([row]);
  await page.poll();
  return { row, page, first: pending(page) };
}

it.each([
  ["Actually, wait for approval", undefined, undefined, false],
  [extended, undefined, undefined, true],
  [extended, undefined, "false", false],
  [words, "false", undefined, false],
] as const)("rejects replay authority: %s", async (text, before, after, reuse) => {
  const { row, page, first } = await observe(caption(words, before));
  const changed = text !== words;
  await page.poll();
  expect(pending(page)).toEqual(first);
  revise(page, row, text);
  if (!text.startsWith(words)) {
    const retired = onlyLine(lines(page));
    expect(retired).toMatchObject({ text: words, provenance: first.provenance });
    expect(retired.source).toBeUndefined();
  }
  const corrected = pending(page);
  expect(corrected.text).toBe(text);
  expect(corrected.provenance).toMatchObject(origin(before));
  expect(corrected.provenance?.observationId === first.provenance?.observationId).toBe(!changed);
  settle(page);
  const committed = lines(page);
  expect(committed).toHaveLength(text.startsWith(words) ? 1 : 2);
  const last = committed.at(-1);
  expect(last?.provenance).toEqual(corrected.provenance);
  const finalRevision = changed ? "3" : "2";
  expect(last?.source).toEqual({ ...first.source, revision: finalRevision, finalized: true });
  page.advance(5_000);
  row.textContent = `Alice\n${words}`;
  page.show([reuse ? row : caption(words, after)]);
  await page.poll();
  expect(lines(page)).toEqual(committed);
  const replay = historical(page, words);
  expect(replay.provenance).toMatchObject(origin(after));
  expect(replay.provenance?.observationId).not.toBe(first.provenance?.observationId);
  expect(page.read(true).lines).toEqual([...committed, replay]);
});

it("retires stale duplicates without advancing their shared source", async () => {
  const row = caption();
  const stale = caption();
  const page = createCaptionPage([row, stale]);
  await page.poll();
  const source = onlySourcedLine(page.read().pendingLines.slice(0, 1)).source;
  revise(page, row, extended, [row, stale]);
  // Expire cross-node matching so the survivor keeps its stale lifecycle.
  page.advance(2_000);
  page.show([stale]);
  const committed = onlySourcedLine(lines(page));
  expect(committed).toMatchObject({
    text: extended,
    source: { ...source, revision: "3", finalized: true },
  });
  const replay = historical(page, words);
  settle(page);
  expect(lines(page)).toEqual([committed, replay]);
});

it("preserves old identities at capacity without granting authority to new captions", async () => {
  const texts = Array.from({ length: maxLines + 1 }, (_, i) => `Caption ${i}`);
  const page = createCaptionPage(texts.map((text) => caption(text)));
  await page.poll();
  const visible = page.read().pendingLines;
  const ids = visible.slice(0, maxLines).map((line) => line.source?.id);
  expect([new Set(ids).size, ids.includes(undefined)]).toEqual([maxLines, false]);
  expect(visible.at(-1)?.source).toBeUndefined();
  const first = onlySourcedLine(visible.slice(0, 1));
  const committed = page.read(true);
  expect(committed.lines.map((line) => line.text)).toEqual(texts.slice(1));
  page.show([caption(first.text)]);
  expect(pending(page).source).toEqual({ ...first.source, revision: "2", finalized: true });
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

it("keeps own-echo authority sticky until a DOM row changes speaker", async () => {
  const parent = new CaptionNode("");
  const row = new CaptionNode(`Alice\n${words}`, {}, parent);
  const { page, first } = await observe(row);
  const id = first.source.id;
  page.markSelf(parent, "true");
  const self = pending(page);
  expect(self.source).toMatchObject({ id, ownEcho: true });
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
  const finalized = page.read(true).lines.at(-1);
  expect(finalized?.source).toMatchObject({ id, ownEcho: true, finalized: true });
  row.textContent = "Assistant\nNew speech";
  row.setAttribute("data-is-self", "true");
  page.show([row]);
  const spoken = pending(page);
  settle(page);
  row.textContent = "Bob\nNew speech";
  row.setAttribute("data-is-self", "false");
  page.advance(5_000);
  page.show([row]);
  const next = pending(page);
  expect(next.source.id).not.toBe(spoken.source.id);
  expect(next.source.ownEcho).toBe(false);
  expect(next.provenance).toMatchObject({ speaker: "Bob", self: "other" });
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
  settle(page);
  expect(page.read().pendingLines).toEqual([]);
  expect(lines(page).at(-1)?.source).toMatchObject({ id: live.source.id, finalized: true });
});
