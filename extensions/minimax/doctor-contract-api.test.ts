// MiniMax tests cover plugin-owned doctor compatibility migrations.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("MiniMax doctor contract", () => {
  it("migrates both official API-key provider keys and preserves Portal OAuth", () => {
    const config = {
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic/",
            api: "anthropic-messages",
            authHeader: true,
            models: [],
          },
          "minimax-cn": {
            baseUrl: "https://api.minimaxi.com/anthropic",
            api: "anthropic-messages",
            authHeader: true,
            models: [],
          },
          "minimax-portal": {
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            authHeader: true,
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(legacyConfigRules[0]?.match(config.models?.providers?.minimax)).toBe(true);
    expect(legacyConfigRules[1]?.match(config.models?.providers?.["minimax-cn"])).toBe(true);

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.config).not.toBe(config);
    expect(result.config.models?.providers?.minimax?.authHeader).toBe(false);
    expect(result.config.models?.providers?.["minimax-cn"]?.authHeader).toBe(false);
    expect(result.config.models?.providers?.["minimax-portal"]?.authHeader).toBe(true);
    expect(config.models?.providers?.minimax?.authHeader).toBe(true);
    expect(config.models?.providers?.["minimax-cn"]?.authHeader).toBe(true);
    expect(result.changes).toEqual([
      "Updated models.providers.minimax.authHeader from true to false for X-Api-Key authentication.",
      "Updated models.providers.minimax-cn.authHeader from true to false for X-Api-Key authentication.",
    ]);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("preserves custom endpoints and already-correct API-key settings", () => {
    const custom = {
      models: {
        providers: {
          minimax: {
            baseUrl: "https://minimax.example/anthropic",
            api: "anthropic-messages",
            authHeader: true,
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    const corrected = {
      models: {
        providers: {
          "minimax-cn": {
            baseUrl: "https://api.minimaxi.com/anthropic",
            api: "anthropic-messages",
            authHeader: false,
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(normalizeCompatibilityConfig({ cfg: custom })).toEqual({
      config: custom,
      changes: [],
    });
    expect(normalizeCompatibilityConfig({ cfg: corrected })).toEqual({
      config: corrected,
      changes: [],
    });
  });
});
