import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import {
  type ModelCatalogRoutePolicy,
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { buildAllowedModelSet } from "./model-selection-shared.js";

type OverlayCase = {
  name: string;
  override: Partial<ModelDefinitionConfig>;
  clearsCapturedMetadata: boolean;
  missingRouteField?: "api" | "baseUrl";
};

const capturedRoute = {
  api: "openai-responses",
  baseUrl: "https://captured.example/v1",
} as const;
const routePolicy: ModelCatalogRoutePolicy = {
  resolveIdentity: ({ provider, id }) => ({ id, key: `${provider}/${id}` }),
  matchesRoute: modelTransportRoutesMatch,
};

describe("configured catalog route overlays", () => {
  it.each<OverlayCase>([
    { name: "same route with omitted metadata", override: {}, clearsCapturedMetadata: false },
    {
      name: "same route with explicit disabled reasoning",
      override: { reasoning: false, input: ["text"], compat: { supportsTools: false } },
      clearsCapturedMetadata: false,
    },
    {
      name: "same route with explicit thinking metadata",
      override: {
        reasoning: true,
        thinkingLevelMap: { off: null, max: "max" },
        contextWindow: 32_000,
        contextTokens: 16_000,
        params: { configured: true },
      },
      clearsCapturedMetadata: false,
    },
    {
      name: "same endpoint with a trailing slash",
      override: { baseUrl: `${capturedRoute.baseUrl}/` },
      clearsCapturedMetadata: false,
    },
    {
      name: "API pin with omitted metadata",
      override: { api: "openai-completions" },
      clearsCapturedMetadata: true,
    },
    {
      name: "endpoint pin with omitted metadata",
      override: { baseUrl: "https://configured.example/v1" },
      clearsCapturedMetadata: true,
    },
    {
      name: "endpoint pin with explicit disabled reasoning",
      override: {
        baseUrl: "https://configured.example/v1",
        reasoning: false,
        input: ["text"],
        compat: { supportsTools: false },
      },
      clearsCapturedMetadata: true,
    },
    {
      name: "API pin with explicit thinking metadata",
      override: {
        api: "openai-completions",
        reasoning: true,
        input: ["text", "image"],
        thinkingLevelMap: { off: null, max: "max" },
        contextWindow: 32_000,
        contextTokens: 16_000,
        params: { configured: true },
        compat: { supportsTools: false },
      },
      clearsCapturedMetadata: true,
    },
    {
      name: "missing API with provider fallback",
      override: {},
      clearsCapturedMetadata: false,
      missingRouteField: "api",
    },
    {
      name: "missing endpoint with provider fallback",
      override: {},
      clearsCapturedMetadata: false,
      missingRouteField: "baseUrl",
    },
    {
      name: "missing API with explicit pin",
      override: { api: "openai-completions" },
      clearsCapturedMetadata: false,
      missingRouteField: "api",
    },
    {
      name: "missing endpoint with explicit pin",
      override: { baseUrl: "https://configured.example/v1" },
      clearsCapturedMetadata: false,
      missingRouteField: "baseUrl",
    },
  ])(
    "keeps capabilities with their owner: $name",
    ({ override, clearsCapturedMetadata, missingRouteField }) => {
      const source = validateConfigObjectRaw({
        agents: {
          entries: { main: {} },
          defaults: {
            models: { "route-fixture/selected": { alias: "Selected alias" } },
            modelPolicy: { allow: ["route-fixture/selected"] },
          },
        },
        models: {
          providers: {
            "route-fixture": {
              ...capturedRoute,
              models: [{ id: "selected", name: "Configured selected", ...override }],
            },
          },
        },
      });
      if (!source.ok) {
        throw new Error(JSON.stringify(source.issues));
      }
      const captured: ModelCatalogEntry = {
        provider: "route-fixture",
        id: "selected",
        name: "Captured selected",
        ...capturedRoute,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        contextWindows: [{ id: "native", label: "Native", contextWindow: 128_000 }],
        contextWindowDefault: "native",
        contextTokens: 96_000,
        thinkingLevelMap: { off: null, high: "high" },
        thinkingPolicyProvider: "fixture-thinking-owner",
        params: { captured: true },
        compat: { supportsTools: true },
        mediaInput: { image: { maxBytes: 4_096 } },
      };
      if (missingRouteField) {
        delete captured[missingRouteField];
      }
      const catalog: ModelCatalogSnapshot = { entries: [captured], routeVariants: [captured] };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const preparedPolicy = vi.fn(
        () =>
          ({
            levels: [{ id: "off" }, { id: "max" }],
            defaultLevel: "max",
          }) as const,
      );
      prepareModelCatalogThinkingPolicies({
        catalog,
        metadataSnapshot,
        providers: [
          { provider: { id: "fixture-thinking-owner", resolveThinkingProfile: preparedPolicy } },
        ],
      });
      const allowed = buildAllowedModelSet({
        cfg: source.config,
        catalog: catalog.entries,
        defaultProvider: "route-fixture",
        manifestPlugins: metadataSnapshot,
      });
      const selected = expectDefined(allowed.allowedCatalog[0], "configured selected row");
      const route: ProviderModelRouteCandidate = {
        ...capturedRoute,
        api: override.api ?? capturedRoute.api,
        baseUrl: override.baseUrl ?? capturedRoute.baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      };
      expect(allowed.allowedCatalog).toHaveLength(1);
      expect(selected).toMatchObject({
        provider: "route-fixture",
        id: "selected",
        name: "Configured selected",
        alias: "Selected alias",
      });
      for (const field of ["api", "baseUrl"] as const) {
        expect(selected[field]).toBe(captured[field]);
        expect(Object.hasOwn(selected, field)).toBe(Object.hasOwn(captured, field));
      }
      expect(
        resolveThinkingProfile({
          provider: selected.provider,
          model: selected.id,
          catalog: [selected],
          providerPolicySource: { providers: [] },
        }).defaultLevel,
      ).toBe(override.reasoning === false ? "off" : clearsCapturedMetadata ? undefined : "max");
      expect(preparedPolicy).toHaveBeenCalledTimes(clearsCapturedMetadata ? 0 : 1);
      preparedPolicy.mockClear();
      expect(selected.configuredReasoning).toBe(override.reasoning);
      expect(selected.reasoning).toBe(
        override.reasoning ?? (clearsCapturedMetadata ? undefined : true),
      );
      expect(selected.input).toEqual(
        override.input ?? (clearsCapturedMetadata ? undefined : ["text", "image"]),
      );
      expect(selected.contextWindow).toBe(
        override.contextWindow ?? (clearsCapturedMetadata ? undefined : 128_000),
      );
      expect(selected.contextTokens).toBe(
        override.contextTokens ?? (clearsCapturedMetadata ? undefined : 96_000),
      );
      expect(selected.thinkingLevelMap).toEqual(
        override.thinkingLevelMap ??
          (clearsCapturedMetadata ? undefined : { off: null, high: "high" }),
      );
      if (!missingRouteField) {
        expect(selected.compat).toEqual(
          clearsCapturedMetadata ? override.compat : { supportsTools: true },
        );
      }
      expect(selected.params).toEqual(
        clearsCapturedMetadata ? override.params : { captured: true, ...override.params },
      );
      expect(selected.contextWindows).toEqual(
        clearsCapturedMetadata ? undefined : captured.contextWindows,
      );
      expect(selected.contextWindowDefault).toBe(clearsCapturedMetadata ? undefined : "native");
      expect(selected.mediaInput).toEqual(clearsCapturedMetadata ? undefined : captured.mediaInput);
      expect(selected.thinkingPolicyProvider).toBe(
        clearsCapturedMetadata ? undefined : "fixture-thinking-owner",
      );

      const { entry: projected, runtimeEntry } = projectModelCatalogEntryForRoute({
        entry: selected,
        projection: { kind: "selected", route, policy: routePolicy },
        catalog: catalog.routeVariants,
        overrides: resolveConfiguredModelCatalogOverrides({
          cfg: source.config,
          entry: selected,
          policy: routePolicy,
        }),
      });
      const hasMatchingDonor = !clearsCapturedMetadata && !missingRouteField;
      expect(projected).toMatchObject({
        provider: "route-fixture",
        id: "selected",
        name: "Configured selected",
        alias: "Selected alias",
        api: route.api,
        baseUrl: route.baseUrl,
      });
      expect(projected.reasoning).toBe(override.reasoning ?? (hasMatchingDonor ? true : undefined));
      expect(projected.input).toEqual(
        override.input ?? (hasMatchingDonor ? ["text", "image"] : undefined),
      );
      expect(projected.contextWindow).toBe(
        override.contextWindow ?? (hasMatchingDonor ? 128_000 : undefined),
      );
      expect(projected.contextTokens).toBe(
        override.contextTokens ?? (hasMatchingDonor ? 96_000 : undefined),
      );
      expect(projected.thinkingLevelMap).toEqual(
        override.thinkingLevelMap ?? (hasMatchingDonor ? { off: null, high: "high" } : undefined),
      );
      expect(projected.thinkingPolicyProvider).toBe(
        hasMatchingDonor ? "fixture-thinking-owner" : undefined,
      );
      expect(runtimeEntry.compat).toEqual(hasMatchingDonor ? { supportsTools: true } : undefined);
      expect(runtimeEntry.params).toEqual(hasMatchingDonor ? { captured: true } : undefined);
      expect(
        resolveThinkingProfile({
          provider: projected.provider,
          model: projected.id,
          catalog: [projected],
          providerPolicySource: { providers: [] },
        }).defaultLevel,
      ).toBe(override.reasoning === false ? "off" : hasMatchingDonor ? "max" : undefined);
      expect(preparedPolicy).toHaveBeenCalledTimes(hasMatchingDonor ? 1 : 0);
    },
  );
});
