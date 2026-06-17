// Adorbis tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("adorbis provider plugin", () => {
  it("registers Adorbis AI as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("adorbis");
    expect(provider.label).toBe("Adorbis AI");
    expect(provider.docsPath).toBe("/providers/adorbis");
    expect(provider.envVars).toEqual(["ADORBIS_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth?.[0]).toMatchObject({
      kind: "api_key",
      label: "Adorbis AI API key",
      hint: "Sovereign OpenAI-compatible gateway",
      wizard: {
        choiceId: "adorbis-api-key",
        groupId: "adorbis",
        groupLabel: "Adorbis AI",
        groupHint: "Sovereign multi-vendor AI gateway",
        onboardingScopes: ["text-inference"],
      },
    });
  });

  it("skips live catalog discovery until an API key is configured", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    expect(result).toBeNull();
  });
});
