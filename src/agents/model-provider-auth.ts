import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "./model-auth.js";
import { normalizeProviderId } from "./model-selection.js";

export function hasAuthForModelProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const store =
    params.store ??
    ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  if (resolveEnvApiKey(provider, params.env)?.apiKey) {
    return true;
  }
  if (hasUsableCustomProviderApiKey(params.cfg, provider, params.env)) {
    return true;
  }
  return false;
}

export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): (provider: string) => boolean {
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
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
      agentDir: params.agentDir,
      env: params.env,
      store,
    });
    authCache.set(key, value);
    return value;
  };
}
