import type { RunEmbeddedAgentParams } from "./run/params.js";

type EmbeddedMessageDeliveryRouteSource = Pick<
  RunEmbeddedAgentParams,
  | "messageChannel"
  | "messageProvider"
  | "messageTo"
  | "currentMessagingTarget"
  | "currentChannelId"
  | "agentAccountId"
  | "messageThreadId"
  | "currentThreadTs"
>;

/** Resolves the canonical originating route shared by embedded delivery paths. */
export function resolveEmbeddedMessageDeliveryRoute(params: EmbeddedMessageDeliveryRouteSource) {
  return {
    channel: params.messageChannel ?? params.messageProvider,
    to: params.messageTo ?? params.currentMessagingTarget ?? params.currentChannelId,
    accountId: params.agentAccountId,
    threadId: params.messageThreadId ?? params.currentThreadTs,
  };
}
