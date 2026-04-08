import { beforeAll, describe, expect, it, vi } from "vitest";

let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;

async function loadSecretsModule() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  ({ createProviderAuthResolver } = await import("./models-config.providers.secrets.js"));
}

beforeAll(loadSecretsModule);

describe("Volcengine and BytePlus providers", () => {
  it("shares VOLCANO_ENGINE_API_KEY across volcengine auth aliases", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        VOLCANO_ENGINE_API_KEY: "test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    expect(resolveAuth("volcengine")).toMatchObject({
      apiKey: "VOLCANO_ENGINE_API_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("volcengine-plan")).toMatchObject({
      apiKey: "VOLCANO_ENGINE_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("shares BYTEPLUS_API_KEY across byteplus auth aliases", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        BYTEPLUS_API_KEY: "test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    expect(resolveAuth("byteplus")).toMatchObject({
      apiKey: "BYTEPLUS_API_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("byteplus-plan")).toMatchObject({
      apiKey: "BYTEPLUS_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("reuses env keyRef markers from auth profiles for paired providers", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "volcengine:default": {
          type: "api_key",
          provider: "volcengine",
          keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
        },
        "byteplus:default": {
          type: "api_key",
          provider: "byteplus",
          keyRef: { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" },
        },
      },
    });

    expect(resolveAuth("volcengine")).toMatchObject({
      apiKey: "VOLCANO_ENGINE_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "volcengine:default",
    });
    expect(resolveAuth("volcengine-plan")).toMatchObject({
      apiKey: "VOLCANO_ENGINE_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "volcengine:default",
    });
    expect(resolveAuth("byteplus")).toMatchObject({
      apiKey: "BYTEPLUS_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "byteplus:default",
    });
    expect(resolveAuth("byteplus-plan")).toMatchObject({
      apiKey: "BYTEPLUS_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "byteplus:default",
    });
  });
});
