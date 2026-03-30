import { describe, expect, it } from "vitest";
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
