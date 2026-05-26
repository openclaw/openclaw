import { createHash } from "node:crypto";
import type {
  BrokerInboundEventV1,
  BrokerMessageAttachment,
  BrokerOutboundRequestV1,
  BrokerReceiptV1,
} from "openclaw/plugin-sdk/channel-broker";
import { buildBrokerConversationTarget } from "openclaw/plugin-sdk/channel-broker";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createDurableInboundReceiveJournal,
  type DurableInboundReceiveCompletedRecord,
  type DurableInboundReceivePendingRecord,
} from "openclaw/plugin-sdk/channel-message";
import type { InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { ResolvedChannelBrokerAccount } from "./types.js";
import type { CoreConfig } from "./types.js";

const CHANNEL_BROKER_DURABLE_INBOUND_PENDING_MAX_ENTRIES = 450;
const CHANNEL_BROKER_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES = 450;
const CHANNEL_BROKER_DURABLE_INBOUND_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_BROKER_DURABLE_INBOUND_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHANNEL_BROKER_DURABLE_INBOUND_STALE_PENDING_MS = 10 * 60 * 1000;

type BrokerInboundDeliveryState = {
  replyDispatchStarted: boolean;
  visibleFailureReported: boolean;
  previewSent: boolean;
  finalSent: boolean;
};

export type ChannelBrokerInboundAckPolicy =
  | "after_receive_record"
  | "after_agent_dispatch"
  | "after_durable_send";

export type ChannelBrokerInboundReceiveResult = {
  status: "accepted" | "duplicate" | "pending" | "rejected";
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
let channelBrokerRuntimeInstanceId = createChannelBrokerRuntimeInstanceId();

type ChannelBrokerDurableInboundMetadata = {
  providerId: string;
  platform: string;
  ackPolicy: ChannelBrokerInboundAckPolicy;
  runtimeInstanceId: string;
};

const brokerIngressIdentity = defineStableChannelIngressIdentity({
  kind: "stable-id",
  normalize: normalizeBrokerIngressIdentifier,
  aliases: [{ key: "handle", kind: "username", normalize: normalizeBrokerIngressIdentifier }],
  isWildcardEntry: (value) => value.trim() === "*",
  entryIdPrefix: "broker-sender",
});

function normalizeBrokerIngressIdentifier(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function hasBrokerControlCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function resolveBrokerMentionFacts(
  event: BrokerInboundEventV1,
  chatKind: "direct" | "group" | "channel",
) {
  if (chatKind === "direct") {
    return undefined;
  }
  return {
    canDetectMention: event.message.mentions?.canDetectMention ?? true,
    wasMentioned: event.message.mentions?.wasMentioned ?? false,
    ...(event.message.mentions?.hasAnyMention !== undefined
      ? { hasAnyMention: event.message.mentions.hasAnyMention }
      : { hasAnyMention: event.message.mentions?.wasMentioned ?? false }),
    ...(event.message.mentions?.implicitMentionKinds
      ? { implicitMentionKinds: event.message.mentions.implicitMentionKinds }
      : {}),
  };
}

function brokerAdmissionFromIngress(admission: "dispatch" | "observe" | "skip" | "drop" | "pairing-required", reason: string) {
  switch (admission) {
    case "dispatch":
      return undefined;
    case "observe":
      return { kind: "observeOnly" as const, reason };
    case "skip":
      return { kind: "handled" as const, reason };
    case "drop":
    case "pairing-required":
      return { kind: "drop" as const, reason };
  }
}

function hashNamespacePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function createChannelBrokerRuntimeInstanceId(): string {
  return `broker-runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createChannelBrokerDurableInboundReceiveJournal(
  pluginRuntime: PluginRuntime,
  accountId: string,
) {
  const accountPart = hashNamespacePart(accountId);
  const pendingStore = pluginRuntime.state.openKeyedStore<
    DurableInboundReceivePendingRecord<BrokerInboundEventV1, ChannelBrokerDurableInboundMetadata>
  >({
    namespace: `channel-broker.inbound.v1.pending.${accountPart}`,
    maxEntries: CHANNEL_BROKER_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
    defaultTtlMs: CHANNEL_BROKER_DURABLE_INBOUND_PENDING_TTL_MS,
  });
  const completedStore = pluginRuntime.state.openKeyedStore<
    DurableInboundReceiveCompletedRecord<ChannelBrokerDurableInboundMetadata>
  >({
    namespace: `channel-broker.inbound.v1.completed.${accountPart}`,
    maxEntries: CHANNEL_BROKER_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
    defaultTtlMs: CHANNEL_BROKER_DURABLE_INBOUND_COMPLETED_TTL_MS,
  });
  return {
    pendingStore,
    journal: createDurableInboundReceiveJournal<
      BrokerInboundEventV1,
      ChannelBrokerDurableInboundMetadata,
      ChannelBrokerDurableInboundMetadata
    >({
      pendingStore,
      completedStore,
      pendingTtlMs: CHANNEL_BROKER_DURABLE_INBOUND_PENDING_TTL_MS,
      completedTtlMs: CHANNEL_BROKER_DURABLE_INBOUND_COMPLETED_TTL_MS,
    }),
  };
}

function isVisibleDeliveryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const flags = error as { sentBeforeError?: unknown; visibleReplySent?: unknown };
  return flags.sentBeforeError === true || flags.visibleReplySent === true;
}

function hasVisibleDelivery(deliveryState: BrokerInboundDeliveryState): boolean {
  return (
    deliveryState.previewSent ||
    deliveryState.finalSent ||
    deliveryState.visibleFailureReported
  );
}

function isStalePendingInboundRecord(record: { updatedAt?: number }): boolean {
  return (
    typeof record.updatedAt === "number" &&
    Date.now() - record.updatedAt >= CHANNEL_BROKER_DURABLE_INBOUND_STALE_PENDING_MS
  );
}

function isReclaimableStalePendingInboundRecord(
  record: DurableInboundReceivePendingRecord<
    BrokerInboundEventV1,
    ChannelBrokerDurableInboundMetadata
  >,
): boolean {
  return (
    isStalePendingInboundRecord(record) &&
    typeof record.metadata?.runtimeInstanceId === "string" &&
    record.metadata.runtimeInstanceId !== channelBrokerRuntimeInstanceId
  );
}

function hasFailedDispatchCounts(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const failedCounts = (result as { failedCounts?: unknown }).failedCounts;
  if (!failedCounts || typeof failedCounts !== "object") {
    return false;
  }
  return Object.values(failedCounts).some((value) => typeof value === "number" && value > 0);
}

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
  const platformTarget = buildBrokerConversationTarget({
    platform: event.platform,
    conversationId: event.conversation.id,
    conversationType: event.conversation.type,
    ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
  });
  return `broker:${platformTarget}`;
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
  platform: string;
  to: string;
  payload: ReplyPayload;
  kind?: "tool" | "block" | "final";
  deliveryState?: BrokerInboundDeliveryState;
  threadId?: string | number | null;
  replyToId?: string | number | null;
}) {
  const {
    sendChannelBrokerMedia,
    sendChannelBrokerPayload,
    sendChannelBrokerPreviewFinalization,
    sendChannelBrokerPreviewUpdate,
    sendChannelBrokerText,
  }: typeof import("./outbound.js") = await import("./outbound.js");
  const text = params.payload.text ?? "";
  const mediaUrl = params.payload.mediaUrl ?? params.payload.mediaUrls?.[0];
  const deliveryCapabilities = params.account.capabilities[params.platform]?.delivery;
  const supportsProgressUpdates = deliveryCapabilities?.progressUpdates === true;
  const supportsPreviewFinalization = deliveryCapabilities?.previewFinalization === true;
  if (params.deliveryState) {
    params.deliveryState.replyDispatchStarted = true;
  }
  if (params.kind === "tool" || params.kind === "block") {
    if (!supportsProgressUpdates) {
      return { visibleReplySent: false };
    }
    const result = await sendChannelBrokerPreviewUpdate({
      cfg: params.cfg,
      accountId: params.account.providerId,
      to: params.to,
      text,
      payload: params.payload,
      mediaUrl,
      threadId: params.threadId,
      replyToId: params.replyToId,
      audioAsVoice: params.payload.audioAsVoice,
    });
    if (params.deliveryState) {
      params.deliveryState.previewSent = true;
    }
    return result;
  }
  if (params.kind === "final" && params.deliveryState?.previewSent && supportsPreviewFinalization) {
    try {
      const result = await sendChannelBrokerPreviewFinalization({
        cfg: params.cfg,
        accountId: params.account.providerId,
        to: params.to,
        text,
        payload: params.payload,
        mediaUrl,
        threadId: params.threadId,
        replyToId: params.replyToId,
        audioAsVoice: params.payload.audioAsVoice,
      });
      params.deliveryState.finalSent = true;
      return result;
    } catch (error) {
      if (isVisibleDeliveryFailure(error)) {
        throw error;
      }
      // Fall through to normal final delivery so a stale preview never replaces the final answer.
    }
  }
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
  const deliveryResult = {
    messageIds: result.receipt.platformMessageIds,
    receipt: result.receipt,
    visibleReplySent: Boolean(result.messageId || result.receipt.platformMessageIds.length),
  };
  if (params.kind === "final" && deliveryResult.visibleReplySent && params.deliveryState) {
    params.deliveryState.finalSent = true;
  }
  return deliveryResult;
}

function createRuntimeFromPluginRuntime(pluginRuntime: PluginRuntime): ChannelBrokerRuntime {
  return {
    receiveInboundEvent: async ({ account, event, dedupeKey, ackPolicy }) => {
      const durableInbound = createChannelBrokerDurableInboundReceiveJournal(
        pluginRuntime,
        account.providerId,
      );
      const metadata = {
        providerId: account.providerId,
        platform: event.platform,
        ackPolicy,
        runtimeInstanceId: channelBrokerRuntimeInstanceId,
      };
      const deliveryState: BrokerInboundDeliveryState = {
        replyDispatchStarted: false,
        visibleFailureReported: false,
        previewSent: false,
        finalSent: false,
      };
      try {
        let acceptResult = await durableInbound.journal.accept(dedupeKey, event, { metadata });
        if (acceptResult.kind === "completed") {
          return { status: "duplicate" };
        }
        if (acceptResult.kind === "pending") {
          if (!isReclaimableStalePendingInboundRecord(acceptResult.record)) {
            return { status: "pending", message: "delivery pending" };
          }
          const consumed = await durableInbound.pendingStore.consume(dedupeKey);
          if (!consumed || consumed.updatedAt !== acceptResult.record.updatedAt) {
            if (consumed) {
              await durableInbound.pendingStore.registerIfAbsent(dedupeKey, consumed);
            }
            return { status: "pending", message: "delivery pending" };
          }
          acceptResult = await durableInbound.journal.accept(dedupeKey, event, { metadata });
          if (acceptResult.kind === "completed") {
            return { status: "duplicate" };
          }
          if (acceptResult.kind === "pending") {
            return { status: "pending", message: "delivery pending" };
          }
        }
        if (ackPolicy === "after_receive_record") {
          await durableInbound.journal.complete(dedupeKey, { metadata });
        }
        const cfg = pluginRuntime.config.current() as CoreConfig;
        const chatKind = conversationKind(event.conversation.type);
        const replyTarget = buildInboundReplyTarget(event);
        const hasThread = Boolean(event.conversation.threadId);
        const peer = {
          kind: chatKind,
          id: hasThread
            ? `${event.platform}:${event.conversation.id}:thread:${event.conversation.threadId}`
            : `${event.platform}:${event.conversation.id}`,
        };
        const parentPeer =
          hasThread
            ? {
                kind: chatKind,
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
        const storePath = pluginRuntime.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        });
        const messageText = event.message.text ?? "";
        const timestamp = event.message.timestamp ? Date.parse(event.message.timestamp) : undefined;
        const media = toInboundMediaFacts(event.message.attachments, event.message.id);
        const mentionFacts = resolveBrokerMentionFacts(event, chatKind);
        const hasControlCommand = hasBrokerControlCommand(messageText);
        let brokerIngress: Awaited<ReturnType<typeof resolveChannelMessageIngress>> | null = null;
        const resolveBrokerIngress = async () => {
          brokerIngress ??= await resolveChannelMessageIngress({
            channelId: "channel-broker",
            accountId: account.providerId,
            identity: brokerIngressIdentity,
            subject: {
              stableId: event.sender.id,
              ...(event.sender.handle ? { aliases: { handle: event.sender.handle } } : {}),
            },
            conversation: {
              kind: chatKind,
              id: event.conversation.id,
              ...(event.conversation.parentId ? { parentId: event.conversation.parentId } : {}),
              ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
              ...(event.conversation.title ? { title: event.conversation.title } : {}),
            },
            event: {
              kind: "message",
              authMode: "inbound",
              mayPair: false,
            },
            policy: {
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              groupAllowFromFallbackToAllowFrom: true,
              ...(chatKind !== "direct"
                ? {
                    activation: {
                      requireMention: true,
                      allowTextCommands: true,
                    },
                  }
                : {}),
              command: {
                useAccessGroups: false,
                allowTextCommands: true,
                hasControlCommand,
              },
            },
            allowFrom: account.allowFrom,
            mentionFacts,
          });
          return brokerIngress;
        };

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
            preflight: async () => {
              const ingress = await resolveBrokerIngress();
              const admission = brokerAdmissionFromIngress(
                ingress.ingress.admission,
                ingress.ingress.reasonCode,
              );
              return {
                ...(admission ? { admission } : {}),
                ...(hasControlCommand
                  ? {
                      command: {
                        kind: "text-slash" as const,
                        body: messageText,
                        authorized: ingress.commandAccess.authorized,
                      },
                    }
                  : {}),
              };
            },
            resolveTurn: (input) => {
              const ingress = brokerIngress;
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
                ...(ingress
                  ? {
                      access: {
                        ...(chatKind !== "direct"
                          ? {
                              group: {
                                policy: "allowlist" as const,
                                routeAllowed: ingress.routeAccess.allowed,
                                senderAllowed: ingress.senderAccess.allowed,
                                allowFrom: [],
                                requireMention: true,
                                ...(ingress.senderAccess.gate?.allowlist
                                  ? { allowlist: ingress.senderAccess.gate.allowlist }
                                  : {}),
                              },
                            }
                          : {}),
                        commands: {
                          authorized: ingress.commandAccess.authorized,
                          shouldBlockControlCommand:
                            ingress.commandAccess.shouldBlockControlCommand,
                          reasonCode: ingress.commandAccess.reasonCode,
                          useAccessGroups: false,
                          allowTextCommands: true,
                          authorizers: [
                            {
                              configured: account.allowFrom.length > 0,
                              allowed: ingress.commandAccess.authorized,
                            },
                          ],
                        },
                        ...(mentionFacts
                          ? {
                              mentions: {
                                canDetectMention: mentionFacts.canDetectMention,
                                wasMentioned: mentionFacts.wasMentioned,
                                ...(mentionFacts.hasAnyMention !== undefined
                                  ? { hasAnyMention: mentionFacts.hasAnyMention }
                                  : {}),
                                ...(mentionFacts.implicitMentionKinds
                                  ? { implicitMentionKinds: [...mentionFacts.implicitMentionKinds] }
                                  : {}),
                                requireMention: true,
                                effectiveWasMentioned:
                                  ingress.activationAccess.effectiveWasMentioned,
                                shouldSkip: ingress.activationAccess.shouldSkip,
                              },
                            }
                          : {}),
                      },
                    }
                  : {}),
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
                  durable: (_payload, info) => {
                    deliveryState.replyDispatchStarted = true;
                    return info.kind === "final" && deliveryState.previewSent
                      ? false
                      : {
                          to: replyTarget,
                          threadId: event.conversation.threadId,
                          replyToId: event.message.replyToId,
                          requiredCapabilities: {
                            payload: true,
                            thread: Boolean(event.conversation.threadId),
                            replyTo: Boolean(event.message.replyToId),
                          },
                        };
                  },
                  deliver: async (payload, info) => {
                    try {
                      return await deliverBrokerInboundReply({
                        cfg,
                        account,
                        platform: event.platform,
                        to: replyTarget,
                        payload,
                        kind: info.kind,
                        deliveryState,
                        threadId: event.conversation.threadId,
                        replyToId: event.message.replyToId,
                      });
                    } catch (error) {
                      if (isVisibleDeliveryFailure(error)) {
                        deliveryState.visibleFailureReported = true;
                      }
                      throw error;
                    }
                  },
                  onError: (error) => {
                    if (isVisibleDeliveryFailure(error)) {
                      deliveryState.visibleFailureReported = true;
                    }
                  },
                  onDelivered: (_payload, info, result) => {
                    if (info.kind === "final" && result?.visibleReplySent === true) {
                      deliveryState.finalSent = true;
                    }
                  },
                },
              };
            },
          },
        });
        if (turnResult.dispatched) {
          if (ackPolicy === "after_agent_dispatch") {
            await durableInbound.journal.complete(dedupeKey, { metadata });
          } else if (ackPolicy === "after_durable_send") {
            if (hasFailedDispatchCounts(turnResult.dispatchResult)) {
              if (hasVisibleDelivery(deliveryState)) {
                await durableInbound.journal.complete(dedupeKey, { metadata });
                return { status: "accepted" };
              }
              await durableInbound.journal.deletePending(dedupeKey);
              return { status: "rejected", message: "delivery_failed" };
            }
            await durableInbound.journal.complete(dedupeKey, { metadata });
          }
        } else if (ackPolicy !== "after_receive_record") {
          await durableInbound.journal.deletePending(dedupeKey);
        }

        return {
          status: turnResult.dispatched ? "accepted" : "rejected",
          ...(turnResult.dispatched ? {} : { message: turnResult.admission.reason }),
        };
      } catch (error) {
        if (ackPolicy !== "after_receive_record") {
          if (
            (ackPolicy === "after_agent_dispatch" && deliveryState.replyDispatchStarted) ||
            hasVisibleDelivery(deliveryState) ||
            isVisibleDeliveryFailure(error)
          ) {
            await durableInbound.journal.complete(dedupeKey, { metadata });
          } else {
            // Providers own retry scheduling; keep pre-delivery failures re-enterable.
            await durableInbound.journal.deletePending(dedupeKey);
          }
        }
        throw error;
      }
    },
  };
}

export function setChannelBrokerRuntime(next: ChannelBrokerRuntime | PluginRuntime): void {
  const adapted = isPluginRuntime(next) ? createRuntimeFromPluginRuntime(next) : next;
  runtime = { ...runtime, ...adapted };
}

export function resetChannelBrokerRuntimeForTest(): void {
  runtime = {};
  channelBrokerRuntimeInstanceId = createChannelBrokerRuntimeInstanceId();
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
