/** Converts auth-profile credentials into agent runtime credential maps. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";

// Converts auth-profile credentials into the compact credential map consumed by
// agent runtimes. Secret refs can be represented by markers without reading
// secret values.
type AgentApiKeyCredential = { type: "api_key"; key: string };
type AgentOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

/** Credential value shape consumed by agent runtimes after auth-profile normalization. */
type AgentCredential = AgentApiKeyCredential | AgentOAuthCredential;
export type AgentCredentialMap = Record<string, AgentCredential>;

type ResolveAgentCredentialMapOptions = {
  includeSecretRefPlaceholders?: boolean;
  /** Optional config so discovery can honor `auth.order` / auth.profiles. */
  config?: OpenClawConfig;
  /** Session or caller preferred profile id for providers that match it. */
  preferredProfile?: string;
};

const AGENT_SECRET_REF_CONFIGURED_MARKER = "openclaw-secret-ref-configured";

function hasConfiguredSecretRef(value: unknown): boolean {
  return coerceSecretRef(value) !== null;
}

function secretRefPlaceholder(
  options: ResolveAgentCredentialMapOptions | undefined,
): AgentCredential | null {
  if (options?.includeSecretRefPlaceholders === true) {
    return { type: "api_key", key: AGENT_SECRET_REF_CONFIGURED_MARKER };
  }
  return null;
}

function convertAuthProfileCredentialToAgent(
  cred: AuthProfileCredential,
  options?: ResolveAgentCredentialMapOptions,
): AgentCredential | null {
  if (cred.type === "api_key") {
    const key = normalizeOptionalString(cred.key) ?? "";
    if (!key) {
      // A configured secret ref proves the credential exists, but this converter
      // must not resolve or leak the actual secret value.
      return hasConfiguredSecretRef(cred.keyRef) ? secretRefPlaceholder(options) : null;
    }
    return { type: "api_key", key };
  }

  if (cred.type === "token") {
    if (cred.expires !== undefined) {
      const expires = asDateTimestampMs(cred.expires);
      if (expires === undefined || Date.now() >= expires) {
        return null;
      }
    }
    const token = normalizeOptionalString(cred.token) ?? "";
    if (!token) {
      return hasConfiguredSecretRef(cred.tokenRef) ? secretRefPlaceholder(options) : null;
    }
    return { type: "api_key", key: token };
  }

  if (cred.type === "oauth") {
    const access = normalizeOptionalString(cred.access) ?? "";
    const refresh = normalizeOptionalString(cred.refresh) ?? "";
    const expires = asDateTimestampMs(cred.expires);
    // Reject expired OAuth the same way tokens are rejected so discovery cannot
    // surface a dead access token as a usable provider credential.
    if (!access || !refresh || expires === undefined || Date.now() >= expires) {
      return null;
    }
    return {
      type: "oauth",
      access,
      refresh,
      expires,
    };
  }

  return null;
}

function listProvidersInStore(store: AuthProfileStore): string[] {
  const providers = new Set<string>();
  for (const credential of Object.values(store.profiles)) {
    const provider = normalizeProviderId(credential.provider ?? "");
    if (provider) {
      providers.add(provider);
    }
  }
  // Deterministic map key order for stable discovery payloads / prompt cache.
  return [...providers].toSorted();
}

/** Build one credential per normalized provider from an auth profile store. */
export function resolveAgentCredentialMapFromStore(
  store: AuthProfileStore,
  options?: ResolveAgentCredentialMapOptions,
): AgentCredentialMap {
  const credentials: AgentCredentialMap = {};
  const readinessMode = options?.includeSecretRefPlaceholders === true ? "read-only" : "execution";

  // Prefer the canonical auth-profile order (auth.order, OAuth-over-api_key,
  // eligibility) instead of raw store insertion order. First convertible
  // profile in that order wins for each provider.
  for (const provider of listProvidersInStore(store)) {
    const profileIds = resolveAuthProfileOrder({
      store,
      provider,
      cfg: options?.config,
      preferredProfile: options?.preferredProfile,
      readinessMode,
    });
    for (const profileId of profileIds) {
      const credential = store.profiles[profileId];
      if (!credential) {
        continue;
      }
      const converted = convertAuthProfileCredentialToAgent(credential, options);
      if (converted) {
        credentials[provider] = converted;
        break;
      }
    }
  }
  return credentials;
}
