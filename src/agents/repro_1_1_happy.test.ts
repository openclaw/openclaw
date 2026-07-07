import { describe, expect, it } from "vitest";
import { resolveModelAuthLabel } from "./model-auth-label.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("repro_1_1_happy: literal apiKey precedence", () => {
  it("prioritizes explicit models.json literal apiKey over store profiles", async () => {
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
