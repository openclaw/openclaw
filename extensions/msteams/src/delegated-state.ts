import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { getMSTeamsRuntime } from "./runtime.js";

export const MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME = "msteams-delegated.json";
export const MSTEAMS_DELEGATED_TOKEN_NAMESPACE = "delegated-token";
export const MSTEAMS_DELEGATED_TOKEN_KEY = "current";
export const MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES = 1;

function openDelegatedTokenStore(
  env?: NodeJS.ProcessEnv,
): PluginStateKeyedStore<MSTeamsDelegatedTokens> {
  return getMSTeamsRuntime().state.openKeyedStore<MSTeamsDelegatedTokens>({
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

export async function loadMSTeamsDelegatedTokens(
  env?: NodeJS.ProcessEnv,
): Promise<MSTeamsDelegatedTokens | undefined> {
  const stored = await openDelegatedTokenStore(env).lookup(MSTEAMS_DELEGATED_TOKEN_KEY);
  return normalizeMSTeamsDelegatedTokens(stored) ?? undefined;
}

export async function saveMSTeamsDelegatedTokens(
  tokens: MSTeamsDelegatedTokens,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const normalized = normalizeMSTeamsDelegatedTokens(tokens);
  if (!normalized) {
    throw new Error("Invalid Microsoft Teams delegated token payload");
  }
  await openDelegatedTokenStore(env).register(MSTEAMS_DELEGATED_TOKEN_KEY, normalized);
}
