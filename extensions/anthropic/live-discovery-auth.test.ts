// Anthropic tests cover live model discovery request auth.
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicProvider } from "./register.runtime.js";

const guardedFetchCalls = vi.hoisted(
  () =>
    [] as Array<
      Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0]
    >,
);

const discoveryRows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      guardedFetchCalls.push(params);
      return Promise.resolve({
        response: new Response(JSON.stringify({ data: discoveryRows.value })),
        finalUrl: "https://api.anthropic.com/v1/models",
        release: async () => undefined,
      });
    },
  };
});

function buildCatalogContext(apiKey: string): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey }),
  } as unknown as ProviderCatalogContext;
}

async function readDiscoveryHeaders(apiKey: string): Promise<Headers> {
  const provider = buildAnthropicProvider();
  await provider.catalog?.run?.(buildCatalogContext(apiKey));
  const request = guardedFetchCalls.at(-1);
  expect(request).toBeDefined();
  return new Headers(request?.init?.headers);
}

describe("anthropic live model discovery auth", () => {
  beforeEach(() => {
    guardedFetchCalls.length = 0;
    discoveryRows.value = [];
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an API key as x-api-key", async () => {
    const headers = await readDiscoveryHeaders("sk-ant-api03-test-key");
    expect(headers.get("x-api-key")).toBe("sk-ant-api03-test-key");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("sends a subscription OAuth token as a bearer credential", async () => {
    const headers = await readDiscoveryHeaders("sk-ant-oat01-test-token");
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-test-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("does not resolve Anthropic credentials for Claude CLI-only catalog scope", async () => {
    const resolveProviderApiKey = vi.fn(() => {
      throw new Error("unselected Anthropic credential read");
    });

    await expect(
      buildAnthropicProvider().catalog?.run?.({
        ...buildCatalogContext("unused"),
        providerIds: ["claude-cli"],
        resolveProviderApiKey,
      }),
    ).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
    expect(guardedFetchCalls).toEqual([]);
  });

  it("keeps shipped models Anthropic does not publish while adding discovered ones", async () => {
    // Discovery replaces the seed catalog, so a shipped model with no live row
    // would silently vanish from the provider listing once discovery succeeds.
    discoveryRows.value = [
      {
        id: "claude-opus-5",
        type: "model",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
      },
      {
        id: "claude-brand-new-9",
        type: "model",
        display_name: "Claude Brand New 9",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          image_input: { supported: true },
          thinking: {
            supported: true,
            types: { adaptive: { supported: true }, disabled: { supported: true } },
          },
          effort: { xhigh: { supported: true }, max: { supported: true } },
        },
      },
      {
        id: "claude-unshaped-9",
        type: "model",
        max_input_tokens: 200_000,
        max_tokens: 64_000,
      },
    ];
    const provider = buildAnthropicProvider();
    const result = await provider.catalog?.run?.(buildCatalogContext("sk-ant-oat01-test-token"));
    const models = new Map(
      result && "provider" in result
        ? (result.provider.models ?? []).map((model) => [model.id, model])
        : [],
    );

    expect(models.has("claude-opus-5")).toBe(true);
    // Shipped but absent from the live response: must survive discovery.
    expect(models.has("claude-mythos-5")).toBe(true);
    // An unknown id ships with the capabilities Anthropic advertised, which request shaping reads.
    expect(models.get("claude-brand-new-9")).toMatchObject({
      name: "Claude Brand New 9",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      params: {
        claudeCapabilities: {
          adaptiveThinking: true,
          disabledThinking: true,
          xhighEffort: true,
          maxEffort: true,
        },
      },
    });
    // Without advertised capabilities an unknown id has no request contract to follow.
    expect(models.has("claude-unshaped-9")).toBe(false);
  });

  it("keeps the closest shipped model's request contract for a listed unknown id", async () => {
    discoveryRows.value = [
      {
        id: "claude-sonnet-4-6",
        type: "model",
        display_name: "Claude Sonnet 4.6",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          image_input: { supported: true },
          thinking: {
            supported: true,
            types: { adaptive: { supported: true }, disabled: { supported: true } },
          },
          effort: { xhigh: { supported: false }, max: { supported: true } },
        },
      },
    ];
    const result = await buildAnthropicProvider().catalog?.run?.(
      buildCatalogContext("sk-ant-api03-test-key"),
    );
    const model =
      result && "provider" in result
        ? result.provider.models?.find((entry) => entry.id === "claude-sonnet-4-6")
        : undefined;

    // Tool surface (Code Mode) comes from the shipped Sonnet row; effort comes from the listing.
    expect(model).toMatchObject({
      compat: { codeMode: "preferred" },
      thinkingLevelMap: { xhigh: null, max: "max" },
      params: { claudeCapabilities: { xhighEffort: false, maxEffort: true } },
    });
  });
});
