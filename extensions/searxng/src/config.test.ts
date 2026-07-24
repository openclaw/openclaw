// Searxng config tests cover local credential resolution behavior.
import { describe, expect, it } from "vitest";
import { resolveSearxngBaseUrl } from "./config.js";

describe("resolveSearxngBaseUrl", () => {
  it("uses configured string baseUrl before ambient env fallback", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: "https://configured.search///",
              },
            },
          },
        },
      },
    } as never;

    expect(
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search",
      }),
    ).toBe("https://configured.search");
  });

  it("uses ambient env fallback when no baseUrl is configured", () => {
    expect(
      resolveSearxngBaseUrl({} as never, {
        SEARXNG_BASE_URL: "https://ambient.search///",
      }),
    ).toBe("https://ambient.search");
  });

  it("uses ambient env fallback when webSearch config omits baseUrl", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {},
            },
          },
        },
      },
    } as never;

    expect(
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search///",
      }),
    ).toBe("https://ambient.search");
  });

  it("uses ambient env fallback when programmatic config leaves baseUrl undefined", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: { baseUrl: undefined },
            },
          },
        },
      },
    } as never;

    expect(
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search///",
      }),
    ).toBe("https://ambient.search");
  });

  it("resolves configured env SecretRefs before ambient env fallback", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: {
                  source: "env",
                  provider: "default",
                  id: "CUSTOM_SEARXNG_BASE_URL",
                },
              },
            },
          },
        },
      },
    } as never;

    expect(
      resolveSearxngBaseUrl(config, {
        CUSTOM_SEARXNG_BASE_URL: "https://configured.search///",
        SEARXNG_BASE_URL: "https://ambient.search",
      }),
    ).toBe("https://configured.search");
  });

  it("does not fall back to ambient env when a configured SecretRef is unavailable", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: {
                  source: "file",
                  provider: "default",
                  id: "/secrets/searxng-base-url",
                },
              },
            },
          },
        },
      },
    } as never;

    expect(() =>
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search",
      }),
    ).toThrow("Configured SearXNG base URL is unavailable or invalid.");
  });

  it("does not fall back to ambient env when a configured env SecretRef is missing", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: {
                  source: "env",
                  provider: "default",
                  id: "CUSTOM_SEARXNG_BASE_URL",
                },
              },
            },
          },
        },
      },
    } as never;

    expect(() =>
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search",
      }),
    ).toThrow("Configured SearXNG base URL is unavailable or invalid.");
  });

  it("does not fall back to ambient env when baseUrl config is blank", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: "   ",
              },
            },
          },
        },
      },
    } as never;

    expect(() =>
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search",
      }),
    ).toThrow("Configured SearXNG base URL is unavailable or invalid.");
  });

  it("does not fall back to ambient env when baseUrl config is null", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: null,
              },
            },
          },
        },
      },
    } as never;

    expect(() =>
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search",
      }),
    ).toThrow("Configured SearXNG base URL is unavailable or invalid.");
  });

  it("does not fall back to ambient env when baseUrl config is malformed", () => {
    const config = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: { source: "env", provider: "default", id: "" },
              },
            },
          },
        },
      },
    } as never;

    expect(() =>
      resolveSearxngBaseUrl(config, {
        SEARXNG_BASE_URL: "https://ambient.search",
      }),
    ).toThrow("Configured SearXNG base URL is unavailable or invalid.");
  });
});
