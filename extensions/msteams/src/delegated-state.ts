import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { resolveMSTeamsAccountStateNamespace } from "./sqlite-state.js";

export const MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME = "msteams-delegated.json";
export const MSTEAMS_DELEGATED_TOKEN_NAMESPACE = "delegated-token";
export const MSTEAMS_DELEGATED_TOKEN_KEY = "current";
export const MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES = 100;

function normalizeDelegatedTokenAccountId(accountId?: string | null): string {
  return accountId?.trim() || DEFAULT_ACCOUNT_ID;
}

function openDelegatedTokenStore(
  accountId?: string | null,
  env?: NodeJS.ProcessEnv,
): PluginStateKeyedStore<MSTeamsDelegatedTokens> {
  const normalizedAccountId = normalizeDelegatedTokenAccountId(accountId);
  return getMSTeamsRuntime().state.openKeyedStore<MSTeamsDelegatedTokens>({
    // Preserve the shipped default namespace/key while giving each named bot
    // an independent reject-new quota so one account cannot block another.
    namespace: resolveMSTeamsAccountStateNamespace(
      MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
      normalizedAccountId,
    ),
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

export async function loadMSTeamsDelegatedTokens(
  accountId?: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<MSTeamsDelegatedTokens | undefined> {
  const stored = await openDelegatedTokenStore(accountId, env).lookup(MSTEAMS_DELEGATED_TOKEN_KEY);
  return normalizeMSTeamsDelegatedTokens(stored) ?? undefined;
}

export async function saveMSTeamsDelegatedTokens(
  tokens: MSTeamsDelegatedTokens,
  accountId?: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const normalized = normalizeMSTeamsDelegatedTokens(tokens);
  if (!normalized) {
    throw new Error("Invalid Microsoft Teams delegated token payload");
  }
  await openDelegatedTokenStore(accountId, env).register(MSTEAMS_DELEGATED_TOKEN_KEY, normalized);
}
