import { expect, it } from "vitest";
import {
  temporalSelectionError,
  temporalQuery,
  type TemporalSelection,
} from "./search-date-filters.js";
const selection = (changes: Partial<TemporalSelection> = {}): TemporalSelection => ({
  since: "",
  until: "",
  timeField: "occurred_at",
  ...changes,
});

it("temporal UI accepts only real explicit calendar dates or timezone-bearing timestamps", () => {
  for (const since of ["2026-10-04", "2024-02-29", "2026-10-04T12:30:00-07:00"]) {
    expect(temporalSelectionError(selection({ since }))).toBe("");
  }
  for (const since of ["yesterday", "2026-02-29", "2026-10-04T12:30:00", "2026-10-04T24:30:00Z"]) {
    expect(temporalSelectionError(selection({ since }))).toMatch(/Since must/);
  }
  expect(temporalSelectionError(selection({ since: "2026-10-05", until: "2026-10-04" }))).toMatch(
    /Since must not be after Until/,
  );
  expect(
    temporalSelectionError(selection({ since: "2026-10-04T23:59:59Z", until: "2026-10-04" })),
  ).toBe("");
});

it("text search date predicates omit blanks", () => {
  expect(temporalQuery(selection())).toStrictEqual({ timeField: "occurred_at" });
  expect(temporalQuery(selection({ timeField: "due_at", since: "2026-10-04" }))).toStrictEqual({
    timeField: "due_at",
    since: "2026-10-04",
  });
});
