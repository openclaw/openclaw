import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveApiKeyForProvider } from "./model-auth.js";

describe("repro_1_1_stress: concurrent precedence resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves multiple provider credentials concurrently without state pollution", async () => {
    vi.stubEnv("CONCURRENT_ENV_1", "concurrent-val-1");
    vi.stubEnv("CONCURRENT_ENV_2", "concurrent-val-2");

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "p1:default": {
          type: "api_key" as const,
          provider: "p1",
          key: "p1-profile-key",
        },
        "p2:default": {
          type: "api_key" as const,
          provider: "p2",
          key: "p2-profile-key",
        },
        "p3:default": {
          type: "api_key" as const,
          provider: "p3",
          key: "p3-profile-key",
        },
      },
    };

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          p1: {
            baseUrl: "https://p1.example",
            auth: "api-key" as const,
            apiKey: "p1-explicit-literal",
            models: [],
          },
          p2: {
            baseUrl: "https://p2.example",
            auth: "api-key" as const,
            apiKey: {
              source: "env",
              provider: "default",
              id: "CONCURRENT_ENV_2",
            },
            models: [],
          },
          p3: {
            baseUrl: "https://p3.example",
            // Should fallback to p3:default
            models: [],
          },
        },
      },
    };

    // Run 50 concurrent lookups
    const promises = Array.from({ length: 50 }).flatMap(() => [
      resolveApiKeyForProvider({ provider: "p1", store, cfg }),
      resolveApiKeyForProvider({ provider: "p2", store, cfg }),
      resolveApiKeyForProvider({ provider: "p3", store, cfg }),
    ]);

    const results = await Promise.all(promises);

    expect(results).toHaveLength(150);

    for (let i = 0; i < results.length; i += 3) {
      const r1 = results[i];
      const r2 = results[i + 1];
      const r3 = results[i + 2];

      expect(r1.apiKey).toBe("p1-explicit-literal");
      expect(r1.source).toBe("models.json");

      expect(r2.apiKey).toBe("concurrent-val-2");
      expect(r2.source).toBe("env: CONCURRENT_ENV_2 (models.json secretref)");

      expect(r3.apiKey).toBe("p3-profile-key");
      expect(r3.source).toBe("profile:p3:default");
    }
  });
});
