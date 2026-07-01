// Tavily config tests cover SecretRef resolution and env fallback behavior.
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

  it("returns a plain string apiKey as-is", () => {
    expect(
      resolveTavilyApiKey({
        plugins: {
          entries: {
            tavily: { config: { webSearch: { apiKey: "tvly-abc123" } } },
          },
        },
      } as never),
    ).toBe("tvly-abc123");
  });

  it("falls back to process.env when no apiKey is configured", () => {
    process.env.TAVILY_API_KEY = "env-fallback-key";
    expect(resolveTavilyApiKey({} as never)).toBe("env-fallback-key");
  });

  it("returns undefined when no apiKey and no env var", () => {
    delete process.env.TAVILY_API_KEY;
    expect(resolveTavilyApiKey({} as never)).toBeUndefined();
  });

  it("allows env fallback when an env-source SecretRef is unresolvable", () => {
    process.env.TAVILY_API_KEY = "runtime-env-key";
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
    ).toBe("runtime-env-key");
  });

  it("blocks env fallback when a file-source SecretRef is configured", () => {
    process.env.TAVILY_API_KEY = "ambient-key";
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

  it("blocks env fallback when an exec-source SecretRef is configured", () => {
    process.env.TAVILY_API_KEY = "ambient-key";
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
                    id: "get-tavily-key",
                  },
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });
});
