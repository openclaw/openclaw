import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  copyConfigResolutionFacts,
  getConfigProviderUseBindings,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type {
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "../plugins/provider-catalog.types.js";
import {
  normalizePluginDiscoveryResult,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveProviderBindingEnvVarCandidates } from "../secrets/provider-env-vars.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { resolveRegisteredAgentIdForDir } from "./agent-dir-registry.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveStartupProviderUseBindingConflict } from "./model-auth-runtime-config.js";
import { resolveSelectedModelProviderIds } from "./model-selection-config.js";
import type {
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
} from "./models-config.providers.secret-helpers.js";
import { resolveProviderAuthAliasMap, resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import {
  resolveProviderUseAdmission,
  type ProviderUseBinding,
} from "./provider-model-auth-source-plan.js";

const log = createSubsystemLogger("agents/model-providers");

type ProviderCatalogAuthScope = Pick<
  Parameters<typeof runProviderCatalog>[0],
  "providerIds" | "resolveProviderApiKey" | "resolveProviderAuth" | "reportCatalogOutcome"
>;

/** A destination's donor permission never depends on another destination's admission. */
export async function runProviderCatalogForAdmittedDestinations(
  params: Omit<ProviderCatalogAuthScope, "resolveProviderApiKey" | "resolveProviderAuth"> & {
    resolveProviderApiKey: ProviderApiKeyResolver;
    resolveProviderAuth: ProviderAuthResolver;
    provider: ProviderPlugin;
    providerIds: readonly string[];
    admission: ReadonlyMap<string, ProviderUseBinding>;
    config: OpenClawConfig;
    authStore: AuthProfileStore;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    run: (scope: ProviderCatalogAuthScope) => Promise<ProviderCatalogResult>;
  },
): Promise<ProviderCatalogResult> {
  const configured: string[] = [];
  const provisional: string[] = [];
  const bound: string[] = [];
  const startupBindings = getConfigProviderUseBindings(params.config);
  const providerIds = [...new Set(params.providerIds.map(normalizeProviderId))];
  for (const id of providerIds) {
    (params.admission.get(id)?.kind === "provider-config"
      ? Object.hasOwn(startupBindings, id)
        ? provisional
        : configured
      : bound
    ).push(id);
  }
  const scopes = [
    ...(configured.length ? [{ ids: configured, allowDonor: true }] : []),
    ...provisional.map((id) => ({ ids: [id], allowDonor: true })),
    ...bound.map((id) => ({ ids: [id], allowDonor: false })),
  ].toSorted(
    (left, right) =>
      providerIds.findIndex((id) => left.ids.includes(id)) -
      providerIds.findIndex((id) => right.ids.includes(id)),
  );
  const providers: Record<string, ProviderConfig> = {};
  const outcomes: ProviderCatalogOutcome[] = [];
  let hasResult = false;
  for (const scope of scopes) {
    const includes = (provider: string) => scope.ids.includes(normalizeProviderId(provider));
    const canResolve = (provider: string) => scope.allowDonor || includes(provider);
    let conflict: ReturnType<typeof resolveStartupProviderUseBindingConflict>;
    const assertCurrentScope = () => {
      for (const provider of scope.ids) {
        conflict = resolveStartupProviderUseBindingConflict({
          ...params,
          provider,
          cfg: params.config,
          store: params.authStore,
        });
        if (conflict) {
          throw conflict;
        }
      }
    };
    let result: ProviderCatalogResult;
    try {
      assertCurrentScope();
      result = await params.run({
        providerIds: scope.ids,
        resolveProviderApiKey: (providerId) => {
          assertCurrentScope();
          const provider = providerId?.trim() || params.provider.id;
          return canResolve(provider)
            ? params.resolveProviderApiKey(provider)
            : { apiKey: undefined, discoveryApiKey: undefined };
        },
        resolveProviderAuth: (providerId, options) => {
          assertCurrentScope();
          const provider = providerId?.trim() || params.provider.id;
          return canResolve(provider)
            ? params.resolveProviderAuth(provider, options)
            : { apiKey: undefined, mode: "none", source: "none" };
        },
        reportCatalogOutcome: (outcome) => {
          assertCurrentScope();
          if (includes(outcome.provider)) {
            params.reportCatalogOutcome?.(outcome);
          }
        },
      });
      if (result) {
        assertCurrentScope();
      }
    } catch (error) {
      if (!conflict || error !== conflict) {
        throw error;
      }
      for (const provider of scope.ids) {
        params.reportCatalogOutcome?.({ provider, status: "unavailable" });
      }
      continue;
    }
    if (!result) {
      continue;
    }
    hasResult = true;
    for (const [id, config] of Object.entries(
      normalizePluginDiscoveryResult({
        provider: params.provider,
        result,
      }),
    )) {
      if (includes(id)) {
        providers[id] = config;
      }
    }
    outcomes.push(...(result.outcomes ?? []).filter((outcome) => includes(outcome.provider)));
  }
  return hasResult ? { providers, ...(outcomes.length ? { outcomes } : {}) } : undefined;
}

/** Translate one catalog generation's source config and metadata into admission facts. */
export function resolveCatalogProviderUseAdmission(params: {
  config?: OpenClawConfig;
  sourceConfigForSecrets?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  workspaceDir?: string;
  profiles?: AuthProfileStore["profiles"];
  requestedProviderIds?: readonly string[];
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry" | "owners">;
}) {
  const authAliasLookupParams = {
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.pluginMetadataSnapshot
      ? {
          plugins: params.pluginMetadataSnapshot.manifestRegistry.plugins,
          owners: params.pluginMetadataSnapshot.owners,
        }
      : undefined,
  };
  return resolveProviderUseAdmission({
    config: params.sourceConfigForSecrets ?? params.config,
    env: params.env,
    profiles: params.profiles,
    requestedProviders: [
      ...resolveSelectedModelProviderIds({
        cfg: params.sourceConfigForSecrets ?? params.config ?? {},
        agentId: resolveRegisteredAgentIdForDir(params.agentDir, params.env),
      }),
      ...(params.requestedProviderIds ?? []),
    ],
    storedCredentialAuthAliases: resolveProviderAuthAliasMap({
      ...authAliasLookupParams,
      storedCredential: true,
    }),
    providerEnvVars: resolveProviderBindingEnvVarCandidates({
      config: params.config,
      env: params.env,
      workspaceDir: params.workspaceDir,
      manifestPlugins: params.pluginMetadataSnapshot?.manifestRegistry.plugins,
    }),
  });
}

type CatalogContext = {
  config?: OpenClawConfig;
  discoveryAuthConfig?: OpenClawConfig;
  explicitProviders?: Record<string, ProviderConfig> | null;
};

export function buildPluginCatalogConfig(
  ctx: CatalogContext,
  provider: ProviderPlugin,
): OpenClawConfig {
  const providers = { ...ctx.config?.models?.providers, ...ctx.explicitProviders };
  if (Object.keys(providers).length === 0) {
    return ctx.config ?? {};
  }
  for (const [providerId, source] of Object.entries(providers)) {
    const runtime = findNormalizedProviderValue(
      ctx.discoveryAuthConfig?.models?.providers,
      providerId,
    );
    if (runtime && matchesProviderPluginRef(provider, providerId)) {
      // Keep source auth selection and other providers private; only this hook's
      // request surfaces consume the matching materialized runtime values.
      providers[providerId] = { ...source, headers: runtime.headers, request: runtime.request };
    }
  }
  const config = {
    ...ctx.config,
    models: {
      ...ctx.config?.models,
      providers,
    },
  };
  copyConfigResolutionFacts(ctx.config, config);
  return config;
}

async function prepareProviderCatalogRun(
  params: Parameters<typeof runProviderCatalog>[0] & {
    agentDir: string;
    authStore: AuthProfileStore;
    isActive: () => boolean;
    timeoutMs?: number | null;
  },
): Promise<
  Parameters<typeof runProviderCatalog>[0] & {
    timeoutMs?: number | null;
    finalizeCatalogResult?: (result: ProviderCatalogResult) => ProviderCatalogResult;
  }
> {
  const { authStore, isActive, ...catalogParams } = params;
  if (
    !params.provider.auth.some((method) => method.kind === "oauth") ||
    (params.providerIds !== undefined &&
      !params.providerIds.some((providerId) =>
        matchesProviderPluginRef(params.provider, providerId),
      ))
  ) {
    return catalogParams;
  }
  // Preparation stays internal and provider-generic. The helper exits before
  // materialization unless this catalog's selected credential is expiring OAuth.
  const { prepareProviderCatalogOAuthAuth } =
    await import("./models-config.providers.discovery-auth.runtime.js");
  const failedProfileIds = new Set<string>();
  const reportedOutcomes: ProviderCatalogOutcome[] = [];
  return {
    ...catalogParams,
    reportCatalogOutcome: (outcome) => {
      reportedOutcomes.push({ ...outcome });
      params.reportCatalogOutcome?.(outcome);
    },
    resolveProviderAuth: await prepareProviderCatalogOAuthAuth(
      {
        agentDir: params.agentDir,
        authStore,
        env: params.env,
        provider: params.provider.id,
        resolveProviderAuth: params.resolveProviderAuth,
        isActive,
        onPreparationFailure: (profileIds) => {
          for (const profileId of profileIds) {
            failedProfileIds.add(profileId);
          }
        },
      },
      params.config,
    ),
    finalizeCatalogResult: (result) => {
      if (failedProfileIds.size === 0) {
        return result;
      }
      const providers = normalizePluginDiscoveryResult({ provider: params.provider, result });
      const providersWithOutcomes = new Set(
        reportedOutcomes.map((outcome) => normalizeProviderId(outcome.provider)),
      );
      const aliasContext = { config: params.config, env: params.env };
      const authProvider = resolveProviderIdForAuth(params.provider.id, aliasContext);
      for (const provider of params.providerIds ?? [params.provider.id]) {
        const normalized = normalizeProviderId(provider);
        if (
          resolveProviderIdForAuth(provider, aliasContext) !== authProvider ||
          providers[normalized] ||
          providersWithOutcomes.has(normalized)
        ) {
          continue;
        }
        // A plugin's selected result wins; only otherwise-unreported exhaustion
        // carries every attempted profile into compatible inventory retention.
        for (const profileId of failedProfileIds) {
          const outcome: ProviderCatalogOutcome = { provider, profileId, status: "unavailable" };
          reportedOutcomes.push(outcome);
          params.reportCatalogOutcome?.(outcome);
        }
      }
      // Carry the accepted snapshot forward without evaluating plugin getters again.
      return result ? { providers, outcomes: reportedOutcomes } : result;
    },
  };
}

async function reportProviderCatalogSecretFailure(
  error: unknown,
  params: {
    provider: { id: string };
    providerIds?: readonly string[];
    reportCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
  },
): Promise<boolean> {
  if (!isTrustedSecretSurfaceUnavailableError(error)) {
    return false;
  }
  const { resolveUnavailableDiscoveryAuthProfileId } =
    await import("./models-config.providers.discovery-auth.runtime.js");
  const profileId = resolveUnavailableDiscoveryAuthProfileId(error);
  for (const provider of params.providerIds ?? [params.provider.id]) {
    params.reportCatalogOutcome?.({
      provider,
      ...(profileId ? { profileId } : {}),
      status: "unavailable",
    });
  }
  return true;
}

export async function runProviderCatalogWithTimeout(
  params: Omit<
    Parameters<typeof runProviderCatalog>[0],
    "providerIds" | "resolveProviderApiKey" | "resolveProviderAuth"
  > &
    Pick<
      Parameters<typeof runProviderCatalogForAdmittedDestinations>[0],
      "providerIds" | "resolveProviderApiKey" | "resolveProviderAuth" | "admission"
    > & {
      agentDir: string;
      authStore: AuthProfileStore;
      timeoutMs: number | null;
    },
): Promise<Awaited<ReturnType<typeof runProviderCatalog>> | undefined> {
  const timeoutMs = params.timeoutMs ?? undefined;
  const timeoutError = new Error(
    `provider catalog timed out after ${timeoutMs}ms: ${params.provider.id}`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const catalogParams = {
    ...params,
    isActive: () => active,
    reportCatalogOutcome: (outcome: ProviderCatalogOutcome) => {
      if (active) {
        params.reportCatalogOutcome?.(outcome);
      }
    },
  };
  const runCatalog = () =>
    runProviderCatalogForAdmittedDestinations({
      ...catalogParams,
      run: async (scope) => {
        if (!active) {
          return undefined;
        }
        try {
          const prepared = await prepareProviderCatalogRun({ ...catalogParams, ...scope });
          if (!active) {
            return undefined;
          }
          const result = await runProviderCatalog({
            ...prepared,
            isActive: catalogParams.isActive,
          });
          if (!active) {
            return undefined;
          }
          return prepared.finalizeCatalogResult ? prepared.finalizeCatalogResult(result) : result;
        } catch (error) {
          if (await reportProviderCatalogSecretFailure(error, { ...catalogParams, ...scope })) {
            return undefined;
          }
          throw error;
        }
      },
    });
  try {
    if (!timeoutMs) {
      return await runCatalog();
    }
    const catalogRun = runCatalog();
    // Live discovery should not hang startup; a timeout skips this provider while
    // preserving the rest of the prepared catalog.
    return await Promise.race([
      catalogRun,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          active = false;
          reject(timeoutError);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error !== timeoutError) {
      throw error;
    }
    for (const provider of params.providerIds ?? [params.provider.id]) {
      params.reportCatalogOutcome?.({ provider, status: "unavailable" });
    }
    if (error === timeoutError) {
      const message = formatErrorMessage(error);
      log.warn(`${message}; skipping provider discovery`);
    }
    return undefined;
  } finally {
    // A timed-out hook can still finish; its late reports no longer own this publication.
    active = false;
    if (timer) {
      clearTimeout(timer);
    }
  }
}
