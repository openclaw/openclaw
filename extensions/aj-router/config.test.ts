import { describe, expect, it } from "vitest";
import { ROUTER_DEFAULTS, resolveConfig } from "./config.js";

describe("aj-router config", () => {
  it("returns full defaults when raw is undefined", () => {
    const cfg = resolveConfig({ raw: undefined, homeDir: "/home/u" });
    expect(cfg.defaultAlias).toBe(ROUTER_DEFAULTS.defaultAlias);
    expect(cfg.aliases).toEqual(ROUTER_DEFAULTS.aliases);
    expect(cfg.logsDir).toBe("/home/u/.openclaw/logs/aj-router");
  });

  it("accepts partial overrides without dropping defaults", () => {
    const cfg = resolveConfig({
      raw: {
        defaultAlias: "flagship",
        escalationThreshold: 0.9,
      },
      homeDir: "/home/u",
    });
    expect(cfg.defaultAlias).toBe("flagship");
    expect(cfg.escalationThreshold).toBeCloseTo(0.9);
    // Defaults preserved for everything else.
    expect(cfg.aliases).toEqual(ROUTER_DEFAULTS.aliases);
    expect(cfg.classifier).toEqual(ROUTER_DEFAULTS.classifier);
  });

  it("normalizes classifier mode to 'heuristic' for unknown values", () => {
    const cfg = resolveConfig({
      raw: { classifier: { mode: "garbage-value", model: "x/y" } },
      homeDir: "/home/u",
    });
    expect(cfg.classifier.mode).toBe("heuristic");
    expect(cfg.classifier.model).toBe("x/y");
  });

  it("accepts a wildcard allowedProviders value", () => {
    const cfg = resolveConfig({
      raw: {
        sensitivity: {
          public: { allowedProviders: "*" },
        },
      },
      homeDir: "/home/u",
    });
    expect(cfg.sensitivity.public?.allowedProviders).toBe("*");
  });

  it("accepts an explicit logsDir override", () => {
    const cfg = resolveConfig({
      raw: { logsDir: "/var/log/aj-router" },
      homeDir: "/home/u",
    });
    expect(cfg.logsDir).toBe("/var/log/aj-router");
  });
});
