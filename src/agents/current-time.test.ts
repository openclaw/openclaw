import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { appendCronStyleCurrentTimeLine, resolveCronStyleNow } from "./current-time.js";

describe("resolveCronStyleNow", () => {
  it("includes a compact local timestamp with offset for cron prompts", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;

    const result = resolveCronStyleNow(cfg, Date.UTC(2026, 2, 3, 14, 0, 0));

    expect(result.userTimezone).toBe("America/New_York");
    expect(result.formattedTime).toBe("Tuesday, March 3rd, 2026 — 9:00 AM");
    expect(result.timeLine).toBe(
      "Current time: Tuesday, March 3rd, 2026 — 9:00 AM (America/New_York) / Local: 2026-03-03 09:00 EST (-05:00) / UTC: 2026-03-03 14:00 UTC",
    );
  });

  it("uses the configured timezone offset for Asia/Shanghai", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "Asia/Shanghai", timeFormat: "24" } },
    } as OpenClawConfig;

    const result = resolveCronStyleNow(cfg, Date.UTC(2026, 2, 15, 6, 0, 0));

    expect(result.timeLine).toContain("Current time: Sunday, March 15th, 2026 — 14:00");
    expect(result.timeLine).toContain("(Asia/Shanghai)");
    expect(result.timeLine).toContain("UTC: 2026-03-15 06:00 UTC");
    expect(result.timeLine).toMatch(/Local: 2026-03-15 14:00 .+ \(\+08:00\)/);
  });
});

describe("appendCronStyleCurrentTimeLine", () => {
  it("does not append duplicate current-time lines", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;

    const prompt = appendCronStyleCurrentTimeLine(
      "Do the thing\nCurrent time: already present",
      cfg,
      Date.UTC(2026, 2, 3, 14, 0, 0),
    );

    expect(prompt).toBe("Do the thing\nCurrent time: already present");
  });
});
