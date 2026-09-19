// Slack native argument menus must match current command authorization.
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import {
  authorizeSlackSystemEventSender,
  resolveSlackCommandIngress,
  resolveSlackEffectiveAllowFrom,
} from "./auth.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { resolveSlackChatType, type SlackMonitorContext } from "./context.js";
import { resolveSlackDeferredActionTarget } from "./deferred-action-routing.js";
import type { SlackEventScope } from "./event-scope.js";
import type { SlackExternalArgMenuEntry } from "./external-arg-menu-store.js";

type SlackArgMenuChannelType = "im" | "mpim" | "channel" | "group";

export function isSlackNativeArgMenuAuthorized(params: {
  ctx: SlackMonitorContext;
  eventScope?: SlackEventScope;
  userId: string;
  channelId: string;
  channelType: SlackArgMenuChannelType;
  commandAuthorized: boolean;
}): boolean {
  const { ctx, eventScope, userId, channelId, channelType } = params;
  const isDirectMessage = channelType === "im";
  const isRoom = channelType === "channel" || channelType === "group";
  const routeTarget = resolveSlackDeferredActionTarget({
    eventScope,
    kind: isDirectMessage ? "user" : "channel",
    id: isDirectMessage ? userId : channelId,
  });
  const slashUserTarget = resolveSlackDeferredActionTarget({
    eventScope,
    kind: "user",
    id: userId,
  });
  return resolveCommandAuthorization({
    ctx: {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      AccountId: ctx.accountId,
      ChatType: resolveSlackChatType(channelType),
      From: isDirectMessage
        ? `slack:${routeTarget.peerId}`
        : isRoom
          ? `slack:channel:${routeTarget.peerId}`
          : `slack:group:${routeTarget.peerId}`,
      To: `slash:${slashUserTarget.peerId}`,
      SenderId: userId,
    },
    cfg: ctx.cfg,
    commandAuthorized: params.commandAuthorized,
  }).isAuthorizedSender;
}

export async function isSlackExternalArgMenuRequestAuthorized(params: {
  ctx: SlackMonitorContext;
  eventScope?: SlackEventScope;
  entry: SlackExternalArgMenuEntry;
}): Promise<boolean> {
  const { ctx, eventScope, entry } = params;
  const currentTeamId = eventScope?.teamId ?? ctx.teamId;
  if (
    entry.scope.accountId !== ctx.accountId ||
    !currentTeamId ||
    entry.scope.teamId !== currentTeamId
  ) {
    return false;
  }

  try {
    const senderAuth = await authorizeSlackSystemEventSender({
      ctx,
      senderId: entry.userId,
      expectedSenderId: entry.userId,
      channelId: entry.scope.channelId,
      channelType: entry.scope.channelType,
      eventScope,
      interactiveEvent: true,
    });
    if (!senderAuth.allowed) {
      return false;
    }

    const channelType = senderAuth.channelType ?? entry.scope.channelType;
    const isDirectMessage = channelType === "im";
    const isRoom = channelType === "channel" || channelType === "group";
    const effectiveAllowFromLower = await resolveSlackEffectiveAllowFrom(ctx, {
      includePairingStore: isDirectMessage,
      eventScope,
    });
    const channelConfig = isRoom
      ? resolveSlackChannelConfig({
          teamId: currentTeamId,
          allowUnscoped: ctx.installationIdentity?.kind !== "enterprise",
          channelId: entry.scope.channelId,
          channelName: senderAuth.channelName,
          channels: ctx.channelsConfig,
          channelKeys: ctx.channelsConfigKeys,
          defaultRequireMention: ctx.defaultRequireMention,
          allowNameMatching: ctx.allowNameMatching,
        })
      : null;
    const sender = await ctx.resolveUserName(entry.userId, eventScope).catch(() => undefined);
    const commandIngress = await resolveSlackCommandIngress({
      ctx,
      teamId: currentTeamId,
      senderId: entry.userId,
      senderName: sender?.name,
      channelType,
      channelId: entry.scope.channelId,
      ownerAllowFromLower: effectiveAllowFromLower,
      channelUsers: isRoom ? channelConfig?.users : undefined,
      allowTextCommands: false,
      hasControlCommand: true,
      eventKind: "button",
      modeWhenAccessGroupsOff: "configured",
    });
    return isSlackNativeArgMenuAuthorized({
      ctx,
      eventScope,
      userId: entry.userId,
      channelId: entry.scope.channelId,
      channelType,
      commandAuthorized: commandIngress.commandAccess.authorized,
    });
  } catch {
    return false;
  }
}
