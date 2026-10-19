import { describe, expect, it } from "vitest";
import {
  parseCardsJson,
  parseObservationSegments,
  revisionWindow,
  selectBatchFrames,
  validateCardCoverage,
} from "./analyze.js";

const DAY = "2026-07-03";
const dayMs = (clock: string) => new Date(`${DAY}T${clock}`).getTime();
const content = {
  title: "Activity",
  summary: "Summary",
  detail: "",
  category: "coding",
  distractions: [],
};
function expectError(
  result: ReturnType<typeof parseCardsJson> | ReturnType<typeof validateCardCoverage>,
  message: string,
) {
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) });
}

describe("parseObservationSegments", () => {
  const startMs = dayMs("10:00:00");
  const endMs = dayMs("10:15:00");
  const parse = (raw: string, window = { startMs, endMs }, day = DAY) =>
    parseObservationSegments({ raw, day, ...window });

  it("parses and clamps segments into the batch window", () => {
    const raw = JSON.stringify({
      segments: [
        { start: "09:55:00", end: "10:05:00", description: "VS Code: editing store.ts" },
        { start: "10:05:00", end: "10:20:00", description: "Chrome: reviewing PR #99" },
      ],
    });
    expect(parse(raw)).toEqual([
      expect.objectContaining({ startMs }),
      expect.objectContaining({ endMs }),
    ]);
  });

  it("returns empty on unparseable output", () => {
    expect(parse("no json here")).toEqual([]);
  });

  it("parses 12h clocks from fenced model output", () => {
    const raw =
      'Here you go:\n```json\n{"segments":[{"start":"1:05 pm","end":"1:05:30 pm","description":"Reviewing the timeline"}]}\n```\nHope that helps!';
    expect(parse(raw, { startMs: dayMs("13:00:00"), endMs: dayMs("13:10:00") })).toEqual([
      expect.objectContaining({ startMs: dayMs("13:05:00"), endMs: dayMs("13:05:30") }),
    ]);
  });

  it.each([
    [DAY, "25:00:00"],
    [DAY, "half past nine"],
    ["not-a-day", "10:00:00"],
  ])("rejects malformed clock %s %s", (day, clock) => {
    const raw = JSON.stringify([{ start: clock, end: "13:06:00", description: "Invalid clock" }]);
    expect(parse(raw, undefined, day)).toEqual([]);
  });
});

describe("parseCardsJson", () => {
  const card = (overrides: Record<string, unknown> = {}) => ({
    startTime: "10:00:00",
    endTime: "10:30:00",
    ...content,
    detailedSummary: "Added frames and cards tables.",
    appSites: { primary: "github.com" },
    ...overrides,
  });
  const parse = (raw: string) => parseCardsJson({ raw, day: DAY });
  const overlap = (firstEnd: string, secondEnd = "11:00:00") =>
    parse(
      JSON.stringify([
        card({ endTime: firstEnd }),
        card({ startTime: "10:30:00", endTime: secondEnd, title: "Second" }),
      ]),
    );

  it("maps unknown categories to other", () => {
    expect(parse(JSON.stringify([card({ category: "quantum-vibes" })]))).toMatchObject({
      ok: true,
      drafts: [{ category: "other" }],
    });
  });

  it("trims sub-minute overlaps and rejects large ones", () => {
    expect(overlap("10:30:30")).toMatchObject({
      ok: true,
      drafts: [{ endMs: dayMs("10:30:30") }, { startMs: dayMs("10:30:30") }],
    });

    expectError(overlap("10:45:00"), "overlap");
  });

  it("rejects an overlap that would leave no duration for a card", () => {
    expectError(overlap("10:30:30", "10:30:30"), "endTime");
  });

  it("reports actionable errors for the correction round-trip", () => {
    expectError(parse(JSON.stringify([card({ startTime: "13:05 pm" })])), "startTime");
  });
});

describe("selectBatchFrames", () => {
  const windowMs = 15 * 60_000;
  const t0 = dayMs("10:00:00");
  const frame = (id: number, offsetSec: number) => ({ id, capturedAtMs: t0 + offsetSec * 1000 });
  const select = (offsets: number[], nowMs: number, force = false) =>
    selectBatchFrames({
      frames: offsets.map((offset, i) => frame(i + 1, offset)),
      windowMs,
      nowMs,
      force,
    });

  it("keeps the boundary when the next frame starts the following window", () => {
    expect(select([0, 30, 60, 15 * 60], t0 + windowMs + 1000)).toMatchObject({
      frameIds: [1, 2, 3],
      endMs: t0 + windowMs,
    });
  });

  it("splits on capture gaps without claiming the idle span", () => {
    expect(select([0, 30, 400], t0 + 60_000)).toMatchObject({
      frameIds: [1, 2],
      endMs: t0 + 30_000 + 1,
    });
  });

  it("force-closes an in-progress window at the last observed frame", () => {
    expect(select([0, 30], t0 + 60_000)).toBeNull();
    expect(select([0, 30], t0 + 60_000, true)).toMatchObject({
      frameIds: [1, 2],
      endMs: t0 + 30_000 + 1,
    });
  });
});

describe("validateCardCoverage", () => {
  const window = { windowStartMs: dayMs("10:00:00"), windowEndMs: dayMs("11:00:00") };
  const span = (start: string, end: string) => ({ startMs: dayMs(start), endMs: dayMs(end) });
  const validate = (drafts: ReturnType<typeof span>[], requiredSpans: ReturnType<typeof span>[]) =>
    validateCardCoverage({ drafts, requiredSpans, ...window });

  it("rejects partial outputs that would erase previous cards", () => {
    expectError(
      validate(
        [span("10:30:00", "11:00:00")],
        [span("10:00:00", "10:30:00"), span("10:30:00", "11:00:00")],
      ),
      "not covered",
    );
  });

  it("rejects drafts outside the revision window", () => {
    expectError(
      validate([span("09:00:00", "11:00:00")], [span("10:00:00", "11:00:00")]),
      "outside the revision window",
    );
  });

  it("tolerates gaps inside required spans up to the tolerance", () => {
    expect(
      validate(
        [span("10:00:00", "10:29:00"), span("10:30:30", "11:00:00")],
        [span("10:00:00", "11:00:00")],
      ).ok,
    ).toBe(true);
  });
});

describe("revisionWindow", () => {
  it("expands the window to cover previous draft cards", () => {
    const window = revisionWindow({
      batchStartMs: dayMs("10:30:00"),
      batchEndMs: dayMs("10:45:00"),
      previousCards: [
        { id: 1, day: DAY, startMs: dayMs("10:00:00"), endMs: dayMs("10:30:00"), ...content },
      ],
    });
    expect(window.startMs).toBe(dayMs("10:00:00"));
    expect(window.endMs).toBe(dayMs("10:45:00"));
  });
});
