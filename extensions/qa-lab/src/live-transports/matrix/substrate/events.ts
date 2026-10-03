import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { asNullableObjectRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
export type MatrixQaRoomEvent = {
  content?: Record<string, unknown>;
  event_id?: string;
  origin_server_ts?: number;
  redacts?: string;
  sender?: string;
  state_key?: string;
  type?: string;
};

type MatrixQaObservedEventKind =
  | "membership"
  | "message"
  | "notice"
  | "redaction"
  | "reaction"
  | "room-event";

type MatrixQaObservedEventAttachment = {
  caption?: string;
  filename?: string;
  kind: "audio" | "file" | "image" | "sticker" | "video";
};

type MatrixQaObservedApproval = {
  agentId?: string;
  allowedDecisions?: string[];
  commandTextPreview?: string;
  hasCommandText?: boolean;
  id: string;
  kind: ChannelApprovalKind;
  pluginId?: string;
  severity?: string;
  state?: string;
  toolName?: string;
  type?: string;
  version?: number;
};

export type MatrixQaObservedEvent = {
  kind: MatrixQaObservedEventKind;
  roomId: string;
  eventId: string;
  sender?: string;
  stateKey?: string;
  type: string;
  originServerTs?: number;
  body?: string;
  formattedBody?: string;
  msgtype?: string;
  live?: true;
  membership?: string;
  relatesTo?: {
    eventId?: string;
    inReplyToId?: string;
    isFallingBack?: boolean;
    relType?: string;
  };
  mentions?: {
    room?: boolean;
    userIds?: string[];
  };
  reaction?: {
    eventId?: string;
    key?: string;
  };
  replacesEventId?: string;
  redactsEventId?: string;
  attachment?: MatrixQaObservedEventAttachment;
  approval?: MatrixQaObservedApproval;
};

const MATRIX_QA_APPROVAL_METADATA_KEY = "com.openclaw.approval";
const MATRIX_QA_APPROVAL_COMMAND_PREVIEW_CHARS = 160;

function readNonEmptyStringEntries(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
}

function resolveMatrixQaMessageContent(
  content: Record<string, unknown>,
  relatesTo: Record<string, unknown> | null,
) {
  const newContent = asNullableObjectRecord(content["m.new_content"]);
  if (relatesTo?.rel_type === "m.replace" && newContent) {
    return newContent;
  }
  return content;
}

function normalizeMatrixQaRelation(value: unknown) {
  const relation = asNullableObjectRecord(value);
  if (!relation) {
    return undefined;
  }
  const inReplyTo = asNullableObjectRecord(relation["m.in_reply_to"]);
  return {
    eventId: readStringField(relation, "event_id"),
    inReplyToId: readStringField(inReplyTo, "event_id"),
    isFallingBack:
      typeof relation.is_falling_back === "boolean" ? relation.is_falling_back : undefined,
    relType: readStringField(relation, "rel_type"),
  };
}

function resolveMatrixQaObservedEventKind(params: { msgtype?: string; type: string }) {
  if (params.type === "m.reaction") {
    return "reaction" as const;
  }
  if (params.type === "m.room.redaction") {
    return "redaction" as const;
  }
  if (params.type === "m.room.member") {
    return "membership" as const;
  }
  if (params.type === "m.room.message") {
    return params.msgtype === "m.notice" ? ("notice" as const) : ("message" as const);
  }
  return "room-event" as const;
}

function resolveMatrixQaAttachmentKind(msgtype: string | undefined) {
  switch (msgtype) {
    case "m.audio":
      return "audio" as const;
    case "m.file":
      return "file" as const;
    case "m.image":
      return "image" as const;
    case "m.sticker":
      return "sticker" as const;
    case "m.video":
      return "video" as const;
    default:
      return undefined;
  }
}

function isLikelyMatrixQaFilenameBody(value: string) {
  return !value.includes("\n") && /\.[a-z0-9][a-z0-9._-]{0,24}$/i.test(value);
}

function resolveMatrixQaAttachmentSummary(params: {
  body?: string;
  filename?: string;
  msgtype?: string;
}): MatrixQaObservedEventAttachment | undefined {
  const kind = resolveMatrixQaAttachmentKind(params.msgtype);
  if (!kind) {
    return undefined;
  }
  const body = params.body?.trim() ?? "";
  const explicitFilename = params.filename?.trim() ?? "";
  const inferredFilename =
    !explicitFilename && body && isLikelyMatrixQaFilenameBody(body) ? body : "";
  const filename = explicitFilename || inferredFilename;
  const caption = body && body !== filename ? body : "";
  return {
    kind,
    ...(caption ? { caption } : {}),
    ...(filename ? { filename } : {}),
  };
}

function normalizeMatrixQaApprovalMetadata(value: unknown): MatrixQaObservedApproval | undefined {
  const metadata = asNullableObjectRecord(value);
  if (!metadata) {
    return undefined;
  }
  const id = readStringField(metadata, "id")?.trim();
  const kind = metadata.kind;
  if (!id || (kind !== "exec" && kind !== "plugin")) {
    return undefined;
  }
  const commandText = readStringField(metadata, "commandText")?.trim();
  const commandPreview = readStringField(metadata, "commandPreview")?.trim();
  const commandTextPreview = commandPreview?.slice(0, MATRIX_QA_APPROVAL_COMMAND_PREVIEW_CHARS);
  return {
    id,
    kind,
    ...(typeof metadata.agentId === "string" ? { agentId: metadata.agentId } : {}),
    ...(typeof metadata.state === "string" ? { state: metadata.state } : {}),
    ...(typeof metadata.type === "string" ? { type: metadata.type } : {}),
    ...(typeof metadata.version === "number" ? { version: metadata.version } : {}),
    ...(metadata.allowedDecisions
      ? { allowedDecisions: readNonEmptyStringEntries(metadata.allowedDecisions) }
      : {}),
    ...(commandText ? { hasCommandText: true } : {}),
    ...(commandTextPreview ? { commandTextPreview } : {}),
    ...(kind === "plugin" && typeof metadata.pluginId === "string"
      ? { pluginId: metadata.pluginId }
      : {}),
    ...(kind === "plugin" && typeof metadata.severity === "string"
      ? { severity: metadata.severity }
      : {}),
    ...(kind === "plugin" && typeof metadata.toolName === "string"
      ? { toolName: metadata.toolName }
      : {}),
  };
}

export function normalizeMatrixQaObservedEvent(
  roomId: string,
  event: MatrixQaRoomEvent,
): MatrixQaObservedEvent | null {
  const eventId = event.event_id?.trim();
  const type = event.type?.trim();
  if (!eventId || !type) {
    return null;
  }
  const content = event.content ?? {};
  const msgtype = readStringField(content, "msgtype");
  const relatesToRaw = content["m.relates_to"];
  const relatesTo = asNullableObjectRecord(relatesToRaw);
  const messageContent = resolveMatrixQaMessageContent(content, relatesTo);
  const replacesEventId =
    relatesTo?.rel_type === "m.replace" && typeof relatesTo.event_id === "string"
      ? relatesTo.event_id
      : undefined;
  // An edit's outer m.replace relation describes wire delivery, not the
  // logical relation of the edited message. Matrix ignores relations inside
  // m.new_content, so the observer must inherit the original event's relation.
  const logicalRelation = replacesEventId ? undefined : normalizeMatrixQaRelation(relatesToRaw);
  const normalizedMsgtype = readStringField(messageContent, "msgtype") ?? msgtype;
  const normalizedFilename =
    readStringField(messageContent, "filename") ?? readStringField(content, "filename");
  const mentions = asNullableObjectRecord(messageContent["m.mentions"] ?? content["m.mentions"]);
  const mentionUserIds = readNonEmptyStringEntries(mentions?.user_ids);
  const reactionKey =
    type === "m.reaction" && typeof relatesTo?.key === "string" ? relatesTo.key : undefined;
  const reactionEventId =
    type === "m.reaction" && typeof relatesTo?.event_id === "string"
      ? relatesTo.event_id
      : undefined;
  const attachment = resolveMatrixQaAttachmentSummary({
    body: readStringField(messageContent, "body"),
    filename: normalizedFilename,
    msgtype: normalizedMsgtype,
  });
  const approval = normalizeMatrixQaApprovalMetadata(
    messageContent[MATRIX_QA_APPROVAL_METADATA_KEY] ?? content[MATRIX_QA_APPROVAL_METADATA_KEY],
  );
  const redactsEventId =
    type === "m.room.redaction"
      ? typeof event.redacts === "string"
        ? event.redacts
        : readStringField(content, "redacts")
      : undefined;

  return {
    kind: resolveMatrixQaObservedEventKind({ msgtype: normalizedMsgtype, type }),
    roomId,
    eventId,
    sender: typeof event.sender === "string" ? event.sender : undefined,
    stateKey: typeof event.state_key === "string" ? event.state_key : undefined,
    type,
    originServerTs:
      typeof event.origin_server_ts === "number" ? Math.floor(event.origin_server_ts) : undefined,
    body: readStringField(messageContent, "body"),
    formattedBody: readStringField(messageContent, "formatted_body"),
    msgtype: normalizedMsgtype,
    ...("org.matrix.msc4357.live" in messageContent ? { live: true as const } : {}),
    membership: readStringField(content, "membership"),
    ...(logicalRelation ? { relatesTo: logicalRelation } : {}),
    ...(mentions
      ? {
          mentions: {
            ...(mentions.room === true ? { room: true } : {}),
            ...(mentionUserIds ? { userIds: mentionUserIds } : {}),
          },
        }
      : {}),
    ...(reactionEventId || reactionKey
      ? {
          reaction: {
            ...(reactionEventId ? { eventId: reactionEventId } : {}),
            ...(reactionKey ? { key: reactionKey } : {}),
          },
        }
      : {}),
    ...(redactsEventId ? { redactsEventId } : {}),
    ...(replacesEventId ? { replacesEventId } : {}),
    ...(attachment ? { attachment } : {}),
    ...(approval ? { approval } : {}),
  };
}

export function inheritMatrixQaReplacementRelation(params: {
  event: MatrixQaObservedEvent;
  replacedEvent?: MatrixQaObservedEvent;
}) {
  if (!params.event.replacesEventId || params.event.relatesTo || !params.replacedEvent?.relatesTo) {
    return params.event;
  }
  return { ...params.event, relatesTo: params.replacedEvent.relatesTo };
}

export function findMatrixQaObservedEventMatch(params: {
  cursorIndex: number;
  events: MatrixQaObservedEvent[];
  predicate: (event: MatrixQaObservedEvent) => boolean;
  roomId: string;
}) {
  for (let index = params.cursorIndex; index < params.events.length; index += 1) {
    const event = params.events[index];
    if (event?.roomId !== params.roomId) {
      continue;
    }
    if (params.predicate(event)) {
      return {
        event,
        nextCursorIndex: index + 1,
      };
    }
  }
  return undefined;
}
