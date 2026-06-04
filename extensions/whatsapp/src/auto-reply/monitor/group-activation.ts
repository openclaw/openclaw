import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppLegacyGroupSessionKey } from "../../group-session-key.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import { loadSessionStore, resolveStorePath } from "../config.runtime.js";
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

function isRealSessionEntry(entry: SessionEntry | undefined): entry is SessionEntry {
  return typeof entry?.sessionId === "string" && typeof entry?.updatedAt === "number";
}

async function patchExistingScopedActivation(params: {
  activation: SessionEntry["groupActivation"];
  scopedEntry: SessionEntry | undefined;
  sessionKey: string;
  storePath: string;
}) {
  if (
    params.scopedEntry?.groupActivation !== undefined ||
    !isRealSessionEntry(params.scopedEntry)
  ) {
    return;
  }

  // Only real scoped session rows get backfilled; legacy activation-only rows
  // remain readable compatibility input, not new steady-state session entries.
  await patchSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    preserveActivity: true,
    update: (entry) => {
      if (entry.groupActivation !== undefined || !isRealSessionEntry(entry)) {
        return null;
      }
      return { groupActivation: params.activation };
    },
  });
}

/** Resolves the WhatsApp group activation policy for one routed group conversation. */
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
  const store = loadSessionStore(storePath);
  const legacySessionKey = resolveWhatsAppLegacyGroupSessionKey({
    sessionKey: params.sessionKey,
    accountId: params.accountId,
  });
  const legacyEntry = legacySessionKey ? store[legacySessionKey] : undefined;
  const scopedEntry = getSessionEntry({
    storePath,
    sessionKey: params.sessionKey,
  });
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const ignoreScopedActivation =
    normalizedAccountId === DEFAULT_ACCOUNT_ID &&
    hasNamedWhatsAppAccounts(params.cfg) &&
    isActivationOnlyEntry(scopedEntry);
  const activation =
    (ignoreScopedActivation ? undefined : scopedEntry?.groupActivation) ??
    legacyEntry?.groupActivation;
  const normalizedActivation = normalizeGroupActivation(activation);
  if (normalizedActivation !== undefined) {
    await patchExistingScopedActivation({
      activation: normalizedActivation,
      scopedEntry,
      sessionKey: params.sessionKey,
      storePath,
    });
  }
  const requireMention = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  }).resolveConversationRequireMention(params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizedActivation ?? defaultActivation;
}
