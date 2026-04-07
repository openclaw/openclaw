import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { MINIMAX_OAUTH_MARKER, NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  createProviderAuthResolver,
  resolveApiKeyFromCredential,
} from "./models-config.providers.secrets.js";

function buildPairedApiKeyProviders(apiKey: string) {
  return {
    provider: { apiKey },
    paired: { apiKey },
  };
}

describe("models-config provider auth provenance", () => {
  it("persists env keyRef and tokenRef auth profiles as env var markers", () => {
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY", "TOGETHER_API_KEY"]);
    delete process.env.VOLCANO_ENGINE_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    try {
      const volcengineApiKey = resolveApiKeyFromCredential({
        type: "api_key",
        provider: "volcengine",
        keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
      })?.apiKey;
      const togetherApiKey = resolveApiKeyFromCredential({
        type: "token",
        provider: "together",
        tokenRef: { source: "env", provider: "default", id: "TOGETHER_API_KEY" },
      })?.apiKey;
      const volcengineProviders = buildPairedApiKeyProviders(volcengineApiKey ?? "");

      expect(volcengineProviders.provider.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(volcengineProviders.paired.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(togetherApiKey).toBe("TOGETHER_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses non-env marker for ref-managed profiles even when runtime plaintext is present", () => {
    const byteplusApiKey = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "byteplus",
      key: "sk-runtime-resolved-byteplus",
      keyRef: { source: "file", provider: "vault", id: "/byteplus/apiKey" },
    })?.apiKey;
    const togetherApiKey = resolveApiKeyFromCredential({
      type: "token",
      provider: "together",
      token: "tok-runtime-resolved-together",
      tokenRef: { source: "exec", provider: "vault", id: "providers/together/token" },
    })?.apiKey;
    const byteplusProviders = buildPairedApiKeyProviders(byteplusApiKey ?? "");

    expect(byteplusProviders.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(byteplusProviders.paired.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(togetherApiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("keeps oauth compatibility markers for minimax-portal", () => {
    const providers = {
      "minimax-portal": {
        apiKey: MINIMAX_OAUTH_MARKER,
      },
    };
    expect(providers["minimax-portal"]?.apiKey).toBe(MINIMAX_OAUTH_MARKER);
  });

  it("prefers profile auth over env auth in provider summaries to match runtime resolution", async () => {
    const auth = createProviderAuthResolver(
      {
        OPENAI_API_KEY: "env-openai-key",
      } as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_PROFILE_KEY" },
          },
        },
      },
    );

    expect(auth("openai")).toEqual({
      apiKey: "OPENAI_PROFILE_KEY",
      discoveryApiKey: undefined,
      mode: "api_key",
      source: "profile",
      profileId: "openai:default",
    });
  });

  it("resolves plugin-owned synthetic auth through the provider hook", () => {
    const auth = createProviderAuthResolver(
      {} as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {},
      },
      {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key",
                },
              },
            },
          },
        },
      },
    );

    expect(auth("xai")).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: "xai-plugin-key",
      mode: "api_key",
      source: "none",
    });
  });
});
