import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { setDiscordRuntime } from "../runtime.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
} from "./message-handler.preflight.test-helpers.js";

/** Real Discord preflight and ingress; only Discord's remote message/channel facts are fixtures. */
export async function prepareDiscordQueuedAdmission(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  sessionKey: string;
  messageId: string;
}) {
  setDiscordRuntime(params.runtime);
  const message = createDiscordMessage({
    id: params.messageId,
    channelId: "200000000000000002",
    content: "queued request",
    author: { id: "300000000000000003", bot: false },
  });
  const args = createDiscordPreflightArgs({
    cfg: params.cfg,
    discordConfig: params.cfg.channels?.discord,
    data: createGuildEvent({
      channelId: message.channelId,
      guildId: "100000000000000001",
      author: message.author,
      message,
    }),
    client: createGuildTextClient(message.channelId),
  });
  args.guildEntries = params.cfg.channels?.discord?.guilds;
  const preflight = await preflightDiscordMessage({
    ...args,
    readPolicy: createDiscordLivePolicyReader({
      ...args,
      resolvedAllowlist: { guildEntries: args.guildEntries, allowFrom: [] },
    }),
  });
  if (!preflight) {
    throw new Error("Discord fixture was refused before queueing");
  }
  return await preflight.resolveChannelIngress({
    agentId: "main",
    sessionKey: params.sessionKey,
    nativeChannelId: message.channelId,
    messageId: params.messageId,
    inboundEventKind: "user_request",
  });
}
