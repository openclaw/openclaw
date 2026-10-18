import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { resolveChannelAccountEntry } from "../../routing/account-lookup.js";
import { resolveLinkedDirectPeerId } from "../../routing/session-key.js";
import type { AgentMessage } from "../runtime/index.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

function stripThreadSuffix(value: string): string {
  return value.match(THREAD_SUFFIX_REGEX)?.[1] ?? value;
}

/**
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

  const conversationStart = messages.findIndex(
    (message) =>
      !(message as AgentMessage & { [SESSION_HISTORY_PRELUDE]?: true })?.[
        SESSION_HISTORY_PRELUDE
      ] &&
      (message?.role === "user" || message?.role === "assistant"),
  );
  if (conversationStart < 0) {
    return messages;
  }
  let userCount = 0;
  for (let i = conversationStart; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
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

  let turnsRemaining = userTurnsToKeep;
  const firstKeptIndex = messages.findLastIndex(
    (message, index) =>
      index >= conversationStart && message?.role === "user" && --turnsRemaining === 0,
  );
  return [
    ...messages.slice(0, conversationStart),
    ...messages.slice(firstKeptIndex < 0 ? messages.length : firstKeptIndex),
  ];
}

/** Raw channel-config fields this resolver reads, at channel root or under `accounts.<id>`. */
type HistoryLimitChannelConfig = {
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, { historyLimit?: number }>;
  accounts?: Record<string, HistoryLimitChannelConfig | undefined>;
};

export function getHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
  route?: { accountId?: string | null; peerId?: string; chatType?: ChatType },
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":");
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = normalizeProviderId(providerParts[0] ?? "");
  if (!provider) {
    return undefined;
  }

  // Account names and linked peers can both contain kind tokens. Enumerate the
  // actual key's interpretations, then use observed route facts to disambiguate;
  // current dmScope cannot describe old sessions or explicit session overrides.
  const candidates = [0, 1].flatMap((accountSegments) => {
    const kind = normalizeChatType(providerParts[1 + accountSegments]);
    const accountId = accountSegments ? providerParts[1] : undefined;
    if (
      !kind ||
      (route?.chatType && kind !== route.chatType) ||
      (accountSegments && kind !== "direct")
    ) {
      return [];
    }
    return [
      {
        kind,
        accountId,
        userId: providerParts.slice(2 + accountSegments).join(":"),
      },
    ];
  });
  const rawPeerId = route?.peerId?.trim();
  const logicalPeerId = rawPeerId
    ? normalizeOptionalLowercaseString(
        resolveLinkedDirectPeerId({
          identityLinks: config.session?.identityLinks,
          channel: provider,
          peerId: rawPeerId,
        }) ?? rawPeerId,
      )
    : undefined;
  const matching = logicalPeerId
    ? candidates.filter(
        (candidate) =>
          candidate.kind !== "direct" ||
          candidate.userId === logicalPeerId ||
          stripThreadSuffix(candidate.userId) === logicalPeerId,
      )
    : candidates;
  const resolved = matching.length === 1 ? matching[0] : undefined;
  const kind =
    resolved?.kind ??
    (candidates.every((candidate) => candidate.kind === candidates[0]?.kind)
      ? candidates[0]?.kind
      : undefined);
  // A linked peer may itself end in :thread:<number>; observed identity wins
  // over the legacy suffix heuristic, including when an actual thread is appended.
  const userId = resolved && (logicalPeerId ?? stripThreadSuffix(resolved.userId));
  // An explicit session override can name another account; the admitted route
  // still owns policy without erasing the key's independently known chat kind.
  const routedAccountId =
    route?.accountId ?? (candidates.length === 1 ? candidates[0]?.accountId : resolved?.accountId);

  const providerConfig = asOptionalRecord(
    Object.entries(config.channels ?? {}).find(
      ([channel]) => normalizeProviderId(channel) === provider,
    )?.[1],
  ) as HistoryLimitChannelConfig | undefined;
  if (!providerConfig) {
    return undefined;
  }

  // Channel schemas accept these keys at the channel root and under `accounts.<id>`,
  // so an account value must win for that account or it validates and is silently
  // ignored. The routed account id is canonical, while config keys are operator
  // text, so both sides normalize before matching (`accounts["Work Team"]` must
  // match the routed `work-team`).
  const trimmedAccountId = routedAccountId?.trim();
  const accountConfig = trimmedAccountId
    ? resolveChannelAccountEntry(
        providerConfig.accounts,
        normalizeAccountId(trimmedAccountId),
        provider,
        normalizeAccountId,
      )
    : undefined;

  if (kind === "direct") {
    // An explicit account `dms` map replaces the root map under the account
    // merge contract, so pick the owning map before indexing. Falling back per
    // entry would leak root per-peer overrides into that account.
    const perDmLimit = userId
      ? (accountConfig?.dms ?? providerConfig.dms)?.[userId]?.historyLimit
      : undefined;
    return perDmLimit !== undefined
      ? perDmLimit
      : (accountConfig?.dmHistoryLimit ?? providerConfig.dmHistoryLimit);
  }

  return kind === "channel" || kind === "group"
    ? (accountConfig?.historyLimit ?? providerConfig.historyLimit)
    : undefined;
}
