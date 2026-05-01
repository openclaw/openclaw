import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the three plugin-resolution helpers so we can count how many times
// each is called per `normalizeDiscoveredPiModel` invocation. The cache fix
// should mean repeat calls with the same model object hit the cache and
// invoke the helpers ZERO times after the first call.
const normalizeProviderResolvedModelWithPlugin = vi.hoisted(() => vi.fn());
const applyProviderResolvedModelCompatWithPlugins = vi.hoisted(() => vi.fn());
const applyProviderResolvedTransportWithPlugin = vi.hoisted(() => vi.fn());

vi.mock(import("../plugins/provider-runtime.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    normalizeProviderResolvedModelWithPlugin,
    applyProviderResolvedModelCompatWithPlugins,
    applyProviderResolvedTransportWithPlugin,
  };
});

const { normalizeDiscoveredPiModel, resetNormalizeDiscoveredPiModelCacheForTest } =
  await import("./pi-model-discovery.js");

describe("normalizeDiscoveredPiModel cache (regression for #75137)", () => {
  afterEach(() => {
    resetNormalizeDiscoveredPiModelCacheForTest();
    vi.resetAllMocks();
  });

  it("does not re-invoke plugin resolution helpers for the same model object", () => {
    const model = {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "anthropic",
      api: "anthropic-messages",
      contextWindow: 200_000,
    };
    // Helpers return the model unchanged so the cache key path is exercised.
    normalizeProviderResolvedModelWithPlugin.mockReturnValue(model);
    applyProviderResolvedModelCompatWithPlugins.mockReturnValue(model);
    applyProviderResolvedTransportWithPlugin.mockReturnValue(model);

    const agentDir = "/tmp/agent";

    // First call: cache miss, all helpers fire.
    normalizeDiscoveredPiModel(model, agentDir);
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledTimes(1);
    expect(applyProviderResolvedModelCompatWithPlugins).toHaveBeenCalledTimes(1);
    expect(applyProviderResolvedTransportWithPlugin).toHaveBeenCalledTimes(1);

    // Subsequent calls with the SAME object: cache hit, helpers must NOT fire again.
    normalizeDiscoveredPiModel(model, agentDir);
    normalizeDiscoveredPiModel(model, agentDir);
    normalizeDiscoveredPiModel(model, agentDir);
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledTimes(1);
    expect(applyProviderResolvedModelCompatWithPlugins).toHaveBeenCalledTimes(1);
    expect(applyProviderResolvedTransportWithPlugin).toHaveBeenCalledTimes(1);
  });

  it("re-normalizes when the model object reference changes (cache miss on identity)", () => {
    const provider = "anthropic";
    const id = "claude-opus-4";
    const m1 = { id, name: "Opus", provider, api: "anthropic-messages" };
    const m2 = { id, name: "Opus", provider, api: "anthropic-messages" };
    normalizeProviderResolvedModelWithPlugin.mockImplementation(({ context }) => context.model);
    applyProviderResolvedModelCompatWithPlugins.mockImplementation(({ context }) => context.model);
    applyProviderResolvedTransportWithPlugin.mockImplementation(({ context }) => context.model);

    normalizeDiscoveredPiModel(m1, "/tmp/agent");
    normalizeDiscoveredPiModel(m2, "/tmp/agent");

    // Different objects with the same (provider, id) — cache invalidates by object identity.
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledTimes(2);
  });

  it("partitions cache by agentDir so different scopes don't collide", () => {
    const model = {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      api: "openai-completions",
    };
    normalizeProviderResolvedModelWithPlugin.mockReturnValue(model);
    applyProviderResolvedModelCompatWithPlugins.mockReturnValue(model);
    applyProviderResolvedTransportWithPlugin.mockReturnValue(model);

    normalizeDiscoveredPiModel(model, "/tmp/agent-a");
    normalizeDiscoveredPiModel(model, "/tmp/agent-b");

    // Different agentDir — separate cache entries — both calls fire helpers.
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledTimes(2);

    // Repeat in agent-a: cache hit.
    normalizeDiscoveredPiModel(model, "/tmp/agent-a");
    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledTimes(2);
  });

  it("skips cache for non-record values", () => {
    expect(normalizeDiscoveredPiModel(undefined as unknown as Record<string, unknown>, "/x")).toBe(
      undefined,
    );
    expect(normalizeDiscoveredPiModel(null as unknown as Record<string, unknown>, "/x")).toBe(null);
    expect(normalizeDiscoveredPiModel("scalar" as unknown as Record<string, unknown>, "/x")).toBe(
      "scalar",
    );
    expect(normalizeProviderResolvedModelWithPlugin).not.toHaveBeenCalled();
  });

  it("skips cache for records missing required string fields", () => {
    const malformed = { id: 42, name: "x", provider: "y" };
    expect(normalizeDiscoveredPiModel(malformed, "/x")).toBe(malformed);
    expect(normalizeProviderResolvedModelWithPlugin).not.toHaveBeenCalled();
  });
});
