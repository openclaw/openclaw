import { describe, expect, it } from "vitest";
import { OCI_GENAI_MODELS } from "./models.js";
import { buildOciCatalogModels, buildOciProvider } from "./provider-catalog.js";

describe("oci-genai provider-catalog", () => {
  it("builds a default OpenAI-compat provider rooted in us-chicago-1", () => {
    const provider = buildOciProvider();
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseUrl).toBe(
      "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1",
    );
    expect(provider.models.length).toBe(OCI_GENAI_MODELS.length);
  });

  it("uses the requested region when one is provided", () => {
    const provider = buildOciProvider("eu-frankfurt-1");
    expect(provider.baseUrl).toBe(
      "https://inference.generativeai.eu-frankfurt-1.oci.oraclecloud.com/openai/v1",
    );
  });

  it("includes Cohere R-series via the OpenAI-compat path", () => {
    const ids = buildOciCatalogModels().map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "cohere.command-r-08-2024",
        "cohere.command-r-plus-08-2024",
        "cohere.command-a-03-2025",
      ]),
    );
  });

  it("marks vision-capable models with image input", () => {
    const grok4 = buildOciCatalogModels().find((m) => m.id === "xai.grok-4");
    const llama = buildOciCatalogModels().find((m) => m.id === "meta.llama-3.3-70b-instruct");
    expect(grok4?.input).toEqual(expect.arrayContaining(["text", "image"]));
    expect(llama?.input).toEqual(["text"]);
  });

  it("fills cacheRead / cacheWrite from input/output when missing", () => {
    const llama = buildOciCatalogModels().find((m) => m.id === "meta.llama-3.3-70b-instruct");
    expect(llama?.cost.cacheRead).toBe(llama?.cost.input);
    expect(llama?.cost.cacheWrite).toBe(llama?.cost.output);
  });
});
