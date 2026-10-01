import { describe, expect, it } from "vitest";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import { makeModel } from "./model.test-harness.js";

describe("buildInlineProviderModels", () => {
  it("normalizes bare Google API hosts for custom Google Generative AI providers", () => {
    expect(
      buildInlineProviderModels({
        "google-paid ": {
          baseUrl: "https://generativelanguage.googleapis.com",
          api: "google-generative-ai",
          models: [makeModel("gemini-2.5-pro")],
        },
      }),
    ).toMatchObject([
      {
        provider: "google-paid",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    ]);
  });

  it("merges provider request headers into inline models", () => {
    const result = buildInlineProviderModels({
      proxy: {
        baseUrl: "https://proxy.example.com/v1",
        api: "openai-completions",
        request: { headers: { "X-Tenant": "acme" } },
        models: [makeModel("proxy-model")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.headers).toEqual({ "X-Tenant": "acme" });
  });

  it("drops SecretRef marker headers in inline provider models", () => {
    const result = buildInlineProviderModels({
      custom: {
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
        models: [makeModel("custom-model")],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.headers).toEqual({ "X-Static": "tenant-a" });
  });
});
