import { expect, test } from "vitest";
import { validateSessionsUsageParams } from "./index.js";

test("sessions.usage accepts time zones and opaque creator selectors", () => {
  for (const params of [
    { mode: "specific", timeZone: "Europe/Vienna" },
    { mode: "specific", utcOffset: "UTC+2" },
    { creatorKey: '["profile","person"]' },
  ]) {
    expect(validateSessionsUsageParams(params)).toBe(true);
  }
  for (const params of [
    { mode: "specific", timeZone: "" },
    { mode: "specific", timeZone: 2 },
    { creatorKey: "" },
    { creatorKey: 2 },
  ]) {
    expect(validateSessionsUsageParams(params)).toBe(false);
  }
});
