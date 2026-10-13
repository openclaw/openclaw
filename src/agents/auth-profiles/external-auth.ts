/**
 * Runtime external auth profile overlays.
 * Combines provider plugin auth profiles with scoped external CLI credentials
 * and decides which runtime profiles may be persisted back to the store.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type {
  ProviderExternalAuthProfileResolverPreparation,
  ProviderExternalAuthProfile,
  ProviderExternalAuthProfileResolver,
} from "../../plugins/provider-external-auth.types.js";
import { isAmbientCredentialAllowedByProviderAuthPin } from "./ambient-auth.js";
import { cloneAuthProfileStore } from "./clone.js";
import { MINIMAX_CLI_PROFILE_ID } from "./constants.js";
import * as externalCliSync from "./external-cli-sync.js";
import {
  areOAuthCredentialsEquivalent,
  overlayRuntimeExternalOAuthProfiles,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import { removeRuntimeExternalProfileReferences } from "./runtime-external-profile-references.js";
import type { AuthProfileStore } from "./types.js";

type ExternalAuthProfileMap = Map<string, ProviderExternalAuthProfile>;
export type ExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

let resolveExternalAuthProfilesForRuntime: ProviderExternalAuthProfileResolver | undefined;

/** Test-only resolver injection for provider external auth profiles. */
const testing = {
  resetResolveExternalAuthProfilesForTest(): void {
    resolveExternalAuthProfilesForRuntime = undefined;
  },
  setResolveExternalAuthProfilesForTest(resolver: ProviderExternalAuthProfileResolver): void {
    resolveExternalAuthProfilesForRuntime = resolver;
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.externalAuthTestApi")] =
    testing;
}

function resolveExplicitProfileIds(values: Iterable<string> | undefined): Set<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  return new Set(Array.from(values, (value) => value.trim()).filter((value) => value.length > 0));
}

function isExternalAuthProfileAllowed(
  profile: ProviderExternalAuthProfile,
  store: AuthProfileStore,
  config: OpenClawConfig | undefined,
  explicitProfileIds: ReadonlySet<string> | undefined,
  env: NodeJS.ProcessEnv,
  metadataSnapshot: PluginMetadataSnapshot | undefined,
): boolean {
  // A provider pin protects its declared auth from ambient takeover. Stored and explicitly
  // bound profiles deliberately keep precedence; see runtime-plan/prepare-auth.test.ts.
  if (store.profiles[profile.profileId] || explicitProfileIds?.has(profile.profileId)) {
    return true;
  }
  return isAmbientCredentialAllowedByProviderAuthPin({
    config,
    authAliasLookupParams: { env, metadataSnapshot },
    provider: profile.credential.provider,
    type: profile.credential.type,
  });
}

function resolveAllowedExternalCliAuthProfiles(params: {
  store: AuthProfileStore;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliOverlayOptions;
}): ReturnType<typeof externalCliSync.resolveExternalCliAuthProfiles> {
  const env = params.env ?? process.env;
  const explicitProfileIds = resolveExplicitProfileIds(params.externalCli?.externalCliProfileIds);
  const cliProfiles = externalCliSync.resolveExternalCliAuthProfiles(params.store, {
    allowKeychainPrompt: params.externalCli?.allowKeychainPrompt,
    ...(params.env ? { env: params.env } : {}),
    providerIds: params.externalCli?.externalCliProviderIds,
    profileIds: explicitProfileIds,
  });
  return cliProfiles.filter((profile) =>
    isExternalAuthProfileAllowed(
      profile,
      params.store,
      params.externalCli?.config,
      explicitProfileIds,
      env,
      params.externalCli?.pluginMetadataSnapshot,
    ),
  );
}

function hasScopedExternalCliOverlay(params?: ExternalCliOverlayOptions): boolean {
  return Boolean(params?.externalCliProviderIds || params?.externalCliProfileIds);
}

/** Persist safe external CLI OAuth profiles that own their local profile slot. */
export function syncPersistedExternalCliAuthProfiles(
  store: AuthProfileStore,
  params?: ExternalCliOverlayOptions,
): AuthProfileStore {
  // MiniMax keeps its persisted external profile fresh without an explicit scope.
  if (
    !hasScopedExternalCliOverlay(params) &&
    store.profiles[MINIMAX_CLI_PROFILE_ID]?.type !== "oauth"
  ) {
    return store;
  }
  const persistedProfiles = resolveAllowedExternalCliAuthProfiles({
    store,
    externalCli: params,
  });
  if (persistedProfiles.length === 0) {
    return store;
  }

  let next: AuthProfileStore | undefined;
  for (const profile of persistedProfiles) {
    const target = next ?? store;
    const existing = target.profiles[profile.profileId];
    if (
      existing?.type === "oauth" &&
      existing.authFlow === profile.credential.authFlow &&
      areOAuthCredentialsEquivalent(existing, profile.credential)
    ) {
      continue;
    }
    next ??= cloneAuthProfileStore(store);
    next.profiles[profile.profileId] = profile.credential;
  }
  return next ?? store;
}

// Only external-profile-dependent operations are bound; module state stays above.
export function createExternalAuthRuntime(
  resolveExternalAuthProfilesWithPlugins: ProviderExternalAuthProfileResolver,
  prepareExternalAuthProfilesWithPlugins: ProviderExternalAuthProfileResolverPreparation,
) {
  type ResolveParams = {
    store: AuthProfileStore;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    externalCli?: ExternalCliOverlayOptions;
  };

  function resolverParams(
    params: ResolveParams,
  ): Parameters<ProviderExternalAuthProfileResolver>[0] {
    const env = params.env ?? process.env;
    return {
      env,
      config: params.externalCli?.config,
      pluginMetadataSnapshot: params.externalCli?.pluginMetadataSnapshot,
      context: {
        config: params.externalCli?.config,
        agentDir: params.agentDir,
        workspaceDir: params.externalCli?.pluginMetadataSnapshot?.workspaceDir,
        env,
        store: params.store,
      },
    };
  }

  function resolveExternalAuthProfiles(
    params: ResolveParams,
    profiles: ProviderExternalAuthProfile[],
  ): ExternalAuthProfileMap {
    const env = params.env ?? process.env;
    const resolved: ExternalAuthProfileMap = new Map(
      resolveAllowedExternalCliAuthProfiles(params).map((profile) => [profile.profileId, profile]),
    );
    const explicitProfileIds = resolveExplicitProfileIds(params.externalCli?.externalCliProfileIds);
    for (const rawProfile of profiles) {
      if (!rawProfile?.profileId || !rawProfile.credential) {
        continue;
      }
      const profile: ProviderExternalAuthProfile = {
        ...rawProfile,
        persistence: rawProfile.persistence ?? "runtime-only",
      };
      if (
        !isExternalAuthProfileAllowed(
          profile,
          params.store,
          params.externalCli?.config,
          explicitProfileIds,
          env,
          params.externalCli?.pluginMetadataSnapshot,
        )
      ) {
        continue;
      }
      resolved.set(profile.profileId, profile);
    }
    return resolved;
  }

  /** List runtime-only and persisted external auth profiles for this store. */
  function listRuntimeExternalAuthProfiles(params: {
    store: AuthProfileStore;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    externalCli?: ExternalCliOverlayOptions;
  }): RuntimeExternalOAuthProfile[] {
    const resolver =
      resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
    return Array.from(
      resolveExternalAuthProfiles(params, resolver(resolverParams(params))).values(),
    );
  }

  /** Overlay external auth profiles onto a cloned auth store for runtime use. */
  function prepareOverlay(
    store: AuthProfileStore,
    params?: { agentDir?: string; env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
  ) {
    const scoped = hasScopedExternalCliOverlay(params);
    // Provider hooks own all runtime-only overlays; MiniMax CLI credentials are persisted.
    const refreshedProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
    const base = removeRuntimeExternalProfileReferences({ store, profileIds: refreshedProfileIds });
    return { base, scoped };
  }

  function finishOverlay(
    base: AuthProfileStore,
    scoped: boolean,
    resolved: ReturnType<typeof resolveExternalAuthProfiles>,
  ): AuthProfileStore {
    return overlayRuntimeExternalOAuthProfiles(base, resolved.values(), {
      runtimeExternalProfileIdsAuthoritative: !scoped,
    });
  }

  function overlayExternalAuthProfiles(
    store: AuthProfileStore,
    params?: { agentDir?: string; env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
  ): AuthProfileStore {
    const { base, scoped } = prepareOverlay(store, params);
    const request = {
      store: base,
      agentDir: params?.agentDir,
      env: params?.env,
      externalCli: params,
    };
    const resolver =
      resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
    return finishOverlay(
      base,
      scoped,
      resolveExternalAuthProfiles(request, resolver(resolverParams(request))),
    );
  }

  async function prepareExternalAuthResolution(
    options?: { env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
  ) {
    const pluginMetadataSnapshot =
      options?.pluginMetadataSnapshot ??
      getCurrentPluginMetadataSnapshot({
        config: options?.config,
        env: options?.env,
        requireDefaultDiscoveryContext: !options?.config,
        allowWorkspaceScopedSnapshot: true,
        allowSynchronousPolicyRead: false,
      }) ??
      (await resolvePluginMetadataSnapshotAsync({
        config: options?.config ?? {},
        env: options?.env,
      }));
    const lookup = {
      config: options?.config,
      env: options?.env ?? process.env,
      workspaceDir: pluginMetadataSnapshot.workspaceDir,
      pluginMetadataSnapshot,
    };
    const testResolver = resolveExternalAuthProfilesForRuntime;
    const resolveProfiles = testResolver
      ? (context: Parameters<ProviderExternalAuthProfileResolver>[0]["context"]) =>
          testResolver({ ...lookup, context })
      : await prepareExternalAuthProfilesWithPlugins(lookup);
    return (params: ResolveParams) => {
      const prepared = {
        ...params,
        env: params.env ?? lookup.env,
        externalCli: { ...options, ...params.externalCli, pluginMetadataSnapshot },
      };
      return resolveExternalAuthProfiles(
        prepared,
        resolveProfiles(resolverParams(prepared).context),
      );
    };
  }

  /** Capture plugin callbacks before a write; evaluate them against its current store. */
  async function prepareRuntimeExternalAuthProfiles(
    options?: { env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
  ): Promise<typeof listRuntimeExternalAuthProfiles> {
    const resolve = await prepareExternalAuthResolution(options);
    return (params) => Array.from(resolve(params).values());
  }

  async function overlayExternalAuthProfilesAsync(
    store: AuthProfileStore,
    params?: { agentDir?: string; env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
  ): Promise<AuthProfileStore> {
    const resolve = await prepareExternalAuthResolution(params);
    const { base, scoped } = prepareOverlay(store, params);
    const request = {
      store: base,
      agentDir: params?.agentDir,
      env: params?.env,
      externalCli: params,
    };
    return finishOverlay(base, scoped, resolve(request));
  }

  return {
    listRuntimeExternalAuthProfiles,
    prepareRuntimeExternalAuthProfiles,
    overlayExternalAuthProfiles,
    overlayExternalAuthProfilesAsync,
  };
}
