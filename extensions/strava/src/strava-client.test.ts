import { describe, expect, it, vi } from "vitest";
import { formatPace, formatDuration, formatDistance, getActivities } from "./strava-client.js";

describe("getActivities", () => {
  it("preserves activity ID precision for large 64-bit values", async () => {
    const largeId = "99999999999999999";
    // JSON.stringify would lose precision on this number — patch the raw JSON.
    const rawBody = JSON.stringify([
      {
        id: 1,
        name: "run",
        sport_type: "Run",
        distance: 5000,
        moving_time: 1800,
        elapsed_time: 1900,
        total_elevation_gain: 50,
        average_speed: 2.78,
        max_speed: 4.0,
        average_heartrate: 150,
        max_heartrate: 170,
        start_date: "2026-01-01T08:00:00Z",
        start_date_local: "2026-01-01T09:00:00+01:00",
        timezone: "Europe/Madrid",
        kudos_count: 3,
      },
    ]).replace(/"id":1/, `"id":${largeId}`);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(rawBody) }),
    );

    const activities = await getActivities("tok");
    expect(activities[0].id).toBe(largeId);

    vi.unstubAllGlobals();
  });
});

describe("formatPace", () => {
  it("returns N/A for zero speed", () => {
    expect(formatPace(0)).toBe("N/A");
  });

  it("returns N/A for negative speed", () => {
    expect(formatPace(-1)).toBe("N/A");
  });

  it("formats a typical running pace", () => {
    // 3.03 m/s ≈ 5:30 /km
    expect(formatPace(3.03)).toBe("5:30 /km");
  });

  it("formats a fast pace", () => {
    // 5.0 m/s = 200s/km = 3:20 /km
    expect(formatPace(5.0)).toBe("3:20 /km");
  });

  it("never produces 60 seconds (rounding overflow)", () => {
    // ~2.779 m/s would round to 5:60 with naive rounding
    const pace = formatPace(2.779);
    const match = pace.match(/^(\d+):(\d{2}) \/km$/);
    expect(match).not.toBeNull();
    const sec = Number.parseInt(match![2], 10);
    expect(sec).toBeLessThan(60);
  });

  it("pads single-digit seconds with zero", () => {
    // 4.0 m/s = 250s/km = 4:10 /km
    expect(formatPace(4.0)).toBe("4:10 /km");
  });
});

describe("formatDuration", () => {
  it("formats seconds only", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatDuration(3723)).toBe("1h 2m 3s");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("formatDistance", () => {
  it("formats meters to km with two decimals", () => {
    expect(formatDistance(10500)).toBe("10.50 km");
  });

  it("formats short distances", () => {
    expect(formatDistance(500)).toBe("0.50 km");
  });

  it("handles zero", () => {
    expect(formatDistance(0)).toBe("0.00 km");
  });
});
