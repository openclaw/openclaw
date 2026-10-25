import { expect, it } from "vitest";
import { readLocation, locationParams } from "./page-location.js";

it("page addresses round-trip stable identity, filters, pagination and encoded text", () => {
  const input = {
    agent: "research",
    vault: "store-123",
    record: "record-123",
    view: "browse",
    kind: "claim",
    type: "belief",
    q: "A & B / café",
    filter: "road map",
    history: "1",
    origin: "user_belief",
    offset: "50",
    back: "0,20,40",
    upper: "84",
    before: "30",
  };
  const url = new URL("https://example.test/console/plugin?plugin=knowledge&id=overview");
  for (const [key, value] of Object.entries(locationParams(readLocation(input)))) {
    url.searchParams.set(`p.${key}`, value);
  }
  const restored = Object.fromEntries(
    [...url.searchParams]
      .filter(([key]) => key.startsWith("p."))
      .map(([key, value]) => [key.slice(2), value]),
  );
  expect(restored).toStrictEqual(input);
});

it("malformed URL filters and unsupported views never produce out-of-contract input or routes", () => {
  for (const offset of ["-1", "501", "1e2", "NaN", "1.5", "9007199254740992"]) {
    expect(readLocation({ offset }).offset).toBe(0);
  }
  expect(readLocation({ upper: "3", before: "4" }).cursor).toBe(undefined);
  expect(
    readLocation({ view: "invalid", kind: "invalid", history: "true", origin: "invalid" }).tab,
  ).toBe("recent");
  expect(
    locationParams(readLocation({ record: "x".repeat(97), q: "x".repeat(201) })),
  ).toStrictEqual({});
  expect(readLocation({ view: "timeline" }).tab).toBe("recent");
  expect(
    locationParams(readLocation({ entity: "person-1", snapshot: "old", offset: "720" })),
  ).toStrictEqual({});
});

it("settings addresses and missing optional parameters use explicit defaults", () => {
  expect(
    locationParams(
      readLocation({ view: "settings", section: "vocab", agent: "main", vault: "one" }),
    ),
  ).toStrictEqual({ agent: "main", vault: "one", view: "settings", section: "vocab" });
  expect(locationParams(readLocation())).toStrictEqual({});
});

it("Browse back trail survives remount and rejects invalid or looping cursors", () => {
  expect(readLocation({ offset: "40", back: "0,20" }).back).toStrictEqual([0, 20]);
  for (const back of ["40", "0,40", "20,0", "0,0", "-1", "1e1", "0,500", "0,x", "9".repeat(2100)]) {
    expect(readLocation({ offset: "40", back }).back).toStrictEqual([]);
  }
  expect(readLocation({ offset: "0", back: "0,20" }).back).toStrictEqual([]);
});

it("Search date filters round trip while invalid bounded date text remains visible for validation", () => {
  const input = {
    view: "search",
    q: "launch",
    since: "2026-02-30",
    until: "2026-10-04",
    timeField: "recorded_at",
  };
  expect(locationParams(readLocation(input))).toStrictEqual(input);
  expect(readLocation({ since: "x".repeat(41) }).since).toBe("");
});
