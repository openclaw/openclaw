import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveModelAuthLabel } from "./model-auth-label.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("repro_1_1_edge: SecretRef apiKey precedence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prioritizes explicit models.json SecretRef apiKey over store profiles", async () => {
    vi.stubEnv("REPRO_1_1_SECRET_ENV", "secret-env-value-12345");

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
              apiKey: {
                source: "env",
                id: "REPRO_1_1_SECRET_ENV",
              },
              models: [],
            },
          },
        },
      },
    });

    expect(resolved.apiKey).toBe("secret-env-value-12345");
    expect(resolved.source).toBe("env: REPRO_1_1_SECRET_ENV (models.json secretref)");
    expect(resolved.profileId).toBeUndefined();
  });

  it("resolves correct label for explicit SecretRef apiKey", () => {
    vi.stubEnv("REPRO_1_1_SECRET_ENV", "secret-env-value-12345");

    const label = resolveModelAuthLabel({
      provider: "demo-local",
      cfg: {
        models: {
          providers: {
            "demo-local": {
              baseUrl: "https://explicit.example",
              apiKey: {
                source: "env",
                id: "REPRO_1_1_SECRET_ENV",
              },
              models: [],
            },
          },
        },
      },
    });

    expect(label).toBe("api-key (models.json)");
  });

  it("falls back to store profiles if SecretRef cannot be resolved", async () => {
    // Env variable REPRO_1_1_SECRET_ENV is NOT set
    const resolved = await resolveApiKeyForProvider({
      provider: "demo-local",
      store: {
        version: 1,
        profiles: {
          "demo-local:default": {
            type: "api_key",
            provider: "demo-local",
            key: "profile-key-to-fallback-to",
          },
        },
      },
      cfg: {
        models: {
          providers: {
            "demo-local": {
              baseUrl: "https://explicit.example",
              apiKey: {
                source: "env",
                id: "REPRO_1_1_SECRET_ENV",
              },
              models: [],
            },
          },
        },
      },
    });

    expect(resolved.apiKey).toBe("profile-key-to-fallback-to");
    expect(resolved.source).toBe("profile:demo-local:default");
  });
});
