import * as authRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  hasLlamaServerAuthorizationHeader,
  shouldUseLlamaServerSyntheticAuth,
} from "./auth-policy.js";
import { resolveLlamaServerProviderHeaders, resolveLlamaServerRuntimeApiKey } from "./auth.js";
import { LLAMA_APP_SERVER, LLAMA_CPP_SERVER } from "./defaults.js";

describe("llama-server auth", () => {
  it.each([LLAMA_APP_SERVER, LLAMA_CPP_SERVER])(
    "keeps the $id synthetic auth marker out of runtime discovery",
    async (server) => {
      const resolve = vi.spyOn(authRuntime, "resolveApiKeyForProvider");
      try {
        resolve.mockResolvedValue({
          mode: "api-key",
          source: "synthetic",
          apiKey: server.authMarker,
        });
        await expect(resolveLlamaServerRuntimeApiKey({ server })).resolves.toBeUndefined();
        resolve.mockResolvedValue({ mode: "api-key", source: "profile", apiKey: "real-key" });
        await expect(resolveLlamaServerRuntimeApiKey({ server })).resolves.toBe("real-key");
      } finally {
        resolve.mockRestore();
      }
    },
  );

  it("rejects an array authorization header container", () => {
    expect(hasLlamaServerAuthorizationHeader([])).toBe(false);
  });

  it("uses synthetic runtime auth for no-auth and header-only providers", () => {
    expect(
      shouldUseLlamaServerSyntheticAuth({ baseUrl: "http://localhost:8080/v1", models: [] }),
    ).toBe(true);
    expect(
      shouldUseLlamaServerSyntheticAuth({
        baseUrl: "http://localhost:8080/v1",
        headers: { authorization: "Bearer proxy-token" },
        models: [],
      }),
    ).toBe(true);
    expect(
      shouldUseLlamaServerSyntheticAuth({
        baseUrl: "http://localhost:8080/v1",
        apiKey: "server-key",
        models: [],
      }),
    ).toBe(false);
    expect(hasLlamaServerAuthorizationHeader({ authorization: "Bearer proxy-token" })).toBe(true);
  });

  it("resolves provider header templates for discovery", async () => {
    const config = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://localhost:8080/v1",
            headers: { "X-Proxy-Key": "${LLAMA_PROXY_TOKEN}" },
            models: [],
          },
        },
      },
    };
    await expect(
      resolveLlamaServerProviderHeaders({
        config,
        env: { LLAMA_PROXY_TOKEN: "proxy-token" },
        headers: config.models.providers["llama-cpp"].headers,
      }),
    ).resolves.toEqual({ "X-Proxy-Key": "proxy-token" });
  });

  it("filters and trims plain provider headers without config", async () => {
    await expect(
      resolveLlamaServerProviderHeaders({
        headers: {
          "X-Proxy-Key": " proxy-token ",
          "X-Empty": " ",
          "X-Invalid": 42,
        },
      }),
    ).resolves.toEqual({ "X-Proxy-Key": "proxy-token" });
    await expect(resolveLlamaServerProviderHeaders({ headers: [] })).resolves.toBeUndefined();
  });
});
