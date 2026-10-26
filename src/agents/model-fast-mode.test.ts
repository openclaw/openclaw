import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderFastModePolicyContext } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as lightPolicy from "../plugins/provider-public-artifacts.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import * as extraParams from "./model-extra-params.js";
import { createModelSpeedPolicyResolver } from "./model-fast-mode.js";
import * as requestCapabilities from "./provider-attribution.js";

const opus: ModelCatalogEntry = {
  id: "claude-opus-5",
  name: "Opus 5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
};
const sonnet = { ...opus, id: "claude-sonnet-5" };
const available = { availability: true, routeResolution: null, selectedAuthMode: "api_key" };
function metadata(providers: string[]) {
  return createPluginMetadataSnapshotFixture({
    plugins: providers.map((id) => ({
      id,
      providers: [id],
      rootDir: path.resolve(import.meta.dirname, "../../extensions", id),
      ...(id === "anthropic"
        ? {
            providerEndpoints: [
              { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
            ],
            providerRequest: { providers: { anthropic: { family: "anthropic" } } },
          }
        : {}),
    })),
  });
}
const openai: ModelCatalogEntry = {
  id: "speed-fixture",
  name: "Speed fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
function fastResolver(params: Parameters<typeof createModelSpeedPolicyResolver>[0]) {
  const resolve = createModelSpeedPolicyResolver(params);
  return (...args: Parameters<typeof resolve>) => resolve(...args).supportsFastMode;
}
function resolver(cfg: OpenClawConfig = {}) {
  return fastResolver({
    cfg,
    agentId: "main",
    catalog: [opus],
    metadataSnapshot: metadata(["anthropic"]),
  });
}
describe("private selected Fast metadata", () => {
  it("uses each selected model's policy", () => {
    const catalog: ModelCatalogEntry[] = [
      openai,
      { id: "grok-3", name: "Grok 3", provider: "xai", api: "openai-responses" },
      { id: "MiniMax-M2.7", name: "MiniMax M2.7", provider: "minimax", api: "anthropic-messages" },
    ];
    const resolve = fastResolver({
      cfg: {},
      agentId: "main",
      catalog,
      metadataSnapshot: metadata(["openai", "xai", "minimax"]),
    });
    const expected = [true, undefined];
    expect(
      catalog.map((entry) => [
        resolve(entry, available, "openclaw"),
        resolve(entry, available, "codex"),
      ]),
    ).toEqual([expected, expected, expected]);
  });
  it("loads the provider's light policy for the exact model and auth facts", () => {
    const resolve = resolver();
    expect(resolve(sonnet, available)).toBe(false);
    expect(resolve(opus, available)).toBe(true);
    expect(resolve(opus, { availability: undefined, routeResolution: null })).toBeUndefined();
    expect(resolve(sonnet, { availability: true, routeResolution: null }, "codex")).toBeUndefined();
  });
  it("uses the same model/agent parameter order as request construction", () => {
    const models = { "anthropic/claude-opus-5": { params: { serviceTier: "standard_only" } } };
    const cases: [OpenClawConfig["agents"], boolean][] = [
      [
        {
          defaults: { params: { serviceTier: "auto" } },
          entries: { main: { params: { serviceTier: "invalid" } } },
        },
        true,
      ],
      [{ defaults: { models } }, false],
      [{ entries: { main: { models } } }, false],
    ];
    for (const [agents, expected] of cases) {
      expect(resolver({ agents })(opus, available)).toBe(expected);
    }
  });
  it("does not replace unresolved route ownership with catalog provenance", () => {
    expect(
      resolver()(opus, { availability: undefined, routeResolution: { kind: "indeterminate" } }),
    ).toBeUndefined();
  });
});

it("derives tier recovery from the selected transport rather than catalog provenance", () => {
  const resolve = createModelSpeedPolicyResolver({
    cfg: {},
    agentId: "main",
    catalog: [openai],
    metadataSnapshot: metadata(["openai"]),
  });
  for (const [baseUrl, expected] of [
    ["https://api.openai.com/v1", true],
    ["https://custom.example/v1", false],
    ["https://api.openai.com/proxy", false],
  ] as const) {
    const evaluation = {
      ...available,
      selectedRoute: {
        api: "openai-responses" as const,
        baseUrl,
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
      },
    };
    expect(resolve(openai, evaluation, "openclaw").supportsServiceTierRecovery).toBe(expected);
    expect(resolve(openai, evaluation, "codex").supportsServiceTierRecovery).toBe(false);
  }
});

describe("speed policy context preparation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("skips unused hook context while preserving selected-route recovery", () => {
    vi.spyOn(lightPolicy, "resolveProviderPolicySurface").mockReturnValue(null);
    const extra = vi.spyOn(extraParams, "resolveModelExtraParamSources");
    const capabilities = vi.spyOn(
      requestCapabilities,
      "resolveProviderFastModeRequestCapabilities",
    );
    const native = { ...openai, nativeRuntime: "openclaw" };
    const resolve = createModelSpeedPolicyResolver({
      cfg: {},
      agentId: "main",
      catalog: [native],
      metadataSnapshot: metadata([]),
    });
    const expected = (recovery: boolean) => ({
      supportsFastMode: undefined,
      serviceTiers: undefined,
      supportsServiceTierRecovery: recovery,
    });
    const selected = (baseUrl: string) => ({
      ...available,
      selectedRoute: {
        api: "openai-responses" as const,
        baseUrl,
        authRequirement: "api-key" as const,
        requestTransportOverrides: "none" as const,
      },
    });

    expect(resolve(native, available)).toStrictEqual(expected(true));
    expect(resolve(native, available, "fixture-native")).toStrictEqual(expected(false));
    expect(
      resolve(
        { ...native, baseUrl: "https://proxy.example/v1" },
        selected("https://api.openai.com/v1"),
      ),
    ).toStrictEqual(expected(true));
    expect(resolve(native, selected("https://proxy.example/v1"))).toStrictEqual(expected(false));
    expect(resolve(native, selected("https://api.openai.com/proxy"))).toStrictEqual(
      expected(false),
    );
    expect(
      resolve(native, { availability: undefined, routeResolution: { kind: "indeterminate" } }),
    ).toStrictEqual({});
    expect(resolve({ ...native, provider: "uncaptured-provider" }, available)).toStrictEqual({});
    expect(extra).not.toHaveBeenCalled();
    expect(capabilities).not.toHaveBeenCalled();
  });

  it.each(["fast", "tiers"] as const)("prepares the full context for a sole %s hook", (kind) => {
    const fast = vi.fn((_context: ProviderFastModePolicyContext) => true);
    const tiers = vi.fn((_context: ProviderFastModePolicyContext) => ["default", "priority"]);
    vi.spyOn(lightPolicy, "resolveProviderPolicySurface").mockReturnValue(
      kind === "fast" ? { resolveFastModeSupport: fast } : { resolveServiceTiers: tiers },
    );
    const extra = vi.spyOn(extraParams, "resolveModelExtraParamSources");
    const capabilities = vi.spyOn(
      requestCapabilities,
      "resolveProviderFastModeRequestCapabilities",
    );
    const entry = {
      ...openai,
      provider: "fixture",
      nativeRuntime: "fixture-native",
      params: { catalogOnly: true },
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          params: { source: "default", defaultOnly: 1 },
          models: { "fixture/speed-fixture": { params: { source: "model", modelOnly: 2 } } },
        },
        entries: {
          main: {
            params: { source: "agent", agentOnly: 4 },
            models: {
              "fixture/speed-fixture": { params: { source: "agent-model", agentModelOnly: 3 } },
            },
          },
        },
      },
    };
    const resolve = createModelSpeedPolicyResolver({
      cfg,
      agentId: "main",
      catalog: [entry],
      metadataSnapshot: metadata([]),
    });
    const selectedRoute = {
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:1234/v1",
      authRequirement: "api-key" as const,
      requestTransportOverrides: "none" as const,
    };
    expect(resolve(entry, { ...available, selectedRoute }, "openclaw")).toStrictEqual({
      supportsFastMode: kind === "fast" ? true : undefined,
      serviceTiers: kind === "tiers" ? ["default", "priority"] : undefined,
      supportsServiceTierRecovery: false,
    });
    expect(fast).toHaveBeenCalledTimes(kind === "fast" ? 1 : 0);
    expect(tiers).toHaveBeenCalledTimes(kind === "tiers" ? 1 : 0);
    const context = (kind === "fast" ? fast.mock.calls : tiers.mock.calls)[0]?.[0];
    expect(context).toEqual({
      provider: entry.provider,
      modelId: entry.id,
      api: selectedRoute.api,
      baseUrl: selectedRoute.baseUrl,
      authMode: "api_key",
      runtimeId: "openclaw",
      modelParams: entry.params,
      params: { source: "agent", defaultOnly: 1, modelOnly: 2, agentModelOnly: 3, agentOnly: 4 },
      requestCapabilities: { endpointClass: "local", allowsAnthropicServiceTier: false },
    });
    expect(extra).toHaveBeenCalledTimes(1);
    expect(capabilities).toHaveBeenCalledTimes(1);
  });
});
