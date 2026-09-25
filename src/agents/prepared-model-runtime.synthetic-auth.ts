/** Synthetic-auth provider ref selection and prepared-catalog resolution for model-runtime builds. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderSyntheticAuthResult } from "../plugins/provider-external-auth.types.js";
import { prepareSyntheticAuthWithProvider } from "../plugins/provider-synthetic-auth.js";
import type { ProviderPlugin } from "../plugins/types.js";

/** Auth refresh owns the requested providers and their separate native auth namespaces. */
export function preparedSyntheticAuthProviderScope(
  providerIds: readonly string[],
): ReadonlySet<string> {
  const scoped = new Set(providerIds.map((id) => normalizeProviderId(id)));
  // OpenAI's native runtime has a separate auth namespace, never a bearer alias.
  if (scoped.has("openai")) {
    scoped.add("codex");
  }
  return scoped;
}

// Scoped discovery must not fan ambient auth probes out to every registered provider.
export function scopeSyntheticAuthProviderRefs(
  refs: readonly string[],
  providerDiscoveryProviderIds: readonly string[] | undefined,
): string[] {
  const scope =
    providerDiscoveryProviderIds &&
    preparedSyntheticAuthProviderScope(providerDiscoveryProviderIds);
  return refs.filter((ref) => !scope || scope.has(normalizeProviderId(ref)));
}

export function listPreparedSyntheticAuthProviderRefs(
  providers: readonly ProviderPlugin[],
): string[] {
  return [
    ...new Set(
      providers.flatMap((provider) =>
        provider.resolveSyntheticAuth || provider.prepareSyntheticAuth
          ? [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])]
          : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export async function prepareSyntheticAuth(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  workspaceDir?: string;
  provider: string;
  providers: readonly ProviderPlugin[];
}): Promise<ProviderSyntheticAuthResult | undefined> {
  const normalizedProvider = normalizeProviderId(params.provider);
  const providerPlugin = params.providers.find((candidate) =>
    [candidate.id, ...(candidate.aliases ?? []), ...(candidate.hookAliases ?? [])].some(
      (ref) => normalizeProviderId(ref) === normalizedProvider,
    ),
  );
  const context = {
    config: params.config,
    provider: params.provider,
    providerConfig: Object.entries(params.config.models?.providers ?? {}).find(
      ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
    )?.[1],
  };
  return providerPlugin
    ? await prepareSyntheticAuthWithProvider(providerPlugin, context, params)
    : undefined;
}
