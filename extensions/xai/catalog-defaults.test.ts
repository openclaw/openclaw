import {
  resolveAgentModelPrimaryValue,
  type ModelProviderConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { expect, it } from "vitest";
import { buildXaiCatalogModels } from "./model-definitions.js";
import { applyXaiConfig, applyXaiOAuthConfig } from "./onboard.js";

const oauthProvider: ModelProviderConfig = {
  api: "openai-responses",
  auth: "oauth",
  baseUrl: "https://cli-chat-proxy.grok.com/v1",
  models: [],
};

it.each(["api-key", "oauth"] as const)("uses the curated default for fresh %s setup", (method) => {
  const config = method === "oauth" ? applyXaiOAuthConfig({}, oauthProvider) : applyXaiConfig({});
  expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe("xai/grok-4.6");
  expect(config.agents?.defaults?.models?.["xai/grok-4.6"]?.alias).toBe("Grok");
});

it("keeps a caller's price and input edits out of the curated catalog", () => {
  const customized = buildXaiCatalogModels();
  const first = customized[0];
  if (!first) {
    throw new Error("expected the default curated model");
  }
  first.cost.input = 999;
  first.input.push("audio");

  const fresh = buildXaiCatalogModels()[0];
  expect(fresh?.cost.input).toBe(2);
  expect(fresh?.input).toEqual(["text", "image"]);
});

it.each(["api-key", "oauth"] as const)(
  "preserves the existing primary during %s setup",
  (method) => {
    const original: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/retained-model", fallbacks: ["xai/grok-4.3"] } },
      },
    };
    const config =
      method === "oauth" ? applyXaiOAuthConfig(original, oauthProvider) : applyXaiConfig(original);
    expect(config.agents?.defaults?.model).toEqual({
      primary: "openai/retained-model",
      fallbacks: ["xai/grok-4.3"],
    });
  },
);
