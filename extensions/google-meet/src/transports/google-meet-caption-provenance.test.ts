import { describe, expect, it } from "vitest";
import {
  CaptionNode,
  createCaptionPage,
  onlyLine,
  onlySourcedLine,
} from "./google-meet-captions.test-support.js";

const words = "Please share the recap";

describe("Google Meet retained observation provenance", () => {
  it("preserves each retained row state without creating a revision journal", async () => {
    const row = new CaptionNode("Alice\nPlease use the blue version", { "data-is-self": "false" });
    const page = createCaptionPage([row]);
    await page.poll();
    const first = onlySourcedLine(page.read().pendingLines);
    expect(first.provenance).toMatchObject({
      observer: "google-meet-caption-dom",
      sessionId: "session-1",
      epoch: first.source.epoch,
      speaker: "Alice",
      self: "other",
      observationId: expect.stringContaining(":observation:"),
      observedAt: expect.any(String),
    });
    await page.poll();
    expect(onlyLine(page.read().pendingLines).provenance).toEqual(first.provenance);

    row.textContent = "Alice\nActually, use the green version";
    page.show([row]);
    const corrected = page.read();
    expect(onlyLine(corrected.lines).provenance).toEqual(first.provenance);
    const current = onlySourcedLine(corrected.pendingLines);
    expect(current.source.id).toBe(first.source.id);
    expect(current.provenance?.observationId).not.toBe(first.provenance?.observationId);
    expect(page.read(true).lines.at(-1)?.provenance).toEqual(current.provenance);

    page.show([new CaptionNode("Alice\nPlease use the blue version", { "data-is-self": "false" })]);
    const historical = onlyLine(page.read().pendingLines);
    expect(historical.source).toBeUndefined();
    expect(historical.provenance).toMatchObject({ speaker: "Alice", self: "other" });
    expect(historical.provenance?.observationId).not.toBe(first.provenance?.observationId);
    expect(page.read(true).lines.at(-1)?.provenance).toEqual(historical.provenance);
  });

  it.each([
    { first: "true", next: "false", reuse: false },
    { first: "false", next: "true", reuse: false },
    { first: "true", next: "false", reuse: true },
    { first: "false", next: "true", reuse: true },
  ])("separates native provenance $first -> $next with node reuse=$reuse", async (testCase) => {
    const initialSpeaker = testCase.first === "true" ? "Meeting Assistant" : "Alice";
    const nextSpeaker = testCase.next === "true" ? "Meeting Assistant" : "Alice";
    const row = new CaptionNode(initialSpeaker + "\n" + words, { "data-is-self": testCase.first });
    const page = createCaptionPage([row]);
    await page.poll();
    page.show([]);
    page.settle();
    const first = onlySourcedLine(page.read().lines);
    const nextRow = testCase.reuse
      ? row
      : new CaptionNode(nextSpeaker + "\n" + words, { "data-is-self": testCase.next });
    nextRow.textContent = nextSpeaker + "\n" + words;
    nextRow.setAttribute("data-is-self", testCase.next);
    page.advance(5_000);
    page.show([nextRow]);
    const pending = onlySourcedLine(page.read().pendingLines);
    expect(pending.source.id).not.toBe(first.source.id);
    expect(pending.source.ownEcho).toBe(testCase.next === "true");
    expect(pending.provenance).toMatchObject({
      speaker: nextSpeaker,
      self: testCase.next === "true" ? "self" : "other",
    });
    expect(page.read().lines[0]?.provenance).toEqual(first.provenance);
  });

  it("keeps missing attribution unknown instead of borrowing an earlier non-self marker", async () => {
    const page = createCaptionPage([
      new CaptionNode("Alice\n" + words, { "data-is-self": "false" }),
    ]);
    await page.poll();
    page.show([]);
    page.settle();
    const original = onlySourcedLine(page.read().lines);
    page.show([new CaptionNode("Alice\n" + words)]);
    const unknown = onlyLine(page.read().pendingLines);
    expect(unknown.provenance).toMatchObject({ speaker: "Alice", self: "unknown" });
    expect(unknown.source).toBeUndefined();
    expect(page.read().lines[0]?.provenance).toEqual(original.provenance);
  });

  it("records marker-only changes without rehabilitating an existing own echo", async () => {
    const row = new CaptionNode("Alice\n" + words);
    const page = createCaptionPage([row]);
    await page.poll();
    const initial = onlySourcedLine(page.read().pendingLines);
    expect(initial.provenance?.self).toBe("unknown");
    page.markSelf(row, "true");
    const self = onlySourcedLine(page.read().pendingLines);
    expect(self.source).toMatchObject({ id: initial.source.id, ownEcho: true });
    expect(self.provenance?.self).toBe("self");
    page.markSelf(row, "false");
    const later = onlySourcedLine(page.read().pendingLines);
    expect(later.source).toMatchObject({ id: initial.source.id, ownEcho: true });
    expect(later.provenance?.self).toBe("other");
    expect(initial.provenance?.self).toBe("unknown");
    expect(self.provenance?.self).toBe("self");
  });

  it.each([false, true])(
    "retains a sticky own echo through marker-change rerenders (settled=%s)",
    async (settled) => {
      const row = new CaptionNode("Alice\n" + words, { "data-is-self": "true" });
      const page = createCaptionPage([row]);
      await page.poll();
      const original = onlySourcedLine(page.read().pendingLines);
      page.markSelf(row, "false");
      const changedMarker = onlySourcedLine(page.read().pendingLines);
      expect(changedMarker.source.ownEcho).toBe(true);
      expect(changedMarker.provenance?.self).toBe("other");
      if (settled) {
        page.show([]);
        page.settle();
      }

      page.show([new CaptionNode("Alice\n" + words, { "data-is-self": "false" })]);
      const replacement = onlySourcedLine(page.read().pendingLines);
      expect(replacement.source).toMatchObject({ id: original.source.id, ownEcho: true });
      expect(replacement.provenance?.self).toBe("other");
      expect(replacement.provenance?.observationId).not.toBe(
        changedMarker.provenance?.observationId,
      );
      expect(page.read(true).lines.at(-1)?.source).toMatchObject({
        id: original.source.id,
        ownEcho: true,
        finalized: true,
      });
    },
  );

  it("keeps superseded unknown observations replay-suppressed after attribution appears", async () => {
    const row = new CaptionNode("Alice\n" + words);
    const page = createCaptionPage([row]);
    await page.poll();
    const original = onlySourcedLine(page.read().pendingLines);
    row.textContent += " only after I approve it";
    page.show([row]);
    page.show([]);
    page.settle();
    const corrected = onlySourcedLine(page.read().lines);
    expect(corrected.source.id).toBe(original.source.id);
    expect(corrected.provenance?.self).toBe("unknown");

    page.advance(5_000);
    page.show([new CaptionNode("Alice\n" + words, { "data-is-self": "false" })]);
    const historical = onlyLine(page.read().pendingLines);
    expect(historical.source).toBeUndefined();
    expect(historical.provenance).toMatchObject({ speaker: "Alice", self: "other" });
    const retained = page.read(true).lines.at(-1);
    expect(retained?.source).toBeUndefined();
    expect(retained?.provenance).toEqual(historical.provenance);
  });

  it.each([0, 1])(
    "does not finalize a still-visible source when duplicate %s disappears",
    async (removed) => {
      const rows = [
        new CaptionNode("Alice\n" + words, { "data-is-self": "false" }),
        new CaptionNode("Alice\n" + words, { "data-is-self": "false" }),
      ];
      const page = createCaptionPage(rows);
      await page.poll();
      const initial = page.read().pendingLines;
      expect(initial[0]?.source).toEqual(initial[1]?.source);
      expect(initial[0]?.provenance?.observationId).not.toBe(initial[1]?.provenance?.observationId);
      const survivor = rows[1 - removed]!;
      page.show([survivor]);
      const afterRemoval = page.read();
      const retired = onlySourcedLine(afterRemoval.lines);
      const live = onlySourcedLine(afterRemoval.pendingLines);
      expect(retired.source).toMatchObject({ id: live.source.id, revision: "1", finalized: false });
      expect(retired.provenance).toEqual(initial[removed]?.provenance);
      expect(live.provenance).toEqual(initial[1 - removed]?.provenance);

      survivor.textContent = "Alice\n" + words + " only after I approve it";
      page.show([survivor]);
      const edited = onlySourcedLine(page.read().pendingLines);
      expect(edited.source).toMatchObject({ id: live.source.id, revision: "2", finalized: false });
      expect(edited.text).toContain("only after I approve it");
      expect(edited.provenance?.observationId).not.toBe(live.provenance?.observationId);
      page.show([]);
      page.settle();
      const completed = page.read();
      expect(completed.pendingLines).toEqual([]);
      expect(completed.lines.at(-1)?.source).toMatchObject({ id: live.source.id, finalized: true });
      expect(completed.lines.at(-1)?.provenance).toEqual(edited.provenance);
    },
  );
});
