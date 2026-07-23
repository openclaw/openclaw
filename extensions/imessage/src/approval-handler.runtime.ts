// Imessage plugin module implements approval handler behavior.
import {
  buildChannelApprovalExpiredText,
  buildChannelApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
  type PendingApprovalView,
  resolvePreparedApprovalAccountId,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildApprovalReactionHint,
  buildApprovalReactionPendingContent,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveIMessageAccount } from "./accounts.js";
import {
  buildApprovalPollOptions,
  mapSentPollOptionsToDecisions,
  registerIMessageApprovalPollTarget,
  unregisterIMessageApprovalPollTarget,
} from "./approval-polls.js";
import {
  buildIMessageApprovalConversationKeyForTarget,
  registerIMessageApprovalReactionTarget,
  unregisterIMessageApprovalReactionTarget,
  type IMessageApprovalConversationKey,
} from "./approval-reactions.js";
import { normalizeIMessageMessagingTarget } from "./normalize.js";
import { getCachedIMessagePrivateApiStatus } from "./probe.js";
import { sendMessageIMessage } from "./send.js";
import { parseIMessageTarget } from "./targets.js";

const log = createSubsystemLogger("imessage/approvals");

const loadIMessageActionsRuntime = createLazyRuntimeNamedExport(
  () => import("./actions.runtime.js"),
  "imessageActionsRuntime",
);

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type IMessagePendingDelivery = {
  /** Prompt text carrying the tapback hint; used when no poll will be sent. */
  text: string;
  /**
   * Poll-mode prompt: no tapback hint and no `/approve` fences, because the
   * poll balloon already renders every decision. Keeps id/command/expiry.
   */
  hintlessText: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};
type PreparedIMessageApprovalTarget = {
  to: string;
  accountId?: string;
};
type PendingIMessageApprovalEntry = {
  accountId?: string;
  to: string;
  conversation: IMessageApprovalConversationKey;
  messageId: string;
  /** Follow-up carrying the tapback hint when an expected poll failed to send. */
  hintMessageId?: string;
  poll?: {
    pollGuid: string;
    optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
  };
};
type IMessageFinalPayload = {
  text: string;
};

function buildPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): IMessagePendingDelivery {
  const pendingContent = buildApprovalReactionPendingContent({
    request: params.request,
    view: params.view as never,
    nowMs: params.nowMs,
  });
  const pollContent = buildApprovalReactionPendingContent({
    request: params.request,
    view: params.view as never,
    nowMs: params.nowMs,
    omitDecisionCommands: true,
  });
  return {
    text: pendingContent.reactionPayload.text ?? "",
    // manualFallbackPayload is the same prompt minus the "React with:" block,
    // so the poll can own the controls without re-deriving the prompt text.
    hintlessText: pollContent.manualFallbackPayload.text ?? "",
    allowedDecisions: pendingContent.reactionPayload.allowedDecisions,
  };
}

/**
 * Cache-only capability check, run before the prompt is sent so the tapback hint
 * can be omitted up front. Deliberately never probes: a probe spawns imsg and
 * would put seconds of latency in front of an approval prompt. An available
 * bridge status is cached for the process lifetime (see probe.ts), so the only
 * cost of a cold cache is that the first approval after start uses tapbacks.
 */
function canIMessageApprovalUsePoll(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): boolean {
  // Messages requires at least two options; a single-decision approval stays
  // text-only rather than being padded with a fake choice.
  if (buildApprovalPollOptions({ allowedDecisions: params.allowedDecisions }).length < 2) {
    return false;
  }
  try {
    const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.target.accountId });
    const cliPath = account.config.cliPath?.trim() || "imsg";
    return getCachedIMessagePrivateApiStatus(cliPath)?.selectors?.pollPayloadMessage === true;
  } catch {
    return false;
  }
}

function resolveIMessageApprovalCliOptions(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
}): { cliPath: string; dbPath?: string; timeoutMs?: number } {
  const account = resolveIMessageAccount({ cfg: params.cfg, accountId: params.target.accountId });
  return {
    cliPath: account.config.cliPath?.trim() || "imsg",
    dbPath: account.config.dbPath?.trim() || undefined,
    timeoutMs: account.config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  };
}

/**
 * imsg always echoes the poll question as a separate caption message, so keep
 * it to a short label. The pending command is already rendered in full on the
 * prompt directly above the balloon; repeating it here just doubles the text.
 */
function buildIMessageApprovalPollCaption(view: PendingApprovalView): string {
  return `Approve ${view.approvalId.slice(0, 8)}?`;
}

/**
 * Send the poll balloon threaded under the already-delivered prompt. Runs AFTER
 * the prompt so no bridge call ever delays approval delivery; a failure here
 * leaves the prompt intact and the caller restores the tapback hint.
 *
 * Conversation-read authority: `chatGuid` is resolved from the approval's own
 * routing target (origin session or a configured approver), so this read is
 * host-originated, not delegated. The bridge runtime seam does not yet accept
 * an attested `conversationReadOrigin` the way `sendMessageIMessage` does; the
 * safety here rests on the target never being caller-supplied. Route this
 * through the attested seam once it exists rather than widening the target.
 *
 * The question stays short on purpose: imsg echoes it as a separate best-effort
 * caption message and the poll payload is capped at 4096 bytes, so the full
 * approval text must remain on the prompt message instead.
 */
async function deliverIMessageApprovalPoll(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
  promptMessageId: string;
  caption: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): Promise<{
  pollGuid: string;
  chatGuid: string;
  optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
} | null> {
  const options = buildApprovalPollOptions({ allowedDecisions: params.allowedDecisions });
  try {
    const cliOptions = resolveIMessageApprovalCliOptions({
      cfg: params.cfg,
      target: params.target,
    });
    const chatGuid = await resolveIMessageApprovalChatGuid({
      to: params.target.to,
      cliOptions,
    });
    if (!chatGuid) {
      return null;
    }
    const runtime = await loadIMessageActionsRuntime();
    const sent = await runtime.sendPoll({
      chatGuid,
      question: params.caption,
      choices: options.map((option) => option.text),
      replyToMessageId: params.promptMessageId,
      options: { ...cliOptions, chatGuid },
    });
    const pollGuid = sent.messageId.trim();
    // resolveMessageId falls back to "ok" when the bridge returns no id; without
    // a real GUID an inbound vote can never be correlated back to this poll.
    if (!pollGuid || pollGuid === "ok" || pollGuid === "unknown") {
      return null;
    }
    const optionDecisions = mapSentPollOptionsToDecisions({
      requested: options,
      sent: sent.pollOptions,
    });
    return optionDecisions.length > 0 ? { pollGuid, chatGuid, optionDecisions } : null;
  } catch (error) {
    log.warn(`imessage approvals: poll send failed, falling back to tapbacks: ${String(error)}`);
    return null;
  }
}

/**
 * Polls must target a chat Messages already knows. Unlike send, we never
 * synthesize an unregistered DM identifier here: the bridge would reject it and
 * the poll would be lost.
 */
async function resolveIMessageApprovalChatGuid(params: {
  to: string;
  cliOptions: { cliPath: string; dbPath?: string; timeoutMs?: number };
}): Promise<string | null> {
  const target = parseIMessageTarget(params.to);
  if (target.kind === "chat_guid") {
    return target.chatGuid;
  }
  const runtime = await loadIMessageActionsRuntime();
  if (target.kind === "chat_id" || target.kind === "chat_identifier") {
    return await runtime.resolveChatGuidForTarget({ target, options: params.cliOptions });
  }
  if (target.kind !== "handle") {
    return null;
  }
  const service = target.service === "sms" ? "SMS" : "iMessage";
  return await runtime.resolveChatGuidForTarget({
    target: { kind: "chat_identifier", chatIdentifier: `${service};-;${target.to}` },
    options: params.cliOptions,
  });
}

/**
 * The prompt already went out without its tapback hint because a poll was
 * expected. Send the hint as a threaded follow-up and return its GUID so the
 * caller can bind a reaction target to it — an unbound hint would invite a
 * tapback that resolves nothing.
 */
async function recoverIMessageApprovalReactionHint(params: {
  cfg: OpenClawConfig;
  target: PreparedIMessageApprovalTarget;
  promptMessageId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): Promise<string | undefined> {
  const hint = buildApprovalReactionHint({ allowedDecisions: params.allowedDecisions });
  if (!hint) {
    return undefined;
  }
  try {
    const result = await sendMessageIMessage(params.target.to, hint, {
      config: params.cfg,
      // Same host-originated authority as the prompt it follows up.
      conversationReadOrigin: "direct-operator",
      ...(params.target.accountId ? { accountId: params.target.accountId } : {}),
      replyToId: params.promptMessageId,
    });
    return result.guid;
  } catch (error) {
    log.error(`imessage approvals: reaction-hint recovery failed: ${String(error)}`);
    return undefined;
  }
}

/** Clear both controls together; a stale binding would resolve a dead approval. */
function clearIMessageApprovalBindings(entry: PendingIMessageApprovalEntry): void {
  const accountId = entry.accountId?.trim();
  if (!accountId) {
    return;
  }
  for (const messageId of [entry.messageId, entry.hintMessageId]) {
    if (messageId) {
      unregisterIMessageApprovalReactionTarget({
        accountId,
        conversation: entry.conversation,
        messageId,
      });
    }
  }
  if (entry.poll) {
    unregisterIMessageApprovalPollTarget({
      accountId,
      conversation: entry.conversation,
      pollGuid: entry.poll.pollGuid,
    });
  }
}

function shouldThreadApprovalUpdate(to: string): boolean {
  try {
    const parsed = parseIMessageTarget(to);
    if (parsed.kind === "handle" && parsed.service === "sms") {
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

export const imessageApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  IMessagePendingDelivery,
  PreparedIMessageApprovalTarget,
  PendingIMessageApprovalEntry,
  true,
  IMessageFinalPayload
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: ({ context }) => Boolean(context),
    shouldHandle: ({ context }) => Boolean(context),
  },
  presentation: {
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) =>
      buildPendingPayload({ request, approvalKind, nowMs, view }),
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalResolvedText({ request, resolved, view }) },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: { text: buildChannelApprovalExpiredText({ request, view }) },
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget, accountId }) => {
      const to = normalizeIMessageMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const prepared: PreparedIMessageApprovalTarget = {
        to,
        accountId: resolvePreparedApprovalAccountId({
          plannedAccountId: (plannedTarget.target as { accountId?: string | null }).accountId,
          contextAccountId: accountId,
        }),
      };
      return {
        dedupeKey: `${prepared.accountId ?? ""}:${buildChannelApprovalNativeTargetKey({
          to: prepared.to,
        })}`,
        target: prepared,
      };
    },
    deliverPending: async ({ cfg, preparedTarget, pendingPayload, view }) => {
      // Cache-only, so nothing here delays the prompt. When true we drop the
      // tapback hint because the poll will carry the controls; if the poll then
      // fails we send the hint as a bound follow-up below.
      const expectPoll = canIMessageApprovalUsePoll({
        cfg,
        target: preparedTarget,
        allowedDecisions: pendingPayload.allowedDecisions,
      });
      const promptText = expectPoll ? pendingPayload.hintlessText : pendingPayload.text;
      const result = await sendMessageIMessage(preparedTarget.to, promptText, {
        config: cfg,
        approvalKind: view.approvalKind,
        // Approval delivery is host-originated: the target comes from the
        // approval's own routing (origin session or a configured approver),
        // never from model input. Attest that so #99905's conversation-read
        // policy sees the real authority instead of failing closed to
        // "delegated". If the target ever becomes caller-influenced, this
        // must go back to delegated.
        conversationReadOrigin: "direct-operator",
        ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
      });
      // Approval reaction bindings must use the GUID-only id (matches the
      // inbound tapback's `reacted_to_guid`). When the bridge only returned a
      // numeric ROWID / `ok` / `unknown`, `result.guid` is undefined — refuse
      // to bind so the reaction shortcut won't silently miss a real tap.
      // Bailing here after a hintless prompt is not a dead end: that text still
      // carries the `/approve <id> <decision>` line.
      const guid = result.guid;
      if (!guid) {
        return null;
      }
      const conversation = buildIMessageApprovalConversationKeyForTarget(preparedTarget.to);
      if (!conversation) {
        return null;
      }
      const poll = expectPoll
        ? await deliverIMessageApprovalPoll({
            cfg,
            target: preparedTarget,
            promptMessageId: guid,
            caption: buildIMessageApprovalPollCaption(view),
            allowedDecisions: pendingPayload.allowedDecisions,
          })
        : null;
      const hintMessageId =
        expectPoll && !poll
          ? await recoverIMessageApprovalReactionHint({
              cfg,
              target: preparedTarget,
              promptMessageId: guid,
              allowedDecisions: pendingPayload.allowedDecisions,
            })
          : undefined;
      return {
        ...(preparedTarget.accountId ? { accountId: preparedTarget.accountId } : {}),
        to: preparedTarget.to,
        // The poll knows the canonical chat GUID; fold it in so an inbound vote
        // keyed by chat still matches a binding registered from a bare handle.
        conversation: poll ? { ...conversation, chatGuid: poll.chatGuid } : conversation,
        messageId: guid,
        ...(hintMessageId ? { hintMessageId } : {}),
        ...(poll
          ? { poll: { pollGuid: poll.pollGuid, optionDecisions: poll.optionDecisions } }
          : {}),
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      await sendMessageIMessage(entry.to, payload.text, {
        config: cfg,
        // The entry and reply target were created by this host-owned approval
        // delivery. Preserve that authority when cache/database proof is gone.
        conversationReadOrigin: "direct-operator",
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
        ...(shouldThreadApprovalUpdate(entry.to) ? { replyToId: entry.messageId } : {}),
      });
    },
  },
  interactions: {
    bindPending: ({ entry, request, view, pendingPayload }) => {
      const accountId = entry.accountId?.trim();
      if (!accountId) {
        // An empty accountId would silently fail buildReactionTargetKey and
        // leave the prompt with no way to be resolved via reaction. Surface
        // this loudly instead of returning null with no signal.
        log.error(
          `imessage approvals: refusing to bind reaction target for ${request.id}; missing accountId in prepared entry`,
        );
        return null;
      }
      // If the approval is already past expiry by the time we bind (clock skew
      // or delayed delivery), don't pretend to honor a 1ms TTL — refuse the
      // binding so callers see an honest "no binding" and the prompt remains
      // resolvable only via the /approve text fallback.
      const ttlMs = view.expiresAtMs - Date.now();
      if (ttlMs <= 0) {
        log.error(
          `imessage approvals: refusing to bind reaction target for ${request.id}; approval already expired at bind time`,
        );
        return null;
      }
      // Bind the prompt and, when the poll failed, the hint follow-up too: the
      // hint tells the approver to react, so that message must be reactable.
      const reactionBound = [entry.messageId, entry.hintMessageId]
        .filter((messageId): messageId is string => Boolean(messageId))
        .map((messageId) =>
          registerIMessageApprovalReactionTarget({
            accountId,
            conversation: entry.conversation,
            messageId,
            approvalId: request.id,
            approvalKind: view.approvalKind,
            allowedDecisions: pendingPayload.allowedDecisions,
            ttlMs,
          }),
        )
        .some(Boolean);
      const pollBound = entry.poll
        ? registerIMessageApprovalPollTarget({
            accountId,
            conversation: entry.conversation,
            pollGuid: entry.poll.pollGuid,
            approvalId: request.id,
            approvalKind: view.approvalKind,
            optionDecisions: entry.poll.optionDecisions,
            expiresAtMs: view.expiresAtMs,
          })
        : false;
      return reactionBound || pollBound ? true : null;
    },
    unbindPending: ({ entry }) => {
      clearIMessageApprovalBindings(entry);
    },
    cancelDelivered: ({ entry }) => {
      clearIMessageApprovalBindings(entry);
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`imessage approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
