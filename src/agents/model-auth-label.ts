import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { maskApiKey } from "../utils/mask-api-key.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "./model-auth.js";
import { normalizeProviderId } from "./model-selection.js";

function formatApiKeySnippet(apiKey: string): string {
  const compact = apiKey.replace(/\s+/g, "");
  if (!compact) {
    return "unknown";
  }
  return maskApiKey(compact);
}

function formatCredentialSnippet(params: {
  value: string | undefined;
  ref: { source: string; id: string } | undefined;
}): string {
  const value = typeof params.value === "string" ? params.value.trim() : "";
  if (value) {
    return formatApiKeySnippet(value);
  }
  if (params.ref) {
    return `ref(${params.ref.source}:${params.ref.id})`;
  }
  return "unknown";
}

export function resolveModelAuthLabel(params: {
  provider?: string;
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentDir?: string;
}): string | undefined {
  const resolvedProvider = params.provider?.trim();
  if (!resolvedProvider) {
    return undefined;
  }

  const providerKey = normalizeProviderId(resolvedProvider);
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOverride = params.sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: providerKey,
    preferredProfile: profileOverride,
  });
  const candidates = [profileOverride, ...order].filter(Boolean) as string[];

  for (const profileId of candidates) {
    const profile = store.profiles[profileId];
    if (!profile || normalizeProviderId(profile.provider) !== providerKey) {
      continue;
    }
    const label = resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store,
      profileId,
    });
    if (profile.type === "oauth") {
      return `oauth${label ? ` (${label})` : ""}`;
    }
    if (profile.type === "token") {
      return `token ${formatCredentialSnippet({ value: profile.token, ref: profile.tokenRef })}${
        label ? ` (${label})` : ""
      }`;
    }
    return `api-key ${formatCredentialSnippet({ value: profile.key, ref: profile.keyRef })}${
      label ? ` (${label})` : ""
    }`;
  }

  const envKey = resolveEnvApiKey(providerKey);
  if (envKey?.apiKey) {
    if (envKey.source.includes("OAUTH_TOKEN")) {
      return `oauth (${envKey.source})`;
    }
    return `api-key ${formatApiKeySnippet(envKey.apiKey)} (${envKey.source})`;
  }

  const customKey = getCustomProviderApiKey(params.cfg, providerKey);
  if (customKey) {
    return `api-key ${formatApiKeySnippet(customKey)} (models.json)`;
  }

  return "unknown";
}
