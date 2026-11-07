import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { migrateTencentTokenHubModelDefaults as migrateDefaults } from "./config-compat.js";

const HY3 = "tencent-tokenhub/hy3";
const HY3_PREVIEW = "tencent-tokenhub/hy3-preview";
const HY4_PREVIEW = "tencent-tokenhub/hy4-preview";
const DEFAULT_MODELS = {
  [HY4_PREVIEW]: { alias: "Hy4 preview (TokenHub)" },
  [HY3]: { alias: "Hy3 (TokenHub)" },
  [HY3_PREVIEW]: { alias: "Hy3 preview (TokenHub)" },
};
const REPAIRED_ALLOWLIST_CHANGE = `Updated Tencent TokenHub agent model defaults to include ${HY4_PREVIEW}, ${HY3}, ${HY3_PREVIEW}.`;
type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
const configWith = (defaults: Defaults): OpenClawConfig => ({ agents: { defaults } });

describe("Tencent config compatibility", () => {
  it.each(["string", "object"])("migrates a %s hy3-preview primary to hy3", (shape) => {
    const objectModel = { primary: HY3_PREVIEW, fallbacks: ["openai/gpt-5.5"] };
    const config: OpenClawConfig = {
      ...configWith({
        model: shape === "string" ? HY3_PREVIEW : objectModel,
        maxConcurrent: 2,
        models: {
          [HY3_PREVIEW]: { alias: "Preview", params: { temperature: 0.4 } },
          "openai/gpt-5.5": { alias: "Other" },
        },
      }),
      gateway: { port: 18790 },
    };
    const original = structuredClone(config);
    const result = migrateDefaults(config);

    expect(result.changes).toEqual([
      REPAIRED_ALLOWLIST_CHANGE,
      `Changed Tencent TokenHub primary default from ${HY3_PREVIEW} to ${HY3}.`,
    ]);
    expect(result.config).toEqual({
      ...config,
      ...configWith({
        maxConcurrent: 2,
        model: { primary: HY3, ...(shape === "object" ? { fallbacks: ["openai/gpt-5.5"] } : {}) },
        models: { ...DEFAULT_MODELS, ...config.agents?.defaults?.models },
      }),
    });
    expect(config).toEqual(original);
    expect(migrateDefaults(result.config)).toEqual({ config: result.config, changes: [] });
  });

  it("backfills the allowlist without touching a working hy3 primary", () => {
    // Hy4 needs different API-key model access, so migration must preserve Hy3.
    const model = { primary: HY3 };
    const models = { [HY3]: { alias: "Custom Hy3" }, [HY3_PREVIEW]: DEFAULT_MODELS[HY3_PREVIEW] };
    const result = migrateDefaults(configWith({ model, models }));
    expect(result.changes).toEqual([REPAIRED_ALLOWLIST_CHANGE]);
    expect(result.config.agents?.defaults).toEqual({
      model,
      models: { ...DEFAULT_MODELS, ...models },
    });
  });

  it.each([HY3, "openai/gpt-5.5"])(
    "preserves an explicit string primary %s while repairing the allowlist",
    (primary) => {
      const config = {
        agents: { defaults: { model: primary, models: { [HY3]: {} } } },
      } as OpenClawConfig;
      const result = migrateDefaults(config);

      expect(result.config.agents?.defaults?.model).toBe(primary);
      expect(result.config.agents?.defaults?.models).toEqual(DEFAULT_MODELS);
    },
  );

  it("does not create a model allowlist when TokenHub models are not already configured", () => {
    const provider = { baseUrl: "https://tokenhub.tencentmaas.com/v1", models: [] };
    const config: OpenClawConfig = {
      models: { providers: { "tencent-tokenhub": provider } },
    };
    expect(migrateDefaults(config)).toEqual({ config, changes: [] });
  });
});
