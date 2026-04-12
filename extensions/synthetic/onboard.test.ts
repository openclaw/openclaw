import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { expectProviderOnboardMergedLegacyConfig } from "../../test/helpers/plugins/provider-onboard.js";
import { SYNTHETIC_DEFAULT_MODEL_REF as SYNTHETIC_DEFAULT_MODEL_REF_PUBLIC } from "./api.js";
import {
  applySyntheticConfig,
  applySyntheticProviderConfig,
  SYNTHETIC_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("synthetic onboard", () => {
  it("adds synthetic provider with correct settings", () => {
    const cfg = applySyntheticConfig({});
    expect(cfg.models?.providers?.synthetic).toMatchObject({
      baseUrl: "https://api.synthetic.new/anthropic",
      api: "anthropic-messages",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      SYNTHETIC_DEFAULT_MODEL_REF_PUBLIC,
    );
  });

  it("merges existing synthetic provider models", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applySyntheticProviderConfig,
      providerId: "synthetic",
      providerApi: "anthropic-messages",
      baseUrl: "https://api.synthetic.new/anthropic",
      legacyApi: "openai-completions",
    });
    const ids = provider?.models.map((m) => m.id);
    expect(ids).toContain("old-model");
    expect(ids).toContain(SYNTHETIC_DEFAULT_MODEL_REF.replace(/^synthetic\//, ""));
  });
});
