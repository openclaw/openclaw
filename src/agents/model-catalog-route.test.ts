import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import type { ProviderDefaultThinkingPolicyContext } from "../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resolveModelContextTokenProjectionFromCache } from "./context-resolution.js";
import {
  type ModelCatalogRoutePolicy,
  projectModelCatalogEntryForRoute,
  createConfiguredModelCatalogOverridesResolver,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";

const matchesRoute = (entry: ModelCatalogEntry, route: ProviderModelRouteCandidate) =>
  entry.api === route.api && entry.baseUrl === route.baseUrl;
const routePolicy: ModelCatalogRoutePolicy = {
  resolveIdentity: (entry) => ({ id: entry.id, key: `${entry.provider}/${entry.id}` }),
  matchesRoute,
};

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const satisfies ProviderModelRouteCandidate;

const chatGPTRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const satisfies ProviderModelRouteCandidate;

const platformEntry: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 1_000_000,
  contextTokens: 272_000,
  reasoning: true,
  thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
  input: ["text", "image"],
  params: { platformOnly: true },
  compat: { supportsTools: false },
};

const chatGPTEntry: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  contextWindow: 400_000,
  contextTokens: 300_000,
  reasoning: true,
  thinkingLevelMap: { off: null, xhigh: null, max: "max" },
  input: ["text"],
  params: { chatGPTOnly: true },
  compat: { supportsTools: true },
};

describe("projectModelCatalogEntryForRoute", () => {
  it.each([undefined, "synthetic"] as const)(
    "prefers the exact physical donor over the platform row (source=%s)",
    (contextWindowSource) => {
      const { entry: publicEntry, runtimeEntry } = projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: [
          platformEntry,
          {
            ...chatGPTEntry,
            contextWindowSource,
            contextWindows: [{ id: "native", label: "Native", contextWindow: 400_000 }],
            contextWindowDefault: "native",
          },
        ],
      });
      expect(runtimeEntry.params).toEqual({ chatGPTOnly: true });
      expect(runtimeEntry.compat).toEqual({ supportsTools: true });
      expect(runtimeEntry.contextWindow).toBe(400_000);
      const capacity = resolveModelContextTokenProjectionFromCache(
        {
          provider: runtimeEntry.provider,
          model: runtimeEntry.id,
          modelContextWindow: runtimeEntry.contextWindow,
          modelContextWindowSource: runtimeEntry.contextWindowSource,
        },
        () => undefined,
        () => undefined,
      );
      expect(capacity).toMatchObject({
        contextTokens: 400_000,
        source: contextWindowSource === "synthetic" ? "fallback" : "model",
      });
      expect(publicEntry.contextWindowSource).toBe(contextWindowSource);
      expect(publicEntry).not.toHaveProperty("params");
      expect(publicEntry).not.toHaveProperty("compat");
      expect(publicEntry.contextWindows).toEqual([
        { id: "native", label: "Native", contextWindow: 400_000 },
      ]);
      expect(runtimeEntry.contextWindowDefault).toBe("native");
    },
  );

  it.each([
    {
      name: "subscription",
      route: chatGPTRoute,
      expected: "ultra",
      owner: "fixture-subscription",
    },
    { name: "unresolved", route: undefined, expected: "off", owner: undefined },
  ])("retains only the $name route's prepared thinking owner", ({ route, expected, owner }) => {
    const resolvePolicy = vi.fn((context: ProviderDefaultThinkingPolicyContext) =>
      context.provider === "fixture-platform"
        ? ({ levels: [{ id: "off" }, { id: "high" }], defaultLevel: "high" } as const)
        : ({
            levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
            defaultLevel: "ultra",
          } as const),
    );
    const entry = { ...platformEntry, thinkingPolicyProvider: "fixture-platform" };
    const catalog: ModelCatalogSnapshot = {
      entries: [entry],
      routeVariants: [entry, { ...chatGPTEntry, thinkingPolicyProvider: "fixture-subscription" }],
    };
    prepareModelCatalogThinkingPolicies({
      catalog,
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      pluginRegistry: {
        ...createEmptyPluginRegistry(),
        providers: ["fixture-platform", "fixture-subscription"].map((id) => ({
          pluginId: id,
          source: "test",
          provider: { id, label: id, auth: [], resolveThinkingProfile: resolvePolicy },
        })),
      },
    });
    const ambient = vi
      .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
      .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
    try {
      const { entry: projected } = projectModelCatalogEntryForRoute({
        entry: expectDefined(catalog.entries[0], "prepared route test entry"),
        projection: route
          ? { kind: "selected", route, policy: routePolicy }
          : { kind: "unresolved", policy: routePolicy },
        catalog: catalog.routeVariants,
      });
      expect(
        resolveThinkingProfile({
          provider: projected.provider,
          model: projected.id,
          catalog: [projected],
          agentRuntime: "codex",
          providerPolicySource: "active",
        }).defaultLevel,
      ).toBe(expected);
      if (owner) {
        expect(resolvePolicy).toHaveBeenCalledWith(expect.objectContaining({ provider: owner }));
        expect(ambient).not.toHaveBeenCalled();
      } else {
        expect(resolvePolicy).not.toHaveBeenCalled();
        expect(projected).not.toHaveProperty("thinkingPolicyProvider");
        expect(ambient).toHaveBeenCalledOnce();
      }
    } finally {
      ambient.mockRestore();
    }
  });

  it("returns the physical row unchanged for unmanaged models", () => {
    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "unmanaged" },
      }).entry,
    ).toBe(platformEntry);
  });

  it("applies explicit logical context overrides after physical route selection", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.5",
                contextTokens: 160_000,
                thinkingLevelMap: { off: "none", max: null },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const overrides = createConfiguredModelCatalogOverridesResolver({ cfg })(platformEntry);

    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: [platformEntry],
        ...(overrides ? { overrides } : {}),
      }).entry,
    ).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextTokens: 160_000,
      thinkingLevelMap: { off: "none", max: null },
    });
  });

  it("selects logical overrides from a legacy fallback", () => {
    const legacy: ModelDefinitionConfig = {
      id: "openai/gpt-5.5",
      name: "Legacy row",
      contextWindow: 900_000,
      contextTokens: 500_000,
      reasoning: true,
      input: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 4096,
    };
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: platformRoute.baseUrl,
            models: [legacy],
          },
        },
      },
    };
    const canonicalPolicy: ModelCatalogRoutePolicy = {
      ...routePolicy,
      resolveIdentity: (entry) => {
        const id = entry.id.replace(/^openai\//u, "");
        return { id, key: `${entry.provider}/${id}` };
      },
    };

    const resolveOverrides = createConfiguredModelCatalogOverridesResolver({
      cfg,
      policy: canonicalPolicy,
    });
    for (const id of ["gpt-5.5", "openai/gpt-5.5", "gpt-5.5"]) {
      expect(resolveOverrides({ ...platformEntry, id })).toEqual({
        name: "Legacy row",
        reasoning: true,
        configuredReasoning: true,
        input: ["image"],
        contextWindow: 900_000,
        contextTokens: 500_000,
      });
    }
  });
});
