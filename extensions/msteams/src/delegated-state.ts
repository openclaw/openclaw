import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { getMSTeamsRuntime } from "./runtime.js";

export const MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME = "msteams-delegated.json";
export const MSTEAMS_DELEGATED_TOKEN_NAMESPACE = "delegated-token";
export const MSTEAMS_DELEGATED_TOKEN_KEY = "current";
export const MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES = 100;

function delegatedTokenKey(accountId?: string | null): string {
  const normalized = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  return normalized === DEFAULT_ACCOUNT_ID
    ? MSTEAMS_DELEGATED_TOKEN_KEY
    : `account:${encodeURIComponent(normalized)}`;
}

function openDelegatedTokenStore(
  env?: NodeJS.ProcessEnv,
): PluginStateSyncKeyedStore<MSTeamsDelegatedTokens> {
  return getMSTeamsRuntime().state.openSyncKeyedStore<MSTeamsDelegatedTokens>({
    namespace: MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
    maxEntries: MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
}

export function normalizeMSTeamsDelegatedTokens(value: unknown): MSTeamsDelegatedTokens | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const token = value as Partial<MSTeamsDelegatedTokens>;
  if (
    typeof token.accessToken !== "string" ||
    !token.accessToken ||
    typeof token.refreshToken !== "string" ||
    !token.refreshToken ||
    typeof token.expiresAt !== "number" ||
    !Number.isFinite(token.expiresAt) ||
    !Array.isArray(token.scopes) ||
    !token.scopes.every((scope) => typeof scope === "string" && scope.length > 0)
  ) {
    return null;
  }
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scopes: [...token.scopes],
    ...(typeof token.userPrincipalName === "string"
      ? { userPrincipalName: token.userPrincipalName }
      : {}),
  };
}

export function loadMSTeamsDelegatedTokens(
  accountId?: string | null,
  env?: NodeJS.ProcessEnv,
): MSTeamsDelegatedTokens | undefined {
  const stored = openDelegatedTokenStore(env).lookup(delegatedTokenKey(accountId));
  return normalizeMSTeamsDelegatedTokens(stored) ?? undefined;
}

export function saveMSTeamsDelegatedTokens(
  tokens: MSTeamsDelegatedTokens,
  accountId?: string | null,
  env?: NodeJS.ProcessEnv,
): void {
  const normalized = normalizeMSTeamsDelegatedTokens(tokens);
  if (!normalized) {
    throw new Error("Invalid Microsoft Teams delegated token payload");
  }
  openDelegatedTokenStore(env).register(delegatedTokenKey(accountId), normalized);
}
