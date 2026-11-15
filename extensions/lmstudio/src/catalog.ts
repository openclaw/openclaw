import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ProviderCatalogContext,
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_PROVIDER_ID as PROVIDER_ID,
} from "./defaults.js";
import { discoverLmstudioModels } from "./models.fetch.js";
import { resolveLmstudioInferenceBase } from "./models.js";
import {
  hasLmstudioAuthorizationHeader,
  resolveLmstudioProviderAuthMode,
  resolvePersistedLmstudioApiKey,
} from "./provider-auth.js";
import {
  LmstudioConfigResolutionError,
  resolveLmstudioConfiguredApiKey,
  resolveLmstudioProviderHeaders,
} from "./runtime.js";

/** Acquires live inventory for the registered catalog; public helper calls stay advisory. */
export function discoverLmstudioProvider(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig;
} | null>;
export function discoverLmstudioProvider(
  ctx: ProviderCatalogContext,
  options: { discoveryMode: "strict" },
): Promise<ProviderCatalogResult>;
export async function discoverLmstudioProvider(
  ctx: ProviderCatalogContext,
  options?: { discoveryMode: "strict" },
): Promise<ProviderCatalogResult> {
  if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER_ID)) {
    return null;
  }
  const explicit = ctx.config.models?.providers?.[PROVIDER_ID];
  const {
    headers: _headers,
    auth: explicitAuth,
    apiKey: _apiKey,
    ...explicitWithoutHeaders
  } = explicit ?? {};
  const { apiKey, discoveryApiKey, profileId } = ctx.resolveProviderApiKey(PROVIDER_ID);
  let resolvedHeaders: Record<string, string> | undefined;
  let hasAuthorizationHeader: boolean;
  let configuredDiscoveryApiKey: string | undefined;
  try {
    resolvedHeaders = await resolveLmstudioProviderHeaders({
      config: ctx.config,
      env: ctx.env,
      headers: explicit?.headers,
    });
    hasAuthorizationHeader = hasLmstudioAuthorizationHeader(resolvedHeaders);
    configuredDiscoveryApiKey = await resolveLmstudioConfiguredApiKey({
      config: ctx.config,
      env: ctx.env,
      allowUnresolved: hasAuthorizationHeader || Boolean(discoveryApiKey),
    });
  } catch (error) {
    if (error instanceof LmstudioConfigResolutionError) {
      return null;
    }
    throw error;
  }
  const resolvedDiscoveryApiKey = hasAuthorizationHeader
    ? undefined
    : (discoveryApiKey ?? configuredDiscoveryApiKey);
  // CLI/runtime-resolved key takes precedence over static provider config key.
  const resolvedApiKey = apiKey ?? explicit?.apiKey;
  const baseUrl = resolveLmstudioInferenceBase(explicit?.baseUrl);
  const quiet = !apiKey && !explicit && !resolvedDiscoveryApiKey;
  const catalogProfileId =
    !hasAuthorizationHeader && discoveryApiKey && !isNonSecretApiKeyMarker(discoveryApiKey)
      ? profileId
      : undefined;
  const run = async () => {
    let modelIdCatalog: ProviderCatalogOutcome["modelIdCatalog"];
    const models =
      !options && explicit?.models?.length
        ? explicit.models
        : await discoverLmstudioModels({
            onListedModels: (rows) => {
              modelIdCatalog = {
                baseUrl,
                modelIds: normalizeUniqueTrimmedStringList(
                  rows.flatMap((row) => [
                    row.key,
                    ...(row.loaded_instances?.map((instance) => instance?.id) ?? []),
                  ]),
                ),
                aliases: normalizeUniqueTrimmedStringList(
                  rows.flatMap((row) =>
                    row.key?.trim()
                      ? [row.selected_variant, ...normalizeUniqueTrimmedStringList(row.variants)]
                      : [],
                  ),
                ),
              };
            },
            baseUrl,
            apiKey: resolvedDiscoveryApiKey ?? "",
            headers: resolvedHeaders,
            quiet,
            ...(!quiet && options ? options : {}),
          });
    const outcomes = modelIdCatalog
      ? [
          {
            provider: PROVIDER_ID,
            profileId: catalogProfileId,
            status: "ready" as const,
            modelIdCatalog,
          },
        ]
      : undefined;
    if (models.length === 0 && (options ? quiet : !apiKey && !explicit?.apiKey)) {
      return options && outcomes ? { providers: {}, outcomes } : null;
    }
    const persistedApiKey = resolvePersistedLmstudioApiKey({
      currentApiKey: resolvedApiKey,
      explicitAuth,
      fallbackApiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
      hasModels: models.length > 0,
      hasAuthorizationHeader,
    });
    const persistedAuth = resolveLmstudioProviderAuthMode(persistedApiKey);
    return {
      ...(outcomes ? { outcomes } : {}),
      provider: {
        ...explicitWithoutHeaders,
        baseUrl,
        api: explicit?.api ?? "openai-completions",
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        ...(persistedApiKey ? { apiKey: persistedApiKey } : {}),
        ...(persistedAuth ? { auth: persistedAuth } : {}),
        models,
      },
    };
  };
  return options
    ? await runLiveProviderCatalog({
        providerId: PROVIDER_ID,
        profileId: catalogProfileId,
        run,
      })
    : await run();
}
