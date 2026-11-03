import { isReplyPayloadNonTerminalToolErrorWarning } from "openclaw/plugin-sdk/reply-payload";
import type { GetReplyOptions, MsgContext, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  clearSlackThreadFailureNotice,
  hasSlackThreadFailureNotice,
  hasSlackThreadParticipation,
  recordSlackThreadFailureNotice,
} from "../../sent-thread-cache.js";

type SlackFailurePolicyParams = {
  context: Pick<
    MsgContext,
    "ChatType" | "ExplicitlyMentionedBot" | "MentionSource" | "CommandTurn"
  >;
  accountId: string;
  channelId: string;
  failureNoticeThreadTs?: string;
  failureNoticeTeamId?: string;
  statusThreadTs?: string;
};

/** One outage policy for immediate replies and later origin-routed queue drains. */
export function createSlackFailureNoticePolicy(
  params: SlackFailurePolicyParams,
  hasVisibleReply: () => boolean,
) {
  const {
    context,
    accountId,
    channelId,
    failureNoticeThreadTs,
    failureNoticeTeamId,
    statusThreadTs,
  } = params;
  let sawTerminalFailurePayload = false;
  let pendingFailureNotice:
    | {
        accountId: string;
        channelId: string;
        threadTs?: string;
        failureText: string;
        teamId?: string;
      }
    | undefined;

  const filterPassiveThreadFailure = (payload: ReplyPayload): ReplyPayload | null => {
    if (
      payload.isError !== true ||
      context.ChatType !== "channel" ||
      isReplyPayloadNonTerminalToolErrorWarning(payload)
    ) {
      return payload;
    }
    sawTerminalFailurePayload = true;
    if (hasVisibleReply()) {
      return payload;
    }

    const explicitlyAddressed =
      context.ExplicitlyMentionedBot === true ||
      context.MentionSource === "explicit_bot" ||
      context.MentionSource === "subteam" ||
      context.MentionSource === "mention_pattern" ||
      context.MentionSource === "command_bypass" ||
      (context.CommandTurn?.kind !== undefined &&
        context.CommandTurn.kind !== "normal" &&
        context.CommandTurn.authorized);
    const noticeThreadTs =
      failureNoticeThreadTs ?? (explicitlyAddressed ? statusThreadTs : undefined);

    const notice = {
      accountId,
      channelId,
      ...(noticeThreadTs ? { threadTs: noticeThreadTs } : {}),
      failureText: payload.text ?? "",
      ...(failureNoticeTeamId ? { teamId: failureNoticeTeamId } : {}),
    };
    if (
      failureNoticeThreadTs &&
      !explicitlyAddressed &&
      context.MentionSource !== "implicit_thread" &&
      !hasSlackThreadParticipation(
        notice.accountId,
        notice.channelId,
        failureNoticeThreadTs,
        failureNoticeTeamId,
      )
    ) {
      logVerbose("slack: suppressed passive failure before thread participation");
      return null;
    }

    if (!explicitlyAddressed && hasSlackThreadFailureNotice(notice)) {
      logVerbose("slack: suppressed repeated passive channel or thread failure");
      return null;
    }
    pendingFailureNotice = notice;
    return payload;
  };

  return {
    filter: filterPassiveThreadFailure,
    recordDelivered(payload?: ReplyPayload) {
      if (
        pendingFailureNotice &&
        (!payload ||
          (payload.isError === true &&
            !isReplyPayloadNonTerminalToolErrorWarning(payload) &&
            (payload.text ?? "") === pendingFailureNotice.failureText))
      ) {
        recordSlackThreadFailureNotice(pendingFailureNotice);
        pendingFailureNotice = undefined;
      }
    },
    complete() {
      if (!sawTerminalFailurePayload && context.ChatType === "channel") {
        clearSlackThreadFailureNotice({
          accountId,
          channelId,
          ...(failureNoticeThreadTs ? { threadTs: failureNoticeThreadTs } : {}),
          ...(failureNoticeTeamId ? { teamId: failureNoticeTeamId } : {}),
        });
      }
    },
  };
}

export function createSlackQueuedFailureNoticePolicy(
  params: SlackFailurePolicyParams,
  beginSessionRun: () => () => void,
): NonNullable<GetReplyOptions["queuedDeliveryCorrelations"]>[number] {
  let visibleReplySent = false;
  let policy = createSlackFailureNoticePolicy(params, () => visibleReplySent);
  return {
    begin() {
      // A retry owns fresh run state; the shared thread outage cache survives it.
      visibleReplySent = false;
      policy = createSlackFailureNoticePolicy(params, () => visibleReplySent);
      const release = beginSessionRun();
      return (settlement) => {
        if (settlement?.completed && !settlement.failed && !settlement.transportPending) {
          policy.complete();
        }
        release();
      };
    },
    shouldSuppressReply: (payload) => policy.filter(payload) === null,
    onReplyDelivered(payload) {
      policy.recordDelivered(payload);
      visibleReplySent = true;
    },
  };
}
