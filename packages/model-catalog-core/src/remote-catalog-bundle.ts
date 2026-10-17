import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  MODEL_CATALOG_APIS,
  MODEL_CATALOG_INPUTS,
  MODEL_CATALOG_MAX_CONTEXT_WINDOWS,
  MODEL_CATALOG_STATUSES,
  MODEL_CATALOG_THINKING_LEVELS,
} from "./model-catalog-types.js";
import type { ModelCatalogModel, ModelCatalogProvider } from "./model-catalog-types.js";
import { ModelInferenceCapabilitiesSchema } from "./model-inference-capabilities.js";

export const REMOTE_CATALOG_MAX_FUTURE_SKEW_MS = 24 * 60 * 60_000;

const stringMapSchema = z.record(z.string(), z.string());
const pricingTierSchema = z
  .object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(),
    cacheWrite: z.number().finite().nonnegative(),
    range: z.union([
      z.tuple([z.number().finite().nonnegative()]),
      z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]),
    ]),
  })
  .strict();

const costSchema = pricingTierSchema
  .omit({ range: true })
  .partial()
  .extend({
    tieredPricing: z.array(pricingTierSchema).optional(),
  });

const hostedPricingSchema = costSchema.extend({
  input: pricingTierSchema.shape.input,
  output: pricingTierSchema.shape.output,
});

export type RemoteModelCatalogPricing = z.infer<typeof hostedPricingSchema>;

const contextWindowOptionSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    contextWindow: z.number().int().positive(),
  })
  .strict();

const inputModalitySchema = z.enum(MODEL_CATALOG_INPUTS);
const modelFieldsSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().optional(),
  api: z.enum(MODEL_CATALOG_APIS).optional(),
  baseUrl: z.string().optional(),
  headers: stringMapSchema.optional(),
  input: z.array(inputModalitySchema).optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().finite().positive().optional(),
  contextWindows: z
    .array(contextWindowOptionSchema)
    .max(MODEL_CATALOG_MAX_CONTEXT_WINDOWS)
    .optional(),
  contextWindowDefault: z.string().trim().min(1).optional(),
  contextTokens: z.number().int().positive().optional(),
  parameterCount: z.number().int().positive().optional(),
  maxTokens: z.number().finite().positive().optional(),
  thinkingLevelMap: z
    .partialRecord(z.enum(MODEL_CATALOG_THINKING_LEVELS), z.string().nullable())
    .optional(),
  cost: costSchema.optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
  mediaInput: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(MODEL_CATALOG_STATUSES).optional(),
  statusReason: z.string().optional(),
  replaces: z.array(z.string()).optional(),
  replacedBy: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

function validateContextWindowDefault(
  model: { contextWindowDefault?: string; contextWindows?: Array<{ id: string }> },
  context: z.RefinementCtx,
) {
  if (
    model.contextWindowDefault &&
    !model.contextWindows?.some((option) => option.id === model.contextWindowDefault)
  ) {
    context.addIssue({
      code: "custom",
      message: "contextWindowDefault must reference a declared contextWindows option",
      path: ["contextWindowDefault"],
    });
  }
}

const modelSchema = modelFieldsSchema.superRefine(validateContextWindowDefault);

type CatalogWarning = (message: string) => void;

function parseCatalogRows<T extends { id: string }>(
  rows: unknown[],
  schema: z.ZodType<T>,
  path: string,
  warn: CatalogWarning,
  key: (model: T) => string = (model) => model.id,
): T[] {
  const seen = new Set<string>();
  return rows.flatMap((raw, index) => {
    const row = `${path}.${index}${isRecord(raw) && typeof raw.id === "string" ? ` (${raw.id})` : ""}`;
    let value = raw;
    let droppedInput = false;
    if (
      isRecord(raw) &&
      Array.isArray(raw.input) &&
      raw.input.every((v) => typeof v === "string")
    ) {
      const input = raw.input.filter((v) =>
        inputModalitySchema.options.some((known) => known === v),
      );
      droppedInput = input.length !== raw.input.length;
      if (droppedInput) {
        if (input.length === 0) {
          warn(`remote model catalog: skipped row with no supported input modalities ${row}`);
          return [];
        }
        value = { ...raw, input };
      }
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success || seen.has(key(parsed.data))) {
      warn(`remote model catalog: skipped invalid row ${row}`);
      return [];
    }
    seen.add(key(parsed.data));
    if (droppedInput) {
      warn(`remote model catalog: dropped unknown input modalities from ${row}`);
    }
    return [parsed.data];
  });
}

const providerFieldsSchema = z
  .object({
    baseUrl: z.string().optional(),
    api: z.enum(MODEL_CATALOG_APIS).optional(),
    headers: stringMapSchema.optional(),
    defaultModel: z.string().optional(),
    defaultUtilityModel: z.string().optional(),
    models: z.array(modelSchema).min(1),
  })
  .strict();

export const remoteModelCatalogProviderSchema = providerFieldsSchema.superRefine(
  (provider, context) => {
    const seen = new Set<string>();
    for (const [index, model] of provider.models.entries()) {
      if (seen.has(model.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate model id: ${model.id}`,
          path: ["models", index, "id"],
        });
      }
      seen.add(model.id);
    }
  },
);

export const remoteModelCatalogBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z
      .number()
      .int()
      .positive()
      .refine((value) => value <= Date.now() + REMOTE_CATALOG_MAX_FUTURE_SKEW_MS, {
        message: "generatedAt is implausibly far in the future",
      }),
    minVersion: z.string().trim().min(1).optional(),
    sourceCommit: z.string().trim().min(1),
    providers: z.record(z.string().trim().min(1), remoteModelCatalogProviderSchema),
    pricing: z.record(z.string().trim().min(1), hostedPricingSchema).optional(),
  })
  .strict();

export type RemoteModelCatalogBundle = Omit<
  z.infer<typeof remoteModelCatalogBundleSchema>,
  "providers"
> & {
  providers: Record<string, ModelCatalogProvider>;
};

// "Known" describes the supplied rates, not a complete tariff. Preserve omitted
// components so ingestion retains the existing partial-cost contract.
const knownPricingV2Schema = costSchema
  .extend({
    status: z.literal("known"),
    currency: z.literal("USD"),
    unit: z.literal("million_tokens"),
    source: z.string().trim().min(1).optional(),
  })
  .refine(
    (pricing) =>
      pricing.input !== undefined ||
      pricing.output !== undefined ||
      pricing.cacheRead !== undefined ||
      pricing.cacheWrite !== undefined ||
      Boolean(pricing.tieredPricing?.length),
    { message: "known pricing must contain rates" },
  );

const pricingV2Schema = z.discriminatedUnion("status", [
  knownPricingV2Schema,
  z
    .object({
      status: z.enum(["unknown", "unavailable"]),
      source: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

export type RemoteModelCatalogPricingV2 = z.infer<typeof pricingV2Schema>;

// Standalone rates cover models outside `models`, in USD per million tokens.
// `upstreamPricing` is keyed by the source's vendor/model ID and serves passthrough
// gateways plus same-vendor lookups. The entry's own rate wins; `alternatives` keep
// later sources' rates for providers that allow only those sources. `passthroughOnly`
// entries are owned by catalog rows and serve gateways alone. `providerPricing` holds
// provider-owned rates for models without a catalog row.
const sourcedPricingV2Schema = hostedPricingSchema
  .extend({ source: z.string().trim().min(1) })
  .strict();
const upstreamPricingV2Schema = sourcedPricingV2Schema
  .extend({
    passthroughOnly: z.literal(true).optional(),
    alternatives: z.array(sourcedPricingV2Schema).min(1).optional(),
  })
  .strict();
const standalonePricingKeySchema = z
  .string()
  .regex(/^[^/\s]+\/\S+$/u, "standalone pricing keys must be provider/model");

const modelV2Schema = modelFieldsSchema
  .omit({ cost: true, baseUrl: true, headers: true })
  .extend({ provider: z.string().trim().min(1), pricing: pricingV2Schema })
  .strict()
  .superRefine(validateContextWindowDefault);

const bundleV2FieldsSchema = remoteModelCatalogBundleSchema
  .omit({ providers: true, pricing: true })
  .extend({
    schemaVersion: z.literal(2),
    providers: z.record(
      z.string().trim().min(1),
      z
        .object({
          api: z.enum(MODEL_CATALOG_APIS).optional(),
          defaultModel: z.string().optional(),
          defaultUtilityModel: z.string().optional(),
          recommendedModels: z
            .array(z.string().trim().min(1))
            .refine((ids) => new Set(ids).size === ids.length, "duplicate recommended model id")
            .optional(),
        })
        .strict(),
    ),
    models: z.array(modelV2Schema).min(1),
    upstreamPricing: z.record(standalonePricingKeySchema, upstreamPricingV2Schema).optional(),
    providerPricing: z.record(standalonePricingKeySchema, sourcedPricingV2Schema).optional(),
  });

function validateBundleModelRefs(
  bundle: Pick<z.infer<typeof bundleV2FieldsSchema>, "providers" | "models">,
  context: z.RefinementCtx,
) {
  const providers = new Map<string, Set<string>>();
  for (const [index, model] of bundle.models.entries()) {
    if (!Object.hasOwn(bundle.providers, model.provider)) {
      context.addIssue({
        code: "custom",
        message: `undeclared model provider: ${model.provider}`,
        path: ["models", index, "provider"],
      });
    }
    const ids = providers.get(model.provider) ?? new Set<string>();
    if (ids.has(model.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate provider/model: ${model.provider}/${model.id}`,
        path: ["models", index, "id"],
      });
    }
    ids.add(model.id);
    providers.set(model.provider, ids);
  }
  for (const [provider, entry] of Object.entries(bundle.providers)) {
    for (const [index, id] of (entry.recommendedModels ?? []).entries()) {
      if (!providers.get(provider)?.has(id)) {
        context.addIssue({
          code: "custom",
          message: `recommended model must reference a model of provider ${provider}: ${id}`,
          path: ["providers", provider, "recommendedModels", index],
        });
      }
    }
  }
}

export const remoteModelCatalogBundleV2Schema =
  bundleV2FieldsSchema.superRefine(validateBundleModelRefs);

const modelV3Schema = modelV2Schema.safeExtend({
  inference: ModelInferenceCapabilitiesSchema.optional(),
});
const bundleV3FieldsSchema = bundleV2FieldsSchema.extend({
  schemaVersion: z.literal(3),
  models: z.array(modelV3Schema).min(1),
});

/** Native task metadata is negotiated separately from the strict released v2 wire. */
export const remoteModelCatalogBundleV3Schema =
  bundleV3FieldsSchema.superRefine(validateBundleModelRefs);

export type RemoteModelCatalogModelV2 = Omit<
  ModelCatalogModel,
  "cost" | "baseUrl" | "headers" | "upstreamModel" | "inference"
> & {
  provider: string;
  pricing: RemoteModelCatalogPricingV2;
};

export type RemoteModelCatalogBundleV2 = Omit<
  z.infer<typeof remoteModelCatalogBundleV2Schema>,
  "models"
> & { models: RemoteModelCatalogModelV2[] };

export type RemoteModelCatalogBundleV3 = Omit<
  RemoteModelCatalogBundleV2,
  "schemaVersion" | "models"
> & {
  schemaVersion: 3;
  models: Array<RemoteModelCatalogModelV2 & Pick<ModelCatalogModel, "inference">>;
};

export function parseRemoteModelCatalogBundleV3(value: unknown): RemoteModelCatalogBundleV3 {
  // SAFETY: the schema validates every field; shared catalog types narrow compat metadata.
  return remoteModelCatalogBundleV3Schema.parse(value) as RemoteModelCatalogBundleV3;
}

export function parseRemoteModelCatalogBundleV2(value: unknown): RemoteModelCatalogBundleV2 {
  // SAFETY: the schema validates every model field; shared catalog types narrow compat metadata.
  return remoteModelCatalogBundleV2Schema.parse(value) as RemoteModelCatalogBundleV2;
}

export function parseRemoteModelCatalogBundle(value: unknown): RemoteModelCatalogBundle {
  return remoteModelCatalogBundleSchema.parse(value) as RemoteModelCatalogBundle;
}

function stripRemoteTransportOverrides(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRemoteTransportOverrides);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value);
  let kept = 0;
  for (const entry of entries) {
    if (entry[0] !== "baseUrl" && entry[0] !== "headers") {
      entry[1] = stripRemoteTransportOverrides(entry[1]);
      entries[kept++] = entry;
    }
  }
  entries.length = kept;
  return Object.fromEntries(entries);
}

/** Removes every transport endpoint/header override before remote data reaches persistence. */
export function sanitizeRemoteModelCatalogBundle<
  T extends RemoteModelCatalogBundle | RemoteModelCatalogBundleV2 | RemoteModelCatalogBundleV3,
>(bundle: T): T {
  // Provider dictionary keys are identities, even when named "headers" or "baseUrl".
  return (
    bundle.schemaVersion === 1
      ? stripRemoteTransportOverrides(bundle)
      : { ...bundle, models: bundle.models.map(stripRemoteTransportOverrides) }
  ) as T;
}

export function validateAndSanitizeRemoteModelCatalogBundle(
  value: unknown,
  warn: CatalogWarning = console.warn,
): RemoteModelCatalogBundle {
  const bundle = remoteModelCatalogBundleSchema
    .extend({
      providers: z.record(
        z.string().trim().min(1),
        providerFieldsSchema.extend({
          models: z.array(z.unknown()),
        }),
      ),
    })
    .parse(value);
  const providers = Object.fromEntries(
    Object.entries(bundle.providers).flatMap<[string, ModelCatalogProvider]>(([id, provider]) => {
      const models = parseCatalogRows(provider.models, modelSchema, `providers.${id}.models`, warn);
      return models.length > 0 ? [[id, { ...provider, models }]] : [];
    }),
  );
  // v1 permits standalone pricing without declaring model providers.
  if (Object.keys(bundle.providers).length > 0 && Object.keys(providers).length === 0) {
    throw new Error("remote model catalog contains no valid models");
  }
  return sanitizeRemoteModelCatalogBundle({ ...bundle, providers });
}

export function validateAndSanitizeRemoteModelCatalogBundleV2(
  value: unknown,
  warn: CatalogWarning = console.warn,
): RemoteModelCatalogBundleV2 {
  const bundle = bundleV2FieldsSchema
    .extend({
      models: z.array(z.unknown()),
    })
    .parse(value);
  const models = parseCatalogRows(
    bundle.models,
    modelV2Schema.refine((model) => Object.hasOwn(bundle.providers, model.provider)),
    "models",
    warn,
    (model) => JSON.stringify([model.provider, model.id]),
  );
  if (models.length === 0) {
    throw new Error("remote model catalog contains no valid models");
  }
  const providers = Object.fromEntries(
    Object.entries(bundle.providers).map(([id, provider]) => [
      id,
      {
        ...provider,
        ...(provider.recommendedModels
          ? {
              recommendedModels: provider.recommendedModels.filter((modelId) =>
                models.some((model) => model.provider === id && model.id === modelId),
              ),
            }
          : {}),
      },
    ]),
  );
  return sanitizeRemoteModelCatalogBundle({ ...bundle, providers, models });
}

export function validateAndSanitizeRemoteModelCatalogBundleV3(
  value: unknown,
  warn: CatalogWarning = console.warn,
): RemoteModelCatalogBundleV3 {
  const bundle = bundleV3FieldsSchema.extend({ models: z.array(z.unknown()) }).parse(value);
  const models = parseCatalogRows(
    bundle.models,
    modelV3Schema.refine((model) => Object.hasOwn(bundle.providers, model.provider)),
    "models",
    warn,
    (model) => JSON.stringify([model.provider, model.id]),
  );
  if (models.length === 0) {
    throw new Error("remote model catalog contains no valid models");
  }
  const providers = Object.fromEntries(
    Object.entries(bundle.providers).map(([id, provider]) => [
      id,
      {
        ...provider,
        ...(provider.recommendedModels
          ? {
              recommendedModels: provider.recommendedModels.filter((modelId) =>
                models.some(
                  (model) =>
                    model.provider === id &&
                    model.id === modelId &&
                    model.inference?.chat !== false,
                ),
              ),
            }
          : {}),
      },
    ]),
  );
  return sanitizeRemoteModelCatalogBundle({ ...bundle, providers, models });
}
