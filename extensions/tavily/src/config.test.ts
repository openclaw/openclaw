import { afterEach, describe, expect, it } from "vitest";
import { resolveTavilyApiKey } from "./config.js";

describe("resolveTavilyApiKey", () => {
  const originalEnv = process.env.TAVILY_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = originalEnv;
    }
  });

  it("returns the configured string apiKey as-is", () => {
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: { apiKey: "configured-key" },
              },
            },
          },
        },
      } as never),
    ).toBe("configured-key");
  });

  it("falls back to process.env.TAVILY_API_KEY when the configured env SecretRef is unresolvable", () => {
    // Real SecretRef input — the bundled SDK v2026.6.8 already supports
    // mode: "inspect" (see types.secrets-* in dist), so the production
    // resolver path runs end-to-end without any vi.mock.
    process.env.TAVILY_API_KEY = "env-fallback-key";
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "TAVILY_API_KEY",
                  },
                },
              },
            },
          },
        },
      } as never),
    ).toBe("env-fallback-key");
  });

  it("does NOT fall back to process.env.TAVILY_API_KEY when the configured SecretRef is a file source", () => {
    // File-backed SecretRefs are blocked at the inspect-mode layer before
    // the env fallback is consulted. Even when process.env.TAVILY_API_KEY
    // is set, the file ref must not be silently replaced with the ambient
    // env value.
    process.env.TAVILY_API_KEY = "env-fallback-key";
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "file",
                    provider: "default",
                    id: "/etc/secrets/tavily",
                  },
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("does NOT fall back to process.env.TAVILY_API_KEY when the configured env SecretRef targets a different env var", () => {
    // Env-backed SecretRefs whose id is not TAVILY_API_KEY must not be
    // silently rewritten to the ambient TAVILY_API_KEY value.
    process.env.TAVILY_API_KEY = "env-fallback-key";
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "OTHER_API_KEY",
                  },
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("does NOT fall back when the configured SecretRef source is exec (any id)", () => {
    // Symmetric with the file-source test: any non-env source is blocked
    // before the ambient env fallback is consulted.
    process.env.TAVILY_API_KEY = "env-fallback-key";
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "exec",
                    provider: "default",
                    id: "TAVILY_API_KEY",
                  },
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("trims whitespace from the configured env SecretRef id before matching", () => {
    // The helper applies .trim() in the resolver so YAML config that pads
    // env var names still matches TAVILY_API_KEY. This pins the behavior.
    process.env.TAVILY_API_KEY = "env-fallback-key";
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "  TAVILY_API_KEY  ",
                  },
                },
              },
            },
          },
        },
      } as never),
    ).toBe("env-fallback-key");
  });

  it("does NOT fall back when the configured env SecretRef uses a provider not in the env allowlist", () => {
    // canResolveEnvSecretRefInReadOnlyPath gates on cfg.secrets.providers
    // allowlist. A non-default provider without an allowlist entry must not
    // silently fall through to process.env.TAVILY_API_KEY.
    process.env.TAVILY_API_KEY = "env-fallback-key";
    expect(
      resolveTavilyApiKey({
        secrets: {
          providers: {
            "unknown-vault": { source: "env", allowlist: [] },
          },
        },
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "unknown-vault",
                    id: "TAVILY_API_KEY",
                  },
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("returns undefined when neither config nor env var is set", () => {
    delete process.env.TAVILY_API_KEY;
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: { config: { webSearch: {} } },
          },
        },
      } as never),
    ).toBeUndefined();
  });
});
