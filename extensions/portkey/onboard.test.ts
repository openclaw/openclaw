import { describe, expect, it } from "vitest";
import { expectProviderOnboardMergedLegacyConfig } from "../../test/helpers/plugins/provider-onboard.js";
import { applyPortkeyProviderConfig } from "./onboard.js";

describe("portkey onboard", () => {
  it("preserves existing baseUrl and api key while adding the default model", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyPortkeyProviderConfig,
      providerId: "portkey",
      providerApi: "openai-completions",
      baseUrl: "https://portkey.example/v1",
      legacyApi: "anthropic-messages",
      legacyModelId: "custom-model",
      legacyModelName: "Custom",
      legacyBaseUrl: "https://portkey.example/v1",
      legacyApiKey: "  old-key  ",
    });

    expect(provider?.models.map((m) => m.id)).toEqual(["custom-model", "claude-opus-4-6"]);
  });
});
