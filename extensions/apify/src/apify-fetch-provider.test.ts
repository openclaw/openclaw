import { afterEach, describe, expect, it, vi } from "vitest";
import { createApifyWebFetchProvider as createContractApifyWebFetchProvider } from "../web-fetch-contract-api.js";
import { createApifyWebFetchProvider } from "./apify-fetch-provider.js";

type MockFetch = (
  _input?: unknown,
  _init?: unknown,
) => Promise<{ ok: boolean; json: () => Promise<unknown>; statusText?: string }>;

function makeFetchMock(items: unknown[]): ReturnType<typeof vi.fn<MockFetch>> {
  return vi.fn<MockFetch>(async () => ({ ok: true, json: async () => items }));
}

describe("apify web fetch provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("exposes the expected metadata and credential wiring", () => {
    const provider = createApifyWebFetchProvider();

    expect(provider.id).toBe("apify");
    expect(provider.label).toBe("Apify Website Content Crawler");
    expect(provider.credentialPath).toBe("plugins.entries.apify.config.apiKey");
    expect(provider.envVars).toEqual(["APIFY_API_KEY"]);
    expect(provider.autoDetectOrder).toBe(50);
    expect(typeof provider.getCredentialValue).toBe("function");
    expect(typeof provider.setCredentialValue).toBe("function");
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createApifyWebFetchProvider();
    const contractProvider = createContractApifyWebFetchProvider();

    expect(contractProvider).toMatchObject({
      id: provider.id,
      label: provider.label,
      hint: provider.hint,
      envVars: provider.envVars,
      placeholder: provider.placeholder,
      signupUrl: provider.signupUrl,
      docsUrl: provider.docsUrl,
      autoDetectOrder: provider.autoDetectOrder,
      credentialPath: provider.credentialPath,
    });
    expect(contractProvider.createTool({ config: {} })).toBeNull();
  });

  it("createTool returns a non-null tool definition", () => {
    const provider = createApifyWebFetchProvider();
    const tool = provider.createTool({ config: {} });
    expect(tool).not.toBeNull();
    expect(tool?.description).toContain("Apify Website Content Crawler");
    expect(tool?.parameters).toBeDefined();
  });

  it("throws when no API key is configured", async () => {
    vi.stubEnv("APIFY_API_KEY", "");
    const provider = createApifyWebFetchProvider();
    const tool = provider.createTool({ config: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ url: "https://example.com" })).rejects.toThrow(
      "missing Apify API token",
    );
  });

  it("resolves the API key from APIFY_API_KEY environment variable", async () => {
    vi.stubEnv("APIFY_API_KEY", "apify_env_key");
    const mockFetch = makeFetchMock([
      { url: "https://example.com", metadata: { title: "Example" }, markdown: "# Example" },
    ]);
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const provider = createApifyWebFetchProvider();
    const tool = provider.createTool({ config: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({ url: "https://example.com" })) as Record<string, unknown>;

    expect(result.provider).toBe("apify");
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init?.headers).toMatchObject({ Authorization: "Bearer apify_env_key" });
  });

  it("prefers configured plugin apiKey over the environment variable", async () => {
    vi.stubEnv("APIFY_API_KEY", "apify_env_key");
    const mockFetch = makeFetchMock([
      { url: "https://example.com", metadata: { title: "Example" }, markdown: "# Example" },
    ]);
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const provider = createApifyWebFetchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            apify: {
              config: {
                apiKey: "apify_configured_key",
              },
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ url: "https://example.com" });

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(init?.headers).toMatchObject({ Authorization: "Bearer apify_configured_key" });
  });

  it("calls the Apify Website Content Crawler endpoint with the correct request body", async () => {
    vi.stubEnv("APIFY_API_KEY", "");
    const mockFetch = makeFetchMock([
      {
        url: "https://example.com",
        metadata: { title: "Example Page" },
        markdown: "# Example\n\nSome content.",
      },
    ]);
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const provider = createApifyWebFetchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            apify: {
              config: {
                apiKey: "apify_test_key",
              },
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({ url: "https://example.com" })) as Record<string, unknown>;

    expect(result.provider).toBe("apify");
    expect(result.url).toBe("https://example.com");

    const requestUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("apify~website-content-crawler");

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.startUrls).toEqual([{ url: "https://example.com" }]);
    expect(body.maxCrawlDepth).toBe(0);
    expect(body.maxCrawlPages).toBe(1);
    expect(body.saveMarkdown).toBe(true);
  });

  it("uses low memory for cheerio and high memory for playwright crawlers", async () => {
    vi.stubEnv("APIFY_API_KEY", "");
    const config = {
      plugins: {
        entries: {
          apify: {
            config: {
              apiKey: "apify_test_key",
            },
          },
        },
      },
    };

    const provider = createApifyWebFetchProvider();

    const cheerioMock = makeFetchMock([
      { url: "https://example.com", metadata: { title: "" }, markdown: "" },
    ]);
    global.fetch = cheerioMock as unknown as typeof global.fetch;
    const cheerioTool = provider.createTool({ config });
    await cheerioTool?.execute({ url: "https://example.com", crawlerType: "cheerio" });
    expect(String(cheerioMock.mock.calls[0]?.[0])).toContain("memory=1024");

    const playwrightMock = makeFetchMock([
      { url: "https://example.com", metadata: { title: "" }, markdown: "" },
    ]);
    global.fetch = playwrightMock as unknown as typeof global.fetch;
    const playwrightTool = provider.createTool({ config });
    await playwrightTool?.execute({
      url: "https://example.com",
      crawlerType: "playwright:firefox",
    });
    expect(String(playwrightMock.mock.calls[0]?.[0])).toContain("memory=4096");
  });

  it("throws when the API returns an empty array", async () => {
    vi.stubEnv("APIFY_API_KEY", "");
    const mockFetch = makeFetchMock([]);
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const provider = createApifyWebFetchProvider();
    const tool = provider.createTool({
      config: {
        plugins: {
          entries: {
            apify: {
              config: { apiKey: "apify_test_key" },
            },
          },
        },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await expect(tool.execute({ url: "https://example.com" })).rejects.toThrow(
      "Website Content Crawler returned no content",
    );
  });

  it("setConfiguredCredentialValue writes apiKey into the expected config path", () => {
    const provider = createApifyWebFetchProvider();
    const configTarget: Record<string, unknown> = {};
    provider.setConfiguredCredentialValue?.(configTarget, "apify_written_key");
    expect(
      (
        configTarget as {
          plugins?: { entries?: { apify?: { config?: { apiKey?: unknown } } } };
        }
      ).plugins?.entries?.apify?.config?.apiKey,
    ).toBe("apify_written_key");
  });
});
