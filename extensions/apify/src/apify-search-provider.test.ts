import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "../test-api.js";
import { createApifyWebSearchProvider as createContractApifyWebSearchProvider } from "../web-search-contract-api.js";
import { createApifyWebSearchProvider } from "./apify-search-provider.js";

describe("apify web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("exposes the expected metadata and credential wiring", () => {
    const provider = createApifyWebSearchProvider();

    expect(provider.id).toBe("apify");
    expect(provider.label).toBe("Apify RAG Web Browser");
    expect(provider.credentialPath).toBe("plugins.entries.apify.config.apiKey");
    expect(provider.envVars).toEqual(["APIFY_API_KEY"]);
    expect(provider.autoDetectOrder).toBe(60);
    expect(typeof provider.getCredentialValue).toBe("function");
    expect(typeof provider.setCredentialValue).toBe("function");
  });

  it("keeps the lightweight contract surface aligned with provider metadata", () => {
    const provider = createApifyWebSearchProvider();
    const contractProvider = createContractApifyWebSearchProvider();

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
    expect(contractProvider.createTool({ config: {}, searchConfig: {} })).toBeNull();
  });

  it("createTool returns a non-null tool definition", () => {
    const provider = createApifyWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    expect(tool).not.toBeNull();
    expect(tool?.description).toContain("Apify RAG Web Browser");
    expect(tool?.parameters).toBeDefined();
  });

  it("returns a soft error payload when no API key is configured", async () => {
    vi.stubEnv("APIFY_API_KEY", "");
    const provider = createApifyWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "test" });

    expect(result).toMatchObject({ error: "missing_apify_api_key" });
  });

  it("picks up APIFY_API_KEY from the environment", () => {
    vi.stubEnv("APIFY_API_KEY", "apify_env_key");
    expect(__testing.resolveApifyApiKey({})).toBe("apify_env_key");
  });

  it("prefers configured plugin apiKey over the environment variable", () => {
    vi.stubEnv("APIFY_API_KEY", "apify_env_key");
    expect(__testing.resolveApifyApiKey({ apiKey: "apify_configured" })).toBe("apify_configured");
  });

  it("calls the Apify actor endpoint with the query and merged searchConfig", async () => {
    vi.stubEnv("APIFY_API_KEY", "");
    const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => [
        {
          crawl: { httpStatusCode: 200, requestStatus: "handled" },
          searchResult: {
            title: "Example",
            description: "Example description",
            url: "https://example.com",
          },
          metadata: { title: "", url: "https://example.com" },
          markdown: "Some content",
        },
      ],
    }));
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const provider = createApifyWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { apiKey: "apify_test_key" },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({ query: "openclaw" })) as Record<string, unknown>;

    expect(result.provider).toBe("apify");
    expect(result.query).toBe("openclaw");
    expect(Array.isArray(result.results)).toBe(true);

    const requestUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("apify~rag-web-browser");

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.query).toBe("openclaw");
  });
});
