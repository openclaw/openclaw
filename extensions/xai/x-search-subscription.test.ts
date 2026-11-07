import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { xaiPluginConfig } from "./plugin-config.test-support.js";
import { createXSearchTool } from "./x-search.js";

const subscriptionBase = "https://cli-chat-proxy.grok.com/v1";
const citation = "https://x.com/openclaw/status/1";
const credential = "synthetic-subscription-credential";
const model = "grok-4.3";

afterEach(() => vi.unstubAllGlobals());

it.each(["explicit subscription endpoint", "provider OAuth endpoint"])(
  "returns a cited answer through the %s",
  async (route) => {
    const config = {
      ...xaiPluginConfig({
        xSearch: {
          model,
          cacheTtlMinutes: 0,
          ...(route === "explicit subscription endpoint" ? { baseUrl: subscriptionBase } : {}),
        },
      }),
      models: {
        providers: {
          xai: { baseUrl: subscriptionBase, api: "openai-responses", auth: "oauth", models: [] },
        },
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== `${subscriptionBase}/responses`) {
        return new Response("OAuth credentials require the subscription route", { status: 401 });
      }
      if (
        request.headers.get("x-xai-token-auth") !== "xai-grok-cli" ||
        request.headers.get("x-grok-client-version") !== "1.0.13" ||
        request.headers.get("x-grok-model-override") !== model
      ) {
        return new Response("Grok CLI version none: native subscription headers required", {
          status: 426,
        });
      }
      expect(request.headers.get("authorization")).toBe(`Bearer ${credential}`);
      expect(await request.json()).toMatchObject({ model, tools: [{ type: "x_search" }] });
      return Response.json({ output_text: "Synthetic cited answer", citations: [citation] });
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    const tool = createXSearchTool({
      config,
      runtimeConfig: config,
      auth: {
        hasAuthForProvider: (provider) => provider === "xai",
        resolveApiKeyForProvider: async (provider) => (provider === "xai" ? credential : undefined),
        resolveAuthForProvider: async (provider) =>
          provider === "xai"
            ? { apiKey: credential, mode: "oauth", profileId: "xai:test" }
            : undefined,
      },
    });
    expect(tool).not.toBeNull();
    const result = await tool!.execute(route, { query: `subscription fixture: ${route}` });
    expect(result.details).toMatchObject({
      content: expect.stringContaining("Synthetic cited answer"),
      externalContent: { source: "x_search", provider: "xai", untrusted: true, wrapped: true },
    });
    expect(result.details).toHaveProperty("citations", [citation]);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  { baseUrl: "https://api.x.ai/v1", mode: "api-key" },
  { baseUrl: "https://search-proxy.example/v1", mode: "api-key" },
  { baseUrl: subscriptionBase, mode: "api-key" },
  { baseUrl: "https://search-proxy.example/v1", mode: "oauth" },
] as const)(
  "preserves $mode requests to $baseUrl without subscription headers",
  async ({ baseUrl, mode }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${baseUrl}/responses`);
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-selected-credential");
      for (const header of ["x-xai-token-auth", "x-grok-client-version", "x-grok-model-override"]) {
        expect(request.headers.has(header)).toBe(false);
      }
      return Response.json({ output_text: "API-key answer", citations: [citation] });
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    const config = {
      ...xaiPluginConfig({ xSearch: { baseUrl, model, cacheTtlMinutes: 0 } }),
      models: { providers: { xai: { baseUrl: subscriptionBase, auth: "oauth", models: [] } } },
    };
    const tool = createXSearchTool({
      config,
      runtimeConfig: config,
      auth: {
        hasAuthForProvider: () => true,
        resolveApiKeyForProvider: async () => "synthetic-selected-credential",
        resolveAuthForProvider: async () => ({ apiKey: "synthetic-selected-credential", mode }),
      },
    });
    expect(tool).not.toBeNull();
    const result = await tool!.execute(baseUrl, { query: baseUrl });
    expect(result.details).toMatchObject({
      content: expect.stringContaining("API-key answer"),
      externalContent: { source: "x_search", provider: "xai", untrusted: true, wrapped: true },
    });
    expect(result.details).toHaveProperty("citations", [citation]);
    expect(fetch).toHaveBeenCalledOnce();
  },
);
