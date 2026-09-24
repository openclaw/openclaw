import {
  registerProviderPlugin,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { MINIMAX_OAUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { registerMinimaxProviders } from "./provider-registration.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

it.each([
  {
    name: "Global OAuth resource URL",
    provider: "minimax-portal",
    baseUrl: "https://api.minimax.io/anthropic/v1",
    endpoint: "https://api.minimax.io/anthropic/v1/models",
  },
  {
    name: "CN OAuth resource URL with whitespace and trailing slashes",
    provider: "minimax-portal",
    baseUrl: " https://api.minimaxi.com/anthropic/v1/// ",
    endpoint: "https://api.minimaxi.com/anthropic/v1/models",
  },
  {
    name: "unversioned OAuth base URL",
    provider: "minimax-portal",
    baseUrl: "https://api.minimax.io/anthropic",
    endpoint: "https://api.minimax.io/anthropic/v1/models",
  },
  {
    name: "versioned API-key base URL with a path prefix",
    provider: "minimax",
    baseUrl: "https://api.minimaxi.com/prefix/anthropic/v1",
    endpoint: "https://api.minimaxi.com/prefix/anthropic/v1/models",
  },
])(
  "registered MiniMax catalog.run preserves the $name",
  async ({ provider, baseUrl, endpoint }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      input === endpoint
        ? Response.json({ data: [{ id: "MiniMax-M3" }], has_more: false })
        : new Response("Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { providers } = await registerProviderPlugin({
      plugin: { register: registerMinimaxProviders },
      id: "minimax",
      name: "MiniMax",
    });
    const oauth = provider === "minimax-portal";
    const profileId = `${provider}:selected`;
    const result = await runProviderCatalog({
      provider: requireRegisteredProvider(providers, provider),
      config: { models: { providers: { [provider]: { baseUrl, models: [] } } } },
      env: {},
      resolveProviderApiKey: () =>
        oauth
          ? { apiKey: undefined }
          : { apiKey: "MINIMAX_API_KEY", discoveryApiKey: "selected-key", profileId },
      resolveProviderAuth: () => ({
        apiKey: MINIMAX_OAUTH_MARKER,
        discoveryApiKey: "selected-oauth",
        mode: "oauth",
        source: "profile",
        profileId,
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(endpoint);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(oauth ? "Bearer selected-oauth" : null);
    expect(headers.get("x-api-key")).toBe(oauth ? null : "selected-key");
    expect(result).toMatchObject({
      provider: {
        baseUrl: baseUrl.trim(),
        api: "anthropic-messages",
        models: [expect.objectContaining({ id: "MiniMax-M3", compat: { codeMode: "preferred" } })],
      },
      outcomes: [{ provider, profileId, status: "ready" }],
    });
  },
);
