import type { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { BaseComponentInteraction, CommandInteraction } from "../internal/discord.js";
import type { DispatchDiscordCommandInteractionResult } from "./native-command-dispatch.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
  resolveDiscordInteractionReplyOptions,
} from "./native-command-reply.js";
import type { DiscordConfig } from "./native-command.types.js";

export async function maybeDeliverDiscordDirectStatus(params: {
  commandName: string;
  suppressReplies?: boolean;
  resolveDirectStatusReplyForSession: typeof resolveDirectStatusReplyForSession;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionKey: string;
  commandTargetSessionKey?: string | null;
  senderId: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  interaction: CommandInteraction | BaseComponentInteraction;
  mediaLocalRoots: readonly string[];
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  effectiveRoute: ResolvedAgentRoute;
  respond: (content: string, options?: { ephemeral?: boolean }) => Promise<void>;
}): Promise<DispatchDiscordCommandInteractionResult | null> {
  if (params.suppressReplies || params.commandName !== "status") {
    return null;
  }
  const statusReply = await params.resolveDirectStatusReplyForSession({
    cfg: params.cfg,
    sessionKey: params.commandTargetSessionKey?.trim() || params.sessionKey,
    channel: "discord",
    senderId: params.senderId,
    senderIsOwner: params.senderIsOwner,
    isAuthorizedSender: params.isAuthorizedSender,
    isGroup: params.isGroup,
    defaultGroupActivation: params.defaultGroupActivation,
  });
  if (statusReply && hasRenderableReplyPayload(statusReply)) {
    await deliverDiscordInteractionReply({
      interaction: params.interaction,
      payload: statusReply,
      mediaLocalRoots: params.mediaLocalRoots,
      ...resolveDiscordInteractionReplyOptions(params),
      preferFollowUp: params.preferFollowUp,
      responseEphemeral: params.responseEphemeral,
    });
  } else {
    await params.respond("Status unavailable.");
  }
  return { accepted: true, effectiveRoute: params.effectiveRoute };
}
