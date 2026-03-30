import { describe, expect, it } from "vitest";
import { isOracleCatalogModelVisible, resolveOracleModelRouting } from "./oci-routing.js";
import { buildOracleCatalogModelId, resolveOracleDynamicModel } from "./provider.js";

describe("oracle provider catalog model ids", () => {
  it("prefers a vendor-qualified model name for opaque on-demand ids", () => {
    expect(
      buildOracleCatalogModelId({
        id: "ocid1.model.oc1..exampleuniqueid",
        displayName: "gemini-2.5-pro",
        vendor: "Google",
      }),
    ).toBe("google.gemini-2.5-pro");
  });

  it("keeps already-qualified model names stable", () => {
    expect(
      buildOracleCatalogModelId({
        id: "ocid1.model.oc1..examplequalifiedid",
        displayName: "google.gemini-2-5-pro",
        vendor: "Google",
      }),
    ).toBe("google.gemini-2-5-pro");
  });

  it("falls back to the raw OCI id when the model name is not a safe ref", () => {
    expect(
      buildOracleCatalogModelId({
        id: "ocid1.model.oc1..examplefallbackid",
        displayName: "Command R 08-2024",
        vendor: "Cohere",
      }),
    ).toBe("ocid1.model.oc1..examplefallbackid");
  });
});

describe("resolveOracleDynamicModel", () => {
  it("keeps the selected on-demand model name as the runtime model id", () => {
    const model = resolveOracleDynamicModel({
      provider: "oracle",
      modelId: "google.gemini-2.5-pro",
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toMatchObject({
      provider: "oracle",
      id: "google.gemini-2.5-pro",
      name: "google.gemini-2.5-pro",
      api: "openai-completions",
      baseUrl: "oci://generative-ai",
    });
  });
});

describe("oracle routing metadata", () => {
  it("hides known non-invokable Cohere aliases from catalog discovery", () => {
    expect(isOracleCatalogModelVisible("cohere.command-a-reasoning")).toBe(false);
    expect(isOracleCatalogModelVisible("cohere.command-r-16k")).toBe(false);
    expect(isOracleCatalogModelVisible("cohere.command-r-plus")).toBe(false);
    expect(isOracleCatalogModelVisible("cohere.command-r-08-2024")).toBe(true);
  });

  it("routes current Cohere aliases to the verified OCI api format", () => {
    expect(resolveOracleModelRouting("cohere.command-a-03-2025")).toMatchObject({
      apiFormat: "COHEREV2",
      family: "cohere-v2",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-a-reasoning")).toMatchObject({
      apiFormat: "COHEREV2",
      family: "cohere-v2",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-a-vision")).toMatchObject({
      apiFormat: "COHEREV2",
      family: "cohere-v2",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-latest")).toMatchObject({
      apiFormat: "COHERE",
      family: "cohere",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-plus-latest")).toMatchObject({
      apiFormat: "COHERE",
      family: "cohere",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-r-08-2024")).toMatchObject({
      apiFormat: "COHERE",
      family: "cohere",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-r-16k")).toMatchObject({
      apiFormat: "COHERE",
      family: "cohere",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-r-plus")).toMatchObject({
      apiFormat: "COHERE",
      family: "cohere",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("cohere.command-r-plus-08-2024")).toMatchObject({
      apiFormat: "COHERE",
      family: "cohere",
      outputTokenField: "maxTokens",
    });
  });

  it("keeps non-Cohere chat models on GENERIC and maps Oracle OpenAI to maxCompletionTokens", () => {
    expect(resolveOracleModelRouting("google.gemini-2.5-pro")).toMatchObject({
      apiFormat: "GENERIC",
      family: "generic",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("meta.llama-3.3-70b-instruct")).toMatchObject({
      apiFormat: "GENERIC",
      family: "generic",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("xai.grok-4")).toMatchObject({
      apiFormat: "GENERIC",
      family: "generic",
      outputTokenField: "maxTokens",
    });
    expect(resolveOracleModelRouting("openai.gpt-5.4")).toMatchObject({
      apiFormat: "GENERIC",
      family: "generic",
      outputTokenField: "maxCompletionTokens",
    });
  });
});
