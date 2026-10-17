import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isSmallModel } from "../shared/model-param-b.js";
import { makeModel } from "./embedded-agent-runner/model.test-harness.js";
import {
  type ModelCatalogRoutePolicy,
  projectModelCatalogEntryForRoute,
  createConfiguredModelCatalogOverridesResolver,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  createModelVisibilityPolicyWithFallbacks,
} from "./model-selection-shared.js";

afterEach(() => vi.restoreAllMocks());

type OverlayCase = [string, Partial<ModelDefinitionConfig>, boolean, ("api" | "baseUrl")?];

const capturedRoute = { api: "openai-responses", baseUrl: "https://captured.example/v1" } as const;
const configuredEndpoint = "https://configured.example/v1";
const thinkingOwner = "fixture-thinking-owner";
const selectedIdentity = {
  provider: "route-fixture",
  id: "selected",
  name: "Configured selected",
  alias: "Selected alias",
};
const routePolicy: ModelCatalogRoutePolicy = {
  resolveIdentity: ({ provider, id }) => ({ id, key: `${provider}/${id}` }),
  matchesRoute: modelTransportRoutesMatch,
};

function modelConfig<T>(
  models: T[],
  route: Pick<ModelProviderConfig, "api" | "baseUrl"> = capturedRoute,
  provider = "route-fixture",
) {
  return { models: { providers: { [provider]: { ...route, models } } } };
}

function project(
  cfg: OpenClawConfig,
  entry: ModelCatalogEntry,
  catalog: ModelCatalogEntry[],
  route: ProviderModelRouteCandidate,
) {
  return projectModelCatalogEntryForRoute({
    entry,
    catalog,
    projection: { kind: "selected", route, policy: routePolicy },
    overrides: createConfiguredModelCatalogOverridesResolver({ cfg, policy: routePolicy })(entry),
  });
}

function thinkingDefault(entry: ModelCatalogEntry) {
  return resolveThinkingProfile({
    provider: entry.provider,
    model: entry.id,
    catalog: [entry],
    providerPolicySource: { providers: [] },
  }).defaultLevel;
}

// Materialize optional fields so absence and explicit undefined keep their original equality semantics.
function expectFields<T>(entry: T, expected: Partial<T>) {
  const actual = { ...expected };
  for (const key in expected) {
    actual[key] = entry[key];
  }
  expect(actual).toEqual(expected);
}

function capabilities(
  override: Partial<ModelDefinitionConfig>,
  hasDonor: boolean,
): Partial<ModelCatalogEntry> {
  return {
    reasoning: override.reasoning ?? (hasDonor ? true : undefined),
    input: override.input ?? (hasDonor ? ["text", "image"] : undefined),
    contextWindow: override.contextWindow ?? (hasDonor ? 128_000 : undefined),
    contextTokens: override.contextTokens ?? (hasDonor ? 96_000 : undefined),
    thinkingLevelMap:
      override.thinkingLevelMap ?? (hasDonor ? { off: null, high: "high" } : undefined),
  };
}

it.each([undefined, 4_000_000_000])(
  "keeps discovered parameter counts with their configured physical route (override %s)",
  (parameterCount) => {
    const cfg = modelConfig([
      { ...makeModel("compact-chat"), name: "Compact Chat", parameterCount },
    ]);
    const catalog = buildConfiguredModelCatalog({
      cfg,
      catalog: [
        {
          ...capturedRoute,
          provider: "route-fixture",
          id: "compact-chat",
          name: "Compact Chat",
          parameterCount: parameterCount === undefined ? 4_000_000_000 : 70_000_000_000,
        },
      ],
      manifestPlugins: [],
    });
    const entry = expectDefined(catalog[0], "configured parameter metadata");
    expect(entry.parameterCount).toBe(4_000_000_000);
    for (const baseUrl of [capturedRoute.baseUrl, "https://different.example/v1"]) {
      const { entry: projected, runtimeEntry } = project(cfg, entry, catalog, {
        ...capturedRoute,
        baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      });
      const matchesConfiguredRoute = baseUrl === capturedRoute.baseUrl;
      expect(projected.parameterCount).toBe(matchesConfiguredRoute ? 4_000_000_000 : undefined);
      expect(runtimeEntry.parameterCount).toBe(projected.parameterCount);
      expect(isSmallModel(runtimeEntry)).toBe(matchesConfiguredRoute);
    }
  },
);

it.each<OverlayCase>([
  [
    "same route with explicit disabled reasoning",
    { reasoning: false, input: ["text"], compat: { supportsTools: false } },
    false,
  ],
  [
    "same endpoint with compatible metadata overrides",
    {
      baseUrl: `${capturedRoute.baseUrl}/`,
      params: { configured: true },
      thinkingLevelMap: { off: null, max: "max" },
    },
    false,
  ],
  ["endpoint pin with omitted metadata", { baseUrl: configuredEndpoint }, true],
  [
    "API pin with explicit thinking metadata",
    {
      api: "openai-completions",
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: null, max: "max" },
      contextWindow: 32_000,
      contextTokens: 16_000,
      params: { configured: true },
      compat: { supportsTools: false },
    },
    true,
  ],
  ["missing API with provider fallback", {}, false, "api"],
  ["missing endpoint with explicit pin", { baseUrl: configuredEndpoint }, false, "baseUrl"],
])(
  "keeps capabilities with their owner: %s",
  (_name, override, clearsCapturedMetadata, missingRouteField) => {
    const source = validateConfigObjectRaw({
      ...modelConfig([{ id: "selected", name: "Configured selected", ...override }]),
      agents: {
        entries: { main: {} },
        defaults: {
          models: { "route-fixture/selected": { alias: "Selected alias" } },
          modelPolicy: { allow: ["route-fixture/selected"] },
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
      thinkingPolicyProvider: thinkingOwner,
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
      () => ({ levels: [{ id: "off" }, { id: "max" }], defaultLevel: "max" }) as const,
    );
    prepareModelCatalogThinkingPolicies({
      catalog,
      metadataSnapshot,
      pluginRegistry: {
        ...createEmptyPluginRegistry(),
        providers: [
          {
            pluginId: thinkingOwner,
            source: "test",
            provider: {
              id: thinkingOwner,
              label: "Thinking owner",
              auth: [],
              resolveThinkingProfile: preparedPolicy,
            },
          },
        ],
      },
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
    for (const field of ["api", "baseUrl"] as const) {
      expect(selected[field]).toBe(captured[field]);
      expect(Object.hasOwn(selected, field)).toBe(Object.hasOwn(captured, field));
    }
    expect(thinkingDefault(selected)).toBe(
      override.reasoning === false ? "off" : clearsCapturedMetadata ? undefined : "max",
    );
    expect(preparedPolicy).toHaveBeenCalledTimes(clearsCapturedMetadata ? 0 : 1);
    preparedPolicy.mockClear();
    expectFields(selected, {
      ...selectedIdentity,
      ...capabilities(override, !clearsCapturedMetadata),
      configuredReasoning: override.reasoning,
      ...(!missingRouteField
        ? { compat: clearsCapturedMetadata ? override.compat : { supportsTools: true } }
        : {}),
      params: clearsCapturedMetadata ? override.params : { captured: true, ...override.params },
      contextWindows: clearsCapturedMetadata ? undefined : captured.contextWindows,
      contextWindowDefault: clearsCapturedMetadata ? undefined : "native",
      mediaInput: clearsCapturedMetadata ? undefined : captured.mediaInput,
      thinkingPolicyProvider: clearsCapturedMetadata ? undefined : thinkingOwner,
    });

    const projection = project(source.config, selected, catalog.routeVariants, route);
    const hasMatchingDonor = !clearsCapturedMetadata && !missingRouteField;
    expectFields(projection.entry, {
      ...selectedIdentity,
      api: route.api,
      baseUrl: route.baseUrl,
      ...capabilities(override, hasMatchingDonor),
      thinkingPolicyProvider: hasMatchingDonor ? thinkingOwner : undefined,
    });
    expectFields(projection.runtimeEntry, {
      compat: hasMatchingDonor ? { supportsTools: true } : undefined,
      params: hasMatchingDonor ? { captured: true } : undefined,
    });
    expect(thinkingDefault(projection.entry)).toBe(
      override.reasoning === false ? "off" : hasMatchingDonor ? "max" : undefined,
    );
    expect(preparedPolicy).toHaveBeenCalledTimes(hasMatchingDonor ? 1 : 0);
  },
);
it.each(["configured", "visibility"] as const)(
  "%s preparation reuses provider policies across rows and refreshes them next time",
  (kind) => {
    const loadPolicy = vi.spyOn(providerPolicy, "resolveDirectBundledProviderPolicySurface");
    const select = (rowCount: number, scope: string) => {
      loadPolicy.mockClear().mockReturnValue({
        normalizeModelCatalogId: ({ modelId }) => modelId.replace(/^legacy-/, `${scope}-`),
      });
      const ids = Array.from({ length: rowCount }, (_, index) => `legacy-${index}`);
      const catalog: ModelCatalogEntry[] = ["first", "second"].flatMap((owner) =>
        ids.map((_, index) => ({
          provider: "fixture",
          id: `${owner}-${index}`,
          name: `${owner}-${index}`,
          api: "openai-responses" as const,
          baseUrl: `https://${owner}.example/v1`,
        })),
      );
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { modelPolicy: { allow: ids.map((id) => `fixture/${id}`) } },
        },
      };
      if (kind === "configured") {
        cfg.models = modelConfig(
          ids.map<ModelDefinitionConfig>((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 1024,
          })),
          { baseUrl: configuredEndpoint },
          "fixture",
        ).models;
      }
      const params = { cfg, catalog, defaultProvider: "fixture", manifestPlugins: [] };
      const selected =
        kind === "configured"
          ? buildConfiguredModelCatalog(params)
          : createModelVisibilityPolicyWithFallbacks({
              ...params,
              fallbackModels: [],
              allowManifestNormalization: false,
              allowPluginNormalization: false,
            }).allowedCatalog;
      expect(selected.map((entry) => entry.baseUrl)).toEqual(
        Array.from({ length: rowCount }, () => `https://${scope}.example/v1`),
      );
      return loadPolicy.mock.calls.length;
    };

    const singleRowLoads = select(1, "first");
    expect(singleRowLoads).toBeGreaterThan(0);
    expect(select(32, "first")).toBe(singleRowLoads);
    expect(select(32, "second")).toBe(singleRowLoads);
  },
);
