import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sendMessage } from "./client.js";
import type { SynologyInboundMessage } from "./inbound-context.js";
import { getSynologyRuntime } from "./runtime.js";
import { buildSynologyChatInboundSessionKey } from "./session-key.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import type { SynologyIngressLifecycle } from "./webhook-ingress.js";

const CHANNEL_ID = "synology-chat";

type SynologyChannelLog = {
  info?: (...args: unknown[]) => void;
};

export async function dispatchSynologyChatInboundEvent(params: {
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  log?: SynologyChannelLog;
  turnAdoptionLifecycle?: SynologyIngressLifecycle;
}): Promise<null> {
  const rt = getSynologyRuntime();
  const currentCfg = rt.config.current() as OpenClawConfig;

  // The Chat API user_id (for sending) may differ from the webhook
  // user_id (used for sessions/pairing). Use chatUserId for API calls.
  const sendUserId = params.msg.chatUserId ?? params.msg.from;
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: currentCfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: "direct", id: params.msg.from },
  });
  const sessionKey = buildSynologyChatInboundSessionKey({
    agentId: route.agentId,
    accountId: params.account.accountId,
    userId: params.msg.from,
    identityLinks: currentCfg.session?.identityLinks,
  });

  await rt.channel.inbound.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: params.msg,
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
    adapter: {
      ingest: (msg) => ({
        id: msg.messageId,
        timestamp: Date.now(),
        rawText: msg.body,
        textForAgent: msg.body,
        textForCommands: msg.body,
        raw: msg,
      }),
      resolveTurn: async (input) => {
        const chatKind =
          params.msg.chatType === "group" || params.msg.chatType === "channel"
            ? params.msg.chatType
            : "direct";
        const channelIngress = await params.msg.resolveChannelIngress({
          agentId: route.agentId,
          sessionKey,
          messageId: input.id,
          inboundEventKind: "user_request",
        });
        const msgCtx = rt.channel.inbound.buildContext({
          channelIngress,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          messageId: input.id,
          timestamp: input.timestamp,
          from: `synology-chat:${params.msg.from}`,
          sender: {
            id: params.msg.from,
            name: params.msg.senderName,
          },
          conversation: {
            kind: chatKind,
            id: params.msg.from,
            label: params.msg.senderName || params.msg.from,
          },
          route: {
            agentId: route.agentId,
            dmScope: route.dmScope,
            accountId: params.account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: {
            to: `synology-chat:${params.msg.from}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            ChatType: params.msg.chatType,
            CommandAuthorized: params.msg.commandAuthorized,
          },
        });
        return {
          cfg: currentCfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          route: {
            agentId: route.agentId,
            dmScope: route.dmScope,
            sessionKey: route.sessionKey,
          },
          ctxPayload: msgCtx,
          delivery: {
            durable: () => ({
              to: sendUserId,
            }),
            deliver: async (payload) => {
              const text = payload.text;
              const visibleReplySent = text
                ? await sendMessage(
                    params.account.incomingUrl,
                    text,
                    sendUserId,
                    params.account.allowInsecureSsl,
                  )
                : false;
              return { visibleReplySent };
            },
          },
          dispatcherOptions: {
            onReplyStart: () => {
              params.log?.info?.(`Agent reply started for ${params.msg.from}`);
            },
          },
          record: {
            onRecordError: (err) => {
              params.log?.info?.(`Session metadata update failed for ${params.msg.from}`, err);
            },
          },
        };
      },
    },
  });

  return null;
}
