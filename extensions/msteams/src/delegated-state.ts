import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { resolveMSTeamsAccountStateNamespace } from "./sqlite-state.js";

export const MSTEAMS_DELEGATED_TOKEN_LEGACY_FILENAME = "msteams-delegated.json";
export const MSTEAMS_DELEGATED_TOKEN_NAMESPACE = "delegated-token";
export const MSTEAMS_DELEGATED_TOKEN_KEY = "current";
export const MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES = 1;

export type MSTeamsDelegatedRefreshClaim = {
  refreshClaim: string;
  requestKey: string;
  callerKey: string;
  credential?: MSTeamsDelegatedTokens;
};
type DelegatedTokenState = MSTeamsDelegatedTokens | MSTeamsDelegatedRefreshClaim;

function openDelegatedTokenStore(
  accountId?: string | null,
): PluginStateKeyedStore<DelegatedTokenState, 2> {
  const runtime = getMSTeamsRuntime();
  return runtime.state.openKeyedStoreV2<DelegatedTokenState>(
    {
      namespace: resolveMSTeamsAccountStateNamespace(MSTEAMS_DELEGATED_TOKEN_NAMESPACE, accountId),
      maxEntries: MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    },
    {
      assertCurrent() {
        if (getMSTeamsRuntime() !== runtime) {
          throw new Error("Microsoft Teams token owner changed");
        }
      },
    },
  );
}

export function normalizeMSTeamsDelegatedTokens(value: unknown): MSTeamsDelegatedTokens | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  // Microsoft explicitly retains old refresh grants after exchange, so a crashed claim can resume.
  const candidate = value as Partial<MSTeamsDelegatedRefreshClaim> &
    Partial<MSTeamsDelegatedTokens>;
  const token = candidate.refreshClaim ? candidate.credential : candidate;
  if (!token) {
    return null;
  }
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
    scopes: token.scopes,
    ...(typeof token.userPrincipalName === "string"
      ? { userPrincipalName: token.userPrincipalName }
      : {}),
  };
}

export async function loadMSTeamsDelegatedTokenState(
  accountId?: string | null,
): Promise<DelegatedTokenState | undefined> {
  return await openDelegatedTokenStore(accountId).lookup(MSTEAMS_DELEGATED_TOKEN_KEY);
}

export async function claimMSTeamsDelegatedTokenRefresh(
  tokens: MSTeamsDelegatedTokens,
  requestKey: string,
  callerKey: string,
  accountId?: string | null,
) {
  const store = openDelegatedTokenStore(accountId);
  const observed = await store.observe(MSTEAMS_DELEGATED_TOKEN_KEY);
  if (!isDeepStrictEqual(normalizeMSTeamsDelegatedTokens(observed.value), tokens)) {
    return undefined;
  }
  const claim = { refreshClaim: randomUUID(), requestKey, callerKey, credential: tokens };
  const result = await store.compareAndApply(MSTEAMS_DELEGATED_TOKEN_KEY, observed.comparison, {
    operation: "update",
    action: "set",
    value: claim,
  });
  if (result.status !== "applied") {
    return undefined;
  }
  return {
    async reject(): Promise<void> {
      const current = await store.observe(MSTEAMS_DELEGATED_TOKEN_KEY);
      if (isDeepStrictEqual(current.value, claim)) {
        await store.compareAndApply(MSTEAMS_DELEGATED_TOKEN_KEY, current.comparison, {
          operation: "update",
          action: "set",
          value: { refreshClaim: claim.refreshClaim, requestKey, callerKey },
        });
      }
    },
    async settle(replacement: MSTeamsDelegatedTokens): Promise<boolean> {
      const current = await store.observe(MSTEAMS_DELEGATED_TOKEN_KEY);
      if (!isDeepStrictEqual(current.value, claim)) {
        return false;
      }
      const normalized = normalizeMSTeamsDelegatedTokens(replacement);
      if (!normalized) {
        throw new Error("Invalid Microsoft Teams delegated token payload");
      }
      const settled = await store.compareAndApply(MSTEAMS_DELEGATED_TOKEN_KEY, current.comparison, {
        operation: "update",
        action: "set",
        value: normalized,
      });
      return settled.status === "applied";
    },
  };
}

export async function loadMSTeamsDelegatedTokens(
  accountId?: string | null,
): Promise<MSTeamsDelegatedTokens | undefined> {
  const stored = await openDelegatedTokenStore(accountId).lookup(MSTEAMS_DELEGATED_TOKEN_KEY);
  return normalizeMSTeamsDelegatedTokens(stored) ?? undefined;
}

export async function saveMSTeamsDelegatedTokens(
  tokens: MSTeamsDelegatedTokens,
  accountId?: string | null,
): Promise<void> {
  const normalized = normalizeMSTeamsDelegatedTokens(tokens);
  if (!normalized) {
    throw new Error("Invalid Microsoft Teams delegated token payload");
  }
  await openDelegatedTokenStore(accountId).register(MSTEAMS_DELEGATED_TOKEN_KEY, normalized);
}
