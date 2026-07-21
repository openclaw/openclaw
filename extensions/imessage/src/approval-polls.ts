// Native Apple Messages poll bindings for approval prompts.
//
// The tapback path (approval-reactions.ts) stays the prompt's primary control;
// a poll is layered on top when the imsg bridge supports it. Both resolve the
// same approval, so a poll that fails to send is a no-op rather than a fallback.
import {
  createApprovalReactionTargetStore,
  listApprovalReactionBindings,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";
import {
  buildIMessageApprovalConversationKeyForInbound,
  enumerateApprovalTargetKeys,
  normalizeConversationKey,
  normalizeIMessageGuid,
  type IMessageApprovalConversationKey,
} from "./approval-target-keys.js";
import type { IMessagePayload, IMessagePoll } from "./monitor/types.js";
import { getOptionalIMessageRuntime } from "./runtime.js";
import { normalizeIMessageHandle } from "./targets.js";

const TARGET_NAMESPACE = "imessage.approval-polls";
const TOMBSTONE_NAMESPACE = "imessage.approval-poll-tombstones";
const MAX_ENTRIES = 1000;
const DEFAULT_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Messages has no close-poll API, so a resolved approval's balloon stays
 * tappable forever. Tombstones outlive the binding so late taps are swallowed
 * instead of reaching the agent as "Poll vote: ..." prose. Persisted, because a
 * gateway restart must not turn old polls back into chat noise.
 */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const APPROVAL_DECISIONS = new Set<ExecApprovalReplyDecision>([
  "allow-once",
  "allow-always",
  "deny",
]);

/** JSON-safe: option pairs stay an array so the persistent store round-trips. */
type IMessageApprovalPollTarget = {
  approvalId: string;
  approvalKind: "exec" | "plugin";
  optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
};

type IMessageApprovalPollTombstone = { approvalId: string };

const loadApprovalResolver = createLazyRuntimeModule(() => import("./approval-resolver.js"));

function reportPersistentError(error: unknown): void {
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-poll-state" })
      .warn("iMessage persistent approval poll state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break poll approvals.
  }
}

function readPersistedTarget(value: unknown): IMessageApprovalPollTarget | null {
  const target = value as Partial<IMessageApprovalPollTarget> | undefined;
  if (
    !target ||
    typeof target.approvalId !== "string" ||
    (target.approvalKind !== "exec" && target.approvalKind !== "plugin") ||
    !Array.isArray(target.optionDecisions)
  ) {
    return null;
  }
  const optionDecisions = target.optionDecisions.flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return [];
    }
    const [optionId, decision] = pair as [unknown, unknown];
    if (typeof optionId !== "string" || typeof decision !== "string") {
      return [];
    }
    return APPROVAL_DECISIONS.has(decision as ExecApprovalReplyDecision)
      ? [[optionId, decision as ExecApprovalReplyDecision] as const]
      : [];
  });
  return optionDecisions.length > 0
    ? { approvalId: target.approvalId, approvalKind: target.approvalKind, optionDecisions }
    : null;
}

const pollTargets = createApprovalReactionTargetStore<IMessageApprovalPollTarget>({
  namespace: TARGET_NAMESPACE,
  maxEntries: MAX_ENTRIES,
  defaultTtlMs: DEFAULT_TARGET_TTL_MS,
  openStore: (params) => getOptionalIMessageRuntime()?.state.openKeyedStore(params),
  logPersistentError: reportPersistentError,
  readPersistedTarget,
});

const pollTombstones = createApprovalReactionTargetStore<IMessageApprovalPollTombstone>({
  namespace: TOMBSTONE_NAMESPACE,
  maxEntries: MAX_ENTRIES,
  defaultTtlMs: TOMBSTONE_TTL_MS,
  openStore: (params) => getOptionalIMessageRuntime()?.state.openKeyedStore(params),
  logPersistentError: reportPersistentError,
  readPersistedTarget: (value) => {
    const approvalId = (value as { approvalId?: unknown } | undefined)?.approvalId;
    return typeof approvalId === "string" ? { approvalId } : null;
  },
});

/**
 * Poll option labels for an approval, in canonical decision order. Reuses the
 * tapback bindings so the two controls never disagree about which decisions
 * exist or what they are called.
 */
export function buildApprovalPollOptions(params: {
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): Array<{ decision: ExecApprovalReplyDecision; text: string }> {
  return listApprovalReactionBindings(params).map((binding) => ({
    decision: binding.decision,
    text: `${binding.emoji} ${binding.label}`,
  }));
}

/**
 * Match the option ids Messages returned back to decisions. Text only pairs the
 * response against what we asked for; the id is what a later vote is authorized
 * against, since option text in a vote payload is attacker-shaped.
 */
export function mapSentPollOptionsToDecisions(params: {
  requested: ReadonlyArray<{ decision: ExecApprovalReplyDecision; text: string }>;
  sent: ReadonlyArray<{ id: string; text: string }>;
}): Array<readonly [string, ExecApprovalReplyDecision]> {
  const byText = new Map(params.requested.map((option) => [option.text.trim(), option.decision]));
  return params.sent.flatMap((option, index) => {
    // Prefer exact text, fall back to position: the bridge echoes options in the
    // order given, and a trimmed label must not silently drop a decision.
    const decision = byText.get(option.text.trim()) ?? params.requested[index]?.decision;
    return decision ? [[option.id, decision] as const] : [];
  });
}

export function registerIMessageApprovalPollTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
  expiresAtMs: number;
}): boolean {
  const accountId = params.accountId.trim();
  const approvalId = params.approvalId.trim();
  const expiresAtMs = asDateTimestampMs(params.expiresAtMs);
  const ttlMs = expiresAtMs === undefined ? undefined : expiresAtMs - Date.now();
  if (
    !accountId ||
    !approvalId ||
    params.optionDecisions.length === 0 ||
    ttlMs === undefined ||
    ttlMs <= 0
  ) {
    return false;
  }
  const keys = enumerateApprovalTargetKeys({
    accountId,
    conversation: params.conversation,
    messageId: normalizeIMessageGuid(params.pollGuid),
  });
  if (keys.length === 0) {
    return false;
  }
  const target: IMessageApprovalPollTarget = {
    approvalId,
    approvalKind: params.approvalKind,
    optionDecisions: params.optionDecisions,
  };
  for (const key of keys) {
    pollTargets.register(key, target, { ttlMs });
  }
  return true;
}

export function unregisterIMessageApprovalPollTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
  approvalId?: string;
}): void {
  for (const key of enumerateApprovalTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    messageId: normalizeIMessageGuid(params.pollGuid),
  })) {
    pollTargets.delete(key);
    pollTombstones.register(
      key,
      { approvalId: params.approvalId ?? "" },
      { ttlMs: TOMBSTONE_TTL_MS },
    );
  }
}

/**
 * Apple prefixes poll participants by handle class (`e:` email, `p:` phone).
 * normalizeIMessageHandle does not know those, so strip them here rather than
 * widening the shared normalizer used for config and routing.
 */
export function normalizeIMessagePollParticipant(raw: string): string {
  return normalizeIMessageHandle(raw.trim().replace(/^[ep]:/iu, ""));
}

type ApprovalPollVoteEvent = {
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
  optionId: string;
  /** Transport row sender: the only authenticated identity on the event. */
  actorHandle: string;
  claimedParticipant: string;
  selected: boolean;
};

function readPollVoteEvent(message: IMessagePayload): ApprovalPollVoteEvent | null {
  const poll = message.poll as IMessagePoll | null | undefined;
  if (!poll || poll.kind !== "vote") {
    return null;
  }
  const vote = poll.vote;
  if (!vote || typeof vote.option_id !== "string" || typeof vote.participant !== "string") {
    return null;
  }
  const pollGuid = normalizeIMessageGuid(
    (typeof poll.original_guid === "string" && poll.original_guid) ||
      (typeof poll.poll_guid === "string" && poll.poll_guid) ||
      "",
  );
  const optionId = vote.option_id.trim();
  // message.sender is the chat.db row author; vote.participant is decoded from
  // the balloon payload and falls back to that sender upstream, so it must
  // never be the authorization identity on its own.
  const actorHandle = normalizeIMessageHandle((message.sender ?? "").trim());
  if (!pollGuid || !optionId || !actorHandle) {
    return null;
  }
  const conversation = buildIMessageApprovalConversationKeyForInbound({
    chatGuid: message.chat_guid,
    chatIdentifier: message.chat_identifier,
    chatId: message.chat_id,
    isGroup: message.is_group,
    actorHandle,
  });
  if (!normalizeConversationKey(conversation)) {
    return null;
  }
  return {
    conversation,
    pollGuid,
    optionId,
    actorHandle,
    claimedParticipant: normalizeIMessagePollParticipant(vote.participant),
    selected: vote.event_type === "selected",
  };
}

async function lookupPollTarget(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
}): Promise<IMessageApprovalPollTarget | null> {
  for (const key of enumerateApprovalTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    messageId: params.pollGuid,
  })) {
    const target = await pollTargets.lookup(key);
    if (target) {
      return target;
    }
  }
  return null;
}

async function hasTombstone(params: {
  accountId: string;
  conversation: IMessageApprovalConversationKey;
  pollGuid: string;
}): Promise<boolean> {
  for (const key of enumerateApprovalTargetKeys({
    accountId: params.accountId,
    conversation: params.conversation,
    messageId: params.pollGuid,
  })) {
    if (await pollTombstones.lookup(key)) {
      return true;
    }
  }
  return false;
}

function warn(message: string, fields: Record<string, unknown>): void {
  try {
    getOptionalIMessageRuntime()
      ?.logging.getChildLogger({ plugin: "imessage", feature: "approval-polls" })
      .warn(message, fields);
  } catch {
    // Logger surface is optional in tests; never let logging mask the outcome.
  }
}

/**
 * Resolve a pending approval from an inbound native poll vote. Returns true when
 * the event belongs to an approval poll we own, so the monitor can stop it
 * before the ordinary dispatch pipeline renders it as prose.
 */
export async function maybeResolveIMessageApprovalPollVote(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  gatewayUrl?: string;
  logVerboseMessage?: (message: string) => void;
}): Promise<boolean> {
  const event = readPollVoteEvent(params.message);
  if (!event) {
    return false;
  }
  const lookupKey = {
    accountId: params.accountId,
    conversation: event.conversation,
    pollGuid: event.pollGuid,
  };
  const target = await lookupPollTarget(lookupKey);
  if (!target) {
    // Resolved/expired approval polls stay tappable; swallow late taps so they
    // do not reach the agent as chat messages.
    return await hasTombstone(lookupKey);
  }

  // An un-vote is owned but never resolves: it must not emit "removed their
  // vote" prose while the approval is still pending.
  if (!event.selected) {
    return true;
  }
  if (event.claimedParticipant && event.claimedParticipant !== event.actorHandle) {
    warn("approval poll vote participant did not match transport sender", {
      approvalId: target.approvalId,
      actorHandle: event.actorHandle,
    });
    return true;
  }
  const decision = target.optionDecisions.find(([optionId]) => optionId === event.optionId)?.[1];
  if (!decision) {
    params.logVerboseMessage?.(
      `imessage: approval poll vote ignored unknown option id=${target.approvalId}`,
    );
    return true;
  }
  if (getIMessageApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0) {
    params.logVerboseMessage?.(
      `imessage: approval poll vote denied id=${target.approvalId}; polls require explicit approvers`,
    );
    return true;
  }
  const auth = imessageApprovalAuth.authorizeActorAction({
    cfg: params.cfg,
    accountId: params.accountId,
    senderId: event.actorHandle,
    action: "approve",
    approvalKind: target.approvalKind,
  });
  if (!auth.authorized) {
    params.logVerboseMessage?.(
      `imessage: approval poll vote denied id=${target.approvalId} sender=${event.actorHandle}`,
    );
    return true;
  }

  const { isApprovalNotFoundError, resolveIMessageApproval } = await loadApprovalResolver();
  try {
    const result = await resolveIMessageApproval({
      cfg: params.cfg,
      approvalId: target.approvalId,
      approvalKind: target.approvalKind,
      decision,
      senderId: event.actorHandle,
      gatewayUrl: params.gatewayUrl,
    });
    unregisterIMessageApprovalPollTarget({ ...lookupKey, approvalId: target.approvalId });
    params.logVerboseMessage?.(
      `imessage: approval poll vote ${result.applied ? "resolved" : "already resolved"} id=${target.approvalId} sender=${event.actorHandle} decision=${decision}`,
    );
    return true;
  } catch (error) {
    if (isApprovalNotFoundError(error)) {
      unregisterIMessageApprovalPollTarget({ ...lookupKey, approvalId: target.approvalId });
      params.logVerboseMessage?.(
        `imessage: approval poll vote ignored for expired approval id=${target.approvalId}`,
      );
      return true;
    }
    // Keep the binding on a transient gateway/network failure so a retry can
    // still land; only terminal and not-found outcomes clear it.
    warn("approval poll vote failed", {
      approvalId: target.approvalId,
      senderId: event.actorHandle,
      error: String(error),
    });
    return true;
  }
}

export function clearIMessageApprovalPollTargetsForTest(): void {
  pollTargets.clearForTest();
  pollTombstones.clearForTest();
  loadApprovalResolver.clear();
}
