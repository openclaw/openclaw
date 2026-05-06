import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("config resolution", () => {
  it("applies defaults when no config provided", () => {
    const config = resolveConfig({});
    expect(config.enabled).toBe(true);
    expect(config.interval_hours).toBe(168);
    expect(config.min_idle_hours).toBe(2);
    expect(config.stale_after_days).toBe(30);
    expect(config.archive_after_days).toBe(90);
    expect(config.backup.enabled).toBe(true);
    expect(config.backup.keep).toBe(5);
  });

  it("applies defaults when undefined", () => {
    const config = resolveConfig(undefined);
    expect(config.enabled).toBe(true);
    expect(config.interval_hours).toBe(168);
  });

  it("respects custom values", () => {
    const config = resolveConfig({
      enabled: false,
      interval_hours: 24,
      stale_after_days: 7,
      backup: { enabled: false, keep: 3 },
    });
    expect(config.enabled).toBe(false);
    expect(config.interval_hours).toBe(24);
    expect(config.stale_after_days).toBe(7);
    expect(config.backup.enabled).toBe(false);
    expect(config.backup.keep).toBe(3);
  });

  it("clamps interval_hours to min 1", () => {
    const config = resolveConfig({ interval_hours: 0 });
    expect(config.interval_hours).toBe(1);
  });

  it("clamps interval_hours to max 8760", () => {
    const config = resolveConfig({ interval_hours: 10000 });
    expect(config.interval_hours).toBe(8760);
  });

  it("clamps min_idle_hours to min 0", () => {
    const config = resolveConfig({ min_idle_hours: -5 });
    expect(config.min_idle_hours).toBe(0);
  });

  it("clamps stale_after_days to min 1", () => {
    const config = resolveConfig({ stale_after_days: 0 });
    expect(config.stale_after_days).toBe(1);
  });

  it("clamps archive_after_days to min 1", () => {
    const config = resolveConfig({ archive_after_days: -1 });
    expect(config.archive_after_days).toBe(1);
  });

  it("clamps backup.keep to range [1, 100]", () => {
    expect(resolveConfig({ backup: { keep: 0 } }).backup.keep).toBe(1);
    expect(resolveConfig({ backup: { keep: 200 } }).backup.keep).toBe(100);
  });

  it("handles non-object backup gracefully", () => {
    const config = resolveConfig({ backup: "not-an-object" });
    expect(config.backup.enabled).toBe(true);
    expect(config.backup.keep).toBe(5);
  });

  it("treats non-boolean enabled as true (default)", () => {
    expect(resolveConfig({ enabled: "yes" }).enabled).toBe(true);
    expect(resolveConfig({ enabled: 1 }).enabled).toBe(true);
    expect(resolveConfig({ enabled: false }).enabled).toBe(false);
  });
});
