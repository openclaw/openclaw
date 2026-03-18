import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveImplicitLocalApiProvider } from "./local-api-provider.js";

describe("local-api-provider", () => {
  it("should resolve provider in API mode", async () => {
    const config = {
      models: {
        providers: {
          "local-api": {
            baseUrl: "http://localhost:1234",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const provider = await resolveImplicitLocalApiProvider({ config });
    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("http://localhost:1234/v1");
    expect(provider?.api).toBe("openai-responses");
    expect(provider?.models).toEqual([]);
  });

  it("should use LM_STUDIO_URL env var", async () => {
    const config = { models: {} } as unknown as OpenClawConfig;
    const env = { LM_STUDIO_URL: "http://localhost:5555" } as NodeJS.ProcessEnv;

    const provider = await resolveImplicitLocalApiProvider({ config, env });
    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("http://localhost:5555/v1");
  });

  it("should use LOCAL_API_URL env var", async () => {
    const config = { models: {} } as unknown as OpenClawConfig;
    const env = { LOCAL_API_URL: "http://localhost:9999" } as NodeJS.ProcessEnv;

    const provider = await resolveImplicitLocalApiProvider({ config, env });
    expect(provider).not.toBeNull();
    expect(provider?.baseUrl).toBe("http://localhost:9999/v1");
  });

  it("should prefer LOCAL_API_URL over LM_STUDIO_URL", async () => {
    const config = { models: {} } as unknown as OpenClawConfig;
    const env = {
      LOCAL_API_URL: "http://localhost:8080",
      LM_STUDIO_URL: "http://localhost:1234",
    } as NodeJS.ProcessEnv;

    const provider = await resolveImplicitLocalApiProvider({ config, env });
    expect(provider?.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("should not append /v1 if already present", async () => {
    const config = {
      models: {
        providers: {
          "local-api": {
            baseUrl: "http://localhost:1234/v1",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const provider = await resolveImplicitLocalApiProvider({ config });
    expect(provider?.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("should return null when no config or env", async () => {
    const config = { models: {} } as unknown as OpenClawConfig;
    const provider = await resolveImplicitLocalApiProvider({ config });
    expect(provider).toBeNull();
  });
});
