// Msteams plugin module implements token behavior.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { privateFileStoreSync } from "openclaw/plugin-sdk/security-runtime";
import type { MSTeamsConfig } from "../runtime-api.js";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { refreshMSTeamsDelegatedTokens } from "./oauth.token.js";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";
import { resolveMSTeamsStorePath } from "./storage.js";

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

export function resolveMSTeamsCredentials(
  cfg?: MSTeamsConfig,
  options?: { allowEnvFallback?: boolean; pathPrefix?: string },
): MSTeamsCredentials | undefined {
  const allowEnvFallback = options?.allowEnvFallback ?? true;
  const pathPrefix = options?.pathPrefix ?? "channels.msteams";
  const authType = resolveAuthType(cfg);

  const appId =
    normalizeSecretInputString(cfg?.appId) ||
    (allowEnvFallback ? normalizeSecretInputString(process.env.MSTEAMS_APP_ID) : undefined);

  const tenantId =
    normalizeSecretInputString(cfg?.tenantId) ||
    (allowEnvFallback ? normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID) : undefined);

  if (!appId || !tenantId) {
    return undefined;
  }

  if (authType === "federated") {
    const certificatePath =
      cfg?.certificatePath ||
      (allowEnvFallback ? process.env.MSTEAMS_CERTIFICATE_PATH : undefined) ||
      undefined;

    const certificateThumbprint =
      cfg?.certificateThumbprint ||
      (allowEnvFallback ? process.env.MSTEAMS_CERTIFICATE_THUMBPRINT : undefined) ||
      undefined;

    const useManagedIdentity =
      cfg?.useManagedIdentity ??
      (allowEnvFallback ? process.env.MSTEAMS_USE_MANAGED_IDENTITY === "true" : false);

    const managedIdentityClientId =
      cfg?.managedIdentityClientId ||
      (allowEnvFallback ? process.env.MSTEAMS_MANAGED_IDENTITY_CLIENT_ID : undefined) ||
      undefined;

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
      path: `${pathPrefix}.appPassword`,
    }) ||
    (allowEnvFallback ? normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD) : undefined);

  if (!appPassword) {
    return undefined;
  }

  return { type: "secret", appId, appPassword, tenantId };
}

// ---------------------------------------------------------------------------
// Delegated token storage / resolution
// ---------------------------------------------------------------------------

const DELEGATED_TOKEN_FILENAME = "msteams-delegated.json";

function normalizeDelegatedTokenAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function accountScopedDelegatedTokenFilename(accountId?: string | null): string {
  const normalized = normalizeDelegatedTokenAccountId(accountId);
  if (normalized === DEFAULT_ACCOUNT_ID) {
    return DELEGATED_TOKEN_FILENAME;
  }
  if (/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    return `msteams-delegated.${normalized}.json`;
  }
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `msteams-delegated.${digest}.json`;
}

function resolveDelegatedTokenPath(accountId?: string | null): string {
  return resolveMSTeamsStorePath({ filename: accountScopedDelegatedTokenFilename(accountId) });
}

export function loadDelegatedTokens(params?: {
  accountId?: string | null;
}): MSTeamsDelegatedTokens | undefined {
  try {
    const content = readFileSync(resolveDelegatedTokenPath(params?.accountId), "utf8");
    return JSON.parse(content) as MSTeamsDelegatedTokens;
  } catch {
    return undefined;
  }
}

export function saveDelegatedTokens(
  tokens: MSTeamsDelegatedTokens,
  params?: { accountId?: string | null },
): void {
  const tokenPath = resolveDelegatedTokenPath(params?.accountId);
  privateFileStoreSync(dirname(tokenPath)).writeJson(basename(tokenPath), tokens);
}

export async function resolveDelegatedAccessToken(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  accountId?: string | null;
}): Promise<string | undefined> {
  const tokens = loadDelegatedTokens({ accountId: params.accountId });
  if (!tokens) {
    return undefined;
  }

  // Token still valid (5-min buffer already baked into expiresAt)
  if (isFutureDateTimestampMs(tokens.expiresAt)) {
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
    saveDelegatedTokens(refreshed, { accountId: params.accountId });
    return refreshed.accessToken;
  } catch {
    return undefined;
  }
}
