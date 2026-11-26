import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { resolveFaceTimeConfig, validateFaceTimeConfig } from "../src/config.js";

describe("facetime config", () => {
  it("defaults omitted policy to owner without exposing a helper endpoint", () => {
    const config = resolveFaceTimeConfig({ allowedCallers: ["mailto:omar@example.com"] });

    expect(config.allowedCallers).toEqual(["mailto:omar@example.com"]);
    expect(config.realtime.toolPolicy).toBe("owner");
    expect(config.realtime).toMatchObject({
      provider: undefined,
      model: undefined,
      voice: undefined,
    });
    expect("helperHost" in config).toBe(false);
    expect("helperPort" in config).toBe(false);
  });

  it.each(["administrator", null])(
    "rejects explicit invalid tool policy %j instead of upgrading authority",
    (toolPolicy) => {
      expect(() =>
        resolveFaceTimeConfig({ allowedCallers: ["omar@example.com"], realtime: { toolPolicy } }),
      ).toThrow("realtime.toolPolicy must be one of");
    },
  );

  it("requires at least one allowed caller", () => {
    const validation = validateFaceTimeConfig(resolveFaceTimeConfig({}));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain("allowedCallers");
  });

  it("bounds custom model-visible instructions", () => {
    expect(() =>
      resolveFaceTimeConfig({
        allowedCallers: ["omar@example.com"],
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
      allowedCallers: ["owner@example.com", "+12065550123"],
      realtime,
    });
    expect(result.config.commands).toEqual({
      ownerAllowFrom: ["facetime:owner@example.com", "facetime:+12065550123"],
    });
    expect(result.changes).toEqual([
      "Moved plugins.entries.facetime.config.whitelistHandles to plugins.entries.facetime.config.allowedCallers.",
      expect.stringContaining("Added FaceTime callers to commands.ownerAllowFrom"),
      "Removed retired plugins.entries.facetime.config.helperHost.",
      "Removed retired plugins.entries.facetime.config.helperPort.",
      "Removed retired plugins.entries.facetime.config.realtime.brain.",
    ]);
  });

  it("moves ownerHandles and promotes its callers to owners once", () => {
    const first = normalizeCompatibilityConfig({
      cfg: {
        ...wrap({
          ownerHandles: ["MAILTO:Owner@Example.com", "tel:+1 (206) 555-0123", "a@b.c"],
          whitelistHandles: ["retired@example.com"],
        }),
        commands: { ownerAllowFrom: ["discord:123", 456, "facetime:a@b.c"] },
      },
    });
    expect(first.config.plugins?.entries?.facetime?.config).toEqual({
      allowedCallers: ["MAILTO:Owner@Example.com", "tel:+1 (206) 555-0123", "a@b.c"],
    });
    expect(first.config.commands?.ownerAllowFrom).toEqual([
      "discord:123",
      456,
      "facetime:a@b.c",
      "facetime:owner@example.com",
      "facetime:+12065550123",
    ]);
    expect(first.changes).toEqual([
      "Moved plugins.entries.facetime.config.ownerHandles to plugins.entries.facetime.config.allowedCallers.",
      expect.stringContaining("(facetime:owner@example.com, facetime:+12065550123)"),
      "Removed plugins.entries.facetime.config.whitelistHandles; plugins.entries.facetime.config.allowedCallers is authoritative.",
    ]);
    expect(normalizeCompatibilityConfig({ cfg: first.config })).toEqual({
      config: first.config,
      changes: [],
    });

    // The operator then takes owner tools away from every FaceTime caller; Doctor keeps that.
    const edited = structuredClone(first.config);
    edited.commands = { ownerAllowFrom: ["discord:123"] };
    expect(normalizeCompatibilityConfig({ cfg: edited })).toEqual({ config: edited, changes: [] });
  });

  it("never promotes allowedCallers to owners", () => {
    const fresh = wrap({ allowedCallers: ["guest@example.com"] });
    expect(normalizeCompatibilityConfig({ cfg: fresh })).toEqual({ config: fresh, changes: [] });

    const both = normalizeCompatibilityConfig({
      cfg: wrap({ allowedCallers: ["guest@example.com"], ownerHandles: ["old@example.com"] }),
    });
    expect(both.config).toEqual(wrap({ allowedCallers: ["guest@example.com"] }));
    expect(both.changes).toEqual([
      "Removed plugins.entries.facetime.config.ownerHandles; plugins.entries.facetime.config.allowedCallers is authoritative.",
    ]);
  });
});
