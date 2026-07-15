import { describe, expect, it } from "vitest";
import { resolveModelAuthLabel } from "./model-auth-label.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("repro_1_1_happy: explicit api-key auth precedence", () => {
  it("preserves profile-first precedence by default", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "demo-local",
      store: {
        version: 1,
        profiles: {
          "demo-local:default": {
            type: "api_key",
            provider: "demo-local",
            key: "profile-key",
          },
        },
      },
      cfg: {
        models: {
          providers: {
            "demo-local": {
              baseUrl: "https://explicit.example",
              apiKey: "models-json-key",
              models: [],
            },
          },
        },
      },
    });

    expect(resolved.apiKey).toBe("profile-key");
    expect(resolved.source).toBe("profile:demo-local:default");
  });

  it("prioritizes models.json literal apiKey when auth explicitly opts in", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "demo-local",
      store: {
        version: 1,
        profiles: {
          "demo-local:default": {
            type: "api_key",
            provider: "demo-local",
            key: "profile-key-to-ignore",
          },
        },
      },
      cfg: {
        models: {
          providers: {
            "demo-local": {
              baseUrl: "https://explicit.example",
              auth: "api-key",
              apiKey: "explicit-literal-key",
              models: [],
            },
          },
        },
      },
    });

    expect(resolved.apiKey).toBe("explicit-literal-key");
    expect(resolved.source).toBe("models.json");
    expect(resolved.profileId).toBeUndefined();
  });

  it("resolves the correct user-facing label for explicit literal apiKey", () => {
    const label = resolveModelAuthLabel({
      provider: "demo-local",
      cfg: {
        models: {
          providers: {
            "demo-local": {
              baseUrl: "https://explicit.example",
              auth: "api-key",
              apiKey: "explicit-literal-key",
              models: [],
            },
          },
        },
      },
    });

    expect(label).toBe("api-key (models.json)");
  });
});
