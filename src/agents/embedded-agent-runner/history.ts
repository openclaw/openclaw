/**
 * Limits embedded-agent history length from session-key policy.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { resolveNormalizedAccountEntry } from "../../routing/account-lookup.js";
import type { AgentMessage } from "../runtime/index.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

function isSessionHistoryPrelude(message: AgentMessage | undefined): boolean {
  return Boolean(
    message &&
    (message as AgentMessage & { [SESSION_HISTORY_PRELUDE]?: true })[SESSION_HISTORY_PRELUDE],
  );
}

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to recent user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 *
 * Leading non-conversation messages (e.g. compactionSummary, branchSummary)
 * placed at index 0 by buildSessionContext are always preserved, since they
 * carry summarized pre-compaction context that history limiting must not drop.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  // Preserve leading non-conversation messages (compactionSummary, branchSummary, etc.)
  // that buildSessionContext places at index 0 to carry pre-compaction context.
  let conversationStart = 0;
  while (conversationStart < messages.length) {
    if (isSessionHistoryPrelude(messages[conversationStart])) {
      conversationStart++;
      continue;
    }
    const role = messages.at(conversationStart)?.role;
    if (role === "user" || role === "assistant") {
      break;
    }
    conversationStart++;
  }

  const tail = messages.slice(conversationStart);
  if (tail.length === 0) {
    return messages;
  }

  let userCount = 0;
  for (const message of tail) {
    if (message.role === "user") {
      userCount++;
    }
  }

  // Allow a 50% cushion, then evict a full batch so the prompt-cache prefix stays
  // stable between cuts; up to 1.5x turns trades strictness for amortized cache reuse.
  const targetUserTurns = Math.floor(limit);
  const maxUserTurns = Math.ceil(targetUserTurns * 1.5);
  if (userCount <= maxUserTurns) {
    return messages;
  }
  const evictionBatchSize = maxUserTurns - targetUserTurns + 1;
  const userTurnsToKeep = targetUserTurns + ((userCount - targetUserTurns) % evictionBatchSize);

  userCount = 0;
  let lastUserIndex = tail.length;

  for (const [i, message] of Array.from(tail.entries()).toReversed()) {
    if (message.role === "user") {
      userCount++;
      if (userCount > userTurnsToKeep) {
        return [...messages.slice(0, conversationStart), ...tail.slice(lastUserIndex)];
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/** Raw channel-config fields this resolver reads, at channel root or under `accounts.<id>`. */
type HistoryLimitChannelConfig = {
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, { historyLimit?: number }>;
  accounts?: Record<string, HistoryLimitChannelConfig | undefined>;
};

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 * For channel/group sessions, uses historyLimit from provider config.
 * Account-scoped values override the channel root for that account.
 */
export function getHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
  accountId?: string | null,
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = normalizeProviderId(providerParts[0] ?? "");
  if (!provider) {
    return undefined;
  }

  const kind = normalizeOptionalLowercaseString(providerParts[1]);
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ): HistoryLimitChannelConfig | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    for (const [configuredProviderId, value] of Object.entries(
      channels as Record<string, unknown>,
    )) {
      if (normalizeProviderId(configuredProviderId) !== providerId) {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      return value as HistoryLimitChannelConfig;
    }
    return undefined;
  };

  const providerConfig = resolveProviderConfig(config, provider);
  if (!providerConfig) {
    return undefined;
  }

  // Channel schemas accept these keys at the channel root and under `accounts.<id>`,
  // so an account value must win for that account or it validates and is silently
  // ignored. The routed account id is canonical, while config keys are operator
  // text, so both sides normalize before matching (`accounts["Work Team"]` must
  // match the routed `work-team`).
  const trimmedAccountId = accountId?.trim();
  const accountConfig = trimmedAccountId
    ? resolveNormalizedAccountEntry(
        providerConfig.accounts,
        normalizeAccountId(trimmedAccountId),
        normalizeAccountId,
      )
    : undefined;

  // For DM sessions: per-DM override -> dmHistoryLimit.
  // Accept both "direct" (new) and "dm" (legacy) for backward compat.
  if (kind === "dm" || kind === "direct") {
    if (userId) {
      const perDmLimit =
        accountConfig?.dms?.[userId]?.historyLimit ?? providerConfig.dms?.[userId]?.historyLimit;
      if (perDmLimit !== undefined) {
        return perDmLimit;
      }
    }
    return accountConfig?.dmHistoryLimit ?? providerConfig.dmHistoryLimit;
  }

  // For channel/group sessions: use historyLimit from provider config
  // This prevents context overflow in long-running channel sessions
  if (kind === "channel" || kind === "group") {
    return accountConfig?.historyLimit ?? providerConfig.historyLimit;
  }

  return undefined;
}
