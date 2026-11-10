import type { ProviderAppGuidedSetupContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeOptionalSecretInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import {
  buildOpenAICompatibleLiveModels,
  LiveModelCatalogHttpError,
  runLiveProviderCatalog,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  selectPreferredLocalModelId,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyProviderDefaultModel,
  discoverOpenAICompatibleLocalModels,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LLAMA_DEFAULT_BASE_URL, LLAMA_PROVIDER_ID, LLAMA_PROVIDER_LABEL } from "./defaults.js";

type LlamaListing = {
  baseUrl: string;
  models: ModelProviderConfig["models"];
  /** Models the app has in memory right now; setup prefers these. */
  loadedIds: string[];
};

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function unreachableMessage(baseUrl: string): string {
  return `Llama isn't reachable at ${baseUrl}. Open the Llama app (https://llama.app), download a model, and run setup again.`;
}

/** Lists the app's chat models. Returns null when the server can't be reached, unless strict. */
async function listLlamaModels(params: {
  config: OpenClawConfig;
  baseUrl?: string;
  signal?: AbortSignal;
  strict?: boolean;
}): Promise<LlamaListing | null> {
  params.signal?.throwIfAborted();
  const baseUrl = normalizeBaseUrl(
    params.baseUrl ??
      params.config.models?.providers?.[LLAMA_PROVIDER_ID]?.baseUrl ??
      LLAMA_DEFAULT_BASE_URL,
  );
  const result = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    label: LLAMA_PROVIDER_LABEL,
    // Llama runs llama-server in router mode: models load on first request, so
    // per-model /props would describe only the few already in memory.
    discoverRuntimeContext: false,
    rawResult: true,
    signal: params.signal,
  });
  params.signal?.throwIfAborted();
  if (result.kind !== "success") {
    if (params.strict) {
      throw result.kind === "http-error"
        ? new LiveModelCatalogHttpError(LLAMA_PROVIDER_ID, result.status)
        : new Error(unreachableMessage(baseUrl));
    }
    return null;
  }
  const rows = result.rows.map(({ model }) => model);
  // The shared projection drops non-chat rows and reads image input from
  // `architecture.input_modalities`, which llama-server reports per model.
  const models = buildOpenAICompatibleLiveModels(rows, {
    baseUrl,
    api: "openai-completions",
    models: [],
  });
  const loadedIds = rows.flatMap((row) => {
    const status = asOptionalRecord(row.status)?.value;
    return typeof row.id === "string" && (status === "loaded" || status === "sleeping")
      ? [row.id]
      : [];
  });
  return { baseUrl, models, loadedIds };
}

/** Prefers a model the user already has loaded in the app, then the shared local-model ranking. */
function pickDefaultModelId(listing: LlamaListing): string | undefined {
  const ids = listing.models.map((model) => model.id);
  const loaded = ids.filter((id) => listing.loadedIds.includes(id));
  return selectPreferredLocalModelId(loaded.length > 0 ? loaded : ids) ?? ids[0];
}

/** Setup saves only the connection; the catalog lists models live from the app. */
function setupResult(baseUrl: string, modelId: string): ProviderAuthResult {
  return {
    profiles: [],
    defaultModel: `${LLAMA_PROVIDER_ID}/${modelId}`,
    configPatch: {
      models: {
        providers: {
          [LLAMA_PROVIDER_ID]: { baseUrl, api: "openai-completions", models: [] },
        },
      },
    },
  };
}

export async function detectLlama(ctx: ProviderAppGuidedSetupContext) {
  const listing = await listLlamaModels(ctx);
  const modelId = listing && pickDefaultModelId(listing);
  return listing && modelId
    ? { modelRef: `${LLAMA_PROVIDER_ID}/${modelId}`, detail: modelId }
    : null;
}

export async function prepareLlama(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const listing = await listLlamaModels(ctx);
  const model = listing?.models.find((m) => `${LLAMA_PROVIDER_ID}/${m.id}` === ctx.modelRef);
  return listing && model ? setupResult(listing.baseUrl, model.id) : null;
}

export async function configureLlamaInteractive(
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const savedBaseUrl = ctx.config.models?.providers?.[LLAMA_PROVIDER_ID]?.baseUrl;
  const baseUrl = await ctx.prompter.text({
    message: "Llama server URL",
    // Prefill only a saved URL: a prefilled default makes typed input append to it.
    initialValue: savedBaseUrl,
    placeholder: LLAMA_DEFAULT_BASE_URL,
    validate: (value) => {
      if (!value.trim()) {
        return undefined;
      }
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? undefined : "Use an HTTP or HTTPS URL";
      } catch {
        return `Enter the Llama server URL, including /v1 (e.g. ${LLAMA_DEFAULT_BASE_URL})`;
      }
    },
  });
  const listing = await listLlamaModels({
    config: ctx.config,
    baseUrl: baseUrl.trim() || undefined,
    signal: ctx.signal,
  });
  if (!listing?.models.length) {
    throw new Error(unreachableMessage(normalizeBaseUrl(baseUrl.trim() || LLAMA_DEFAULT_BASE_URL)));
  }
  const modelId = await ctx.prompter.select({
    message: "Llama model",
    initialValue: pickDefaultModelId(listing),
    options: listing.models.map((model) => ({ value: model.id, label: model.name })),
  });
  ctx.signal?.throwIfAborted();
  return setupResult(listing.baseUrl, modelId);
}

type NonInteractiveContext = Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">;

async function prepareNonInteractive(ctx: NonInteractiveContext) {
  const baseUrl = normalizeOptionalSecretInput(ctx.opts.customBaseUrl);
  const listing = await listLlamaModels({ config: ctx.config, baseUrl });
  if (!listing?.models.length) {
    ctx.runtime.error(
      unreachableMessage(
        normalizeBaseUrl(
          baseUrl ??
            ctx.config.models?.providers?.[LLAMA_PROVIDER_ID]?.baseUrl ??
            LLAMA_DEFAULT_BASE_URL,
        ),
      ),
    );
    return null;
  }
  const requested = normalizeOptionalSecretInput(ctx.opts.customModelId);
  const modelId = requested ?? pickDefaultModelId(listing);
  if (!modelId || !listing.models.some((model) => model.id === modelId)) {
    const available = listing.models.map((model) => model.id).join(", ");
    ctx.runtime.error(`Llama model ${requested} was not found. Available models: ${available}`);
    return null;
  }
  return { listing, modelId };
}

export async function validateLlamaNonInteractive(ctx: NonInteractiveContext): Promise<boolean> {
  return (await prepareNonInteractive(ctx)) !== null;
}

export async function configureLlamaNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const prepared = await prepareNonInteractive(ctx);
  if (!prepared) {
    ctx.runtime.exit(1);
    return null;
  }
  const { listing, modelId } = prepared;
  const existing = ctx.config.models?.providers?.[LLAMA_PROVIDER_ID];
  const config: OpenClawConfig = {
    ...ctx.config,
    models: {
      ...ctx.config.models,
      providers: {
        ...ctx.config.models?.providers,
        [LLAMA_PROVIDER_ID]: {
          ...existing,
          baseUrl: listing.baseUrl,
          api: "openai-completions",
          models: existing?.models ?? [],
        },
      },
    },
  };
  ctx.runtime.log(`Default ${LLAMA_PROVIDER_LABEL} model: ${modelId}`);
  return applyProviderDefaultModel(config, `${LLAMA_PROVIDER_ID}/${modelId}`);
}

/** Lists the app's models live; runs only once Llama is set up or explicitly requested. */
export async function discoverLlamaProvider(ctx: ProviderCatalogContext) {
  if (ctx.providerIds && !ctx.providerIds.includes(LLAMA_PROVIDER_ID)) {
    return null;
  }
  const configured = ctx.config.models?.providers?.[LLAMA_PROVIDER_ID];
  if (!ctx.providerIds && !configured) {
    return null;
  }
  return await runLiveProviderCatalog({
    providerId: LLAMA_PROVIDER_ID,
    run: async () => {
      const listing = await listLlamaModels({
        config: ctx.config,
        signal: ctx.signal,
        strict: true,
      });
      if (!listing) {
        throw new Error(unreachableMessage(LLAMA_DEFAULT_BASE_URL));
      }
      return {
        provider: {
          ...configured,
          baseUrl: listing.baseUrl,
          api: "openai-completions" as const,
          models: listing.models,
        },
      };
    },
  });
}
