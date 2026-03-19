import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPrepareRuntimeAuthContext } from "openclaw/plugin-sdk/core";
import { getAccessTokenResultAsync } from "./cli.js";
import {
  type CachedTokenEntry,
  TOKEN_REFRESH_MARGIN_MS,
  buildFoundryProviderBaseUrl,
  extractFoundryEndpoint,
  getFoundryTokenCacheKey,
  resolveConfiguredModelNameHint,
} from "./shared-runtime.js";

const cachedTokens = new Map<string, CachedTokenEntry>();
const refreshPromises = new Map<string, Promise<{ apiKey: string; expiresAt: number }>>();

async function refreshEntraToken(params?: {
  subscriptionId?: string;
  tenantId?: string;
}): Promise<{ apiKey: string; expiresAt: number }> {
  const result = await getAccessTokenResultAsync(params);
  const rawExpiry = result.expiresOn ? new Date(result.expiresOn).getTime() : Number.NaN;
  const expiresAt = Number.isFinite(rawExpiry) ? rawExpiry : Date.now() + 55 * 60 * 1000;
  cachedTokens.set(getFoundryTokenCacheKey(params), {
    token: result.accessToken,
    expiresAt,
  });
  return { apiKey: result.accessToken, expiresAt };
}

export async function prepareFoundryRuntimeAuth(ctx: ProviderPrepareRuntimeAuthContext) {
  if (ctx.apiKey !== "__entra_id_dynamic__") {
    return null;
  }
  try {
    const authStore = ensureAuthProfileStore(ctx.agentDir, {
      allowKeychainPrompt: false,
    });
    const credential = ctx.profileId ? authStore.profiles[ctx.profileId] : undefined;
    const metadata = credential?.type === "api_key" ? credential.metadata : undefined;
    const modelId =
      typeof ctx.modelId === "string" && ctx.modelId.trim().length > 0
        ? ctx.modelId.trim()
        : typeof metadata?.modelId === "string" && metadata.modelId.trim().length > 0
          ? metadata.modelId.trim()
          : ctx.modelId;
    const activeModelNameHint = ctx.modelId === metadata?.modelId ? metadata?.modelName : undefined;
    const modelNameHint = resolveConfiguredModelNameHint(modelId, ctx.model.name ?? activeModelNameHint);
    const endpoint =
      typeof metadata?.endpoint === "string" && metadata.endpoint.trim().length > 0
        ? metadata.endpoint.trim()
        : extractFoundryEndpoint(ctx.model.baseUrl ?? "");
    const baseUrl = endpoint ? buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint) : undefined;
    const cacheKey = getFoundryTokenCacheKey({
      subscriptionId: metadata?.subscriptionId,
      tenantId: metadata?.tenantId,
    });
    const cachedToken = cachedTokens.get(cacheKey);
    if (cachedToken && cachedToken.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      return {
        apiKey: cachedToken.token,
        expiresAt: cachedToken.expiresAt,
        ...(baseUrl ? { baseUrl } : {}),
      };
    }
    let refreshPromise = refreshPromises.get(cacheKey);
    if (!refreshPromise) {
      refreshPromise = refreshEntraToken({
        subscriptionId: metadata?.subscriptionId,
        tenantId: metadata?.tenantId,
      }).finally(() => {
        refreshPromises.delete(cacheKey);
      });
      refreshPromises.set(cacheKey, refreshPromise);
    }
    const token = await refreshPromise;
    return {
      ...token,
      ...(baseUrl ? { baseUrl } : {}),
    };
  } catch (err) {
    throw new Error(
      `Failed to refresh Azure Entra ID token via az CLI: ${String(err)}\nMake sure you are logged in: az login --use-device-code`,
    );
  }
}
