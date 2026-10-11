import type { AllMiddlewareArgs, SlackActionMiddlewareArgs } from "@slack/bolt";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import type { SlackActionSummary } from "./modal-input-summary.js";

export type SlackBlockActionBody = {
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
