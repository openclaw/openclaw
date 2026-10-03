import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { resolveFaceTimeConfig, validateFaceTimeConfig } from "../src/config.js";

describe("facetime config", () => {
  it.each(["administrator", null])(
    "rejects explicit invalid tool policy %j instead of upgrading authority",
    (toolPolicy) => {
      expect(() =>
        resolveFaceTimeConfig({ ownerHandles: ["omar@example.com"], realtime: { toolPolicy } }),
      ).toThrow("realtime.toolPolicy must be one of");
    },
  );

  it("requires at least one owner handle", () => {
    const validation = validateFaceTimeConfig(resolveFaceTimeConfig({}));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain("ownerHandles");
  });

  it("bounds custom model-visible instructions", () => {
    expect(() =>
      resolveFaceTimeConfig({
        ownerHandles: ["omar@example.com"],
        realtime: { instructions: "x".repeat(4_001) },
      }),
    ).toThrow("must not exceed 4000 characters");
  });
});

describe("FaceTime doctor config compatibility", () => {
  const wrap = (config: Record<string, unknown>) => ({
    plugins: { entries: { facetime: { enabled: true, config } } },
  });

  it("migrates the deployed legacy config without mutating the input", () => {
    const realtime = {
      provider: "openai",
      model: "gpt-realtime-2.1",
      sessionKey: "main",
      toolPolicy: "owner",
      voice: "marin",
    };
    const cfg = wrap({
      enabled: true,
      helperHost: "127.0.0.1",
      helperPort: 45670,
      whitelistHandles: ["owner@example.com", "+12065550123"],
      realtime: { ...realtime, brain: "agent-consult" },
    });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config).not.toBe(cfg);
    expect(cfg.plugins.entries.facetime.config).toHaveProperty("helperHost");
    expect(result.config.plugins?.entries?.facetime?.config).toEqual({
      enabled: true,
      ownerHandles: ["owner@example.com", "+12065550123"],
      realtime,
    });
    expect(result.changes).toEqual([
      "Moved plugins.entries.facetime.config.whitelistHandles to plugins.entries.facetime.config.ownerHandles.",
      "Removed retired plugins.entries.facetime.config.helperHost.",
      "Removed retired plugins.entries.facetime.config.helperPort.",
      "Removed retired plugins.entries.facetime.config.realtime.brain.",
    ]);
  });

  it("keeps canonical owner handles authoritative and is idempotent", () => {
    const first = normalizeCompatibilityConfig({
      cfg: wrap({
        ownerHandles: ["current@example.com"],
        whitelistHandles: ["retired@example.com"],
      }),
    });
    expect(first.config.plugins?.entries?.facetime?.config).toEqual({
      ownerHandles: ["current@example.com"],
    });
    expect(first.changes).toEqual([
      "Removed plugins.entries.facetime.config.whitelistHandles; plugins.entries.facetime.config.ownerHandles is authoritative.",
    ]);
    expect(normalizeCompatibilityConfig({ cfg: first.config })).toEqual({
      config: first.config,
      changes: [],
    });
  });
});
