import { parseBuffer, type IFileInfo } from "music-metadata";
import type { MessageReceiptPartKind } from "openclaw/plugin-sdk/channel-outbound";
import { isVoiceMessageCompatibleAudio } from "openclaw/plugin-sdk/media-runtime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { PollInput } from "openclaw/plugin-sdk/poll-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig } from "../types.js";
import {
  createMatrixPlannedEvents,
  loadMatrixDeliveryPlan,
  persistMatrixDeliveryPlan,
  resolveMatrixDurableDeliveryIdentity,
  type MatrixPreparedEvent,
} from "./delivery-plan.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import { buildMatrixReactionContent } from "./reaction-common.js";
import { buildMatrixMessageRelation, resolveMatrixReplyToEventId } from "./relations.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";
import { chunkMatrixText, prepareMatrixSingleText } from "./send/chunking.js";
import {
  resolveMediaMaxBytes,
  withResolvedMatrixControlClient,
  withResolvedMatrixSendClient,
} from "./send/client.js";
import { resolveMatrixEditContent } from "./send/edit-content.js";
import {
  buildTextContent,
  diffMatrixMentions,
  enrichMatrixFormattedContent,
  extractMatrixMentions,
  resolveMatrixMentionsForBody,
  resolveMatrixMsgType,
} from "./send/formatting.js";
import { prepareImageInfo, uploadMediaWithEncryption } from "./send/media.js";
import { createMatrixSendReceipt, type MatrixReceiptEvent } from "./send/receipt.js";
import { normalizeThreadId, resolveMatrixRoomId } from "./send/targets.js";
import {
  EventType,
  MSC4357_LIVE_KEY,
  MsgType,
  RelationType,
  type MatrixExtraContentFields,
  type MatrixMediaContent,
  type MatrixOutboundContent,
  type MatrixSendOpts,
  type MatrixSendResult,
  type MatrixTextMsgType,
} from "./send/types.js";

export { chunkMatrixText, prepareMatrixSingleText } from "./send/chunking.js";
export { resolveMatrixMentionsForBody } from "./send/formatting.js";
export { resolveMatrixRoomId } from "./send/targets.js";

type MatrixClientResolveOpts = Parameters<typeof withResolvedMatrixControlClient>[0];

const AIFC_IMA4_BYTES_PER_CHANNEL_PACKET = 34;
const AIFC_IMA4_FRAMES_PER_PACKET = 64;

function resolveAifcIma4DurationSeconds(buffer: Buffer, sampleRate?: number): number | undefined {
  if (
    !sampleRate ||
    !Number.isFinite(sampleRate) ||
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "FORM" ||
    buffer.toString("ascii", 8, 12) !== "AIFC"
  ) {
    return undefined;
  }

  let channels: number | undefined;
  let declaredFrameCount: number | undefined;
  let soundDataBytes: number | undefined;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32BE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkSize > buffer.length - chunkStart) {
      return undefined;
    }
    if (chunkType === "COMM") {
      if (chunkSize < 22 || buffer.toString("ascii", chunkStart + 18, chunkStart + 22) !== "ima4") {
        return undefined;
      }
      channels = buffer.readUInt16BE(chunkStart);
      declaredFrameCount = buffer.readUInt32BE(chunkStart + 2);
    } else if (chunkType === "SSND") {
      if (chunkSize < 8) {
        return undefined;
      }
      const soundDataOffset = buffer.readUInt32BE(chunkStart);
      if (soundDataOffset > chunkSize - 8) {
        return undefined;
      }
      soundDataBytes = chunkSize - 8 - soundDataOffset;
    }
    offset = chunkStart + chunkSize + (chunkSize & 1);
  }

  if (!channels || !declaredFrameCount || !soundDataBytes) {
    return undefined;
  }
  const packetSize = channels * AIFC_IMA4_BYTES_PER_CHANNEL_PACKET;
  if (soundDataBytes % packetSize !== 0) {
    return undefined;
  }
  const packetCount = soundDataBytes / packetSize;
  if (packetCount !== declaredFrameCount) {
    return undefined;
  }
  // Apple AIFC stores IMA4 packet count in COMM; each packet decodes to 64
  // sample frames. Other encoders can store decoded frames, so verify SSND first.
  return (packetCount * AIFC_IMA4_FRAMES_PER_PACKET) / sampleRate;
}

function resolvePreviousThreadId(previousEvent: unknown): string | undefined {
  const content = asOptionalObjectRecord(asOptionalObjectRecord(previousEvent)?.content);
  const relation = asOptionalObjectRecord(content?.["m.relates_to"]);
  if (relation?.rel_type !== RelationType.Thread || typeof relation.event_id !== "string") {
    return undefined;
  }
  return normalizeThreadId(relation.event_id) ?? undefined;
}

function withMatrixExtraContentFields<T extends Record<string, unknown>>(
  content: T,
  extraContent?: MatrixExtraContentFields,
): T {
  if (!extraContent) {
    return content;
  }
  return { ...content, ...extraContent };
}

async function resolvePreviousEditMentions(params: {
  client: MatrixClient;
  roomId: string;
  event: MatrixRawEvent | null;
}) {
  const content = await resolveMatrixEditContent(params);
  if (content && Object.hasOwn(content, "m.mentions")) {
    return extractMatrixMentions(content);
  }
  const body = typeof content?.body === "string" ? content.body : "";
  if (!body) {
    return {};
  }
  return await resolveMatrixMentionsForBody({
    client: params.client,
    body,
  });
}

export async function sendMessageMatrix(
  to: string,
  message: string | undefined,
  opts: MatrixSendOpts,
): Promise<MatrixSendResult> {
  const messageText = message?.trimEnd() ?? "";
  if (!messageText.trim() && !opts.mediaUrl) {
    throw new Error("Matrix send requires text or media");
  }
  const durableIdentity = resolveMatrixDurableDeliveryIdentity({
    queueId: opts.deliveryQueueId,
    partIndex: opts.deliveryPartIndex,
    partCount: opts.deliveryPartCount,
  });
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
      signal: opts.signal,
      assertDirectAdapterHandoff: opts.assertDirectAdapterHandoff,
    },
    async (client) => {
      const roomId = await resolveMatrixRoomId(client, to);
      const wireEventType = await client.prepareRoomForMessageSend(roomId);
      const cfg = requireRuntimeConfig(opts.cfg, "Matrix send") as CoreConfig;
      const threadId = normalizeThreadId(opts.threadId);
      const transactionScopeId = durableIdentity ? await client.getTransactionScopeId() : undefined;
      const storedPlan = durableIdentity
        ? await loadMatrixDeliveryPlan({
            identity: durableIdentity,
            accountId: opts.accountId,
            roomId,
            transactionScopeId: transactionScopeId!,
            wireEventType: wireEventType!,
          })
        : null;
      let plannedEvents: readonly MatrixPreparedEvent[] | undefined = storedPlan?.events;
      if (!plannedEvents) {
        const preparedText = chunkMatrixText(messageText, {
          cfg,
          accountId: opts.accountId,
        });
        const { chunks, convertedText, preparedBody, fitsInSingleEvent, tableMode } = preparedText;
        const singleEventBody = fitsInSingleEvent ? preparedBody : undefined;
        const relation = buildMatrixMessageRelation({ ...opts, threadId });
        let textChunks = chunks;
        let textRelation = relation;
        let pendingExtraContent = opts.extraContent;
        const events: Omit<MatrixPreparedEvent, "transactionId">[] = [];
        const prepareContent = async (
          content: MatrixOutboundContent,
          receiptKind: MessageReceiptPartKind,
          markdown: string,
        ) => {
          await enrichMatrixFormattedContent({
            client,
            content,
            markdown,
            preparedBody: markdown === convertedText ? singleEventBody : undefined,
            tableMode,
          });
          events.push({
            content: withMatrixExtraContentFields(content, pendingExtraContent),
            receiptKind,
          });
          pendingExtraContent = undefined;
        };

        if (opts.mediaUrl) {
          const maxBytes = resolveMediaMaxBytes(opts.accountId, cfg);
          const media = await loadOutboundMediaFromUrl(opts.mediaUrl, {
            maxBytes,
            mediaAccess: opts.mediaAccess,
            mediaLocalRoots: opts.mediaLocalRoots,
            mediaReadFile: opts.mediaReadFile,
          });
          const uploaded = await uploadMediaWithEncryption(client, roomId, media.buffer, {
            contentType: media.contentType,
            filename: media.fileName,
          });
          let durationMs: number | undefined;
          if (media.kind === "audio" || media.kind === "video") {
            try {
              const fileInfo: IFileInfo | string | undefined =
                media.contentType || media.fileName
                  ? {
                      mimeType: media.contentType,
                      size: media.buffer.byteLength,
                      path: media.fileName,
                    }
                  : undefined;
              const metadata = await parseBuffer(media.buffer, fileInfo, {
                duration: true,
                skipCovers: true,
              });
              const durationSeconds =
                resolveAifcIma4DurationSeconds(media.buffer, metadata.format.sampleRate) ??
                metadata.format.duration;
              if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
                durationMs = Math.max(0, Math.round(durationSeconds * 1000));
              }
            } catch {
              // Duration is optional; ignore parse failures.
            }
          }
          const baseMsgType = resolveMatrixMsgType(media.contentType);
          const useVoice = opts.audioAsVoice === true && isVoiceMessageCompatibleAudio(media);
          const msgtype = useVoice ? MsgType.Audio : baseMsgType;
          const receiptKind: MessageReceiptPartKind = useVoice ? "voice" : "media";
          const imageInfo =
            msgtype === MsgType.Image
              ? await prepareImageInfo({
                  buffer: media.buffer,
                  client,
                  roomId,
                })
              : undefined;
          const [firstChunk, ...rest] = chunks;
          const captionMarkdown = useVoice ? "" : (firstChunk ?? "");
          const content: MatrixMediaContent = {
            msgtype,
            body: useVoice ? "Voice message" : captionMarkdown || media.fileName || "(file)",
            filename: media.fileName,
            info: {
              size: media.buffer.byteLength,
              ...(media.contentType ? { mimetype: media.contentType } : {}),
              ...imageInfo,
              ...(typeof durationMs === "number" ? { duration: durationMs } : {}),
            },
          };
          // Encrypted media should only include the "file" payload, not top-level "url".
          if (!uploaded.file && uploaded.url) {
            content.url = uploaded.url;
          }
          if (uploaded.file) {
            content.file = uploaded.file;
          }
          if (useVoice) {
            content["org.matrix.msc3245.voice"] = {};
            if (typeof durationMs === "number") {
              content["org.matrix.msc1767.audio"] = {
                duration: durationMs,
              };
            }
          }
          if (relation) {
            content["m.relates_to"] = relation;
          }
          await prepareContent(content, receiptKind, captionMarkdown);
          textChunks = useVoice ? chunks : rest;
          textRelation = useVoice || threadId ? relation : undefined;
        }
        for (const chunk of textChunks) {
          if (!chunk.trim()) {
            continue;
          }
          await prepareContent(buildTextContent(chunk, textRelation), "text", chunk);
        }
        plannedEvents = durableIdentity
          ? createMatrixPlannedEvents({ identity: durableIdentity, events })
          : events.map((event) => ({
              content: event.content,
              receiptKind: event.receiptKind,
              transactionId: "",
            }));
      }

      if (opts.mediaUrl) {
        await client.prepareRoomForMessageSend(roomId, plannedEvents[0]?.content);
      }
      const acceptedEvents: MatrixReceiptEvent[] = [];
      const acceptedContents: string[] = [];
      let lastMessageId = "";
      for (const planned of plannedEvents) {
        const eventId = await client.sendMessage(
          roomId,
          planned.content,
          planned.transactionId || undefined,
          durableIdentity
            ? async (dispatch) => {
                await persistMatrixDeliveryPlan({
                  identity: durableIdentity,
                  accountId: opts.accountId,
                  roomId,
                  transactionScopeId: transactionScopeId!,
                  wireEventType: dispatch.eventType,
                  events: plannedEvents,
                  dispatch,
                });
                await opts.onPlatformSendDispatch?.();
              }
            : opts.onPlatformSendDispatch,
        );
        lastMessageId = eventId || lastMessageId;
        if (!eventId) {
          continue;
        }
        // Media captions and text follow-ups can intentionally have different reply relations.
        const eventReplyToId = resolveMatrixReplyToEventId(planned.content);
        const acceptedEvent: MatrixReceiptEvent = {
          messageId: eventId,
          kind: planned.receiptKind,
          ...(eventReplyToId ? { replyToId: eventReplyToId } : {}),
        };
        acceptedEvents.push(acceptedEvent);
        const visibleContent = planned.content.body ?? "";
        acceptedContents.push(visibleContent);
        await opts.onDeliveryResult?.({
          messageId: eventId,
          roomId,
          primaryMessageId: eventId,
          receipt: createMatrixSendReceipt({
            roomId,
            events: [acceptedEvent],
            threadId,
          }),
          content: visibleContent,
        });
      }

      return {
        messageId: lastMessageId || "unknown",
        roomId,
        primaryMessageId: acceptedEvents[0]?.messageId ?? (lastMessageId || "unknown"),
        receipt: createMatrixSendReceipt({
          roomId,
          events: acceptedEvents,
          threadId,
        }),
        content: acceptedContents.join("\n"),
      };
    },
  );
}

export async function sendPollMatrix(
  to: string,
  poll: PollInput,
  opts: MatrixSendOpts,
): Promise<{ eventId: string; roomId: string }> {
  if (!poll.question?.trim()) {
    throw new Error("Matrix poll requires a question");
  }
  if (!poll.options?.length) {
    throw new Error("Matrix poll requires options");
  }
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    },
    async (client) => {
      const roomId = await resolveMatrixRoomId(client, to);
      const pollContent = buildPollStartContent(poll);
      const fallbackText =
        pollContent["m.text"] ?? pollContent["org.matrix.msc1767.text"] ?? poll.question ?? "";
      const mentions = await resolveMatrixMentionsForBody({
        client,
        body: fallbackText,
      });
      const threadId = normalizeThreadId(opts.threadId);
      const pollPayload: Record<string, unknown> = threadId
        ? { ...pollContent, "m.relates_to": buildMatrixMessageRelation({ threadId }) }
        : { ...pollContent };
      pollPayload["m.mentions"] = mentions;
      const eventId = await client.sendEvent(roomId, M_POLL_START, pollPayload);

      return {
        eventId: eventId ?? "unknown",
        roomId,
      };
    },
  );
}

export async function sendTypingMatrix(
  roomId: string,
  typing: boolean,
  opts: MatrixClientResolveOpts = {},
): Promise<void> {
  await withResolvedMatrixControlClient(opts, async (resolved) => {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    const resolvedTimeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : 30_000;
    await resolved.setTyping(resolvedRoom, typing, resolvedTimeoutMs);
  });
}

export async function sendReadReceiptMatrix(
  roomId: string,
  eventId: string,
  client?: MatrixClient,
): Promise<void> {
  if (!eventId?.trim()) {
    return;
  }
  await withResolvedMatrixControlClient({ client }, async (resolved) => {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    await resolved.sendReadReceipt(resolvedRoom, eventId.trim());
  });
}

export async function sendSingleTextMessageMatrix(
  roomId: string,
  text: string,
  opts: {
    client?: MatrixClient;
    cfg: CoreConfig;
    replyToId?: string;
    threadId?: string;
    accountId?: string;
    msgtype?: MatrixTextMsgType;
    includeMentions?: boolean;
    extraContent?: MatrixExtraContentFields;
    /** When true, marks the message as a live/streaming update (MSC4357). */
    live?: boolean;
  },
): Promise<MatrixSendResult> {
  const {
    trimmedText,
    convertedText,
    preparedBody,
    singleEventLimit,
    eventTextLength,
    fitsInSingleEvent,
    tableMode,
  } = prepareMatrixSingleText(text.trimEnd(), {
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  if (!trimmedText.trim()) {
    throw new Error("Matrix single-message send requires text");
  }
  if (!fitsInSingleEvent) {
    throw new Error(
      `Matrix single-message text exceeds limit (${eventTextLength} > ${singleEventLimit})`,
    );
  }
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      accountId: opts.accountId,
    },
    async (client) => {
      const resolvedRoom = await resolveMatrixRoomId(client, roomId);
      const normalizedThreadId = normalizeThreadId(opts.threadId);
      const relation = buildMatrixMessageRelation({ ...opts, threadId: normalizedThreadId });
      const content = withMatrixExtraContentFields(
        buildTextContent(convertedText, relation, {
          msgtype: opts.msgtype,
        }),
        opts.extraContent,
      );
      await enrichMatrixFormattedContent({
        client,
        content,
        markdown: convertedText,
        preparedBody,
        includeMentions: opts.includeMentions,
        tableMode,
      });
      // MSC4357: mark the initial message as live so supporting clients start
      // rendering a streaming animation immediately.
      if (opts.live) {
        (content as Record<string, unknown>)[MSC4357_LIVE_KEY] = {};
      }
      const eventId = await client.sendMessage(resolvedRoom, content);
      const replyToId = resolveMatrixReplyToEventId(content);
      return {
        messageId: eventId ?? "unknown",
        roomId: resolvedRoom,
        primaryMessageId: eventId ?? "unknown",
        receipt: createMatrixSendReceipt({
          roomId: resolvedRoom,
          events: eventId
            ? [{ messageId: eventId, kind: "text", ...(replyToId ? { replyToId } : {}) }]
            : [],
          threadId: normalizedThreadId,
        }),
        content: content.body,
      };
    },
  );
}

export async function editMessageMatrix(
  roomId: string,
  originalEventId: string,
  newText: string,
  opts: {
    client?: MatrixClient;
    cfg: CoreConfig;
    threadId?: string;
    accountId?: string;
    timeoutMs?: number;
    msgtype?: MatrixTextMsgType;
    includeMentions?: boolean;
    extraContent?: MatrixExtraContentFields;
    /** When true, marks the edit as a live/streaming update (MSC4357). */
    live?: boolean;
  },
): Promise<string> {
  return await withResolvedMatrixSendClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      accountId: opts.accountId,
      timeoutMs: opts.timeoutMs,
    },
    async (client) => {
      const resolvedRoom = await resolveMatrixRoomId(client, roomId);
      const cfg = requireRuntimeConfig(opts.cfg, "Matrix message edit") as CoreConfig;
      const { convertedText, preparedBody, tableMode } = prepareMatrixSingleText(newText, {
        cfg,
        accountId: opts.accountId,
      });
      const newContent = withMatrixExtraContentFields(
        buildTextContent(convertedText, undefined, {
          msgtype: opts.msgtype,
        }),
        opts.extraContent,
      );
      await enrichMatrixFormattedContent({
        client,
        content: newContent,
        markdown: convertedText,
        preparedBody,
        includeMentions: opts.includeMentions,
        tableMode,
      });
      const threadId = normalizeThreadId(opts.threadId);
      const previousEvent =
        opts.includeMentions !== false || threadId
          ? ((await client.getEvent(resolvedRoom, originalEventId)) as MatrixRawEvent)
          : null;
      const replaceMentions =
        opts.includeMentions === false
          ? undefined
          : diffMatrixMentions(
              extractMatrixMentions(newContent),
              await resolvePreviousEditMentions({
                client,
                roomId: resolvedRoom,
                event: previousEvent,
              }),
            );

      const replaceRelation: Record<string, unknown> = {
        rel_type: RelationType.Replace,
        event_id: originalEventId,
      };
      if (threadId) {
        // Matrix applies m.new_content while preserving the original relation.
        // Edits can update threaded events, but cannot add or move thread membership.
        if (resolvePreviousThreadId(previousEvent) !== threadId) {
          throw new Error("Matrix edit cannot add or change the original event thread relation.");
        }
      }

      // Spread newContent into the outer event so clients that don't support
      // m.new_content still see properly formatted text (with HTML).
      const content: Record<string, unknown> = {
        ...newContent,
        body: `* ${newContent.body}`,
        ...(typeof newContent.formatted_body === "string"
          ? { formatted_body: `* ${newContent.formatted_body}` }
          : {}),
        "m.new_content": newContent,
        "m.relates_to": replaceRelation,
      };
      if (replaceMentions !== undefined) {
        content["m.mentions"] = replaceMentions;
      }

      // MSC4357: mark in-progress edits so supporting clients can render a
      // streaming animation. The marker is placed in both the outer content
      // (for unencrypted rooms / server-side aggregation) and inside
      // m.new_content (for E2EE rooms where only decrypted content is read).
      if (opts.live) {
        content[MSC4357_LIVE_KEY] = {};
        (content["m.new_content"] as Record<string, unknown>)[MSC4357_LIVE_KEY] = {};
      }

      const eventId = await client.sendMessage(resolvedRoom, content);
      return eventId ?? "";
    },
  );
}

export async function reactMatrixMessage(
  roomId: string,
  messageId: string,
  emoji: string,
  opts: MatrixClientResolveOpts = {},
): Promise<void> {
  await withResolvedMatrixSendClient(
    {
      ...opts,
      accountId: opts.accountId ?? undefined,
    },
    async (resolved) => {
      const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
      const reaction = buildMatrixReactionContent(messageId, emoji);
      await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
    },
  );
}
