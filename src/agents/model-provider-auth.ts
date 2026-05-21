import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  externalCliDiscoveryForProviderAuth,
  externalCliDiscoveryForProviders,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { hasRuntimeAvailableProviderAuth } from "./model-auth.js";
import { loadModelCatalog } from "./model-catalog.js";
import { normalizeProviderId } from "./model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

// Prepared runtime fact: which providers have available auth given the
// current cfg + env. Populated explicitly at gateway startup and on config
// reload; consulted by hasAuthForModelProvider so every model-listing call
// (pickers, /models, status commands, CLI) skips the per-provider plugin
// discovery and external-CLI probing on the hot path.

type PreparedProviderAuthState = {
  configFingerprint: string;
  workspaceDir: string;
  preparedAtMs: number;
  providers: ReadonlyMap<string, boolean>;
};

const PREPARED_PROVIDER_AUTH_STATE_TTL_MS = 10_000;
let currentProviderAuthState: PreparedProviderAuthState | null = null;
const configFingerprintCache = new WeakMap<OpenClawConfig, string>();
// Generation counter guards against an in-flight warm publishing stale
// state after a subsequent warm or clear has invalidated it.
let currentProviderAuthStateGeneration = 0;

export function clearCurrentProviderAuthState(): void {
  currentProviderAuthState = null;
  currentProviderAuthStateGeneration += 1;
}

function resolveProviderAuthConfigFingerprint(cfg: OpenClawConfig | undefined): string | null {
  if (!cfg) {
    return null;
  }
  const cached = configFingerprintCache.get(cfg);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = hashRuntimeConfigValue(cfg);
  configFingerprintCache.set(cfg, fingerprint);
  return fingerprint;
}

export function hasAuthForModelProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  // The prepared map is built by warmCurrentProviderAuthState with broad
  // auth discovery (external CLI + plugin synthetic auth enabled) and the
  // default-agent workspace dir. Only consult it when the caller's full
  // auth context matches; otherwise fall through to compute so callers
  // that narrow the scope — e.g. gateway `models.list` with
  // `runtimeAuthDiscovery: false`, or per-agent picker calls that pass a
  // non-default workspaceDir — get the answer they asked for.
  const preparedState = currentProviderAuthState;
  const workspaceDir = params.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const configFingerprint = resolveProviderAuthConfigFingerprint(params.cfg);
  const preparedStateFresh =
    preparedState !== null &&
    Date.now() - preparedState.preparedAtMs <= PREPARED_PROVIDER_AUTH_STATE_TTL_MS;
  const matchesWarmedScope =
    preparedStateFresh &&
    configFingerprint === preparedState.configFingerprint &&
    workspaceDir === preparedState.workspaceDir &&
    params.discoverExternalCliAuth !== false &&
    params.allowPluginSyntheticAuth !== false &&
    params.agentDir === undefined &&
    params.env === undefined &&
    params.store === undefined;
  if (matchesWarmedScope) {
    const preparedAnswer = preparedState.providers.get(provider);
    if (preparedAnswer !== undefined) {
      return preparedAnswer;
    }
  }
  if (
    hasRuntimeAvailableProviderAuth({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
    })
  ) {
    return true;
  }
  const store =
    params.store ??
    (params.discoverExternalCliAuth === false
      ? ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
          allowKeychainPrompt: false,
        })
      : ensureAuthProfileStore(params.agentDir, {
          externalCli: externalCliDiscoveryForProviderAuth({ cfg: params.cfg, provider }),
        }));
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  return false;
}

export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): (provider: string) => boolean {
  const authCache = new Map<string, boolean>();
  return (provider: string) => {
    const key = normalizeProviderId(provider);
    const cached = authCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = hasAuthForModelProvider({
      provider: key,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      discoverExternalCliAuth: params.discoverExternalCliAuth,
    });
    authCache.set(key, value);
    return value;
  };
}

export async function warmCurrentProviderAuthState(cfg: OpenClawConfig): Promise<void> {
  // Claim a fresh generation; any concurrent warm or clear bumps this and
  // turns our published state stale.
  currentProviderAuthStateGeneration += 1;
  const ownGeneration = currentProviderAuthStateGeneration;
  const catalog = await loadModelCatalog({ config: cfg });
  const providers = new Set<string>();
  for (const entry of catalog) {
    providers.add(normalizeProviderId(entry.provider));
  }
  const workspaceDir = resolveDefaultAgentWorkspaceDir();
  // One AuthProfileStore scoped to every candidate provider; without this the
  // per-provider externalCli discovery rebuilds the store ~N times.
  const store = ensureAuthProfileStore(undefined, {
    config: cfg,
    externalCli: externalCliDiscoveryForProviders({
      cfg,
      providers: [...providers],
    }),
  });
  const state = new Map<string, boolean>();
  for (const provider of providers) {
    const value = hasAuthForModelProvider({
      provider,
      cfg,
      workspaceDir,
      store,
    });
    state.set(provider, value);
  }
  if (ownGeneration !== currentProviderAuthStateGeneration) {
    // A newer warm or clear ran while we were building; skip publication so
    // the newer answer wins.
    return;
  }
  currentProviderAuthState = {
    configFingerprint: resolveProviderAuthConfigFingerprint(cfg) ?? "",
    workspaceDir,
    preparedAtMs: Date.now(),
    providers: state,
  };
}
