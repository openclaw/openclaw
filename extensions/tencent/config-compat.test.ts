import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { migrateTencentTokenHubModelDefaults } from "./config-compat.js";

const HY3 = "tencent-tokenhub/hy3";
const HY3_PREVIEW = "tencent-tokenhub/hy3-preview";
const HY4_PREVIEW = "tencent-tokenhub/hy4-preview";
const DEFAULT_MODELS = {
  [HY4_PREVIEW]: { alias: "Hy4 preview (TokenHub)" },
  [HY3]: { alias: "Hy3 (TokenHub)" },
  [HY3_PREVIEW]: { alias: "Hy3 preview (TokenHub)" },
};
const REPAIRED_ALLOWLIST_CHANGE =
  `Updated Tencent TokenHub agent model defaults to include ${HY4_PREVIEW}, ` +
  `${HY3}, ${HY3_PREVIEW}.`;

describe("Tencent config compatibility", () => {
  it.each(["string", "object"])("migrates a %s hy3-preview primary to hy3", (shape) => {
    const config = {
      gateway: { port: 18790 },
      agents: {
        defaults: {
          model:
            shape === "string"
              ? HY3_PREVIEW
              : { primary: HY3_PREVIEW, fallbacks: ["openai/gpt-5.5"] },
          maxConcurrent: 2,
          models: {
            [HY3_PREVIEW]: { alias: "Preview", params: { temperature: 0.4 } },
            "openai/gpt-5.5": { alias: "Other" },
          },
        },
      },
    } as OpenClawConfig;
    const original = structuredClone(config);
    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.changes).toEqual([
      REPAIRED_ALLOWLIST_CHANGE,
      `Changed Tencent TokenHub primary default from ${HY3_PREVIEW} to ${HY3}.`,
    ]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: HY3,
      ...(shape === "object" ? { fallbacks: ["openai/gpt-5.5"] } : {}),
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      ...DEFAULT_MODELS,
      ...config.agents?.defaults?.models,
    });
    expect(result.config.gateway).toEqual(config.gateway);
    expect(result.config.agents?.defaults?.maxConcurrent).toBe(2);
    expect(config).toEqual(original);
    expect(migrateTencentTokenHubModelDefaults(result.config)).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("backfills the allowlist without touching a working hy3 primary", () => {
    // Hy4 needs different API-key model access, so migration must preserve Hy3.
    const config = {
      agents: {
        defaults: {
          model: { primary: HY3 },
          models: {
            [HY3]: { alias: "Custom Hy3" },
            [HY3_PREVIEW]: { alias: "Hy3 preview (TokenHub)" },
          },
        },
      },
    } as OpenClawConfig;
    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.changes).toEqual([REPAIRED_ALLOWLIST_CHANGE]);
    expect(result.config.agents?.defaults?.model).toEqual({ primary: HY3 });
    expect(result.config.agents?.defaults?.models).toEqual({
      ...DEFAULT_MODELS,
      [HY3]: { alias: "Custom Hy3" },
    });
  });

  it.each([HY3, "openai/gpt-5.5"])(
    "preserves an explicit string primary %s while repairing the allowlist",
    (primary) => {
      const config = {
        agents: { defaults: { model: primary, models: { [HY3]: {} } } },
      } as OpenClawConfig;
      const result = migrateTencentTokenHubModelDefaults(config);

      expect(result.config.agents?.defaults?.model).toBe(primary);
      expect(result.config.agents?.defaults?.models).toEqual(DEFAULT_MODELS);
    },
  );

  it("repairs configs that only pinned hy4-preview", () => {
    const config = {
      agents: { defaults: { model: { primary: HY4_PREVIEW }, models: { [HY4_PREVIEW]: {} } } },
    } as OpenClawConfig;
    const result = migrateTencentTokenHubModelDefaults(config);

    expect(result.changes).toEqual([REPAIRED_ALLOWLIST_CHANGE]);
    expect(result.config.agents?.defaults?.model).toEqual({ primary: HY4_PREVIEW });
    expect(result.config.agents?.defaults?.models).toEqual(DEFAULT_MODELS);
  });

  it("does not create a model allowlist when TokenHub models are not already configured", () => {
    const config = {
      models: {
        providers: {
          "tencent-tokenhub": { baseUrl: "https://tokenhub.tencentmaas.com/v1", models: [] },
        },
      },
    } as OpenClawConfig;
    expect(migrateTencentTokenHubModelDefaults(config)).toEqual({ config, changes: [] });
  });

  it("preserves custom aliases after defaults are repaired", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: HY3 },
          models: {
            [HY4_PREVIEW]: { alias: "My Hy4" },
            [HY3]: { alias: "My Hy3" },
            [HY3_PREVIEW]: { alias: "My preview" },
          },
        },
      },
    } as OpenClawConfig;
    expect(migrateTencentTokenHubModelDefaults(config)).toEqual({ config, changes: [] });
  });
});
