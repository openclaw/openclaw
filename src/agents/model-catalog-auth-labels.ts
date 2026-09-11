import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { maskApiKey } from "../security/secret-mask.js";
import { shortenHomePath } from "../utils.js";
import { formatRemainingShort } from "./auth-health.js";
import {
  isConfiguredAwsSdkAuthProfileForProvider,
  isProfileInCooldown,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles.js";
import { cloneAuthProfileStore } from "./auth-profiles/clone.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import { resolveEnvApiKey, resolveUsableCustomProviderApiKey } from "./model-auth.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./model-selection.js";

function resolveStoredCredentialLabel(params: { value: unknown; refValue: unknown }): string {
  const masked = maskApiKey(typeof params.value === "string" ? params.value : "");
  if (masked !== "missing") {
    return masked;
  }
  if (coerceSecretRef(params.refValue)) {
    return "ref";
  }
  return "missing";
}

type ModelCatalogAuthLabel =
  | string
  | {
      provider: string;
      profiles: Record<string, string>;
      fallback: string;
      source: string;
      apiKeyOnly: boolean;
    };

/** Reuses time-dependent ordering against captured facts without reopening auth sources. */
export function formatModelCatalogAuthLabel(
  label: ModelCatalogAuthLabel,
  context: {
    cfg: OpenClawConfig;
    store: AuthProfileStore;
    metadataSnapshot: Pick<PluginMetadataSnapshot, "plugins">;
  },
): string {
  if (typeof label === "string") {
    return label;
  }
  const { cfg, metadataSnapshot } = context;
  const store = cloneAuthProfileStore(context.store);
  const now = Date.now();
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider: label.provider,
    authAliasLookupParams: { metadataSnapshot },
  }).filter((id) => {
    if (!label.apiKeyOnly) {
      return true;
    }
    const mode = store.profiles[id]?.type ?? cfg.auth?.profiles?.[id]?.mode;
    return !isStoredAuthProfileType(mode) || mode === "api_key";
  });
  if (!order.length) {
    return label.fallback;
  }
  const lastGood = findNormalizedProviderValue(store.lastGood, label.provider);
  const profiles = order.map((profileId, index) => {
    const flags: string[] = [];
    if (index === 0) {
      flags.push("next");
    }
    if (lastGood === profileId) {
      flags.push("lastGood");
    }
    if (isProfileInCooldown(store, profileId)) {
      const until = store.usageStats?.[profileId]?.cooldownUntil;
      flags.push(
        typeof until === "number" && Number.isFinite(until) && until > now
          ? `cooldown ${formatRemainingShort(until - now, { underMinuteLabel: "soon" })}`
          : "cooldown",
      );
    }
    const profile = store.profiles[profileId];
    const expires =
      profile && profile.type !== "api_key" ? asDateTimestampMs(profile.expires) : undefined;
    if (expires !== undefined && expires > 0) {
      flags.push(
        expires <= now
          ? "expired"
          : ` exp ${formatRemainingShort(expires - now, { underMinuteLabel: "soon" })}`,
      );
    }
    return `${label.profiles[profileId]}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  return `${profiles.join(", ")} (${label.source})`;
}

function isStoredAuthProfileType(value: unknown): value is AuthProfileCredential["type"] {
  return value === "api_key" || value === "oauth" || value === "token";
}

function captureProfileLabel(
  provider: string,
  profileId: string,
  cfg: OpenClawConfig,
  store: AuthProfileStore,
): string {
  const profile = store.profiles[profileId];
  const configProfile = cfg.auth?.profiles?.[profileId];
  if (!profile && isConfiguredAwsSdkAuthProfileForProvider({ cfg, provider, profileId })) {
    return `${profileId}=aws-sdk`;
  }
  if (
    !profile ||
    (configProfile?.provider && configProfile.provider !== profile.provider) ||
    (configProfile?.mode &&
      configProfile.mode !== profile.type &&
      !(configProfile.mode === "oauth" && profile.type === "token"))
  ) {
    return `${profileId}=missing`;
  }
  if (profile.type === "api_key") {
    return `${profileId}=${resolveStoredCredentialLabel({ value: profile.key, refValue: profile.keyRef })}`;
  }
  if (profile.type === "token") {
    return `${profileId}=token:${resolveStoredCredentialLabel({ value: profile.token, refValue: profile.tokenRef })}`;
  }
  const display = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
  const suffix =
    display === profileId
      ? ""
      : display.startsWith(profileId)
        ? display.slice(profileId.length).trim()
        : `(${display})`;
  return `${profileId}=OAuth${suffix ? ` ${suffix}` : ""}`;
}

function captureFallbackLabel(
  provider: string,
  cfg: OpenClawConfig,
  agentDir: string,
  env: NodeJS.ProcessEnv,
  workspaceDir?: string,
): string {
  // Auth profiles win over environment/config keys because they encode provider order.
  const envKey = resolveEnvApiKey(provider, env, { config: cfg, workspaceDir });
  if (envKey) {
    const isOAuthEnv =
      envKey.source.includes("ANTHROPIC_OAUTH_TOKEN") ||
      normalizeLowercaseStringOrEmpty(envKey.source).includes("oauth");
    const label = isOAuthEnv ? "OAuth (env)" : maskApiKey(envKey.apiKey);
    return envKey.source && envKey.source !== label && envKey.source !== "missing"
      ? `${label} (${envKey.source})`
      : label;
  }
  const customKey = resolveUsableCustomProviderApiKey({ cfg, provider })?.apiKey;
  if (customKey) {
    return `${maskApiKey(customKey)} (models.json: ${shortenHomePath(`${agentDir}/models.json`)})`;
  }
  return "missing";
}

export type ModelCatalogAuthLabels = ReadonlyMap<
  string,
  { all: ModelCatalogAuthLabel; apiKey: ModelCatalogAuthLabel }
>;

/** Captures display labels from the generation's auth store and workspace environment. */
export function prepareModelCatalogAuthLabels(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  store: AuthProfileStore;
  providers: Iterable<string>;
}): ModelCatalogAuthLabels {
  const labels = new Map<string, { all: ModelCatalogAuthLabel; apiKey: ModelCatalogAuthLabel }>();
  const profileIds = new Set([
    ...Object.keys(params.store.profiles),
    ...Object.keys(params.config.auth?.profiles ?? {}),
    ...Object.values(params.store.order ?? {}).flat(),
    ...Object.values(params.config.auth?.order ?? {}).flat(),
  ]);
  for (const provider of new Set([...params.providers].map(normalizeProviderId))) {
    const all = {
      provider,
      profiles: Object.fromEntries(
        [...profileIds].map((id) => [
          id,
          captureProfileLabel(provider, id, params.config, params.store),
        ]),
      ),
      source: `auth profile store: ${shortenHomePath(resolveAuthStorePathForDisplay(params.agentDir))}`,
      fallback: captureFallbackLabel(
        provider,
        params.config,
        params.agentDir,
        params.env,
        params.workspaceDir,
      ),
      apiKeyOnly: false,
    };
    labels.set(provider, {
      all,
      apiKey: provider === "openai" ? { ...all, apiKeyOnly: true } : all,
    });
  }
  return labels;
}
