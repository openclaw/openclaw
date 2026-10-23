import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "../plugins/provider-catalog.types.js";
import {
  normalizePluginDiscoveryResult,
  type runProviderCatalog,
} from "../plugins/provider-discovery.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../shared/current-read-authority.js";
import { resolveRegisteredAgentIdForDir } from "./agent-dir-registry.js";
import { buildOAuthRefreshFailureLoginCommand } from "./auth-profiles/oauth-refresh-failure.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ProviderConfig } from "./models-config.providers.secret-helpers.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

const log = createSubsystemLogger("agents/model-providers");

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
  return {
    ...ctx.config,
    models: {
      ...ctx.config?.models,
      providers,
    },
  };
}

export async function prepareProviderCatalogRun(
  params: Parameters<typeof runProviderCatalog>[0] & {
    agentDir: string;
    authStore: AuthProfileStore;
    isActive: () => boolean;
    timeoutMs?: number | null;
    preparationAuthority?: CurrentReadAuthority;
  },
): Promise<
  Parameters<typeof runProviderCatalog>[0] & {
    timeoutMs?: number | null;
    finalizeCatalogResult?: (result: ProviderCatalogResult) => ProviderCatalogResult;
  }
> {
  const { authStore, isActive, preparationAuthority, ...catalogParams } = params;
  if (
    !params.provider.auth.some(
      (method) => method.kind === "oauth" || method.kind === "device_code",
    ) ||
    (params.providerIds !== undefined &&
      !params.providerIds.some((providerId) =>
        matchesProviderPluginRef(params.provider, providerId),
      ))
  ) {
    return catalogParams;
  }
  const agentId = resolveRegisteredAgentIdForDir(params.agentDir, params.env);
  // Preparation stays internal and provider-generic. The helper exits before
  // materialization unless this catalog's selected credential is expiring OAuth.
  const { prepareProviderCatalogOAuthAuth } =
    await import("./models-config.providers.discovery-auth.runtime.js");
  const failedProfileIds = new Set<string>();
  const reportedOutcomes: ProviderCatalogOutcome[] = [];
  const { resolveProviderAuth, failures } = await withCurrentReadAuthority(
    preparationAuthority,
    () =>
      prepareProviderCatalogOAuthAuth(
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
  );
  await withCurrentReadAuthority(preparationAuthority, () => {});
  return {
    ...catalogParams,
    reportCatalogOutcome: (outcome) => {
      reportedOutcomes.push({ ...outcome });
      params.reportCatalogOutcome?.(outcome);
    },
    resolveProviderAuth,
    finalizeCatalogResult: (result) => {
      if (failedProfileIds.size === 0 && failures.length === 0) {
        return result;
      }
      const providers = normalizePluginDiscoveryResult({ provider: params.provider, result });
      const origins = [
        ...new Set(
          Object.values(providers).flatMap(({ baseUrl }) => {
            const origin = URL.parse(baseUrl)?.origin;
            return origin ? [origin] : [];
          }),
        ),
      ];
      const destination = origins.length
        ? `the live catalog returned ${origins.join(", ")}`
        : "no live provider catalog was returned";
      for (const failure of failures) {
        const login = buildOAuthRefreshFailureLoginCommand(params.provider.id, {
          profileId: failure.profileId,
          agentId,
        });
        log.warn(
          `${params.provider.id}: OAuth profile ${JSON.stringify(failure.profileId)} could not be resolved (${failure.message}); ${destination}. Re-authenticate with ${login}.`,
        );
      }
      if (failedProfileIds.size > 0) {
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
      }
      // Carry the accepted snapshot forward without evaluating plugin getters again.
      return result ? { providers, outcomes: reportedOutcomes } : result;
    },
  };
}

export async function reportProviderCatalogSecretFailure(
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

/** An authorized selected profile reuses normal bounded provider discovery without failover. */
export async function loadSelectedProviderAccountCatalog(params: {
  provider: ProviderPlugin;
  providerId: string;
  profileId: string;
  authStore: AuthProfileStore;
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  isCurrent: () => boolean;
  assertCurrent: () => void;
  withCurrent?: CurrentReadAuthority["withCurrent"];
  beforeRequest?: () => void;
}): Promise<readonly ProviderCatalogOutcome[]> {
  const { providerId, profileId, authStore } = params;
  const assertCurrent = () => {
    params.assertCurrent();
    if (!params.isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError("Selected account catalog changed");
    }
  };
  const authority = { assertCurrent, withCurrent: params.withCurrent };
  const credential = authStore.profiles[profileId];
  if (!credential) {
    return [];
  }
  const [{ runProviderCatalogWithTimeout }, { createProviderAuthResolver }] = await Promise.all([
    import("./models-config.providers.implicit.js"),
    import("./models-config.providers.secrets.js"),
  ]);
  await withCurrentReadAuthority(authority, () => {});
  const selectedStore = { ...authStore, profiles: { [profileId]: credential } };
  const selectedConfig = {
    ...params.config,
    auth: {
      ...params.config.auth,
      order: { ...params.config.auth?.order, [providerId]: [profileId] },
    },
  };
  const preparedAuth = await withCurrentReadAuthority(authority, () =>
    createProviderAuthResolver(process.env, selectedStore, selectedConfig)(providerId),
  );
  const authProvider = resolveProviderIdForAuth(providerId, { config: selectedConfig });
  // Provider callbacks stay synchronous and consume only the already-authorized auth facts.
  const lockedAuth: ReturnType<typeof createProviderAuthResolver> = (requested, options) => {
    assertCurrent();
    if (
      preparedAuth.profileId !== profileId ||
      options?.excludeProfileIds?.includes(profileId) ||
      resolveProviderIdForAuth(requested, { config: selectedConfig }) !== authProvider
    ) {
      return { apiKey: undefined, mode: "none", source: "none", preparationFailed: true };
    }
    return {
      ...preparedAuth,
      ...(preparedAuth.mode === "oauth" ? { apiKey: options?.oauthMarker } : {}),
    };
  };
  const acquired: ProviderCatalogOutcome[] = [];
  // Reuse the HTTP owner's closure-bound fence: auth refresh, lazy imports,
  // DNS/proxy preparation, and every redirect retain this exact selected scope.
  // Closing the bounded run also denies late/detached guarded requests.
  const hook = params.provider.catalog;
  const catalogRequest = {
    provider: {
      ...params.provider,
      ...(hook
        ? {
            catalog: {
              ...hook,
              run: async (context: Parameters<typeof hook.run>[0]) => {
                const result = await withCurrentReadAuthority(authority, () => hook.run(context));
                return withCurrentReadAuthority(authority, () => result);
              },
            },
          }
        : {}),
    },
    preparationAuthority: authority,
    providerIds: [providerId],
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    authStore: selectedStore,
    timeoutMs: 5_000,
    resolveProviderAuth: (
      requested: string | undefined,
      options: Parameters<typeof lockedAuth>[1],
    ) => lockedAuth(requested ?? providerId, options),
    resolveProviderApiKey: (requested?: string) => {
      const { mode, ...auth } = lockedAuth(requested ?? providerId);
      return {
        ...auth,
        ...(mode === "api_key" || mode === "oauth" || mode === "token" ? { mode } : {}),
      };
    },
    isActive: params.isCurrent,
    reportCatalogOutcome: (outcome: ProviderCatalogOutcome) => {
      assertCurrent();
      if (normalizeProviderId(outcome.provider) === providerId && outcome.profileId === profileId) {
        acquired.push(outcome);
      }
    },
  } satisfies Parameters<typeof runProviderCatalogWithTimeout>[0] & {
    preparationAuthority: CurrentReadAuthority;
  };
  await withCurrentReadAuthority(authority, () =>
    withGuardedFetchRequestAuthority(
      assertCurrent,
      async () => runProviderCatalogWithTimeout(catalogRequest),
      params.beforeRequest,
    ),
  );
  return withCurrentReadAuthority(authority, () => acquired);
}
