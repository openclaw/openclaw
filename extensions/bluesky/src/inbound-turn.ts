import type { BskyAgent } from "@atproto/api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { InboundMessage } from "./poll.js";
import { getBlueskyRuntime } from "./runtime.js";
import { sendBlueskyMessage } from "./send.js";
import { buildBlueskySessionKey } from "./session-key.js";
import type { ResolvedBlueskyAccount } from "./types.js";

type LogSink = {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
};

const CHANNEL_ID = "bluesky";

/**
 * Dispatch a single inbound Bluesky DM through the OpenClaw agent reply pipeline.
 *
 * Routing uses the convoId as the peer identifier so replies are routed back to
 * the correct conversation. The agent session is keyed by convoId, meaning the
 * same 1:1 conversation always reaches the same agent session.
 */
export async function dispatchBlueskyInboundTurn(params: {
  account: ResolvedBlueskyAccount;
  agent: BskyAgent;
  msg: InboundMessage;
  cfg?: OpenClawConfig;
  log?: LogSink;
}): Promise<void> {
  const { account, agent, msg, log } = params;
  const rt = getBlueskyRuntime();
  const cfg = params.cfg ?? rt.config.loadConfig();

  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: msg.convoId,
    },
  });

  const sessionKey = buildBlueskySessionKey({
    agentId: route.agentId,
    accountId: account.accountId,
    convoId: msg.convoId,
    identityLinks: cfg.session?.identityLinks,
  });

  const isCommand = msg.text.trim().startsWith("/");
  const commandBody = isCommand ? msg.text : undefined;

  const msgCtx = rt.channel.reply.finalizeInboundContext({
    Body: msg.text,
    RawBody: msg.text,
    CommandBody: commandBody,
    From: `${CHANNEL_ID}:${msg.convoId}`,
    To: `${CHANNEL_ID}:${msg.convoId}`,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${msg.convoId}`,
    ChatType: "direct",
    SenderId: msg.senderDid,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    Timestamp: new Date(msg.sentAt).getTime() || Date.now(),
  });

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; body?: string }) => {
        const text = payload.text ?? payload.body;
        if (!text) {
          return;
        }
        await sendBlueskyMessage(agent, msg.convoId, text);
      },
      onReplyStart: () => {
        log?.info?.(`Bluesky: agent reply started for convo ${msg.convoId}`);
      },
    },
  });
}
