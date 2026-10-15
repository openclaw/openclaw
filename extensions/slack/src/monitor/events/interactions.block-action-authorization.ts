import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import {
  authorizeSlackSystemEventSender,
  resolveSlackCommandIngress,
  resolveSlackEffectiveAllowFrom,
} from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import type {
  SlackBlockActionContext,
  SlackBlockActionRespond,
} from "./interactions.block-action-context.js";

export async function respondEphemeral(
  respond: SlackBlockActionRespond | undefined,
  text: string,
): Promise<void> {
  if (!respond) {
    return;
  }
  try {
    await respond({
      text,
      response_type: "ephemeral",
    });
  } catch {
    // Best-effort feedback only.
  }
}

export async function authorizeSlackBlockAction(params: SlackBlockActionContext): Promise<
  | {
      allowed: true;
      channelType?: "im" | "mpim" | "channel" | "group";
    }
  | { allowed: false }
> {
  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    eventScope: params.eventScope,
    senderId: params.parsed.userId,
    channelId: params.parsed.channelId,
    channelType: params.parsed.channelId ? undefined : "im",
    // Block action sender identity is verified by Slack's request signing.
    // Pass the Slack-verified userId as expectedSenderId to satisfy the
    // mandatory actor-binding requirement for interactive events.
    expectedSenderId: params.parsed.userId,
    interactiveEvent: true,
  });
  if (auth.allowed) {
    return auth;
  }
  params.ctx.runtime.log?.(
    `slack:interaction drop action=${params.parsed.actionId} user=${params.parsed.userId} channel=${params.parsed.channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`,
  );
  await respondEphemeral(params.respond, "You are not authorized to use this control.");
  return { allowed: false };
}

export async function resolveSlackBlockActionCommandAuthorized(
  params: SlackBlockActionContext & {
    auth: { channelType?: "im" | "mpim" | "channel" | "group"; channelName?: string };
  },
): Promise<boolean> {
  const commandsAllowFrom = params.ctx.cfg.commands?.allowFrom;
  const commandsAllowFromConfigured =
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.slack) || Array.isArray(commandsAllowFrom["*"]));
  if (commandsAllowFromConfigured) {
    return (
      await resolveCommandAuthorizationAsync({
        ctx: {
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          AccountId: params.ctx.accountId,
          ChatType: params.auth.channelType === "im" ? "direct" : "group",
          From: params.parsed.channelId ? `slack:${params.parsed.channelId}` : "slack",
          SenderId: params.parsed.userId,
        },
        cfg: params.ctx.cfg,
        commandAuthorized: false,
      })
    ).isAuthorizedSender;
  }

  const isDirectMessage = params.auth.channelType === "im";
  const isRoom = params.auth.channelType === "channel" || params.auth.channelType === "group";
  const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, {
    includePairingStore: isDirectMessage,
    eventScope: params.eventScope,
  });
  const sender = await params.ctx
    .resolveUserName(params.parsed.userId, params.eventScope)
    .catch(() => undefined);
  const senderName = sender?.name;

  let channelUsers: Array<string | number> = [];
  if (isRoom && params.parsed.channelId) {
    const channelConfig = resolveSlackChannelConfig({
      teamId: params.eventScope?.teamId ?? params.ctx.teamId,
      allowUnscoped: params.ctx.installationIdentity?.kind !== "enterprise",
      channelId: params.parsed.channelId,
      channelName: params.auth.channelName,
      channels: params.ctx.channelsConfig,
      channelKeys: params.ctx.channelsConfigKeys,
      defaultRequireMention: params.ctx.defaultRequireMention,
      allowNameMatching: params.ctx.allowNameMatching,
    });
    channelUsers = Array.isArray(channelConfig?.users) ? channelConfig.users : [];
  }

  const commandIngress = await resolveSlackCommandIngress({
    ctx: params.ctx,
    teamId: params.eventScope?.teamId ?? params.ctx.teamId,
    senderId: params.parsed.userId,
    senderName,
    channelType: params.auth.channelType ?? "channel",
    channelId: params.parsed.channelId ?? "slack-interaction",
    ownerAllowFromLower: allowFromLower,
    channelUsers,
    allowTextCommands: false,
    hasControlCommand: true,
    eventKind: "button",
    modeWhenAccessGroupsOff: "configured",
  });
  return commandIngress.commandAccess.authorized;
}
