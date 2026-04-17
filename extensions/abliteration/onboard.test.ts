import { describe, expect, it } from "vitest";
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "../../test/helpers/plugins/provider-onboard.js";
import { ABLITERATION_DEFAULT_MODEL_REF as ABLITERATION_DEFAULT_MODEL_REF_PUBLIC } from "./api.js";
import {
  ABLITERATION_DEFAULT_MODEL_REF,
  applyAbliterationConfig,
  applyAbliterationProviderConfig,
} from "./onboard.js";

describe("abliteration onboard", () => {
  it("adds Abliteration provider with correct settings", () => {
    const cfg = applyAbliterationConfig({});
    expect(cfg.models?.providers?.abliteration).toMatchObject({
      baseUrl: "https://api.abliteration.ai",
      api: "anthropic-messages",
      authHeader: true,
    });
    expectProviderOnboardPrimaryModel({
      applyConfig: applyAbliterationConfig,
      modelRef: ABLITERATION_DEFAULT_MODEL_REF_PUBLIC,
    });
  });

  it("keeps the public default model ref aligned", () => {
    expect(ABLITERATION_DEFAULT_MODEL_REF).toBe(ABLITERATION_DEFAULT_MODEL_REF_PUBLIC);
    expectProviderOnboardPrimaryModel({
      applyConfig: applyAbliterationConfig,
      modelRef: ABLITERATION_DEFAULT_MODEL_REF,
    });
  });

  it("merges existing Abliteration provider models", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyAbliterationProviderConfig,
      providerId: "abliteration",
      providerApi: "anthropic-messages",
      baseUrl: "https://api.abliteration.ai",
      legacyApi: "openai-completions",
    });
    const ids = provider?.models.map((m) => m.id);
    expect(provider?.authHeader).toBe(true);
    expect(ids).toContain("old-model");
    expect(ids).toContain(ABLITERATION_DEFAULT_MODEL_REF.replace(/^abliteration\//, ""));
  });
});
