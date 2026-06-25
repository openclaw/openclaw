import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeProviders, type ProviderConfig } from "./models-config.providers.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

// Regression coverage for issue #96600: custom models added to a native
// provider (google-vertex) via config were silently dropped from the model
// list. google-vertex authenticates via gcloud ADC and has no plain apiKey, but
// pi's ModelRegistry rejects a custom-model provider lacking baseUrl OR apiKey,
// and that rejection drops ALL custom models from models.json. normalizeProviders
// now backfills the built-in baseUrl and a sentinel apiKey for known providers so
// the entry survives validation.

function buildVertexModel(): NonNullable<ProviderConfig["models"]>[number] {
  return {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash (Vertex AI)",
    input: ["text"] as Array<"text" | "image">,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65536,
  };
}

describe("google-vertex provider normalization", () => {
  it("backfills a sentinel apiKey for a custom google-vertex model with a baseUrl", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-vertex-"));
    // Schema-valid shape: api maps to google-generative-ai, baseUrl present, but
    // no apiKey because Vertex uses ADC.
    const providers = {
      "google-vertex": {
        api: "google-generative-ai",
        baseUrl: "https://{location}-aiplatform.googleapis.com",
        models: [buildVertexModel()],
      } as ProviderConfig,
    };

    const normalized = normalizeProviders({ providers, agentDir });

    const vertex = normalized?.["google-vertex"];
    expect(vertex).toBeDefined();
    expect(vertex?.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
    expect(vertex?.apiKey).toBeTruthy();
    expect(vertex?.models.map((model) => model.id)).toEqual(["gemini-3.5-flash"]);
  });

  it("backfills a built-in baseUrl when a known provider omits it", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-vertex-"));
    const providers = {
      "google-vertex": {
        api: "google-generative-ai",
        models: [buildVertexModel()],
      } as unknown as ProviderConfig,
    };

    const normalized = normalizeProviders({ providers, agentDir });

    const vertex = normalized?.["google-vertex"];
    expect(typeof vertex?.baseUrl).toBe("string");
    expect(vertex?.baseUrl).toContain("aiplatform.googleapis.com");
    expect(vertex?.apiKey).toBeTruthy();
  });

  it("does not override a user-provided apiKey", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-vertex-"));
    const providers = {
      "google-vertex": {
        api: "google-generative-ai",
        baseUrl: "https://{location}-aiplatform.googleapis.com",
        apiKey: "MY_VERTEX_KEY", // pragma: allowlist secret
        models: [buildVertexModel()],
      } as ProviderConfig,
    };

    const normalized = normalizeProviders({ providers, agentDir });

    expect(normalized?.["google-vertex"]?.apiKey).toBe("MY_VERTEX_KEY");
  });

  it("leaves unknown custom providers untouched", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-vertex-"));
    const providers = {
      "totally-unknown-provider": {
        api: "openai-completions",
        models: [{ ...buildVertexModel(), id: "some-model" }],
      } as unknown as ProviderConfig,
    };

    const normalized = normalizeProviders({ providers, agentDir });

    // No baseUrl/apiKey backfill for non-built-in providers.
    expect(normalized?.["totally-unknown-provider"]?.baseUrl).toBeUndefined();
    expect(normalized?.["totally-unknown-provider"]?.apiKey).toBeUndefined();
  });

  it("keeps the custom vertex model visible through pi's ModelRegistry", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-vertex-"));
    const providers = {
      "google-vertex": {
        api: "google-generative-ai",
        baseUrl: "https://{location}-aiplatform.googleapis.com",
        models: [buildVertexModel()],
      } as ProviderConfig,
    };
    const normalized = normalizeProviders({ providers, agentDir });

    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: normalized }, null, 2),
      "utf8",
    );

    const registry = discoverModels(discoverAuthStorage(agentDir), agentDir);
    const ids = registry
      .getAll()
      .filter((model) => model.provider === "google-vertex")
      .map((model) => model.id);

    expect(ids).toContain("gemini-3.5-flash");
  });
});
