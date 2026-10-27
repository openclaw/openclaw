import "../../test/dom.setup.ts";
import { expect, it, vi } from "vitest";
import { formatDurationCompact } from "../../lib/format.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { formatUpdatedTime, matchesCardQuery } from "./view-helpers.tsx";

it("matches card ID prefixes case-insensitively", () => {
  const card = createWorkboardCard({ id: "123e4567-e89b-12d3-a456-426614174000" });
  const query = " 123E4567-E89B ";

  expect(matchesCardQuery(card, query)).toBe(true);
});

it("reuses card formatters and replaces them when the host locale changes", () => {
  const timestamp = 1_800_000_000_000;
  const expected = (locale: string) => ({
    date: new Date(timestamp).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    duration: new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "minute",
      unitDisplay: "narrow",
      maximumFractionDigits: 0,
    }).format(2),
  });
  const french = expected("fr");
  const german = expected("de");
  const dates = vi.spyOn(Intl, "DateTimeFormat");
  const numbers = vi.spyOn(Intl, "NumberFormat");
  try {
    for (const [locale, result] of [
      ["fr", french],
      ["de", german],
    ] as const) {
      Object.assign(workboardTestHost().host, { locale });
      for (let row = 0; row < 3; row++) {
        expect(formatUpdatedTime(timestamp)).toBe(result.date);
        expect(formatDurationCompact(120_000)).toBe(result.duration);
      }
    }
    expect(dates).toHaveBeenCalledTimes(2);
    expect(numbers).toHaveBeenCalledTimes(2);
    expect(formatUpdatedTime(undefined)).toBe("");
  } finally {
    dates.mockRestore();
    numbers.mockRestore();
  }
});
