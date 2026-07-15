import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelAuthLabel } from "./model-auth-label.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("repro_1_1_edge: explicit api-key SecretRef precedence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prioritizes models.json SecretRef when auth explicitly opts in", async () => {
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
              auth: "api-key",
              apiKey: {
                source: "env",
                provider: "default",
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
              auth: "api-key",
              apiKey: {
                source: "env",
                provider: "default",
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
              auth: "api-key",
              apiKey: {
                source: "env",
                provider: "default",
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
