import { describe, expect, it } from "vitest";
import { resolveGeolocationSettings } from "./config.js";

describe("geolocation settings", () => {
  it("defaults to the DB-IP source and its required credit", () => {
    const settings = resolveGeolocationSettings(undefined);
    expect(settings.databaseUrl).toContain("dbip-city-lite");
    expect(settings.attribution).toEqual({
      text: "IP Geolocation by DB-IP",
      url: "https://db-ip.com",
    });
    expect(settings.refreshMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("keeps attribution overridable so a swapped source can carry its own credit", () => {
    const settings = resolveGeolocationSettings({
      databaseUrl: "https://example.test/db.mmdb",
      attributionText: "Data by Example",
      attributionUrl: "https://example.test",
      refreshDays: 7,
    });
    expect(settings.databaseUrl).toBe("https://example.test/db.mmdb");
    expect(settings.attribution.text).toBe("Data by Example");
    expect(settings.refreshMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("ignores unusable overrides instead of producing an empty source or credit", () => {
    const settings = resolveGeolocationSettings({
      databaseUrl: "   ",
      attributionText: "",
      refreshDays: 0,
    });
    expect(settings.databaseUrl).toContain("dbip-city-lite");
    expect(settings.attribution.text).toBe("IP Geolocation by DB-IP");
    expect(settings.refreshMs).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
