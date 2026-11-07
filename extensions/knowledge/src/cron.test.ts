import { expect, it } from "vitest";
import { nextRun, parseCron } from "./cron.js";

// Next run strictly after `after` for `expr` in `timeZone`, as an ISO string.
function next(expr: string, timeZone: string, after: string): string {
  return new Date(nextRun(parseCron(expr, timeZone), Date.parse(after))).toISOString();
}

it.each([
  [
    "weekday",
    "0 0 * * 1",
    "America/Los_Angeles",
    "2026-03-07T08:00:00Z",
    "2026-03-09T07:00:00.000Z",
  ],
  [
    "weekday range",
    "15 0 * * 1-5",
    "America/Los_Angeles",
    "2026-03-07T08:00:00Z",
    "2026-03-09T07:15:00.000Z",
  ],
  [
    "day of month",
    "0 0 9 * *",
    "America/Los_Angeles",
    "2026-03-08T07:00:00Z",
    "2026-03-09T07:00:00.000Z",
  ],
  [
    "Paris weekday",
    "0 0 * * 1",
    "Europe/Paris",
    "2026-03-28T23:00:00Z",
    "2026-03-29T22:00:00.000Z",
  ],
])(
  "tests the civil day after a spring-forward skip from local midnight (%s)",
  (_name, expr, timeZone, after, expected) => {
    expect(next(expr, timeZone, after)).toBe(expected);
  },
);

it("keeps the next Monday midnight after a fall-back day", () => {
  expect(next("0 0 * * 1", "America/Los_Angeles", "2026-10-31T07:00:00Z")).toBe(
    "2026-11-02T08:00:00.000Z",
  );
});

it("does not step back when the next civil day has no local midnight", () => {
  // Santiago springs forward at local midnight: 2026-09-06 starts at 01:00.
  expect(next("0 1 * * 0", "America/Santiago", "2026-09-05T04:00:00Z")).toBe(
    "2026-09-06T04:00:00.000Z",
  );
  expect(next("0 0 * * 0", "America/Santiago", "2026-09-05T04:00:00Z")).toBe(
    "2026-09-13T03:00:00.000Z",
  );
});
