import { expect, test } from "vitest";
import { validateSessionsUsageParams } from "./index.js";

test("sessions.usage accepts time zones and opaque creator selectors", () => {
  for (const params of [
    { mode: "specific", timeZone: "Europe/Vienna" },
    { mode: "specific", utcOffset: "UTC+2" },
    { creatorKey: '["profile","person"]' },
    {
      projection: "overview",
      offset: 50,
      query: "model:example",
      selectedDays: ["2026-10-11"],
      selectedHours: [0, 23],
      selectedSessions: ["agent:main:example"],
      sort: "tokens",
      sortDirection: "asc",
    },
  ]) {
    expect(validateSessionsUsageParams(params)).toBe(true);
  }
  for (const params of [
    { mode: "specific", timeZone: "" },
    { mode: "specific", timeZone: 2 },
    { creatorKey: "" },
    { creatorKey: 2 },
    { projection: "unknown" },
    { offset: -1 },
    { selectedHours: [24] },
    { selectedHours: [1.5] },
    { sort: "unknown" },
  ]) {
    expect(validateSessionsUsageParams(params)).toBe(false);
  }
});
