import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { onTestFinished, vi } from "vitest";
import { setDiscordRuntime } from "../runtime.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  createThreadClient,
} from "./message-handler.preflight.test-helpers.js";

/** Real Discord preflight and ingress; only Discord's remote message/channel facts are fixtures. */
export async function prepareDiscordQueuedAdmission(params: {
  runtime: PluginRuntime;
  cfg: OpenClawConfig;
  sessionKey: string;
  messageId: string;
  thread?: boolean;
  policyUnavailable?: boolean;
}) {
  setDiscordRuntime(params.runtime);
  const message = createDiscordMessage({
    id: params.messageId,
    channelId: "200000000000000002",
    content: "queued request",
    author: { id: "300000000000000003", bot: false },
  });
  const client = params.thread
    ? createThreadClient({ threadId: message.channelId, parentId: "700000000000000007" })
    : createGuildTextClient(message.channelId);
  const restCalls = vi.spyOn(client, "fetchChannel");
  onTestFinished(() => restCalls.mockRestore());
  const args = createDiscordPreflightArgs({
    cfg: params.cfg,
    discordConfig: params.cfg.channels?.discord,
    data: createGuildEvent({
      channelId: message.channelId,
      guildId: "100000000000000001",
      author: message.author,
      message,
    }),
    client,
  });
  args.guildEntries = params.cfg.channels?.discord?.guilds;
  const readPolicy = createDiscordLivePolicyReader({
    ...args,
    resolvedAllowlist: { guildEntries: args.guildEntries, allowFrom: [] },
  });
  await readPolicy();
  let policyReads = 0;
  const preflight = await preflightDiscordMessage({
    ...args,
    readPolicy: async () => {
      policyReads += 1;
      if (params.policyUnavailable) {
        throw new Error("Discord policy source is unavailable");
      }
      return readPolicy();
    },
  });
  if (!preflight) {
    throw new Error("Discord fixture was refused before queueing");
  }
  const ingress = await preflight.resolveChannelIngress({
    agentId: "main",
    sessionKey: params.sessionKey,
    nativeChannelId: message.channelId,
    messageId: params.messageId,
    inboundEventKind: preflight.inboundEventKind,
  });
  return {
    ingress,
    inboundEventKind: preflight.inboundEventKind,
    counts: () => ({ policyReads, restCalls: restCalls.mock.calls.length }),
  };
}
