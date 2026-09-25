// Slack plugin module owns session routing for non-message events.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMessageEvent } from "../types.js";
import { normalizeSlackChannelType, resolveSlackChatType } from "./channel-type.js";
import type { SlackEventScope } from "./event-scope.js";
import {
  qualifySlackConversationId,
  qualifySlackRoutePeerId,
  resolveSlackEnterpriseMainDmSessionKey,
} from "./workspace-routing.js";

type SlackSystemEventSessionKeyParams = {
  channelId?: string | null;
  channelType?: string | null;
  senderId?: string | null;
  threadTs?: string | null;
  eventScope?: SlackEventScope;
};

export function createSlackSystemEventRouteResolver(params: {
  cfg: OpenClawConfig;
  accountId: string;
  getTeamId: () => string;
  mainKey: string;
  threadInheritParent: boolean;
  recallSlackChannelType: (
    channelId: string | null | undefined,
    eventScope?: SlackEventScope,
  ) => SlackMessageEvent["channel_type"] | undefined;
}) {
  return (event: SlackSystemEventSessionKeyParams) => {
    const channelId = normalizeOptionalString(event.channelId) ?? "";
    const senderId = normalizeOptionalString(event.senderId) ?? "";
    // System events can omit channel_type too; prefer a type already seen on events
    // for this channel over C-prefix inference so they key the same session (#102676).
    const channelType = normalizeSlackChannelType(
      event.channelType ?? params.recallSlackChannelType(channelId, event.eventScope),
      channelId,
    );
    const isDirectMessage = channelType === "im";
    if (!channelId && (!isDirectMessage || !senderId)) {
      const route = resolveAgentRoute({
        cfg: params.cfg,
        channel: "slack",
        accountId: params.accountId,
        teamId: event.eventScope?.teamId ?? params.getTeamId(),
      });
      return { agentId: route.agentId, sessionKey: params.mainKey };
    }
    const peerId = isDirectMessage ? senderId : channelId;
    if (!peerId) {
      throw new Error("Slack system event route requires a peer");
    }
    let route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "slack",
      accountId: params.accountId,
      teamId: event.eventScope?.teamId ?? params.getTeamId(),
      peer: {
        kind: resolveSlackChatType(channelType),
        id: qualifySlackRoutePeerId({
          id: peerId,
          kind: isDirectMessage ? "user" : "channel",
          eventScope: event.eventScope,
        }),
      },
    });
    if (event.eventScope && isDirectMessage && route.dmScope === "main") {
      const sessionKey = resolveSlackEnterpriseMainDmSessionKey({
        baseSessionKey: route.sessionKey,
        accountId: params.accountId,
        eventScope: event.eventScope,
      });
      route = { ...route, sessionKey, mainSessionKey: sessionKey };
    }

    const threadTs = normalizeOptionalString(event.threadTs);
    const baseConversationId = qualifySlackConversationId(
      isDirectMessage ? `user:${senderId}` : channelId,
      event.eventScope,
    );
    const threadBindingRoute =
      !event.eventScope && threadTs
        ? resolveRuntimeConversationBindingRoute({
            route,
            conversation: {
              channel: "slack",
              accountId: params.accountId,
              conversationId: threadTs,
              parentConversationId: baseConversationId,
            },
          })
        : null;
    const runtimeRoute = event.eventScope
      ? { route, bindingRecord: null, boundSessionKey: undefined }
      : threadBindingRoute?.boundSessionKey || threadBindingRoute?.bindingRecord
        ? threadBindingRoute
        : resolveRuntimeConversationBindingRoute({
            route,
            conversation: {
              channel: "slack",
              accountId: params.accountId,
              conversationId: baseConversationId,
            },
          });
    if (runtimeRoute.boundSessionKey) {
      return runtimeRoute.route;
    }
    const sessionKey = resolveThreadSessionKeys({
      baseSessionKey: runtimeRoute.route.sessionKey,
      threadId: threadTs,
      parentSessionKey:
        threadTs && params.threadInheritParent ? runtimeRoute.route.sessionKey : undefined,
    }).sessionKey;
    return { agentId: runtimeRoute.route.agentId, sessionKey };
  };
}
