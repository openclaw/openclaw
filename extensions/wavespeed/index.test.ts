import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { resolveProviderAuthEnvVarCandidates } from "../../src/secrets/provider-env-vars.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import wavespeedPlugin from "./index.js";
import { WAVESPEED_BASE_URL, WAVESPEED_DEFAULT_MODEL_REF } from "./models.js";

describe("wavespeed provider plugin", () => {
  it("registers WaveSpeed with an API key auth choice", async () => {
    const provider = await registerSingleProviderPlugin(wavespeedPlugin);

    expect(provider.id).toBe("wavespeed");
    expect(provider.label).toBe("WaveSpeed");
    expect(provider.envVars).toEqual(["WAVESPEED_API_KEY"]);
    expect(provider.auth).toHaveLength(1);

    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "wavespeed-api-key",
    });
    expect(choice).not.toBeNull();
    expect(choice?.provider.id).toBe("wavespeed");
    expect(choice?.method.id).toBe("wavespeed-platform");
  });

  it("writes the default WaveSpeed provider config during onboarding", async () => {
    const provider = await registerSingleProviderPlugin(wavespeedPlugin);
    const method = provider.auth?.find((entry) => entry.id === "wavespeed-platform");
    if (!method?.runNonInteractive) {
      throw new Error("expected non-interactive WaveSpeed auth");
    }

    const config = await method.runNonInteractive({
      config: {},
      opts: {},
      env: {},
      runtime: {
        error: () => {},
        exit: () => {},
        log: () => {},
      },
      resolveApiKey: async () => ({
        key: "ws-test-key",
        source: "profile",
      }),
      toApiKeyCredential: () => null,
    } as never);

    expect(config?.models?.providers?.wavespeed).toMatchObject({
      baseUrl: WAVESPEED_BASE_URL,
      api: "openai-completions",
    });
    expect(config?.models?.providers?.wavespeed?.models?.map((model) => model.id)).toEqual([
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.6",
      "openai/gpt-4.1",
    ]);
    expect(config?.agents?.defaults?.model).toMatchObject({
      primary: WAVESPEED_DEFAULT_MODEL_REF,
    });
  });

  it("declares its env var candidate for provider auth resolution", () => {
    const candidates = resolveProviderAuthEnvVarCandidates();

    expect(candidates.wavespeed).toEqual(["WAVESPEED_API_KEY"]);
  });

  it("builds the direct WaveSpeed model catalog", async () => {
    const provider = await registerSingleProviderPlugin(wavespeedPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: (id?: string) =>
        id === "wavespeed" ? { apiKey: "ws-test-key" } : { apiKey: undefined },
    });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe(WAVESPEED_BASE_URL);
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.6",
      "openai/gpt-4.1",
    ]);
  });
});
