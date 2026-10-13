import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveOAuthApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { CHUTES_BASE_URL } from "./models.js";

const CHUTES_OAUTH_MARKER = resolveOAuthApiKeyMarker("chutes");

async function runChutesCatalog(params: { apiKey?: string; discoveryApiKey?: string }) {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run({
    config: {},
    resolveProviderAuth: () => ({
      apiKey: params.apiKey ?? "",
      discoveryApiKey: params.discoveryApiKey,
    }),
  } as never);
  return result ?? null;
}

async function runChutesCatalogProvider(params: { apiKey: string; discoveryApiKey?: string }) {
  const result = await runChutesCatalog(params);
  if (!result || !("provider" in result)) {
    throw new Error("expected Chutes catalog to return one provider");
  }
  return result.provider;
}

function stubDiscoveryFetch() {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: [{ id: "chutes/private-model" }] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("chutes implicit provider auth mode", () => {
  it("publishes the env vars used by core api-key auto-detection", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.envVars).toEqual(["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"]);
  });

  it("renews an OAuth credential through the registered hook with caller config", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "renewed-access",
        refresh_token: "rotated-refresh",
        expires_in: 1800,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const credential = {
      type: "oauth" as const,
      provider: "chutes",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
      clientId: "stored-client",
      clientSecret: "synthetic-client-secret",
    };
    const renewed = await provider.refreshOAuth?.(credential, {
      models: { providers: { chutes: { baseUrl: "https://proxy.example.com/v1", models: [] } } },
    });
    expect(renewed).toMatchObject({
      ...credential,
      access: "renewed-access",
      refresh: "rotated-refresh",
      expires: expect.any(Number),
    });
    expect(renewed?.expires).toBeGreaterThan(Date.now());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.chutes.ai/idp/token");
  });

  it("does not publish a provider when no API key is resolved", async () => {
    await expect(runChutesCatalog({})).resolves.toBeNull();
  });

  it("keeps api-key resolved Chutes profiles on the API-key loader path", async () => {
    stubDiscoveryFetch();
    const provider = await runChutesCatalogProvider({ apiKey: "chutes-live-api-key" });

    expect(provider.baseUrl).toBe(CHUTES_BASE_URL);
    expect(provider.apiKey).toBe("chutes-live-api-key");
    expect(provider.apiKey).not.toBe(CHUTES_OAUTH_MARKER);
  });

  it("forwards oauth access token to Chutes model discovery", async () => {
    const fetchMock = stubDiscoveryFetch();
    const provider = await runChutesCatalogProvider({
      apiKey: CHUTES_OAUTH_MARKER,
      discoveryApiKey: "my-chutes-access-token",
    });
    expect(provider.baseUrl).toBe(CHUTES_BASE_URL);
    expect(provider.apiKey).toBe(CHUTES_OAUTH_MARKER);

    const chutesCalls = fetchMock.mock.calls.filter(([url]) =>
      (url instanceof Request ? url.url : url.toString()).includes("chutes.ai"),
    );
    expect(chutesCalls.length).toBeGreaterThan(0);
    const request = chutesCalls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer my-chutes-access-token",
    );
  });
});
