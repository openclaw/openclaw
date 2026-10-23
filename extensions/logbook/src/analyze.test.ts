import { assert, describe, expect, it } from "vitest";
import {
  parseCardsJson,
  parseObservationSegments,
  revisionWindow,
  selectBatchFrames,
  validateCardCoverage,
} from "./analyze.js";

const DAY = "2026-07-03";
const dayMs = (clock: string) => new Date(`${DAY}T${clock}`).getTime();
const content = { title: "t", summary: "s", detail: "", category: "coding", distractions: [] };
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

  it("orders model cards before validating revision coverage", () => {
    const result = parse(
      JSON.stringify([card({ startTime: "10:30:00", endTime: "11:00:00" }), card()]),
    );
    assert(result.ok);
    expect(
      validateCardCoverage({
        drafts: result.drafts,
        requiredSpans: [{ startMs: dayMs("10:00:00"), endMs: dayMs("11:00:00") }],
        windowStartMs: dayMs("10:00:00"),
        windowEndMs: dayMs("11:00:00"),
      }),
    ).toEqual({ ok: true });
  });
});

it.each<[string, number[], number, boolean, number[] | null, number]>([
  ["elapsed boundary", [0, 30, 60, 900], 901_000, false, [1, 2, 3], 900_000],
  ["capture gap", [0, 30, 400], 60_000, false, [1, 2], 30_001],
  ["pending window", [0, 30], 60_000, false, null, 0],
  ["forced window", [0, 30], 60_000, true, [1, 2], 30_001],
])("selectBatchFrames: %s", (_name, offsets, now, force, ids, end) => {
  const t0 = dayMs("10:00:00");
  const selection = selectBatchFrames({
    frames: offsets.map((seconds, i) => ({ id: i + 1, capturedAtMs: t0 + seconds * 1000 })),
    windowMs: 900_000,
    nowMs: t0 + now,
    force,
  });
  expect(selection).toEqual(
    ids ? expect.objectContaining({ frameIds: ids, endMs: t0 + end }) : null,
  );
});

it.each(["2026-07-03", "2026-03-08", "2026-11-01"])(
  "closes a batch at local midnight on %s without including next-day frames",
  (day) => {
    const first = new Date(`${day}T23:59:00`).getTime();
    expect(
      selectBatchFrames({
        frames: [0, 30_000, 60_000].map((offset, id) => ({
          id,
          capturedAtMs: first + offset,
        })),
        windowMs: 900_000,
        nowMs: first + 60_000,
      }),
    ).toEqual({ frameIds: [0, 1], startMs: first, endMs: first + 30_001 });
  },
);

type Span = [number, number];
const span = ([start, end]: Span) => ({
  startMs: dayMs("10:00:00") + start * 60_000,
  endMs: dayMs("10:00:00") + end * 60_000,
});
it.each<[Span[], Span[], string | null]>([
  [
    [[30, 60]],
    [
      [0, 30],
      [30, 60],
    ],
    "not covered",
  ],
  [[[-60, 60]], [[0, 60]], "outside the revision window"],
  [
    [
      [0, 29],
      [30.5, 60],
    ],
    [[0, 60]],
    null,
  ],
])("validates card coverage: %j over %j", (drafts, required, error) => {
  const result = validateCardCoverage({
    drafts: drafts.map(span),
    requiredSpans: required.map(span),
    windowStartMs: dayMs("10:00:00"),
    windowEndMs: dayMs("11:00:00"),
  });
  expect(result).toMatchObject(
    error ? { ok: false, error: expect.stringContaining(error) } : { ok: true },
  );
});

it("expands the revision window to cover previous draft cards", () => {
  expect(
    revisionWindow({
      batchStartMs: dayMs("10:30:00"),
      batchEndMs: dayMs("10:45:00"),
      previousCards: [{ id: 1, day: DAY, ...span([0, 30]), ...content }],
    }),
  ).toEqual({ startMs: dayMs("10:00:00"), endMs: dayMs("10:45:00") });
});
