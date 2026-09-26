import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelCatalogModel } from "../../packages/model-catalog-core/src/model-catalog-types.js";
import type {
  RemoteModelCatalogBundle as PublishedModelCatalogBundle,
  RemoteModelCatalogBundleV2,
  RemoteModelCatalogBundleV3,
  RemoteModelCatalogPricing as PublishedModelPricing,
  RemoteModelCatalogPricingV2,
} from "../../packages/model-catalog-core/src/remote-catalog-bundle.js";
import { importToolingTypeScript } from "./import-tooling-typescript.mts";
import { resolveRepoRoot } from "./repo-root.mjs";
const defaultRootDir = resolveRepoRoot(import.meta.url);
export type PricingSelection = Pick<RemoteModelCatalogPricingV2, "status" | "source">;
type SourcedPricing = {
  source: string;
  pricing: PublishedModelPricing;
  passthroughOnly?: true;
  /** Later sources' rates, for providers whose policy excludes the winning source. */
  alternatives?: SourcedPricing[];
};
/** Standalone v2 prices: one upstream table plus provider-owned prices for uncatalogued models. */
export type StandalonePricing = {
  upstream: Map<string, SourcedPricing>;
  provider: Map<string, SourcedPricing>;
};
export async function loadClientBundleValidator(version: 1 | 2 | 3 = 1) {
  const modulePath = path.join(
    defaultRootDir,
    "packages/model-catalog-core/src/remote-catalog-bundle.ts",
  );
  const module = await importToolingTypeScript(pathToFileURL(modulePath).href, import.meta.url);
  const name =
    version === 1
      ? "validateAndSanitizeRemoteModelCatalogBundle"
      : version === 2
        ? "validateAndSanitizeRemoteModelCatalogBundleV2"
        : "validateAndSanitizeRemoteModelCatalogBundleV3";
  if (typeof module[name] !== "function") {
    throw new Error("remote catalog bundle validator export is unavailable");
  }
  return module[name];
}

export function compactPricing(pricing: PublishedModelPricing): PublishedModelPricing {
  return {
    input: pricing.input,
    output: pricing.output,
    ...((pricing.cacheRead ?? 0) > 0 ? { cacheRead: pricing.cacheRead } : {}),
    ...((pricing.cacheWrite ?? 0) > 0 ? { cacheWrite: pricing.cacheWrite } : {}),
    ...(pricing.tieredPricing ? { tieredPricing: pricing.tieredPricing } : {}),
  };
}

export function hasKnownPricing(pricing: Partial<PublishedModelPricing>): boolean {
  return (
    (pricing.input ?? 0) > 0 ||
    (pricing.output ?? 0) > 0 ||
    (pricing.cacheRead ?? 0) > 0 ||
    (pricing.cacheWrite ?? 0) > 0 ||
    Boolean(pricing.tieredPricing?.some(hasKnownPricing))
  );
}

function sortCatalogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCatalogValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortCatalogValue(entry)]),
  );
}

export function serializeModelCatalogBundle(bundle: PublishedModelCatalogBundle): string {
  const providers = Object.fromEntries(
    Object.entries(bundle.providers)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([providerId, provider]) => [
        providerId,
        {
          ...provider,
          models: provider.models.toSorted((left, right) => left.id.localeCompare(right.id)),
        },
      ]),
  );
  return `${JSON.stringify(sortCatalogValue({ ...bundle, providers }), null, 2)}\n`;
}

function serializeStandalonePricing(prices: Map<string, SourcedPricing> | undefined) {
  if (!prices?.size) {
    return undefined;
  }
  const serialize = ({ source, pricing }: SourcedPricing) => ({
    ...compactPricing(pricing),
    source,
  });
  return Object.fromEntries(
    [...prices.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        {
          ...serialize(entry),
          ...(entry.passthroughOnly ? { passthroughOnly: entry.passthroughOnly } : {}),
          ...(entry.alternatives ? { alternatives: entry.alternatives.map(serialize) } : {}),
        },
      ]),
  );
}

function retainedNativePricing(
  model: ModelCatalogModel,
  selections: WeakMap<ModelCatalogModel, PricingSelection>,
) {
  const billing = model.inference?.decision?.billing;
  if (billing && billing.unit !== "tokens") {
    return undefined;
  }
  const selection = selections.get(model);
  const cost = model.cost ?? (billing?.unit === "tokens" ? billing.usdPerMillion : undefined);
  if (
    !cost ||
    cost.input === undefined ||
    cost.output === undefined ||
    selection?.status === "unavailable"
  ) {
    return undefined;
  }
  const declared =
    billing?.unit === "tokens" &&
    billing.usdPerMillion?.input !== undefined &&
    billing.usdPerMillion.output !== undefined;
  if (selection?.status !== "known" && !declared && !hasKnownPricing(cost)) {
    return undefined;
  }
  return {
    ...cost,
    input: cost.input,
    output: cost.output,
    source: selection?.source ?? billing?.source ?? "manifest",
  };
}

function buildVersionedModelCatalogBundle(
  bundle: PublishedModelCatalogBundle,
  pricingSelections: WeakMap<ModelCatalogModel, PricingSelection>,
  standalonePricing: StandalonePricing | undefined,
  version: 2 | 3,
) {
  const providers: RemoteModelCatalogBundleV2["providers"] = {};
  const models: RemoteModelCatalogBundleV3["models"] = [];
  const omittedPricing: Record<string, NonNullable<ReturnType<typeof retainedNativePricing>>> = {};
  for (const [providerId, provider] of Object.entries(bundle.providers)) {
    const included = provider.models.filter(
      (model) => version === 3 || model.inference?.chat !== false,
    );
    if (version === 2) {
      for (const model of provider.models) {
        if (model.inference?.chat === false) {
          const pricing = retainedNativePricing(model, pricingSelections);
          if (pricing) {
            omittedPricing[providerId + "/" + model.id] = pricing;
          }
        }
      }
    }
    if (included.length === 0) {
      continue;
    }
    const ids = new Set(included.map((model) => model.id));
    providers[providerId] = {
      api: provider.api,
      defaultModel:
        provider.defaultModel && ids.has(provider.defaultModel) ? provider.defaultModel : undefined,
      defaultUtilityModel:
        provider.defaultUtilityModel && ids.has(provider.defaultUtilityModel)
          ? provider.defaultUtilityModel
          : undefined,
    };
    for (const model of included) {
      const { cost: modelCost, ...metadata } = model;
      let cost = modelCost;
      if (version === 2) {
        delete metadata.inference;
      }
      delete metadata.baseUrl;
      delete metadata.headers;
      delete metadata.upstreamModel;
      let selection = pricingSelections.get(model);
      const billing = metadata.inference?.decision?.billing;
      if (version === 3 && metadata.inference?.chat === false) {
        if (billing?.unit !== "tokens") {
          cost = undefined;
        } else if (
          !selection &&
          billing.usdPerMillion &&
          Object.values(billing.usdPerMillion).some((rate) => rate !== undefined)
        ) {
          cost = billing.usdPerMillion;
          selection = { status: "known", source: billing.source };
        }
      }
      const pricing: RemoteModelCatalogPricingV2 =
        cost && (selection?.status === "known" || hasKnownPricing(cost))
          ? {
              status: "known",
              currency: "USD",
              unit: "million_tokens",
              ...cost,
              ...(selection?.source ? { source: selection.source } : {}),
            }
          : {
              status: selection?.status === "unavailable" ? "unavailable" : "unknown",
              ...(selection?.source ? { source: selection.source } : {}),
            };
      if (
        version === 3 &&
        metadata.inference?.chat === false &&
        metadata.inference.decision?.billing?.unit === "tokens"
      ) {
        const { usdPerMillion: _oldRates, ...billingFacts } = metadata.inference.decision.billing;
        metadata.inference = {
          ...metadata.inference,
          decision: {
            ...metadata.inference.decision,
            billing: {
              ...billingFacts,
              // Native flat-rate metadata cannot represent a context-dependent schedule.
              ...(pricing.status === "known" && !pricing.tieredPricing?.length
                ? {
                    usdPerMillion: {
                      ...(pricing.input !== undefined ? { input: pricing.input } : {}),
                      ...(pricing.output !== undefined ? { output: pricing.output } : {}),
                    },
                  }
                : {}),
            },
          },
        };
      }
      models.push({ ...metadata, provider: providerId, pricing });
    }
  }
  // The first supporting release is not assigned yet. schemaVersion gates v2;
  // never copy v1's older client floor onto a new wire contract.
  const upstreamPricing = serializeStandalonePricing(standalonePricing?.upstream);
  const providerPricing = {
    ...serializeStandalonePricing(standalonePricing?.provider),
    ...omittedPricing,
  };
  return {
    schemaVersion: version,
    generatedAt: bundle.generatedAt,
    sourceCommit: bundle.sourceCommit,
    providers,
    models,
    ...(upstreamPricing ? { upstreamPricing } : {}),
    ...(Object.keys(providerPricing).length ? { providerPricing } : {}),
  };
}

export async function assembleModelCatalogBundleV2(
  bundle: PublishedModelCatalogBundle,
  selections: WeakMap<ModelCatalogModel, PricingSelection>,
  standalonePricing?: StandalonePricing,
): Promise<RemoteModelCatalogBundleV2> {
  return (await loadClientBundleValidator(2))(
    buildVersionedModelCatalogBundle(bundle, selections, standalonePricing, 2),
  );
}
export async function assembleModelCatalogBundleV3(
  bundle: PublishedModelCatalogBundle,
  selections: WeakMap<ModelCatalogModel, PricingSelection>,
  standalonePricing?: StandalonePricing,
): Promise<RemoteModelCatalogBundleV3> {
  return (await loadClientBundleValidator(3))(
    buildVersionedModelCatalogBundle(bundle, selections, standalonePricing, 3),
  );
}

export function serializeModelCatalogBundleV2(
  bundle: RemoteModelCatalogBundleV2 | RemoteModelCatalogBundleV3,
): string {
  const models = bundle.models
    .toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
    )
    .map(({ id, provider, ...metadata }) =>
      Object.assign(
        { id, provider },
        Object.fromEntries(
          Object.entries(metadata)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [key, sortCatalogValue(value)]),
        ),
      ),
    );
  return `${JSON.stringify(
    Object.fromEntries(
      Object.entries(bundle)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, key === "models" ? models : sortCatalogValue(value)]),
    ),
    null,
    2,
  )}\n`;
}

/** Legacy wire readers must never mistake native decision rows for conversational models. */
export function projectLegacyModelCatalogBundle(
  bundle: PublishedModelCatalogBundle,
  selections: WeakMap<ModelCatalogModel, PricingSelection> = new WeakMap(),
): PublishedModelCatalogBundle {
  const pricing = { ...bundle.pricing };
  const providers = Object.fromEntries(
    Object.entries(bundle.providers).flatMap(([id, provider]) => {
      for (const model of provider.models) {
        if (model.inference?.chat === false) {
          const retained = retainedNativePricing(model, selections);
          if (retained) {
            const { source: _source, ...rates } = retained;
            pricing[id + "/" + model.id] = rates;
          }
        }
      }
      const models = provider.models
        .filter((model) => model.inference?.chat !== false)
        .map(({ inference: _inference, ...model }) => model);
      if (models.length === 0) {
        return [];
      }
      const ids = new Set(models.map((model) => model.id));
      return [
        [
          id,
          {
            api: provider.api,
            ...(provider.defaultModel && ids.has(provider.defaultModel)
              ? { defaultModel: provider.defaultModel }
              : {}),
            ...(provider.defaultUtilityModel && ids.has(provider.defaultUtilityModel)
              ? { defaultUtilityModel: provider.defaultUtilityModel }
              : {}),
            models,
          },
        ],
      ];
    }),
  );
  return { ...bundle, providers, ...(Object.keys(pricing).length ? { pricing } : {}) };
}
