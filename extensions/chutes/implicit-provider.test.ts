import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveOAuthApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { CHUTES_BASE_URL } from "./models.js";

const OAUTH_MARKER = resolveOAuthApiKeyMarker("chutes");

async function runChutesCatalog(apiKey = "", discoveryApiKey?: string) {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run({
    config: {},
    resolveProviderAuth: () => ({ apiKey, discoveryApiKey }),
  } as never);
  return result ?? null;
}

function stubFetch(body: unknown = { data: [{ id: "chutes/private-model" }] }) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

it("publishes the env vars used by core api-key auto-detection", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.envVars).toEqual(["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"]);
});

it("renews an OAuth credential through the registered hook with caller config", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  const fetchMock = stubFetch({
    access_token: "renewed-access",
    refresh_token: "rotated-refresh",
    expires_in: 1800,
  });
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
  await expect(runChutesCatalog()).resolves.toBeNull();
});

it("keeps api-key resolved Chutes profiles on the API-key loader path", async () => {
  stubFetch();
  expect(await runChutesCatalog("chutes-live-api-key")).toMatchObject({
    provider: { baseUrl: CHUTES_BASE_URL, apiKey: "chutes-live-api-key" },
  });
});

it("forwards oauth access token to Chutes model discovery", async () => {
  const fetchMock = stubFetch();
  expect(await runChutesCatalog(OAUTH_MARKER, "access-token")).toMatchObject({
    provider: { baseUrl: CHUTES_BASE_URL, apiKey: OAUTH_MARKER },
  });
  const request = fetchMock.mock.calls.find(([url]) =>
    (url instanceof Request ? url.url : url.toString()).includes("chutes.ai"),
  )?.[1];
  expect(new Headers(request?.headers).get("authorization")).toBe("Bearer access-token");
});
