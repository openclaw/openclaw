import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  return Promise.all([
    import("./model-auth-markers.js"),
    import("./models-config.providers.secrets.js"),
  ]);
}

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
});

describe("vercel-ai-gateway provider resolution", () => {
  it("resolves AI_GATEWAY_API_KEY through provider auth lookup", async () => {
    const [, { createProviderAuthResolver }] = await loadModules();
    const resolveAuth = createProviderAuthResolver(
      {
        AI_GATEWAY_API_KEY: "vercel-gateway-test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    expect(resolveAuth("vercel-ai-gateway")).toMatchObject({
      apiKey: "AI_GATEWAY_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("prefers env keyRef markers over runtime plaintext in auth profiles", async () => {
    const [, { createProviderAuthResolver }] = await loadModules();
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "vercel-ai-gateway:default": {
          type: "api_key",
          provider: "vercel-ai-gateway",
          key: "sk-runtime-vercel",
          keyRef: { source: "env", provider: "default", id: "AI_GATEWAY_API_KEY" },
        },
      },
    });

    expect(resolveAuth("vercel-ai-gateway")).toMatchObject({
      apiKey: "AI_GATEWAY_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "vercel-ai-gateway:default",
    });
  });

  it("uses non-env markers for non-env keyRef vercel profiles", async () => {
    const [{ NON_ENV_SECRETREF_MARKER }, { createProviderAuthResolver }] = await loadModules();
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "vercel-ai-gateway:default": {
          type: "api_key",
          provider: "vercel-ai-gateway",
          key: "sk-runtime-vercel",
          keyRef: { source: "file", provider: "vault", id: "/vercel/ai-gateway/api-key" },
        },
      },
    });

    expect(resolveAuth("vercel-ai-gateway")).toMatchObject({
      apiKey: NON_ENV_SECRETREF_MARKER,
      mode: "api_key",
      source: "profile",
      profileId: "vercel-ai-gateway:default",
    });
  });
});
