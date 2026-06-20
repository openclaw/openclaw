import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTavilyApiKey } from "./config.js";

describe("resolveTavilyApiKey", () => {
  const originalEnv = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    process.env.TAVILY_API_KEY = "env-fallback-key";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = originalEnv;
    }
    vi.restoreAllMocks();
    vi.unmock("openclaw/plugin-sdk/secret-input");
    vi.unmock("openclaw/plugin-sdk/extension-shared");
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
    // Simulate the case where the runtime snapshot cannot inline-resolve
    // a configured env SecretRef. resolveConfiguredSecret should return
    // `available` with the env value, so the key is used.
    vi.mock("openclaw/plugin-sdk/secret-input", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/secret-input")>(
        "openclaw/plugin-sdk/secret-input",
      );
      return {
        ...actual,
        resolveSecretInputString: (params: { value: unknown; path: string; mode: string }) => {
          if (params.mode === "inspect") {
            // Mimic the runtime returning "configured_unavailable" for an
            // env SecretRef that targets TAVILY_API_KEY.
            return {
              status: "configured_unavailable",
              ref: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
            };
          }
          return actual.resolveSecretInputString(params);
        },
      };
    });

    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
                },
              },
            },
          },
        },
      } as never),
    ).toBe("env-fallback-key");
  });

  it("does NOT fall back to process.env.TAVILY_API_KEY when the configured SecretRef is a file source", () => {
    // File-backed SecretRefs must not silently fall through to ambient
    // TAVILY_API_KEY. resolveConfiguredSecret should return `blocked`,
    // and resolveTavilyApiKey should return undefined.
    vi.mock("openclaw/plugin-sdk/secret-input", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/secret-input")>(
        "openclaw/plugin-sdk/secret-input",
      );
      return {
        ...actual,
        resolveSecretInputString: () => ({
          status: "configured_unavailable",
          ref: { source: "file", provider: "default", id: "/etc/secrets/tavily" },
        }),
      };
    });

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
    // Env-backed SecretRefs whose id is not TAVILY_API_KEY must not
    // silently fall through to ambient TAVILY_API_KEY.
    vi.mock("openclaw/plugin-sdk/secret-input", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/secret-input")>(
        "openclaw/plugin-sdk/secret-input",
      );
      return {
        ...actual,
        resolveSecretInputString: () => ({
          status: "configured_unavailable",
          ref: { source: "env", provider: "default", id: "OTHER_API_KEY" },
        }),
      };
    });

    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "OTHER_API_KEY" },
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("returns undefined when neither config nor env var is set", () => {
    const savedEnv = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    try {
      expect(
        resolveTavilyApiKey({
          plugins: {
            entries: {
              tavily: { config: { webSearch: {} } },
            },
          },
        } as never),
      ).toBeUndefined();
    } finally {
      process.env.TAVILY_API_KEY = savedEnv;
    }
  });
});
