import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  MSTEAMS_DELEGATED_TOKEN_KEY,
  MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
  MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
  normalizeMSTeamsDelegatedTokens,
} from "./delegated-token-contract.js";
import type { MSTeamsDelegatedTokens } from "./oauth.shared.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { resolveMSTeamsAccountStateNamespace } from "./sqlite-state.js";

function openDelegatedTokenStore(
  accountId?: string | null,
): PluginStateKeyedStore<MSTeamsDelegatedTokens> {
  return getMSTeamsRuntime().state.openKeyedStore<MSTeamsDelegatedTokens>({
    namespace: resolveMSTeamsAccountStateNamespace(MSTEAMS_DELEGATED_TOKEN_NAMESPACE, accountId),
    maxEntries: MSTEAMS_DELEGATED_TOKEN_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
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
