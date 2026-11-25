import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { SlackEventScope } from "./event-scope.js";

export function resolveSlackAgentRoute(
  params: Pick<Parameters<typeof resolveAgentRoute>[0], "cfg" | "defaultAgentId" | "teamId"> & {
    accountId: string;
    peer: { kind: "direct" | "group" | "channel"; id: string };
    eventScope?: Pick<SlackEventScope, "teamId">;
  },
) {
  const route = resolveAgentRoute({
    cfg: params.cfg,
    defaultAgentId: params.defaultAgentId,
    channel: "slack",
    accountId: params.accountId,
    teamId: params.teamId,
    peer: {
      kind: params.peer.kind,
      id: qualifySlackRoutePeerId({
        id: params.peer.id,
        kind: params.peer.kind === "direct" ? "user" : "channel",
        eventScope: params.eventScope,
      }),
    },
  });
  if (!params.eventScope || params.peer.kind !== "direct" || route.dmScope !== "main") {
    return route;
  }
  const accountId = encodeURIComponent(params.accountId).toLowerCase();
  const teamId = encodeURIComponent(params.eventScope.teamId).toLowerCase();
  const sessionKey = `${route.sessionKey}:account:${accountId}:team:${teamId}`;
  return { ...route, sessionKey, mainSessionKey: sessionKey };
}

export function qualifySlackRoutePeerId(params: {
  id: string;
  kind: "user" | "channel";
  eventScope?: Pick<SlackEventScope, "teamId">;
}): string {
  if (!params.eventScope) {
    return params.id;
  }
  return `team:${encodeURIComponent(params.eventScope.teamId)}:${params.kind}:${encodeURIComponent(params.id)}`;
}

export function qualifySlackConversationId(
  conversationId: string,
  eventScope?: Pick<SlackEventScope, "teamId">,
): string {
  return eventScope
    ? `team:${encodeURIComponent(eventScope.teamId)}:${conversationId}`
    : conversationId;
}
