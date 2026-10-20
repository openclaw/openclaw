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

function discoveryRow(id: string, overrides: Record<string, unknown> = {}) {
  return { id, type: "model", max_input_tokens: 1_000_000, max_tokens: 128_000, ...overrides };
}

function capabilities(xhigh = true) {
  return {
    image_input: { supported: true },
    thinking: {
      supported: true,
      types: { adaptive: { supported: true }, disabled: { supported: true } },
    },
    effort: { xhigh: { supported: xhigh }, max: { supported: true } },
  };
}

async function discover(apiKey: string) {
  const result = await buildAnthropicProvider().catalog?.run?.(buildCatalogContext(apiKey));
  if (!result || !("providers" in result)) {
    throw new Error("Expected a keyed discovery result");
  }
  return result;
}

describe("anthropic live model discovery auth", () => {
  beforeEach(() => {
    guardedFetchCalls.length = 0;
    discoveryRows.value = [];
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["sk-ant-api03-test-key", "x-api-key", "sk-ant-api03-test-key", "authorization"],
    ["sk-ant-oat01-test-token", "authorization", "Bearer sk-ant-oat01-test-token", "x-api-key"],
  ])("sends %s with the exclusive %s header", async (key, header, value, absent) => {
    const headers = await readDiscoveryHeaders(key);
    expect(headers.get(header)).toBe(value);
    expect(headers.get(absent)).toBeNull();
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
    // Discovery must retain shipped rows absent from the live response.
    discoveryRows.value = [
      discoveryRow("claude-opus-5"),
      discoveryRow("claude-brand-new-9", {
        display_name: "Claude Brand New 9",
        capabilities: capabilities(),
      }),
      discoveryRow("claude-unshaped-9", {
        max_input_tokens: 200_000,
        max_tokens: 64_000,
      }),
    ];
    const result = await discover("sk-ant-oat01-test-token");
    // Never republish API rows under the native CLI hook alias.
    expect(Object.keys(result.providers)).toEqual(["anthropic"]);
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ provider: "anthropic", status: "ready" }),
    );
    const models = new Map(
      (result.providers.anthropic?.models ?? []).map((model) => [model.id, model]),
    );

    expect(models.has("claude-opus-5")).toBe(true);
    expect(models.has("claude-mythos-5")).toBe(true);
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
    expect(models.has("claude-unshaped-9")).toBe(false);
  });

  it("keeps the closest shipped model's request contract for a listed unknown id", async () => {
    discoveryRows.value = [
      discoveryRow("claude-sonnet-4-6", {
        display_name: "Claude Sonnet 4.6",
        capabilities: capabilities(false),
      }),
    ];
    const result = await discover("sk-ant-api03-test-key");
    const model = result.providers.anthropic?.models?.find(
      (entry) => entry.id === "claude-sonnet-4-6",
    );

    // Tool surface (Code Mode) comes from the shipped Sonnet row; effort comes from the listing.
    expect(model).toMatchObject({
      compat: { codeMode: "preferred" },
      thinkingLevelMap: { xhigh: null, max: "max" },
      params: { claudeCapabilities: { xhighEffort: false, maxEffort: true } },
    });
  });
});
