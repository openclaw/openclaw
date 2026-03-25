import {
  getScopedCredentialValue,
  resolveWebSearchProviderCredential,
} from "openclaw/plugin-sdk/provider-web-search";
import { describe, expect, it } from "vitest";
import { withEnv } from "../../test/helpers/extensions/env.js";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { __testing as grokProviderTesting } from "./src/grok-web-search-provider.js";
import { __testing } from "./web-search.js";

const { extractXaiWebSearchContent, resolveXaiInlineCitations, resolveXaiWebSearchModel } =
  __testing;

describe("xai web search config resolution", () => {
  it("prefers configured api keys and resolves grok scoped defaults", () => {
    expect(grokProviderTesting.resolveGrokApiKey({ apiKey: "xai-secret" })).toBe("xai-secret");
    expect(grokProviderTesting.resolveGrokModel()).toBe("grok-4-1-fast");
    expect(grokProviderTesting.resolveGrokInlineCitations()).toBe(false);
  });

  it("uses config apiKey when provided", () => {
    const searchConfig = { grok: { apiKey: "xai-test-key" } }; // pragma: allowlist secret
    expect(
      resolveWebSearchProviderCredential({
        credentialValue: getScopedCredentialValue(searchConfig, "grok"),
        path: "tools.web.search.grok.apiKey",
        envVars: ["XAI_API_KEY"],
      }),
    ).toBe("xai-test-key");
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(
        resolveWebSearchProviderCredential({
          credentialValue: getScopedCredentialValue({}, "grok"),
          path: "tools.web.search.grok.apiKey",
          envVars: ["XAI_API_KEY"],
        }),
      ).toBeUndefined();
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveXaiWebSearchModel({})).toBe("grok-4-1-fast");
    expect(resolveXaiWebSearchModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveXaiWebSearchModel({ grok: { model: "grok-4-fast-reasoning" } })).toBe(
      "grok-4-fast",
    );
  });

  it("normalizes deprecated grok 4.20 beta model ids to GA ids", () => {
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-reasoning" },
      }),
    ).toBe("grok-4.20-beta-latest-reasoning");
    expect(
      resolveXaiWebSearchModel({
        grok: { model: "grok-4.20-experimental-beta-0304-non-reasoning" },
      }),
    ).toBe("grok-4.20-beta-latest-non-reasoning");
  });

  it("defaults inlineCitations to false", () => {
    expect(resolveXaiInlineCitations({})).toBe(false);
    expect(resolveXaiInlineCitations(undefined)).toBe(false);
  });

  it("respects inlineCitations config", () => {
    expect(resolveXaiInlineCitations({ grok: { inlineCitations: true } })).toBe(true);
    expect(resolveXaiInlineCitations({ grok: { inlineCitations: false } })).toBe(false);
  });

  it("builds wrapped payloads with optional inline citations", () => {
    expect(
      grokProviderTesting.buildXaiWebSearchPayload({
        query: "q",
        provider: "grok",
        model: "grok-4-fast",
        tookMs: 12,
        content: "body",
        citations: ["https://a.test"],
      }),
    ).toMatchObject({
      query: "q",
      provider: "grok",
      model: "grok-4-fast",
      tookMs: 12,
      citations: ["https://a.test"],
      externalContent: expect.objectContaining({ wrapped: true }),
    });
  });
});

describe("xai web search response parsing", () => {
  it("extracts content from Responses API message blocks", () => {
    const result = extractXaiWebSearchContent({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello from output" }],
        },
      ],
    });
    expect(result.text).toBe("hello from output");
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts url_citation annotations from content blocks", () => {
    const result = extractXaiWebSearchContent({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "hello with citations",
              annotations: [
                { type: "url_citation", url: "https://example.com/a" },
                { type: "url_citation", url: "https://example.com/b" },
                { type: "url_citation", url: "https://example.com/a" },
              ],
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("hello with citations");
    expect(result.annotationCitations).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("falls back to deprecated output_text", () => {
    const result = extractXaiWebSearchContent({ output_text: "hello from output_text" });
    expect(result.text).toBe("hello from output_text");
    expect(result.annotationCitations).toEqual([]);
  });

  it("returns undefined text when no content found", () => {
    const result = extractXaiWebSearchContent({});
    expect(result.text).toBeUndefined();
    expect(result.annotationCitations).toEqual([]);
  });

  it("extracts output_text blocks directly in output array", () => {
    const result = extractXaiWebSearchContent({
      output: [
        { type: "web_search_call" },
        {
          type: "output_text",
          text: "direct output text",
          annotations: [{ type: "url_citation", url: "https://example.com/direct" }],
        },
      ],
    });
    expect(result.text).toBe("direct output text");
    expect(result.annotationCitations).toEqual(["https://example.com/direct"]);
  });
});

describe("xai provider models", () => {
  it("publishes the newer Grok fast and code models in the bundled catalog", () => {
    expect(resolveXaiCatalogEntry("grok-4-1-fast")).toMatchObject({
      id: "grok-4-1-fast",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(resolveXaiCatalogEntry("grok-code-fast-1")).toMatchObject({
      id: "grok-code-fast-1",
      reasoning: true,
      contextWindow: 256_000,
      maxTokens: 10_000,
    });
  });

  it("publishes Grok 4.20 reasoning and non-reasoning models", () => {
    expect(resolveXaiCatalogEntry("grok-4.20-beta-latest-reasoning")).toMatchObject({
      id: "grok-4.20-beta-latest-reasoning",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
    });
    expect(resolveXaiCatalogEntry("grok-4.20-beta-latest-non-reasoning")).toMatchObject({
      id: "grok-4.20-beta-latest-non-reasoning",
      reasoning: false,
      contextWindow: 2_000_000,
    });
  });

  it("keeps older Grok aliases resolving with current limits", () => {
    expect(resolveXaiCatalogEntry("grok-4-1-fast-reasoning")).toMatchObject({
      id: "grok-4-1-fast-reasoning",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(resolveXaiCatalogEntry("grok-4.20-reasoning")).toMatchObject({
      id: "grok-4.20-reasoning",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
  });

  it("publishes the remaining Grok 3 family that Pi still carries", () => {
    expect(resolveXaiCatalogEntry("grok-3-mini-fast")).toMatchObject({
      id: "grok-3-mini-fast",
      reasoning: true,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
    expect(resolveXaiCatalogEntry("grok-3-fast")).toMatchObject({
      id: "grok-3-fast",
      reasoning: false,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
  });

  it("marks current Grok families as modern while excluding multi-agent ids", () => {
    expect(isModernXaiModel("grok-4.20-beta-latest-reasoning")).toBe(true);
    expect(isModernXaiModel("grok-code-fast-1")).toBe(true);
    expect(isModernXaiModel("grok-3-mini-fast")).toBe(true);
    expect(isModernXaiModel("grok-4.20-multi-agent-experimental-beta-0304")).toBe(false);
  });

  it("builds forward-compatible runtime models for newer Grok ids", () => {
    const grok41 = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4-1-fast",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok420 = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.20-beta-latest-reasoning",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok3Mini = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-3-mini-fast",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });

    expect(grok41).toMatchObject({
      provider: "xai",
      id: "grok-4-1-fast",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(grok420).toMatchObject({
      provider: "xai",
      id: "grok-4.20-beta-latest-reasoning",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(grok3Mini).toMatchObject({
      provider: "xai",
      id: "grok-3-mini-fast",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
  });

  it("refuses the unsupported multi-agent endpoint ids", () => {
    const model = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.20-multi-agent-experimental-beta-0304",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });

    expect(model).toBeUndefined();
  });
});
