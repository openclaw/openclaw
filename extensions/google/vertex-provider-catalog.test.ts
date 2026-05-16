import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import {
  buildGoogleVertexProvider,
  GOOGLE_VERTEX_DEFAULT_MODEL_ID,
  mergeImplicitGoogleVertexProvider,
} from "./vertex-provider-catalog.js";

describe("buildGoogleVertexProvider", () => {
  it("builds a provider config rooted at the global Vertex endpoint by default", () => {
    const provider = buildGoogleVertexProvider({
      env: { GOOGLE_CLOUD_PROJECT: "my-project" } as NodeJS.ProcessEnv,
    });
    expect(provider.baseUrl).toBe("https://aiplatform.googleapis.com");
    expect(provider.api).toBe("google-generative-ai");
    expect(provider.apiKey).toBe("gcp-vertex-credentials");
    expect(provider.headers).toEqual({ "x-goog-user-project": "my-project" });
  });

  it("respects an explicit GOOGLE_CLOUD_LOCATION", () => {
    const provider = buildGoogleVertexProvider({
      env: {
        GOOGLE_CLOUD_PROJECT: "my-project",
        GOOGLE_CLOUD_LOCATION: "europe-west4",
      } as NodeJS.ProcessEnv,
    });
    expect(provider.baseUrl).toBe("https://europe-west4-aiplatform.googleapis.com");
  });

  it("omits the project header when no project can be resolved", () => {
    const provider = buildGoogleVertexProvider({
      env: {
        HOME: "/no/such/home",
      } as NodeJS.ProcessEnv,
    });
    expect(provider.headers).toBeUndefined();
  });

  it("includes the default model in its catalog", () => {
    const provider = buildGoogleVertexProvider({
      env: { GOOGLE_CLOUD_PROJECT: "my-project" } as NodeJS.ProcessEnv,
    });
    const ids = provider.models?.map((model) => model.id) ?? [];
    expect(ids).toContain(GOOGLE_VERTEX_DEFAULT_MODEL_ID);
  });
});

describe("mergeImplicitGoogleVertexProvider", () => {
  const implicit = buildGoogleVertexProvider({
    env: { GOOGLE_CLOUD_PROJECT: "implicit-project" } as NodeJS.ProcessEnv,
  });

  it("returns the implicit provider when no existing config", () => {
    expect(mergeImplicitGoogleVertexProvider({ implicit })).toEqual(implicit);
  });

  it("preserves user-provided fields and merges headers", () => {
    const merged = mergeImplicitGoogleVertexProvider({
      existing: {
        baseUrl: "https://us-east1-aiplatform.googleapis.com",
        api: "google-generative-ai",
        apiKey: "gcp-vertex-credentials",
        headers: { "x-goog-user-project": "user-project" },
      } as unknown as ModelProviderConfig,
      implicit,
    });
    expect(merged.baseUrl).toBe("https://us-east1-aiplatform.googleapis.com");
    expect(merged.headers).toEqual({ "x-goog-user-project": "user-project" });
  });

  it("falls back to implicit models when existing has no models array", () => {
    const merged = mergeImplicitGoogleVertexProvider({
      existing: {
        baseUrl: "https://aiplatform.googleapis.com",
        api: "google-generative-ai",
        apiKey: "gcp-vertex-credentials",
      } as unknown as ModelProviderConfig,
      implicit,
    });
    expect(merged.models).toEqual(implicit.models);
  });

  it("preserves explicit user model lists", () => {
    const merged = mergeImplicitGoogleVertexProvider({
      existing: {
        baseUrl: "https://aiplatform.googleapis.com",
        api: "google-generative-ai",
        apiKey: "gcp-vertex-credentials",
        models: [{ id: "custom-model", name: "Custom" }],
      } as unknown as ModelProviderConfig,
      implicit,
    });
    expect(merged.models).toEqual([{ id: "custom-model", name: "Custom" }]);
  });
});
