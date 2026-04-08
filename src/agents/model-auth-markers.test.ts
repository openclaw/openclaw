import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadMarkerModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  return Promise.all([import("./model-auth-env-vars.js"), import("./model-auth-markers.js")]);
}

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
});

describe("model auth markers", () => {
  it("recognizes explicit non-secret markers", async () => {
    const [
      ,
      {
        GCP_VERTEX_CREDENTIALS_MARKER,
        NON_ENV_SECRETREF_MARKER,
        isNonSecretApiKeyMarker,
        resolveOAuthApiKeyMarker,
      },
    ] = await loadMarkerModules();
    expect(isNonSecretApiKeyMarker(NON_ENV_SECRETREF_MARKER)).toBe(true);
    expect(isNonSecretApiKeyMarker(resolveOAuthApiKeyMarker("chutes"))).toBe(true);
    expect(isNonSecretApiKeyMarker("ollama-local")).toBe(true);
    expect(isNonSecretApiKeyMarker(GCP_VERTEX_CREDENTIALS_MARKER)).toBe(true);
  });

  it("does not treat removed provider markers as active auth markers", async () => {
    const [, { isNonSecretApiKeyMarker }] = await loadMarkerModules();
    expect(isNonSecretApiKeyMarker("qwen-oauth")).toBe(false);
  });

  it("recognizes known env marker names but not arbitrary all-caps keys", async () => {
    const [, { isNonSecretApiKeyMarker }] = await loadMarkerModules();
    expect(isNonSecretApiKeyMarker("OPENAI_API_KEY")).toBe(true);
    expect(isNonSecretApiKeyMarker("ALLCAPS_EXAMPLE")).toBe(false);
  });

  it("recognizes all built-in provider env marker names", async () => {
    const [{ listKnownProviderEnvApiKeyNames }, { isNonSecretApiKeyMarker }] =
      await loadMarkerModules();
    for (const envVarName of listKnownProviderEnvApiKeyNames()) {
      expect(isNonSecretApiKeyMarker(envVarName)).toBe(true);
    }
  });

  it("can exclude env marker-name interpretation for display-only paths", async () => {
    const [, { isNonSecretApiKeyMarker }] = await loadMarkerModules();
    expect(isNonSecretApiKeyMarker("OPENAI_API_KEY", { includeEnvVarName: false })).toBe(false);
  });

  it("excludes aws-sdk env markers from known api key env marker helper", async () => {
    const [, { isKnownEnvApiKeyMarker }] = await loadMarkerModules();
    expect(isKnownEnvApiKeyMarker("OPENAI_API_KEY")).toBe(true);
    expect(isKnownEnvApiKeyMarker("AWS_PROFILE")).toBe(false);
  });
});
