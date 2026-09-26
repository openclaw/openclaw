/**
 * Ordered credential resolution for one provider request.
 */
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildProviderMissingAuthMessageWithPlugin,
  resolveProviderDeprecatedAuthProfileIds,
  shouldDeferProviderSyntheticProfileAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveOwningPluginIdsForProviderRef } from "../plugins/providers.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { resolveUserPath } from "../utils.js";
import { resolveDefaultAgentDir } from "./agent-scope-config.js";
import {
  type AuthProfileStore,
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles.js";
import { assertAuthProfileMigrationReady } from "./auth-profiles/legacy-source-diagnostic.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "./auth-profiles/order.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { assertAuthModeAllowedForModel, isAuthModeAllowedForModel } from "./model-auth-policy.js";
import * as authConfig from "./model-auth-provider-config.js";
import { resolveModelProviderAuthConfig } from "./model-auth-provider-route.js";
import {
  assertRuntimeProviderSecretOwnerAvailable,
  resolveManagedSecretRefRuntimeProviderAuth,
} from "./model-auth-runtime-config.js";
import {
  ProviderAuthError,
  resolveDirectProviderCredentialMode,
  type ResolvedProviderAuth,
} from "./model-auth-runtime-shared.js";
import { prepareSyntheticLocalProviderAuth } from "./model-auth-runtime.js";

export type ProviderCredentialPrecedence = "profile-first" | "env-first";

const log = createSubsystemLogger("model-auth");

function assertAuthProfileNotRetired(params: {
  profileId: string;
  deprecatedProfileIds: ReadonlySet<string>;
}): void {
  if (!params.deprecatedProfileIds.has(params.profileId)) {
    return;
  }
  throw new Error(
    `Auth profile "${params.profileId}" is retired. Run ${formatCliCommand("openclaw doctor --fix")}.`,
  );
}

function shouldDeferSyntheticProfileAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  resolvedApiKey: string | undefined;
  modelApi?: string;
}): boolean {
  const providerConfig = authConfig.resolveProviderConfig(params.cfg, params.provider);
  return (
    shouldDeferProviderSyntheticProfileAuthWithPlugin({
      provider: params.provider,
      config: params.cfg,
      modelApi: params.modelApi,
      context: {
        config: params.cfg,
        provider: params.provider,
        providerConfig,
        resolvedApiKey: params.resolvedApiKey,
      },
    }) === true
  );
}

export function resolveScopedAuthProfileStore(params: {
  agentDir?: string;
  cfg?: OpenClawConfig;
  provider: string;
  profileId?: string;
  preferredProfile?: string;
}): AuthProfileStore {
  return ensureAuthProfileStore(params.agentDir, {
    migrationProvider: params.provider,
    config: params.cfg,
    profileId: params.profileId,
    externalCli: externalCliDiscoveryForProviderAuth(params),
  });
}

function assertProviderAuthReady(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): void {
  // Pending credential files own their providers' auth routes until Doctor commits
  // and archives them; do not fall through to env/config credentials.
  assertAuthProfileMigrationReady(params.agentDir, undefined, params.provider, params.cfg);
  // A failed explicit ref owns the provider. Stop before profile/env discovery so requests cannot
  // silently switch credentials while this configured owner is cold.
  assertRuntimeProviderSecretOwnerAvailable({ cfg: params.cfg, provider: params.provider });
}

/** Resolves a stored provider-entry binding without general credential discovery. */
export async function resolveProviderEntryApiKeyAuth(params: {
  provider: string;
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  agentDir?: string;
  modelApi?: string;
  modelBaseUrl?: string;
  secretSentinels?: boolean;
  signal?: AbortSignal;
}): Promise<ResolvedProviderAuth | undefined> {
  params.signal?.throwIfAborted();
  const { provider, cfg } = params;
  assertProviderAuthReady(params);
  const reference = authConfig.resolveProviderEntryApiKeyProfileReference(params);
  if (!("profileId" in reference)) {
    return undefined;
  }
  assertAuthProfileNotRetired({
    profileId: reference.profileId,
    deprecatedProfileIds: new Set(
      resolveProviderDeprecatedAuthProfileIds({ provider, config: cfg }),
    ),
  });
  // A matched binding is terminal: never replace a bad profile with a different
  // credential or send the profile id as literal bearer text.
  const binding = await authConfig.resolveProviderEntryApiKeyBinding(params);
  params.signal?.throwIfAborted();
  if (binding.kind === "profile-resolved") {
    assertAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      modelBaseUrl: params.modelBaseUrl,
      profileId: binding.auth.profileId ?? provider,
      mode: binding.auth.mode,
      authFlow: binding.auth.authFlow,
    });
    return binding.auth;
  }
  if (binding.kind === "profile-incompatible") {
    const reason =
      binding.reason === "credential-class"
        ? "which is not a bearer-style auth class"
        : "which is not compatible with this provider entry's auth binding";
    const action =
      binding.reason === "credential-class"
        ? "Use an api-key or token profile, or set apiKey to a literal bearer token."
        : "Use a compatible provider auth alias, configure the referenced provider entry with the same baseUrl, or set apiKey to a literal bearer token.";
    throw new Error(
      `Per-entry apiKey "${binding.profileId}" for provider "${provider}" references a "${binding.credentialType}" credential for provider "${binding.credentialProvider}", ${reason}. ${action}`,
    );
  }
  if (binding.kind === "profile-unresolved") {
    const cause = binding.error
      ? formatErrorMessage(binding.error)
      : "credential resolution returned no key";
    throw new Error(
      `Per-entry apiKey "${binding.profileId}" for provider "${provider}" matched a stored profile but failed to resolve: ${cause}. Fix the referenced profile or set apiKey to a literal bearer token.`,
    );
  }
  return undefined;
}

/** Resolves the credential that should be used for one provider request. */
export async function resolveApiKeyForProviderCore(input: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  /** Cancels this credential lookup, not an independently owned OAuth refresh. */
  signal?: AbortSignal;
  /** When true, treat profileId as a user-locked selection that must not be
   *  silently replaced by another profile or env/config credentials. */
  lockedProfile?: boolean;
  forceRefresh?: boolean;
  credentialPrecedence?: ProviderCredentialPrecedence;
  /** Skip implicit profile discovery for a prepared env/config fallback attempt. */
  allowAuthProfileFallback?: boolean;
  /** Skip plugin setup fallback when the prepared route already excludes it. */
  skipSetupProviderFallback?: boolean;
  modelId?: string;
  modelApi?: string;
  modelBaseUrl?: string;
  /** Keep SecretRef-backed model credentials opaque until a sentinel-aware transport boundary. */
  secretSentinels?: boolean;
}): Promise<ResolvedProviderAuth> {
  input.signal?.throwIfAborted();
  const modelAuthConfig = resolveModelProviderAuthConfig({
    provider: input.provider,
    config: input.cfg,
    workspaceDir: input.workspaceDir,
    modelBaseUrl: input.modelBaseUrl,
  });
  const changedAuthProvider = modelAuthConfig !== input.cfg;
  const params = { ...input, cfg: modelAuthConfig };
  const { provider, cfg, profileId, preferredProfile } = params;
  let deprecatedProfileIds: ReadonlySet<string> | undefined;
  const getDeprecatedProfileIds = () =>
    (deprecatedProfileIds ??= new Set(
      resolveProviderDeprecatedAuthProfileIds({ provider, config: cfg }),
    ));
  const agentDir = params.agentDir?.trim() || (cfg ? resolveDefaultAgentDir(cfg) : undefined);
  assertProviderAuthReady({ cfg, provider, agentDir });
  let scopedStore: AuthProfileStore | undefined = params.store;
  const getScopedStore = (requestedProfileId?: string) =>
    (scopedStore ??= resolveScopedAuthProfileStore({
      agentDir,
      cfg,
      provider,
      profileId: requestedProfileId,
      preferredProfile,
    }));

  if (profileId) {
    const awsSdkProfileAuth = authConfig.resolveConfiguredAwsSdkProfileAuth({
      cfg,
      provider,
      profileId,
    });
    if (awsSdkProfileAuth) {
      return awsSdkProfileAuth;
    }
    const store = getScopedStore(profileId);
    assertAuthProfileNotRetired({
      profileId,
      deprecatedProfileIds: getDeprecatedProfileIds(),
    });
    const configuredCredential = store.profiles[profileId];
    const configuredProfileType = configuredCredential?.type;
    if (configuredProfileType) {
      assertAuthModeAllowedForModel({
        provider,
        modelApi: params.modelApi,
        modelBaseUrl: params.modelBaseUrl,
        profileId,
        mode: authConfig.profileTypeToAuthMode(configuredProfileType),
        authFlow:
          configuredCredential?.type === "oauth" ? configuredCredential.authFlow : undefined,
      });
    }
    const resolved = await resolveApiKeyForProfile({
      cfg,
      store,
      profileId,
      agentDir,
      signal: params.signal,
      forceRefresh: params.forceRefresh,
      allowProfileFallback: !params.lockedProfile,
    });
    params.signal?.throwIfAborted();
    if (!resolved) {
      throw new Error(`No credentials found for profile "${profileId}".`);
    }
    const resolvedProfileId = resolved.profileId ?? profileId;
    if (params.lockedProfile && resolvedProfileId !== profileId) {
      throw new Error("Locked auth profile resolution returned a different profile.");
    }
    const credential = resolved.credential ?? store.profiles[resolvedProfileId];
    if (
      changedAuthProvider &&
      (!credential || !isStoredCredentialCompatibleWithAuthProvider({ cfg, provider, credential }))
    ) {
      throw new Error(
        `Auth profile "${resolvedProfileId}" is not compatible with the resolved model endpoint for "${provider}".`,
      );
    }
    const mode = resolved.profileType ?? credential?.type;
    const result = authConfig.projectResolvedProfileAuth({
      apiKey: resolved.apiKey,
      enabled: params.secretSentinels,
      profileId: resolvedProfileId,
      provider,
      store,
      mode: mode ? authConfig.profileTypeToAuthMode(mode) : "api-key",
      authFlow: credential?.type === "oauth" ? credential.authFlow : undefined,
    });
    assertAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      modelBaseUrl: params.modelBaseUrl,
      profileId: resolvedProfileId,
      mode: result.mode,
      authFlow: result.authFlow,
    });
    // When the resolved key is a provider-owned synthetic profile marker and
    // the caller has not locked this profile, fall through to env/config
    // resolution so provider-owned real credentials take precedence. The auth
    // controller iterates profile candidates and passes each as an explicit
    // profileId, so we cannot assume explicit === user-locked.
    if (
      !params.lockedProfile &&
      shouldDeferSyntheticProfileAuth({
        cfg,
        provider,
        resolvedApiKey: resolved.apiKey,
        modelApi: params.modelApi,
      })
    ) {
      return resolveApiKeyForProviderCore({
        ...params,
        store,
        profileId: undefined,
        lockedProfile: true,
      }) //
        .catch(() => {
          params.signal?.throwIfAborted();
          return result;
        });
    }
    return result;
  }

  if (params.allowAuthProfileFallback !== false && (cfg?.auth?.profiles || cfg?.auth?.order)) {
    const store = getScopedStore();
    const configuredProfileOrder = resolveAuthProfileOrder({
      cfg,
      store,
      provider,
      preferredProfile,
      forModel: params.modelId,
    });
    for (const candidate of configuredProfileOrder) {
      const awsSdkProfileAuth = authConfig.resolveConfiguredAwsSdkProfileAuth({
        cfg,
        provider,
        profileId: candidate,
      });
      if (awsSdkProfileAuth) {
        return awsSdkProfileAuth;
      }
    }
  }

  const authOverride = authConfig.resolveProviderAuthOverride(cfg, provider);
  if (authOverride === "aws-sdk") {
    return authConfig.resolveAwsSdkAuthInfo();
  }
  if (authConfig.shouldUseImplicitAwsSdkAuth({ cfg, provider, modelApi: params.modelApi })) {
    return authConfig.resolveAwsSdkAuthInfo();
  }

  const modeAllowed = (mode: ResolvedProviderAuth["mode"], authFlow?: string) =>
    isAuthModeAllowedForModel({
      provider,
      modelApi: params.modelApi,
      modelBaseUrl: params.modelBaseUrl,
      mode,
      authFlow,
    });
  const assertInlineSourceUsable = (source: string) => {
    const store = getScopedStore();
    if (authConfig.isConfigBackedInlineProviderApiKey({ cfg, provider, source, store })) {
      authConfig.assertInlineProviderApiKeyUsable({ store, provider });
    }
  };
  // An incompatible env credential restarts profile-first selection; absence continues in place.
  const resolveEnvAuth = (): ResolvedProviderAuth | null | "incompatible" => {
    const resolved = authConfig.resolveConfigAwareEnvApiKey(
      cfg,
      provider,
      params.workspaceDir,
      params.skipSetupProviderFallback,
    );
    if (!resolved) {
      return null;
    }
    const mode = resolveDirectProviderCredentialMode({
      cfg,
      provider,
      inferredMode: resolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
    });
    if (mode === "api-key") {
      assertInlineSourceUsable(resolved.source);
    }
    if (!modeAllowed(mode)) {
      return "incompatible";
    }
    return {
      apiKey: authConfig.sentinelizeConfigSecretRefEnvApiKey({
        apiKey: resolved.apiKey,
        source: resolved.source,
        cfg,
        provider,
        enabled: params.secretSentinels,
      }),
      source: resolved.source,
      mode,
    };
  };
  if (params.credentialPrecedence === "env-first") {
    const auth = resolveEnvAuth();
    if (auth === "incompatible") {
      return resolveApiKeyForProviderCore({ ...params, credentialPrecedence: "profile-first" });
    }
    if (auth) {
      return auth;
    }
  }

  // General model auth keeps its AWS/env precedence ahead of per-entry bindings.
  const providerEntryAuth = await resolveProviderEntryApiKeyAuth({
    cfg,
    provider,
    store: getScopedStore(),
    agentDir,
    signal: params.signal,
    modelApi: params.modelApi,
    modelBaseUrl: params.modelBaseUrl,
    secretSentinels: params.secretSentinels,
  });
  params.signal?.throwIfAborted();
  if (providerEntryAuth) {
    return providerEntryAuth;
  }

  if (authConfig.shouldPreferExplicitConfigApiKeyAuth(cfg, provider)) {
    const runtimeCustomKey = resolveManagedSecretRefRuntimeProviderAuth({
      cfg,
      provider,
      secretSentinels: params.secretSentinels,
    });
    if (runtimeCustomKey) {
      // Managed (file/exec) SecretRef provider keys are config-backed inline
      // credentials too, so they must honor the inline-key cooldown gate just
      // like the literal/env paths below — otherwise a 402 cooldown is recorded
      // but never enforced for these keys.
      authConfig.assertInlineProviderApiKeyUsable({ store: getScopedStore(), provider });
      return runtimeCustomKey;
    }
    const customKey = authConfig.resolveUsableCustomProviderApiKey({
      cfg,
      provider,
      secretSentinels: params.secretSentinels,
    });
    if (customKey) {
      authConfig.assertInlineProviderApiKeyUsable({ store: getScopedStore(), provider });
      return {
        apiKey: customKey.apiKey,
        source: customKey.source,
        mode: "api-key",
      };
    }
  }
  const providerConfig = authConfig.resolveProviderConfig(cfg, provider);
  const configuredLocalKey = authConfig.resolveUsableCustomProviderApiKey({
    cfg,
    provider,
    secretSentinels: params.secretSentinels,
  });
  if (configuredLocalKey && isNonSecretApiKeyMarker(configuredLocalKey.apiKey)) {
    return {
      apiKey: configuredLocalKey.apiKey,
      source: configuredLocalKey.source,
      mode: "api-key",
    };
  }
  const localMarkerEnv = authConfig.resolveConfigAwareEnvApiKey(
    cfg,
    provider,
    params.workspaceDir,
    params.skipSetupProviderFallback,
  );
  if (localMarkerEnv && isNonSecretApiKeyMarker(localMarkerEnv.apiKey)) {
    return {
      apiKey: localMarkerEnv.apiKey,
      source: localMarkerEnv.source,
      mode: "api-key",
    };
  }
  const store = getScopedStore();
  const order =
    params.allowAuthProfileFallback === false
      ? []
      : resolveAuthProfileOrder({
          cfg,
          store,
          provider,
          preferredProfile,
          forModel: params.modelId,
          includePendingOAuthRefresh: true,
        });
  let deferredAuthProfileResult: ResolvedProviderAuth | null = null;
  let refreshFailure: OAuthRefreshFailureError | undefined;
  for (const candidate of order) {
    const candidateCredential = store.profiles[candidate];
    const candidateType = candidateCredential?.type;
    const candidateAuthFlow =
      candidateCredential?.type === "oauth" ? candidateCredential.authFlow : undefined;
    const candidateMode = candidateType
      ? authConfig.profileTypeToAuthMode(candidateType)
      : undefined;
    if (candidateMode && !modeAllowed(candidateMode, candidateAuthFlow)) {
      continue;
    }
    if (getDeprecatedProfileIds().has(candidate)) {
      continue;
    }
    try {
      const awsSdkProfileAuth = authConfig.resolveConfiguredAwsSdkProfileAuth({
        cfg,
        provider,
        profileId: candidate,
      });
      if (awsSdkProfileAuth) {
        return awsSdkProfileAuth;
      }
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId: candidate,
        agentDir,
        signal: params.signal,
        forceRefresh: params.forceRefresh,
      });
      params.signal?.throwIfAborted();
      if (resolved) {
        const resolvedProfileId = resolved.profileId ?? candidate;
        const credential = resolved.credential ?? store.profiles[resolvedProfileId];
        const mode = resolved.profileType ?? credential?.type;
        const result = authConfig.projectResolvedProfileAuth({
          apiKey: resolved.apiKey,
          enabled: params.secretSentinels,
          profileId: resolvedProfileId,
          provider,
          store,
          mode: mode ? authConfig.profileTypeToAuthMode(mode) : "api-key",
          authFlow: credential?.type === "oauth" ? credential.authFlow : undefined,
        });
        if (!modeAllowed(result.mode, result.authFlow)) {
          continue;
        }
        if (
          shouldDeferSyntheticProfileAuth({
            cfg,
            provider,
            resolvedApiKey: resolved.apiKey,
            modelApi: params.modelApi,
          })
        ) {
          deferredAuthProfileResult ??= result;
          continue;
        }
        return result;
      }
    } catch (err) {
      params.signal?.throwIfAborted();
      if (err instanceof SecretSurfaceUnavailableError) {
        throw err;
      }
      if (
        !refreshFailure &&
        err instanceof OAuthRefreshFailureError &&
        (!candidateMode || modeAllowed(candidateMode, candidateAuthFlow))
      ) {
        refreshFailure = err;
      }
      log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
    }
  }

  if (refreshFailure) {
    throw refreshFailure;
  }

  const envAuth = resolveEnvAuth();
  if (envAuth && envAuth !== "incompatible") {
    return envAuth;
  }

  const managedRuntimeAuth = resolveManagedSecretRefRuntimeProviderAuth({
    cfg,
    provider,
    secretSentinels: params.secretSentinels,
  });
  if (managedRuntimeAuth && modeAllowed(managedRuntimeAuth.mode)) {
    assertInlineSourceUsable(managedRuntimeAuth.source);
    return managedRuntimeAuth;
  }

  const customKey = authConfig.resolveUsableCustomProviderApiKey({
    cfg,
    provider,
    secretSentinels: params.secretSentinels,
  });
  if (customKey) {
    const mode = resolveDirectProviderCredentialMode({
      cfg,
      provider,
      inferredMode: "api-key",
    });
    if (modeAllowed(mode)) {
      authConfig.assertInlineProviderApiKeyUsable({ store: getScopedStore(), provider });
      return { apiKey: customKey.apiKey, source: customKey.source, mode };
    }
  }

  if (deferredAuthProfileResult) {
    return deferredAuthProfileResult;
  }

  const syntheticLocalAuth = await prepareSyntheticLocalProviderAuth({
    cfg,
    provider,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
    secretSentinels: params.secretSentinels,
    allowPluginSyntheticAuth: params.allowAuthProfileFallback !== false,
  });
  params.signal?.throwIfAborted();
  if (syntheticLocalAuth) {
    return syntheticLocalAuth;
  }

  const hasInlineConfiguredModels =
    Array.isArray(providerConfig?.models) && providerConfig.models.length > 0;
  const owningPluginIds =
    params.allowAuthProfileFallback !== false && !hasInlineConfiguredModels
      ? resolveOwningPluginIdsForProviderRef({
          provider,
          config: cfg,
        })
      : undefined;
  if (owningPluginIds?.length) {
    const pluginMissingAuthMessage = buildProviderMissingAuthMessageWithPlugin({
      provider,
      config: cfg,
      context: {
        config: cfg,
        agentDir,
        env: process.env,
        provider,
        listProfileIds: (providerId) => listProfilesForProvider(store, providerId),
      },
    });
    if (pluginMissingAuthMessage) {
      throw new ProviderAuthError("missing-provider-auth", provider, pluginMissingAuthMessage, {
        providerGuidance: true,
      });
    }
  }

  const authStorePath = resolveAuthStorePathForDisplay(agentDir);
  const agentDirContext = agentDir ? ` (agentDir: ${resolveUserPath(agentDir)})` : "";
  throw new ProviderAuthError(
    "missing-provider-auth",
    provider,
    [
      `No API key found for provider "${provider}".`,
      `Auth store: ${authStorePath}${agentDirContext}.`,
      `Configure an API key (${formatCliCommand(`openclaw models auth paste-api-key --provider ${provider}`)}; add --agent <id> for a non-default agent) or copy only portable static auth profiles from the main agentDir.`,
    ].join(" "),
  );
}
