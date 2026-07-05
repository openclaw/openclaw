// Whatsapp plugin module implements group activation behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
<<<<<<< HEAD
import {
  getSessionEntry,
  patchSessionEntry,
  resolveStorePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppLegacyGroupSessionKey } from "../../group-session-key.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
=======
import { updateSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppLegacyGroupSessionKey } from "../../group-session-key.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import { loadSessionStore, resolveStorePath } from "../config.runtime.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import { normalizeGroupActivation } from "./group-activation.runtime.js";

function hasNamedWhatsAppAccounts(cfg: OpenClawConfig) {
  const accountIds = Object.keys(cfg.channels?.whatsapp?.accounts ?? {});
  return accountIds.some((accountId) => normalizeAccountId(accountId) !== DEFAULT_ACCOUNT_ID);
}

function isActivationOnlyEntry(
  entry:
    | {
        groupActivation?: unknown;
        sessionId?: unknown;
        updatedAt?: unknown;
      }
    | undefined,
) {
  return (
    entry?.groupActivation !== undefined &&
    typeof entry?.sessionId !== "string" &&
    typeof entry?.updatedAt !== "number"
  );
}

<<<<<<< HEAD
/** Resolves group activation for a WhatsApp conversation and backfills scoped session metadata. */
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export async function resolveGroupActivationFor(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  agentId: string;
  sessionKey: string;
  conversationId: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
<<<<<<< HEAD
  const sessionScope = { storePath, agentId: params.agentId };
=======
  const store = loadSessionStore(storePath);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const legacySessionKey = resolveWhatsAppLegacyGroupSessionKey({
    sessionKey: params.sessionKey,
    accountId: params.accountId,
  });
<<<<<<< HEAD
  const legacyEntry = legacySessionKey
    ? getSessionEntry({ ...sessionScope, sessionKey: legacySessionKey })
    : undefined;
  const scopedEntry = getSessionEntry({ ...sessionScope, sessionKey: params.sessionKey });
=======
  const legacyEntry = legacySessionKey ? store[legacySessionKey] : undefined;
  const scopedEntry = store[params.sessionKey];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const ignoreScopedActivation =
    normalizedAccountId === DEFAULT_ACCOUNT_ID &&
    hasNamedWhatsAppAccounts(params.cfg) &&
    isActivationOnlyEntry(scopedEntry);
  const activation =
    (ignoreScopedActivation ? undefined : scopedEntry?.groupActivation) ??
    legacyEntry?.groupActivation;
  if (activation !== undefined && scopedEntry?.groupActivation === undefined) {
<<<<<<< HEAD
    // Activation-only backfills must not synthesize session ids or activity.
    // replaceEntry preserves existing scoped metadata while keeping fallback writes sparse.
    await patchSessionEntry({
      ...sessionScope,
      sessionKey: params.sessionKey,
      fallbackEntry: {} as SessionEntry,
      replaceEntry: true,
      update: (entry) => {
        if (entry.groupActivation !== undefined) {
          return null;
        }
        return {
          ...entry,
          groupActivation: activation,
        };
      },
=======
    await updateSessionStore(storePath, (nextStore) => {
      const nextScopedEntry = nextStore[params.sessionKey];
      if (nextScopedEntry?.groupActivation !== undefined) {
        return;
      }
      nextStore[params.sessionKey] = {
        ...nextScopedEntry,
        groupActivation: activation,
      };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    });
  }
  const requireMention = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  }).resolveConversationRequireMention(params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(activation) ?? defaultActivation;
}
