// Feishu tests cover the doctor contract artifact surface.
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { describe, expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { FeishuConfigSchema } from "./src/config-validator.js";

vi.mock(import("openclaw/plugin-sdk/channel-config-schema"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildChannelConfigSchema: vi.fn(actual.buildChannelConfigSchema) };
});

const projectedOnImport = vi.mocked(buildChannelConfigSchema).mock.calls.map(([schema]) => schema);

describe("feishu doctor contract artifact", () => {
  it("loads its validator without converting the Feishu schema for the channel editor", () => {
    expect(projectedOnImport).not.toContain(FeishuConfigSchema);
  });

  it("exposes registry-shaped streaming alias rules and the config normalizer", () => {
    // The doctor contract registry keeps rules whose path is an array and
    // whose message is a string (coerceLegacyConfigRules); anything else is
    // silently dropped, which would disable the migration for installed builds.
    expect(legacyConfigRules.length).toBeGreaterThan(0);
    for (const rule of legacyConfigRules) {
      expect(Array.isArray(rule.path)).toBe(true);
      expect(typeof rule.message).toBe("string");
    }

    const result = normalizeCompatibilityConfig({
      cfg: { channels: { feishu: { streaming: true } } } as never,
    });
    const feishu = result.config.channels?.feishu as Record<string, unknown>;
    expect(feishu.streaming).toEqual({ mode: "partial" });
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("moves stray plugin-entry config into channels.feishu and clears the entry", () => {
    const cfg = {
      plugins: {
        entries: { feishu: { enabled: true, config: { appId: "cli_a1", appSecret: "s3cret" } } },
      },
    } as never;

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([
      "Moved plugins.entries.feishu.config.appId to channels.feishu.appId.",
      "Moved plugins.entries.feishu.config.appSecret to channels.feishu.appSecret.",
    ]);
    expect(result.config.channels?.feishu).toEqual({ appId: "cli_a1", appSecret: "s3cret" });
    expect(result.config.plugins?.entries?.feishu).toEqual({ enabled: true });
  });

  it("leaves unmergeable stray plugin-entry config in place", () => {
    const cfg = {
      plugins: { entries: { feishu: { config: { appId: 42 } } } },
    } as never;

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([]);
    expect(result.config.plugins?.entries?.feishu).toEqual({ config: { appId: 42 } });
  });
});
