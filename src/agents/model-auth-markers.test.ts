import { beforeAll, describe, expect, it, vi } from "vitest";

let listKnownProviderEnvApiKeyNames: typeof import("./model-auth-env-vars.js").listKnownProviderEnvApiKeyNames;
let GCP_VERTEX_CREDENTIALS_MARKER: typeof import("./model-auth-markers.js").GCP_VERTEX_CREDENTIALS_MARKER;
let NON_ENV_SECRETREF_MARKER: typeof import("./model-auth-markers.js").NON_ENV_SECRETREF_MARKER;
let isKnownEnvApiKeyMarker: typeof import("./model-auth-markers.js").isKnownEnvApiKeyMarker;
let isNonSecretApiKeyMarker: typeof import("./model-auth-markers.js").isNonSecretApiKeyMarker;
let resolveOAuthApiKeyMarker: typeof import("./model-auth-markers.js").resolveOAuthApiKeyMarker;

async function loadMarkerModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [envVarsModule, markersModule] = await Promise.all([
    import("./model-auth-env-vars.js"),
    import("./model-auth-markers.js"),
  ]);
  listKnownProviderEnvApiKeyNames = envVarsModule.listKnownProviderEnvApiKeyNames;
  GCP_VERTEX_CREDENTIALS_MARKER = markersModule.GCP_VERTEX_CREDENTIALS_MARKER;
  NON_ENV_SECRETREF_MARKER = markersModule.NON_ENV_SECRETREF_MARKER;
  isKnownEnvApiKeyMarker = markersModule.isKnownEnvApiKeyMarker;
  isNonSecretApiKeyMarker = markersModule.isNonSecretApiKeyMarker;
  resolveOAuthApiKeyMarker = markersModule.resolveOAuthApiKeyMarker;
}

beforeAll(loadMarkerModules);

describe("model auth markers", () => {
  it("recognizes explicit non-secret markers", () => {
    expect(isNonSecretApiKeyMarker(NON_ENV_SECRETREF_MARKER)).toBe(true);
    expect(isNonSecretApiKeyMarker(resolveOAuthApiKeyMarker("chutes"))).toBe(true);
    expect(isNonSecretApiKeyMarker("ollama-local")).toBe(true);
    expect(isNonSecretApiKeyMarker(GCP_VERTEX_CREDENTIALS_MARKER)).toBe(true);
  });

  it("does not treat removed provider markers as active auth markers", () => {
    expect(isNonSecretApiKeyMarker("qwen-oauth")).toBe(false);
  });

  it("recognizes known env marker names but not arbitrary all-caps keys", () => {
    expect(isNonSecretApiKeyMarker("OPENAI_API_KEY")).toBe(true);
    expect(isNonSecretApiKeyMarker("ALLCAPS_EXAMPLE")).toBe(false);
  });

  it("recognizes all built-in provider env marker names", () => {
    for (const envVarName of listKnownProviderEnvApiKeyNames()) {
      expect(isNonSecretApiKeyMarker(envVarName)).toBe(true);
    }
  });

  it("can exclude env marker-name interpretation for display-only paths", () => {
    expect(isNonSecretApiKeyMarker("OPENAI_API_KEY", { includeEnvVarName: false })).toBe(false);
  });

  it("excludes aws-sdk env markers from known api key env marker helper", () => {
    expect(isKnownEnvApiKeyMarker("OPENAI_API_KEY")).toBe(true);
    expect(isKnownEnvApiKeyMarker("AWS_PROFILE")).toBe(false);
  });
});
