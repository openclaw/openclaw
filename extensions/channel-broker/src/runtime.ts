import type {
  BrokerInboundEventV1,
  BrokerMessageAttachment,
  BrokerOutboundRequestV1,
  BrokerReceiptV1,
} from "openclaw/plugin-sdk/channel-broker";
import { buildBrokerConversationTarget } from "openclaw/plugin-sdk/channel-broker";
import type { InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { ResolvedChannelBrokerAccount } from "./types.js";
import type { CoreConfig } from "./types.js";

export type ChannelBrokerInboundAckPolicy =
  | "after_receive_record"
  | "after_agent_dispatch"
  | "after_durable_send";

export type ChannelBrokerInboundReceiveResult = {
  status: "accepted" | "duplicate" | "rejected";
  message?: string;
};

export type ChannelBrokerRuntime = {
  createRequestId?: () => string;
  fetch?: typeof fetch;
  receiveInboundEvent?: (params: {
    account: ResolvedChannelBrokerAccount;
    event: BrokerInboundEventV1;
    dedupeKey: string;
    ackPolicy: ChannelBrokerInboundAckPolicy;
  }) => Promise<ChannelBrokerInboundReceiveResult>;
  sendOutboundRequest?: (params: {
    account: ResolvedChannelBrokerAccount;
    request: BrokerOutboundRequestV1;
    signal?: AbortSignal;
  }) => Promise<BrokerReceiptV1>;
};

let runtime: ChannelBrokerRuntime = {};

function isPluginRuntime(value: unknown): value is PluginRuntime {
  return Boolean(
    value &&
    typeof value === "object" &&
    "channel" in value &&
    typeof (value as { channel?: { turn?: { run?: unknown } } }).channel?.turn?.run === "function",
  );
}

function conversationKind(
  type: BrokerInboundEventV1["conversation"]["type"],
): "direct" | "group" | "channel" {
  return type === "direct" || type === "group" ? type : "channel";
}

function buildInboundReplyTarget(event: BrokerInboundEventV1): string {
  return buildBrokerConversationTarget({
    platform: event.platform,
    conversationId: event.conversation.id,
    conversationType: event.conversation.type,
    ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
  });
}

function toInboundMediaFacts(
  attachments: readonly BrokerMessageAttachment[] | undefined,
  messageId: string,
): InboundMediaFacts[] {
  return (attachments ?? [])
    .map((attachment): InboundMediaFacts => {
      const kind: InboundMediaFacts["kind"] =
        attachment.mediaType === "image" ||
        attachment.mediaType === "video" ||
        attachment.mediaType === "audio" ||
        attachment.mediaType === "document"
          ? attachment.mediaType
          : "unknown";
      return {
        url: attachment.url,
        contentType: attachment.mimeType,
        kind,
        messageId: attachment.id ?? messageId,
      };
    })
    .filter((entry) => entry.url || entry.contentType);
}

async function deliverBrokerInboundReply(params: {
  cfg: CoreConfig;
  account: ResolvedChannelBrokerAccount;
  to: string;
  payload: ReplyPayload;
  threadId?: string | number | null;
  replyToId?: string | number | null;
}) {
  const {
    sendChannelBrokerMedia,
    sendChannelBrokerPayload,
    sendChannelBrokerText,
  }: typeof import("./outbound.js") = await import("./outbound.js");
  const text = params.payload.text ?? "";
  const mediaUrl = params.payload.mediaUrl ?? params.payload.mediaUrls?.[0];
  const needsPayloadTransport = Boolean(
    params.payload.channelData ||
    params.payload.presentation ||
    params.payload.interactive ||
    params.payload.mediaUrls?.length,
  );
  const result = needsPayloadTransport
    ? await sendChannelBrokerPayload({
        cfg: params.cfg,
        accountId: params.account.providerId,
        to: params.to,
        text,
        payload: params.payload,
        mediaUrl,
        threadId: params.threadId,
        replyToId: params.replyToId,
        audioAsVoice: params.payload.audioAsVoice,
      })
    : mediaUrl
      ? await sendChannelBrokerMedia({
          cfg: params.cfg,
          accountId: params.account.providerId,
          to: params.to,
          text,
          mediaUrl,
          threadId: params.threadId,
          replyToId: params.replyToId,
          audioAsVoice: params.payload.audioAsVoice,
        })
      : await sendChannelBrokerText({
          cfg: params.cfg,
          accountId: params.account.providerId,
          to: params.to,
          text,
          threadId: params.threadId,
          replyToId: params.replyToId,
        });
  return {
    messageIds: result.receipt.platformMessageIds,
    receipt: result.receipt,
    visibleReplySent: Boolean(result.messageId || result.receipt.platformMessageIds.length),
  };
}

function createRuntimeFromPluginRuntime(pluginRuntime: PluginRuntime): ChannelBrokerRuntime {
  return {
    receiveInboundEvent: async ({ account, event }) => {
      const cfg = pluginRuntime.config.current() as CoreConfig;
      const chatKind = conversationKind(event.conversation.type);
      const peer = {
        kind: chatKind,
        id: `${event.platform}:${event.conversation.id}`,
      };
      const parentPeer =
        event.conversation.type === "thread"
          ? {
              kind: "channel" as const,
              id: `${event.platform}:${event.conversation.parentId ?? event.conversation.id}`,
            }
          : null;
      const route = pluginRuntime.channel.routing.resolveAgentRoute({
        cfg: cfg as never,
        channel: "channel-broker",
        accountId: account.providerId,
        peer,
        parentPeer,
      });
      const replyTarget = buildInboundReplyTarget(event);
      const storePath = pluginRuntime.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      const messageText = event.message.text ?? "";
      const timestamp = event.message.timestamp ? Date.parse(event.message.timestamp) : undefined;
      const media = toInboundMediaFacts(event.message.attachments, event.message.id);

      const turnResult = await pluginRuntime.channel.turn.run({
        channel: "channel-broker",
        accountId: account.providerId,
        raw: event,
        adapter: {
          ingest: () => ({
            id: event.message.id || event.eventId,
            timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
            rawText: messageText,
            textForAgent: messageText,
            textForCommands: messageText,
            raw: event,
          }),
          resolveTurn: (input) => {
            const ctxPayload = pluginRuntime.channel.turn.buildContext({
              channel: "channel-broker",
              accountId: account.providerId,
              provider: account.providerId,
              surface: event.platform,
              messageId: event.message.id,
              messageIdFull: event.eventId,
              timestamp: input.timestamp,
              from: `${event.platform}:${event.sender.id}`,
              sender: {
                id: event.sender.id,
                name: event.sender.displayName,
                username: event.sender.handle,
                isBot: event.sender.isBot,
              },
              conversation: {
                kind: chatKind,
                id: event.conversation.id,
                label: event.conversation.title,
                parentId: event.conversation.parentId,
                threadId: event.conversation.threadId,
                nativeChannelId: event.conversation.id,
                routePeer: peer,
              },
              route: {
                agentId: route.agentId,
                accountId: account.providerId,
                routeSessionKey: route.sessionKey,
                dispatchSessionKey: route.sessionKey,
              },
              reply: {
                to: replyTarget,
                originatingTo: replyTarget,
                replyToId: event.message.replyToId,
                messageThreadId: event.conversation.threadId,
                nativeChannelId: event.conversation.id,
              },
              message: {
                rawBody: input.rawText,
                bodyForAgent: input.textForAgent,
                commandBody: input.textForCommands,
                envelopeFrom: event.sender.displayName ?? event.sender.handle ?? event.sender.id,
              },
              media,
              extra: {
                BrokerProviderId: account.providerId,
                BrokerPlatform: event.platform,
                BrokerNativeIds: event.message.nativeIds,
                BrokerRawRef: event.message.rawRef,
              },
            });
            return {
              cfg,
              channel: "channel-broker",
              accountId: account.providerId,
              agentId: route.agentId,
              routeSessionKey: route.sessionKey,
              storePath,
              ctxPayload,
              recordInboundSession: pluginRuntime.channel.session.recordInboundSession,
              dispatchReplyWithBufferedBlockDispatcher:
                pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
              delivery: {
                durable: () => ({
                  to: replyTarget,
                  threadId: event.conversation.threadId,
                  replyToId: event.message.replyToId,
                  requiredCapabilities: {
                    payload: true,
                    thread: Boolean(event.conversation.threadId),
                    replyTo: Boolean(event.message.replyToId),
                  },
                }),
                deliver: async (payload) =>
                  await deliverBrokerInboundReply({
                    cfg,
                    account,
                    to: replyTarget,
                    payload,
                    threadId: event.conversation.threadId,
                    replyToId: event.message.replyToId,
                  }),
              },
            };
          },
        },
      });

      return {
        status: turnResult.dispatched ? "accepted" : "rejected",
        ...(turnResult.dispatched ? {} : { message: turnResult.admission.reason }),
      };
    },
  };
}

export function setChannelBrokerRuntime(next: ChannelBrokerRuntime | PluginRuntime): void {
  const adapted = isPluginRuntime(next) ? createRuntimeFromPluginRuntime(next) : next;
  runtime = { ...runtime, ...adapted };
}

export function resetChannelBrokerRuntimeForTest(): void {
  runtime = {};
}

export function getChannelBrokerRuntime(): ChannelBrokerRuntime {
  return runtime;
}

export function createBrokerRequestId(): string {
  const custom = runtime.createRequestId?.();
  if (custom?.trim()) {
    return custom.trim();
  }
  return `broker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function requireBrokerBaseUrl(account: ResolvedChannelBrokerAccount): string {
  const baseUrl = account.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      `Channel broker provider ${account.providerId} is not configured (missing baseUrl).`,
    );
  }
  return baseUrl.replace(/\/+$/u, "");
}

function parseBrokerReceipt(value: unknown): BrokerReceiptV1 {
  if (!value || typeof value !== "object") {
    throw new Error("Channel broker provider returned a non-object receipt.");
  }
  return value as BrokerReceiptV1;
}

async function sendBrokerOutboundHttp(params: {
  account: ResolvedChannelBrokerAccount;
  request: BrokerOutboundRequestV1;
  signal?: AbortSignal;
}): Promise<BrokerReceiptV1> {
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Channel broker outbound HTTP transport requires fetch.");
  }
  const response = await fetchImpl(`${requireBrokerBaseUrl(params.account)}/v1/outbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-broker-provider": params.account.providerId,
      ...(params.account.outboundToken
        ? { authorization: `Bearer ${params.account.outboundToken}` }
        : {}),
    },
    body: JSON.stringify(params.request),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Channel broker provider returned HTTP ${response.status}.`);
  }
  return parseBrokerReceipt(await response.json());
}

export async function sendBrokerOutboundRequest(params: {
  account: ResolvedChannelBrokerAccount;
  request: BrokerOutboundRequestV1;
  signal?: AbortSignal;
}): Promise<BrokerReceiptV1> {
  if (runtime.sendOutboundRequest) {
    return await runtime.sendOutboundRequest(params);
  }
  return await sendBrokerOutboundHttp(params);
}

export async function receiveBrokerInboundEvent(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
  dedupeKey: string;
  ackPolicy: ChannelBrokerInboundAckPolicy;
}): Promise<ChannelBrokerInboundReceiveResult> {
  if (!runtime.receiveInboundEvent) {
    throw new Error("Channel broker inbound runtime is not configured.");
  }
  return await runtime.receiveInboundEvent(params);
}
