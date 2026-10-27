import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from "@slack/bolt";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isSlackCallbackActionId,
  SLACK_REPLY_BUTTON_ACTION_ID,
  SLACK_REPLY_LINK_ACTION_ID,
  SLACK_REPLY_SELECT_ACTION_ID,
  SLACK_SESSION_LINK_ACTION_ID,
} from "../../reply-action-ids.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { summarizeAction, type SlackActionSummary } from "./modal-input-summary.js";

type SlackBlockActionBody = {
  user?: { id?: string };
  team?: { id?: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] };
};

export type SlackBlockActionRespond = NonNullable<SlackActionMiddlewareArgs["respond"]>;
export type SlackBlockActionHandlerArgs = SlackActionMiddlewareArgs &
  Pick<AllMiddlewareArgs, "context" | "client">;

export type ParsedSlackBlockAction = {
  typedBody: SlackBlockActionBody;
  typedAction: Record<string, unknown>;
  typedActionWithText: {
    action_id?: string;
    action_ts?: string;
    block_id?: string;
    type?: string;
    text?: { text?: string };
  };
  actionId: string;
  blockId?: string;
  userId: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  actionSummary: SlackActionSummary;
};

export type SlackBlockActionContext = {
  ctx: SlackMonitorContext;
  eventScope?: SlackEventScope;
  parsed: ParsedSlackBlockAction;
  respond?: SlackBlockActionRespond;
};

export function resolveSlackActionValue(summary: SlackActionSummary): string | undefined {
  return normalizeOptionalString(summary.value) ?? summary.selectedValues?.[0];
}

export function buildSlackPluginInteractionData(params: {
  actionId: string;
  summary: SlackActionSummary;
}): string | null {
  const actionId = normalizeOptionalString(params.actionId) ?? "";
  if (!actionId) {
    return null;
  }
  const payload = resolveSlackActionValue(params.summary) ?? "";
  if (isSlackReplyActionId(actionId) || isSlackCallbackActionId(actionId)) {
    return payload || null;
  }
  return payload ? `${actionId}:${payload}` : actionId;
}

export function isSlackReplyActionId(actionId: string): boolean {
  return (
    actionId === SLACK_REPLY_BUTTON_ACTION_ID ||
    actionId === SLACK_REPLY_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_REPLY_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_REPLY_SELECT_ACTION_ID}:`)
  );
}

export function isSlackReplyLinkAction(parsed: ParsedSlackBlockAction): boolean {
  if (parsed.actionId.replace(/:\d+$/u, "") === SLACK_SESSION_LINK_ACTION_ID) {
    return true;
  }
  if (
    parsed.actionId === SLACK_REPLY_LINK_ACTION_ID ||
    parsed.actionId.startsWith(`${SLACK_REPLY_LINK_ACTION_ID}:`)
  ) {
    return true;
  }
  const legacyUrl = normalizeOptionalString(parsed.typedAction.url);
  return Boolean(legacyUrl && isSlackReplyActionId(parsed.actionId));
}

export function buildSlackPluginInteractionId(parsed: ParsedSlackBlockAction): string {
  return [
    normalizeOptionalString(parsed.userId) ?? "",
    normalizeOptionalString(parsed.channelId) ?? "",
    normalizeOptionalString(parsed.messageTs) ?? "",
    normalizeOptionalString(parsed.typedBody.trigger_id) ?? "",
    normalizeOptionalString(parsed.actionId) ?? "",
    resolveSlackActionValue(parsed.actionSummary) ?? "",
  ].join(":");
}

export function parseSlackBlockAction(params: {
  body: unknown;
  action: unknown;
  log?: (message: string) => void;
}): ParsedSlackBlockAction | null {
  // SAFETY: The Bolt action listener supplies the Slack-owned body; this projection reads only its optional interaction fields.
  const typedBody = params.body as SlackBlockActionBody;
  const typedAction = asOptionalRecord(params.action);
  if (!typedAction) {
    params.log?.(
      `slack:interaction malformed action payload channel=${typedBody.channel?.id ?? typedBody.container?.channel_id ?? "unknown"} user=${
        typedBody.user?.id ?? "unknown"
      }`,
    );
    return null;
  }
  // SAFETY: Bolt owns action metadata and plain-text labels; the record check above rejects absent action payloads.
  const typedActionWithText = typedAction as ParsedSlackBlockAction["typedActionWithText"];
  return {
    typedBody,
    typedAction,
    typedActionWithText,
    actionId:
      typeof typedActionWithText.action_id === "string" ? typedActionWithText.action_id : "unknown",
    blockId: typedActionWithText.block_id,
    userId: typedBody.user?.id ?? "unknown",
    channelId: typedBody.channel?.id ?? typedBody.container?.channel_id,
    messageTs: typedBody.message?.ts ?? typedBody.container?.message_ts,
    threadTs: typedBody.container?.thread_ts ?? typedBody.message?.thread_ts,
    actionSummary: summarizeAction(typedAction),
  };
}
