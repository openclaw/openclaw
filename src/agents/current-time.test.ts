import { describe, expect, it } from "vitest";
import { resolveCronStyleNow } from "./current-time.js";

describe("resolveCronStyleNow", () => {
  it("uses the per-agent userTimezone override when configured", () => {
    const result = resolveCronStyleNow(
      {
        agents: {
          defaults: {
            userTimezone: "America/New_York",
            timeFormat: "12",
          },
          list: [
            {
              id: "work",
              userTimezone: "America/Los_Angeles",
            },
          ],
        },
      },
      Date.UTC(2026, 2, 3, 17, 0, 0),
      "work",
    );

    expect(result.userTimezone).toBe("America/Los_Angeles");
    expect(result.timeLine).toContain("Current time: Tuesday, March 3rd, 2026 — 9:00 AM");
    expect(result.timeLine).toContain("(America/Los_Angeles)");
  });

  it("falls back to agents.defaults.userTimezone when no per-agent override exists", () => {
    const result = resolveCronStyleNow(
      {
        agents: {
          defaults: {
            userTimezone: "America/New_York",
            timeFormat: "12",
          },
          list: [
            {
              id: "work",
            },
          ],
        },
      },
      Date.UTC(2026, 2, 3, 17, 0, 0),
      "work",
    );

    expect(result.userTimezone).toBe("America/New_York");
    expect(result.timeLine).toContain("Current time: Tuesday, March 3rd, 2026 — 12:00 PM");
    expect(result.timeLine).toContain("(America/New_York)");
  });
});
