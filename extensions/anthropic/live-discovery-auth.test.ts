import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { buildAnthropicProvider } from "./register.runtime.js";

const discoveryRows = vi.hoisted(() => ({ value: [] as unknown[] }));
const guardedFetch = vi.hoisted(() => vi.fn<typeof fetchWithSsrFGuard>());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: guardedFetch,
  };
});

function buildCatalogContext(apiKey: string): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey }),
  } as unknown as ProviderCatalogContext;
}

function discoveryRow(id: string, overrides: Record<string, unknown> = {}) {
  return { id, type: "model", max_input_tokens: 1_000_000, max_tokens: 128_000, ...overrides };
}

function capabilities(xhigh = true) {
  const supported = { supported: true };
  return {
    image_input: supported,
    thinking: { types: { adaptive: supported, disabled: supported } },
    effort: { xhigh: { supported: xhigh }, max: supported },
  };
}

async function discover(apiKey: string) {
  const result = await buildAnthropicProvider().catalog?.run?.(buildCatalogContext(apiKey));
  if (!result || !("providers" in result)) {
    throw new Error("Expected a keyed discovery result");
  }
  return result;
}

beforeEach(() => {
  guardedFetch.mockReset().mockImplementation(async () => ({
    response: Response.json({ data: discoveryRows.value }),
    finalUrl: "https://api.anthropic.com/v1/models",
    release: async () => undefined,
  }));
  discoveryRows.value = [];
  clearLiveCatalogCacheForTests();
});

it.each([
  ["sk-ant-api03-test-key", "x-api-key", "sk-ant-api03-test-key", "authorization"],
  ["sk-ant-oat01-test-token", "authorization", "Bearer sk-ant-oat01-test-token", "x-api-key"],
])("sends %s with the exclusive %s header", async (key, header, value, absent) => {
  await buildAnthropicProvider().catalog?.run?.(buildCatalogContext(key));
  const request = guardedFetch.mock.calls.at(-1)?.[0];
  const headers = new Headers(request?.init?.headers);
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
  expect(guardedFetch).not.toHaveBeenCalled();
});

it("retains shipped models and their compat while projecting discovered capabilities", async () => {
  discoveryRows.value = [
    discoveryRow("claude-opus-5"),
    discoveryRow("claude-brand-new-9", {
      display_name: "Claude Brand New 9",
      capabilities: capabilities(),
    }),
    discoveryRow("claude-unshaped-9"),
    discoveryRow("claude-sonnet-4-6", { capabilities: capabilities(false) }),
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
  // Tool surface (Code Mode) comes from the shipped Sonnet row; effort comes from the listing.
  expect(models.get("claude-sonnet-4-6")).toMatchObject({
    compat: { codeMode: "preferred" },
    thinkingLevelMap: { xhigh: null, max: "max" },
    params: { claudeCapabilities: { xhighEffort: false, maxEffort: true } },
  });
});
