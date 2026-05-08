import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MSTeamsConfig } from "../runtime-api.js";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { refreshMSTeamsDelegatedTokens } from "./oauth.token.js";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";

// ── Credential types ───────────────────────────────────────────────────────

export type MSTeamsSecretCredentials = {
  type: "secret";
  appId: string;
  appPassword: string;
  tenantId: string;
};

export type MSTeamsFederatedCredentials = {
  type: "federated";
  appId: string;
  tenantId: string;
  certificatePath?: string;
  certificateThumbprint?: string;
  useManagedIdentity?: boolean;
  managedIdentityClientId?: string;
};

export type MSTeamsCredentials = MSTeamsSecretCredentials | MSTeamsFederatedCredentials;

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveAuthType(cfg?: MSTeamsConfig): "secret" | "federated" {
  const fromCfg = cfg?.authType;
  if (fromCfg === "secret" || fromCfg === "federated") {
    return fromCfg;
  }

  const fromEnv = process.env.MSTEAMS_AUTH_TYPE;
  if (fromEnv === "federated") {
    return "federated";
  }

  return "secret";
}

// ── hasConfiguredMSTeamsCredentials ────────────────────────────────────────

export function hasConfiguredMSTeamsCredentials(cfg?: MSTeamsConfig): boolean {
  const authType = resolveAuthType(cfg);

  const hasAppId = Boolean(
    normalizeSecretInputString(cfg?.appId) ||
    normalizeSecretInputString(process.env.MSTEAMS_APP_ID),
  );
  const hasTenantId = Boolean(
    normalizeSecretInputString(cfg?.tenantId) ||
    normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID),
  );

  if (authType === "federated") {
    const hasCert = Boolean(cfg?.certificatePath || process.env.MSTEAMS_CERTIFICATE_PATH);
    const hasManagedIdentity =
      cfg?.useManagedIdentity ?? process.env.MSTEAMS_USE_MANAGED_IDENTITY === "true";

    return hasAppId && hasTenantId && (hasCert || hasManagedIdentity);
  }

  // "secret" (default) — original logic
  return Boolean(
    normalizeSecretInputString(cfg?.appId) &&
    hasConfiguredSecretInput(cfg?.appPassword) &&
    normalizeSecretInputString(cfg?.tenantId),
  );
}

// ── resolveMSTeamsCredentials ─────────────────────────────────────────────

export function resolveMSTeamsCredentials(cfg?: MSTeamsConfig): MSTeamsCredentials | undefined {
  const authType = resolveAuthType(cfg);

  const appId =
    normalizeSecretInputString(cfg?.appId) ||
    normalizeSecretInputString(process.env.MSTEAMS_APP_ID);

  const tenantId =
    normalizeSecretInputString(cfg?.tenantId) ||
    normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID);

  if (!appId || !tenantId) {
    return undefined;
  }

  if (authType === "federated") {
    const certificatePath =
      cfg?.certificatePath || process.env.MSTEAMS_CERTIFICATE_PATH || undefined;

    const certificateThumbprint =
      cfg?.certificateThumbprint || process.env.MSTEAMS_CERTIFICATE_THUMBPRINT || undefined;

    const useManagedIdentity =
      cfg?.useManagedIdentity ?? process.env.MSTEAMS_USE_MANAGED_IDENTITY === "true";

    const managedIdentityClientId =
      cfg?.managedIdentityClientId || process.env.MSTEAMS_MANAGED_IDENTITY_CLIENT_ID || undefined;

    // At least one federated mechanism must be configured.
    if (!certificatePath && !useManagedIdentity) {
      return undefined;
    }

    return {
      type: "federated",
      appId,
      tenantId,
      certificatePath,
      certificateThumbprint,
      useManagedIdentity: useManagedIdentity || undefined,
      managedIdentityClientId,
    };
  }

  // "secret" (default) — original logic
  const appPassword =
    normalizeResolvedSecretInputString({
      value: cfg?.appPassword,
      path: "channels.msteams.appPassword",
    }) || normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD);

  if (!appPassword) {
    return undefined;
  }

  return { type: "secret", appId, appPassword, tenantId };
}

// ---------------------------------------------------------------------------
// Delegated token storage / resolution
// ---------------------------------------------------------------------------

export const MSTEAMS_DELEGATED_TOKEN_FILENAME = "msteams-delegated.json";
export const MSTEAMS_DELEGATED_TOKEN_NAMESPACE = "delegated-tokens";
const MSTEAMS_PLUGIN_ID = "msteams";
const MSTEAMS_DELEGATED_TOKEN_KEY = "current";

const delegatedTokenStore = createPluginStateSyncKeyedStore<MSTeamsDelegatedTokens>(
  MSTEAMS_PLUGIN_ID,
  {
    namespace: MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
    maxEntries: 8,
  },
);

export function parseMSTeamsDelegatedTokens(value: unknown): MSTeamsDelegatedTokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const tokens = value as Partial<MSTeamsDelegatedTokens>;
  if (
    typeof tokens.accessToken !== "string" ||
    !tokens.accessToken ||
    typeof tokens.refreshToken !== "string" ||
    !tokens.refreshToken ||
    typeof tokens.expiresAt !== "number" ||
    !Number.isFinite(tokens.expiresAt) ||
    !Array.isArray(tokens.scopes) ||
    tokens.scopes.some((scope) => typeof scope !== "string" || !scope)
  ) {
    return null;
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: [...tokens.scopes],
    ...(typeof tokens.userPrincipalName === "string" && tokens.userPrincipalName
      ? { userPrincipalName: tokens.userPrincipalName }
      : {}),
  };
}

export function loadDelegatedTokens(): MSTeamsDelegatedTokens | undefined {
  return (
    parseMSTeamsDelegatedTokens(delegatedTokenStore.lookup(MSTEAMS_DELEGATED_TOKEN_KEY)) ??
    undefined
  );
}

export function saveDelegatedTokens(tokens: MSTeamsDelegatedTokens): void {
  delegatedTokenStore.register(MSTEAMS_DELEGATED_TOKEN_KEY, tokens);
}

export async function resolveDelegatedAccessToken(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string | undefined> {
  const tokens = loadDelegatedTokens();
  if (!tokens) {
    return undefined;
  }

  // Token still valid (5-min buffer already baked into expiresAt)
  if (tokens.expiresAt > Date.now()) {
    return tokens.accessToken;
  }

  // Attempt refresh
  try {
    const refreshed = await refreshMSTeamsDelegatedTokens({
      tenantId: params.tenantId,
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    });
    saveDelegatedTokens(refreshed);
    return refreshed.accessToken;
  } catch {
    return undefined;
  }
}
