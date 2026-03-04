import { describe, expect, it } from "vitest";
import { appendCronStyleCurrentTimeLine, resolveCronStyleNow } from "./current-time.js";

/**
 * Tests for the cron/heartbeat timestamp injection path.
 *
 * This module is part of OpenClaw's timestamp injection architecture.
 * The system prompt intentionally contains only the timezone for cache stability.
 * Heartbeat polls and cron jobs use `appendCronStyleCurrentTimeLine` to give
 * agents date/time context in the message body instead.
 *
 * @see `buildTimeSection` in `system-prompt.ts` — Why the system prompt is timezone-only
 * @see `injectTimestamp` in `gateway/server-methods/agent-timestamp.ts` — Gateway injection
 * @see `docs/date-time.md` — Full architecture documentation
 */
describe("resolveCronStyleNow", () => {
  it("returns a formatted time line with timezone", () => {
    const result = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "America/New_York" } } },
      new Date("2026-01-28T20:30:00.000Z").getTime(),
    );

    expect(result.userTimezone).toBe("America/New_York");
    expect(result.timeLine).toContain("Current time:");
    expect(result.timeLine).toContain("America/New_York");
    expect(result.formattedTime).toContain("2026");
  });

  it("uses configured timezone", () => {
    const result = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "Asia/Tokyo" } } },
      new Date("2026-01-28T20:30:00.000Z").getTime(),
    );

    expect(result.userTimezone).toBe("Asia/Tokyo");
    expect(result.timeLine).toContain("Asia/Tokyo");
  });

  it("falls back to host timezone when not configured", () => {
    const result = resolveCronStyleNow({}, Date.now());

    expect(result.userTimezone).toBeTruthy();
    expect(result.timeLine).toContain("Current time:");
  });
});

describe("appendCronStyleCurrentTimeLine", () => {
  it("appends Current time: line to text", () => {
    const result = appendCronStyleCurrentTimeLine(
      "Check your daily tasks",
      { agents: { defaults: { userTimezone: "America/New_York" } } },
      new Date("2026-01-28T20:30:00.000Z").getTime(),
    );

    expect(result).toContain("Check your daily tasks");
    expect(result).toContain("Current time:");
    expect(result).toContain("America/New_York");
  });

  it("does not double-inject if Current time: already present", () => {
    const withTime = "Do stuff\nCurrent time: Wednesday, January 28th, 2026";
    const result = appendCronStyleCurrentTimeLine(
      withTime,
      { agents: { defaults: { userTimezone: "UTC" } } },
      Date.now(),
    );

    expect(result).toBe(withTime);
  });

  it("returns empty string unchanged for empty input", () => {
    const result = appendCronStyleCurrentTimeLine(
      "",
      { agents: { defaults: { userTimezone: "UTC" } } },
      Date.now(),
    );

    expect(result).toBe("");
  });

  it("trims trailing whitespace before appending", () => {
    const result = appendCronStyleCurrentTimeLine(
      "Hello   \n\n  ",
      { agents: { defaults: { userTimezone: "UTC" } } },
      Date.now(),
    );

    expect(result).toMatch(/^Hello\nCurrent time:/);
  });
});
