import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type { PersistentDedupeEntry } from "openclaw/plugin-sdk/persistent-dedupe";
import { z } from "zod";
import type {
  NextcloudTalkInboundAttachment,
  NextcloudTalkInboundMessage,
  NextcloudTalkInboundQuote,
} from "./types.js";

export const NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION = 1;

export type NextcloudTalkIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEvent: string;
};

export type NextcloudTalkLegacyReplayEntry = PersistentDedupeEntry;

export type NextcloudTalkLegacyReplayStore = {
  entries: () => Promise<Array<{ value: NextcloudTalkLegacyReplayEntry }>>;
  clear: () => Promise<void>;
};

export class NextcloudTalkWebhookPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NextcloudTalkWebhookPayloadError";
  }
}

function parseRawObject(rawEvent: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new NextcloudTalkWebhookPayloadError("Nextcloud Talk webhook contains invalid JSON.", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new NextcloudTalkWebhookPayloadError("Nextcloud Talk webhook must be a JSON object.");
  }
  return parsed;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new NextcloudTalkWebhookPayloadError(`Nextcloud Talk webhook is missing ${field}.`);
}

/** Read one optional signed parent without rejecting an otherwise valid current message. */
function parseNextcloudTalkQuotedReply(
  envelope: Record<string, unknown>,
): NextcloudTalkInboundQuote | undefined {
  const object = isRecord(envelope.object) ? envelope.object : null;
  const quote = isRecord(object?.inReplyTo) ? object.inReplyTo : null;
  const actor = isRecord(quote?.actor) ? quote.actor : null;
  const parent = isRecord(quote?.object) ? quote.object : null;
  if (
    quote?.type !== "Note" ||
    actor?.type !== "Person" ||
    typeof actor.id !== "string" ||
    !actor.id.trim() ||
    typeof actor.name !== "string" ||
    parent?.type !== "Note" ||
    typeof parent.id !== "string" ||
    !parent.id.trim() ||
    typeof parent.content !== "string"
  ) {
    return undefined;
  }

  let body = parent.content;
  let structured: unknown;
  try {
    structured = JSON.parse(body);
  } catch {
    // Plain text is supported alongside Talk's JSON-encoded rich strings.
  }
  if (isRecord(structured)) {
    const parameters: Record<string, unknown> | undefined = isRecord(structured.parameters)
      ? structured.parameters
      : Array.isArray(structured.parameters) && structured.parameters.length === 0
        ? {}
        : undefined;
    if (typeof structured.message !== "string" || !parameters) {
      return undefined;
    }
    body = structured.message.replace(/\{([^{}]+)\}/gu, (placeholder, key: string) => {
      const parameter = Object.hasOwn(parameters, key) ? parameters[key] : undefined;
      return isRecord(parameter) && typeof parameter.name === "string"
        ? parameter.name
        : placeholder;
    });
  } else if (Array.isArray(structured)) {
    return undefined;
  }
  return {
    id: parent.id.trim(),
    senderId: actor.id.trim(),
    senderName: actor.name,
    body,
  };
}

export type ParsedNextcloudTalkFileShare = {
  text: string;
  mentionText: string;
  attachment?: NextcloudTalkInboundAttachment;
  attachmentIssue?: "media_missing_metadata";
};

function parseDeclaredSizeBytes(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseFileAttachment(value: unknown): NextcloudTalkInboundAttachment | undefined {
  if (!isRecord(value) || value.type !== "file") {
    return undefined;
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const mimeType = typeof value.mimetype === "string" ? value.mimetype.trim() : "";
  const shareUrl = typeof value.link === "string" ? value.link.trim() : "";
  const declaredSizeBytes = parseDeclaredSizeBytes(value.size);
  const hideDownload = value["hide-download"];
  if (
    !name ||
    !mimeType ||
    !shareUrl ||
    declaredSizeBytes === undefined ||
    (hideDownload !== undefined && hideDownload !== "yes" && hideDownload !== "no")
  ) {
    return undefined;
  }
  const fileId = typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined;
  return {
    ...(fileId ? { fileId } : {}),
    name,
    mimeType,
    declaredSizeBytes,
    shareUrl,
    hideDownload: hideDownload === "yes",
  };
}

/** Recognize Talk's file-bearing message Activity without admitting other system events. */
function parseNextcloudTalkFileSharedActivity(
  envelope: Record<string, unknown>,
): ParsedNextcloudTalkFileShare | null {
  if (envelope.type !== "Activity") {
    return null;
  }
  const object = isRecord(envelope.object) ? envelope.object : null;
  if (
    object?.type !== "Note" ||
    (object.name !== "file_shared" && object.name !== "message" && object.name !== "")
  ) {
    return null;
  }

  let content: unknown;
  try {
    content = typeof object.content === "string" ? JSON.parse(object.content) : null;
  } catch {
    content = null;
  }
  const contentRecord = isRecord(content) ? content : null;
  const parameters = isRecord(contentRecord?.parameters) ? contentRecord.parameters : null;
  if (!parameters || !Object.hasOwn(parameters, "file")) {
    return null;
  }
  const message = typeof contentRecord?.message === "string" ? contentRecord.message : "";
  const text = message.trim() === "{file}" ? "" : message;
  // Only referenced user placeholders contribute to mention gating. Actor and
  // file metadata may contain the bot name without addressing the bot.
  const mentionText = text.replace(/\{([^{}]+)\}/gu, (placeholder, key: string) => {
    const parameter = Object.hasOwn(parameters, key) ? parameters[key] : undefined;
    return isRecord(parameter) && parameter.type === "user" && typeof parameter.name === "string"
      ? `@${parameter.name}`
      : placeholder;
  });
  const attachment = parseFileAttachment(parameters.file);
  return attachment
    ? { text, mentionText, attachment }
    : { text, mentionText, attachmentIssue: "media_missing_metadata" };
}

export function inspectNextcloudTalkWebhookEnvelope(
  rawEvent: string,
): { eventId: string; laneKey: string } | null {
  const envelope = parseRawObject(rawEvent);
  const isCreateMessage = envelope.type === "Create";
  const isFileShare = parseNextcloudTalkFileSharedActivity(envelope) !== null;
  if (!isCreateMessage && !isFileShare) {
    return null;
  }
  const object = isRecord(envelope.object) ? envelope.object : null;
  if (object?.type !== undefined && object.type !== "Note") {
    return null;
  }
  if (!object) {
    throw new NextcloudTalkWebhookPayloadError("Nextcloud Talk webhook is missing object.");
  }
  const target = isRecord(envelope.target) ? envelope.target : null;
  return {
    eventId: requiredString(object.id, "object.id"),
    laneKey: `room:${requiredString(target?.id, "target.id")}`,
  };
}

// Activity Streams payload: https://nextcloud-talk.readthedocs.io/en/latest/bots/
const NextcloudTalkWebhookPayloadSchema = z.object({
  type: z.enum(["Create", "Update", "Delete", "Activity"]),
  actor: z.object({
    type: z.literal("Person"),
    id: z.string().min(1),
    name: z.string(),
  }),
  object: z.object({
    type: z.literal("Note"),
    id: z.string().min(1),
    name: z.string(),
    content: z.string(),
    mediaType: z.string(),
  }),
  target: z.object({
    type: z.literal("Collection"),
    id: z.string().min(1),
    name: z.string(),
  }),
});

export function parseClaimedMessage(payload: NextcloudTalkIngressPayload, claimedId: string) {
  const rawEnvelope = parseRawObject(payload.rawEvent);
  const result = NextcloudTalkWebhookPayloadSchema.safeParse(rawEnvelope);
  const fileShare = parseNextcloudTalkFileSharedActivity(rawEnvelope);
  if (!result.success) {
    throw new NextcloudTalkWebhookPayloadError(
      `Nextcloud Talk ingress row ${claimedId} has invalid message identity.`,
    );
  }
  const webhook = result.data;
  const isSupportedEvent =
    webhook.type === "Create" || (webhook.type === "Activity" && fileShare !== null);
  if (!isSupportedEvent || webhook.object.id !== claimedId) {
    throw new NextcloudTalkWebhookPayloadError(
      `Nextcloud Talk ingress row ${claimedId} has invalid message identity.`,
    );
  }
  const roomId = requiredString(webhook.target.id, "target.id");
  const quote = parseNextcloudTalkQuotedReply(rawEnvelope);
  const message: NextcloudTalkInboundMessage = {
    messageId: webhook.object.id,
    roomToken: roomId,
    roomName: webhook.target.name,
    senderId: webhook.actor.id,
    senderName: webhook.actor.name,
    text: fileShare ? fileShare.text : webhook.object.content || webhook.object.name,
    ...(fileShare ? { mentionText: fileShare.mentionText } : {}),
    mediaType: webhook.object.mediaType || "text/plain",
    timestamp: payload.receivedAt,
    // Activity Streams does not distinguish Talk room kinds. Runtime lookup refines this.
    isGroupChat: true,
    ...(fileShare?.attachment ? { attachment: fileShare.attachment } : {}),
    ...(fileShare?.attachmentIssue ? { attachmentIssue: fileShare.attachmentIssue } : {}),
    ...(quote ? { quote } : {}),
  };
  return message;
}

export function describeIgnoredWebhookEvent(rawEvent: string): string {
  // Admission already parsed ignored envelopes; this read selects bounded log fields only.
  const envelope = parseRawObject(rawEvent);
  const type = typeof envelope.type === "string" ? envelope.type : "unknown";
  const object = isRecord(envelope.object) ? envelope.object : null;
  const objectType = typeof object?.type === "string" ? object.type : "unknown";
  return `type=${type} objectType=${objectType}`;
}
