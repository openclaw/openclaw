import { describe, expect, it } from "vitest";
import { withEnv } from "../../test/helpers/extensions/env.js";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";
import { __testing, createXaiWebSearchProvider } from "./web-search.js";

const {
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiToolSearchConfig,
  resolveXaiWebSearchCredential,
  resolveXaiWebSearchModel,
} = __testing;

describe("xai web search config resolution", () => {
  it("prefers configured api keys and resolves grok scoped defaults", () => {
    expect(resolveXaiWebSearchCredential({ grok: { apiKey: "xai-secret" } })).toBe("xai-secret");
    expect(resolveXaiWebSearchModel()).toBe("grok-4-1-fast");
    expect(resolveXaiInlineCitations()).toBe(false);
  });

  it("uses config apiKey when provided", () => {
    expect(resolveXaiWebSearchCredential({ grok: { apiKey: "xai-test-key" } })).toBe(
      "xai-test-key",
    );
  });

  it("returns undefined when no apiKey is available", () => {
    withEnv({ XAI_API_KEY: undefined }, () => {
      expect(resolveXaiWebSearchCredential({})).toBeUndefined();
    });
  });

  it("resolves env SecretRefs without requiring a runtime snapshot", () => {
    withEnv({ XAI_WEB_SEARCH_KEY: "xai-env-ref-key" }, () => {
      expect(
        resolveXaiWebSearchCredential({
          grok: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "XAI_WEB_SEARCH_KEY",
            },
          },
        }),
      ).toBe("xai-env-ref-key");
    });
  });

  it("merges canonical plugin config into the tool search config", () => {
    const searchConfig = resolveXaiToolSearchConfig({
      config: {
        plugins: {
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "plugin-key",
                  inlineCitations: true,
                  model: "grok-4-fast-reasoning",
                },
              },
            },
          },
        },
      },
      searchConfig: { provider: "grok" },
    });

    expect(resolveXaiWebSearchCredential(searchConfig)).toBe("plugin-key");
    expect(resolveXaiInlineCitations(searchConfig)).toBe(true);
    expect(resolveXaiWebSearchModel(searchConfig)).toBe("grok-4-fast-reasoning");
  });

  it("treats unresolved non-env SecretRefs as missing credentials instead of throwing", async () => {
    await withEnv({ XAI_API_KEY: undefined }, async () => {
      const provider = createXaiWebSearchProvider();
      const maybeTool = provider.createTool({
        config: {
          plugins: {
            entries: {
              xai: {
                enabled: true,
                config: {
                  webSearch: {
                    apiKey: {
                      source: "file",
                      provider: "vault",
                      id: "/providers/xai/web-search",
                    },
                  },
                },
              },
            },
          },
        },
      });
      expect(maybeTool).toBeTruthy();
      if (!maybeTool) {
        throw new Error("expected xai web search tool");
      }

      await expect(maybeTool.execute({ query: "OpenClaw" })).resolves.toMatchObject({
        error: "missing_xai_api_key",
      });
    });
  });

  it("uses default model when not specified", () => {
    expect(resolveXaiWebSearchModel({})).toBe("grok-4-1-fast");
    expect(resolveXaiWebSearchModel(undefined)).toBe("grok-4-1-fast");
  });

  it("uses config model when provided", () => {
    expect(resolveXaiWebSearchModel({ grok: { model: "grok-4-fast-reasoning" } })).toBe(
      "grok-4-fast-reasoning",
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
      __testing.buildXaiWebSearchPayload({
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
