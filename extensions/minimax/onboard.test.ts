// Minimax tests cover onboard plugin behavior.
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPreservesPrimary,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { createModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import { buildMinimaxApiModelDefinition } from "./model-definitions.js";
import {
  applyMinimaxApiConfig,
  applyMinimaxApiConfigCn,
  applyMinimaxApiProviderConfig,
  applyMinimaxApiProviderConfigCn,
} from "./onboard.js";

describe.each([
  [
    "global",
    applyMinimaxApiConfig,
    applyMinimaxApiProviderConfig,
    "https://api.minimax.io/anthropic",
  ],
  [
    "cn",
    applyMinimaxApiConfigCn,
    applyMinimaxApiProviderConfigCn,
    "https://api.minimaxi.com/anthropic",
  ],
])("minimax onboard (%s)", (_region, applyConfig, applyProviderConfig, baseUrl) => {
  it("merges existing minimax provider models", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyConfig,
      providerId: "minimax",
      providerApi: "anthropic-messages",
      baseUrl,
      legacyApi: "openai-completions",
    });
    expect(provider?.authHeader).toBe(true);
    expect(provider?.models.map((m) => m.id)).toEqual(["old-model", "MiniMax-M3"]);
  });

  it("drops placeholder apiKey while preserving provider timeout", () => {
    const cfg = applyConfig(
      createModelProviderConfig({
        minimax: {
          baseUrl: "https://api.minimax.io/anthropic",
          apiKey: "minimax",
          api: "anthropic-messages",
          timeoutSeconds: 900,
          models: [buildMinimaxApiModelDefinition("MiniMax-M2.7")],
        },
      }),
    );

    expect(cfg.models?.providers?.minimax?.apiKey).toBeUndefined();
    expect(cfg.models?.providers?.minimax?.timeoutSeconds).toBe(900);
    expect(cfg.models?.providers?.minimax?.models.map((m) => m.id)).toEqual([
      "MiniMax-M2.7",
      "MiniMax-M3",
    ]);
  });

  it("does not overwrite existing primary model in provider-only mode", () => {
    expectProviderOnboardPreservesPrimary({
      applyProviderConfig,
      primaryModelRef: "anthropic/claude-opus-4-5",
    });
  });
});
