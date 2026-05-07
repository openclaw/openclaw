import { isRecord, normalizeString, readString } from "./comment-shared.js";

export type FeishuEventRoute = "direct" | "publish";

export type NormalizedFeishuEventCategory =
  | "im.message"
  | "im.chat"
  | "drive.comment"
  | "drive.file"
  | "bitable.record"
  | "bitable.field"
  | "approval.instance"
  | "calendar.calendar"
  | "calendar.event"
  | "card.action"
  | "application.bot.menu"
  | "contact"
  | "vc.meeting"
  | "custom";

export type NormalizedFeishuEventActor = {
  openId?: string;
  userId?: string;
  unionId?: string;
};

export type NormalizedFeishuEventSubject = {
  kind:
    | "chat"
    | "message"
    | "drive"
    | "bitable"
    | "approval"
    | "calendar"
    | "card"
    | "contact"
    | "custom";
  tokens: Record<string, string>;
};

export type NormalizedFeishuEvent<TRaw = unknown> = {
  eventType: string;
  route: FeishuEventRoute;
  category: NormalizedFeishuEventCategory;
  subtype: string;
  accountId: string;
  sourceId: string;
  actor?: NormalizedFeishuEventActor;
  subject?: NormalizedFeishuEventSubject;
  summary: string;
  raw: TRaw;
};

type NormalizeFeishuEventParams<TRaw = unknown> = {
  accountId: string;
  eventType: string;
  payload: TRaw;
};

function stripVersionSuffix(value: string): string {
  return value.replace(/_v\d+$/i, "");
}

function readObjectPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function readFirstStringAtPaths(
  value: unknown,
  paths: ReadonlyArray<readonly string[]>,
): string | undefined {
  for (const path of paths) {
    const candidate = normalizeString(readString(readObjectPath(value, path)));
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function pushToken(tokens: Record<string, string>, key: string, value: string | undefined): void {
  if (value) {
    tokens[key] = value;
  }
}

export function resolveFeishuEventRoute(eventType: string): FeishuEventRoute {
  return eventType.startsWith("im.message.") || eventType === "drive.notice.comment_add_v1"
    ? "direct"
    : "publish";
}

export function resolveNormalizedFeishuEventCategory(
  eventType: string,
): NormalizedFeishuEventCategory {
  if (eventType.startsWith("im.message.")) {
    return "im.message";
  }
  if (eventType.startsWith("im.chat.")) {
    return "im.chat";
  }
  if (eventType === "drive.notice.comment_add_v1") {
    return "drive.comment";
  }
  if (eventType.startsWith("drive.file.bitable_record")) {
    return "bitable.record";
  }
  if (eventType.startsWith("drive.file.bitable_field")) {
    return "bitable.field";
  }
  if (eventType.startsWith("drive.file.")) {
    return "drive.file";
  }
  if (eventType.startsWith("approval.") || eventType.endsWith("_approval")) {
    return "approval.instance";
  }
  if (eventType.startsWith("calendar.calendar.event.")) {
    return "calendar.event";
  }
  if (eventType.startsWith("calendar.calendar.")) {
    return "calendar.calendar";
  }
  if (eventType === "card.action.trigger") {
    return "card.action";
  }
  if (eventType.startsWith("application.bot.menu")) {
    return "application.bot.menu";
  }
  if (eventType.startsWith("contact.")) {
    return "contact";
  }
  if (eventType.startsWith("vc.meeting.")) {
    return "vc.meeting";
  }
  return "custom";
}

function resolveFeishuEventSubtype(eventType: string): string {
  const segments = eventType.split(".").filter(Boolean);
  const last = segments.at(-1);
  return last ? stripVersionSuffix(last) : "unknown";
}

function resolveFeishuEventActor(
  eventType: string,
  payload: unknown,
): NormalizedFeishuEventActor | undefined {
  const openId = readFirstStringAtPaths(payload, [
    ["sender", "sender_id", "open_id"],
    ["user_id", "open_id"],
    ["operator_id", "open_id"],
    ["operator", "open_id"],
    ["notice_meta", "from_user_id", "open_id"],
    ["from_user_id", "open_id"],
  ]);
  const userId = readFirstStringAtPaths(payload, [
    ["sender", "sender_id", "user_id"],
    ["user_id", "user_id"],
    ["operator_id", "user_id"],
    ["operator", "user_id"],
    ["notice_meta", "from_user_id", "user_id"],
    ["from_user_id", "user_id"],
  ]);
  const unionId = readFirstStringAtPaths(payload, [
    ["sender", "sender_id", "union_id"],
    ["operator_id", "union_id"],
    ["operator", "union_id"],
  ]);
  if (!openId && !userId && !unionId) {
    if (eventType === "p2p_chat_create") {
      const p2pOpenId = readFirstStringAtPaths(payload, [["open_id"]]);
      return p2pOpenId ? { openId: p2pOpenId } : undefined;
    }
    return undefined;
  }
  return {
    ...(openId ? { openId } : {}),
    ...(userId ? { userId } : {}),
    ...(unionId ? { unionId } : {}),
  };
}

function resolveChatSubject(payload: unknown): NormalizedFeishuEventSubject | undefined {
  const tokens: Record<string, string> = {};
  pushToken(
    tokens,
    "chatId",
    readFirstStringAtPaths(payload, [
      ["message", "chat_id"],
      ["chat_id"],
      ["context", "chat_id"],
      ["context", "open_chat_id"],
    ]),
  );
  pushToken(
    tokens,
    "messageId",
    readFirstStringAtPaths(payload, [
      ["message", "message_id"],
      ["message_id"],
      ["open_message_id"],
      ["context", "open_message_id"],
    ]),
  );
  pushToken(
    tokens,
    "threadId",
    readFirstStringAtPaths(payload, [
      ["message", "thread_id"],
      ["message", "root_id"],
      ["thread_id"],
    ]),
  );
  return Object.keys(tokens).length > 0 ? { kind: "chat", tokens } : undefined;
}

function resolveDriveSubject(payload: unknown): NormalizedFeishuEventSubject | undefined {
  const tokens: Record<string, string> = {};
  pushToken(
    tokens,
    "fileType",
    readFirstStringAtPaths(payload, [["notice_meta", "file_type"], ["file_type"]]),
  );
  pushToken(
    tokens,
    "fileToken",
    readFirstStringAtPaths(payload, [["notice_meta", "file_token"], ["file_token"]]),
  );
  pushToken(tokens, "commentId", readFirstStringAtPaths(payload, [["comment_id"]]));
  pushToken(tokens, "replyId", readFirstStringAtPaths(payload, [["reply_id"]]));
  return Object.keys(tokens).length > 0 ? { kind: "drive", tokens } : undefined;
}

function resolveBitableSubject(payload: unknown): NormalizedFeishuEventSubject | undefined {
  const tokens: Record<string, string> = {};
  pushToken(
    tokens,
    "appToken",
    readFirstStringAtPaths(payload, [
      ["app_token"],
      ["base_id"],
      ["base_token"],
      ["table", "app_token"],
    ]),
  );
  pushToken(
    tokens,
    "tableId",
    readFirstStringAtPaths(payload, [["table_id"], ["table", "table_id"]]),
  );
  pushToken(
    tokens,
    "recordId",
    readFirstStringAtPaths(payload, [["record_id"], ["record", "record_id"]]),
  );
  pushToken(
    tokens,
    "fieldId",
    readFirstStringAtPaths(payload, [["field_id"], ["field", "field_id"]]),
  );
  return Object.keys(tokens).length > 0 ? { kind: "bitable", tokens } : undefined;
}

function resolveApprovalSubject(payload: unknown): NormalizedFeishuEventSubject | undefined {
  const tokens: Record<string, string> = {};
  pushToken(
    tokens,
    "instanceCode",
    readFirstStringAtPaths(payload, [["instance_code"], ["approval_instance_code"]]),
  );
  pushToken(
    tokens,
    "approvalCode",
    readFirstStringAtPaths(payload, [["approval_code"], ["definition_code"]]),
  );
  return Object.keys(tokens).length > 0 ? { kind: "approval", tokens } : undefined;
}

function resolveCalendarSubject(payload: unknown): NormalizedFeishuEventSubject | undefined {
  const tokens: Record<string, string> = {};
  pushToken(
    tokens,
    "calendarId",
    readFirstStringAtPaths(payload, [["calendar_id"], ["calendar", "calendar_id"]]),
  );
  pushToken(
    tokens,
    "eventId",
    readFirstStringAtPaths(payload, [["event_id"], ["event", "event_id"]]),
  );
  return Object.keys(tokens).length > 0 ? { kind: "calendar", tokens } : undefined;
}

function resolveCardSubject(payload: unknown): NormalizedFeishuEventSubject | undefined {
  const tokens: Record<string, string> = {};
  pushToken(tokens, "token", readFirstStringAtPaths(payload, [["token"]]));
  pushToken(
    tokens,
    "openMessageId",
    readFirstStringAtPaths(payload, [["open_message_id"], ["context", "open_message_id"]]),
  );
  pushToken(
    tokens,
    "chatId",
    readFirstStringAtPaths(payload, [
      ["context", "chat_id"],
      ["context", "open_chat_id"],
    ]),
  );
  return Object.keys(tokens).length > 0 ? { kind: "card", tokens } : undefined;
}

function resolveContactSubject(payload: unknown): NormalizedFeishuEventSubject | undefined {
  const tokens: Record<string, string> = {};
  pushToken(
    tokens,
    "userId",
    readFirstStringAtPaths(payload, [["object", "user_id"], ["user_id"], ["open_id"]]),
  );
  pushToken(
    tokens,
    "departmentId",
    readFirstStringAtPaths(payload, [["object", "department_id"], ["department_id"]]),
  );
  return Object.keys(tokens).length > 0 ? { kind: "contact", tokens } : undefined;
}

function resolveFeishuEventSubject(
  category: NormalizedFeishuEventCategory,
  payload: unknown,
): NormalizedFeishuEventSubject | undefined {
  if (category === "im.message" || category === "im.chat") {
    return resolveChatSubject(payload);
  }
  if (category === "drive.comment" || category === "drive.file") {
    return resolveDriveSubject(payload);
  }
  if (category === "bitable.record" || category === "bitable.field") {
    return resolveBitableSubject(payload);
  }
  if (category === "approval.instance") {
    return resolveApprovalSubject(payload);
  }
  if (category === "calendar.calendar" || category === "calendar.event") {
    return resolveCalendarSubject(payload);
  }
  if (category === "card.action" || category === "application.bot.menu") {
    return resolveCardSubject(payload);
  }
  if (category === "contact") {
    return resolveContactSubject(payload);
  }
  return undefined;
}

function resolveFeishuEventSourceId(
  eventType: string,
  category: NormalizedFeishuEventCategory,
  payload: unknown,
): string {
  const messageOrChatId = readFirstStringAtPaths(payload, [
    ["message", "message_id"],
    ["message_id"],
    ["chat_id"],
    ["context", "chat_id"],
  ]);
  if (category === "im.message" && messageOrChatId) {
    return messageOrChatId;
  }

  const driveEventId = readFirstStringAtPaths(payload, [
    ["event_id"],
    ["comment_id"],
    ["reply_id"],
  ]);
  if (category === "drive.comment" && driveEventId) {
    return driveEventId;
  }

  const bitableId = readFirstStringAtPaths(payload, [
    ["record_id"],
    ["record", "record_id"],
    ["field_id"],
    ["field", "field_id"],
    ["event_id"],
  ]);
  if ((category === "bitable.record" || category === "bitable.field") && bitableId) {
    return bitableId;
  }

  const genericId = readFirstStringAtPaths(payload, [
    ["event_id"],
    ["token"],
    ["instance_code"],
    ["approval_code"],
    ["open_message_id"],
    ["comment_id"],
    ["reply_id"],
    ["message_id"],
    ["chat_id"],
    ["record_id"],
    ["field_id"],
    ["calendar_id"],
  ]);
  if (genericId) {
    return genericId;
  }

  const subjectId = resolveFeishuEventSubject(category, payload);
  const tokenString = subjectId
    ? Object.entries(subjectId.tokens)
        .map(([key, value]) => `${key}=${value}`)
        .join(",")
    : "none";
  return `${eventType}:${tokenString}`;
}

function buildFeishuEventSummary(params: {
  eventType: string;
  category: NormalizedFeishuEventCategory;
  subtype: string;
  sourceId: string;
  subject?: NormalizedFeishuEventSubject;
}): string {
  const parts = [`${params.eventType}`, `category=${params.category}`, `subtype=${params.subtype}`];
  if (params.subject) {
    const tokens = Object.entries(params.subject.tokens)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    if (tokens) {
      parts.push(`${params.subject.kind}[${tokens}]`);
    }
  }
  parts.push(`source=${params.sourceId}`);
  return parts.join(" ");
}

export function normalizeFeishuEvent<TRaw = unknown>(
  params: NormalizeFeishuEventParams<TRaw>,
): NormalizedFeishuEvent<TRaw> {
  const category = resolveNormalizedFeishuEventCategory(params.eventType);
  const subject = resolveFeishuEventSubject(category, params.payload);
  const sourceId = resolveFeishuEventSourceId(params.eventType, category, params.payload);
  const subtype = resolveFeishuEventSubtype(params.eventType);
  const route = resolveFeishuEventRoute(params.eventType);
  return {
    eventType: params.eventType,
    route,
    category,
    subtype,
    accountId: params.accountId,
    sourceId,
    actor: resolveFeishuEventActor(params.eventType, params.payload),
    subject,
    summary: buildFeishuEventSummary({
      eventType: params.eventType,
      category,
      subtype,
      sourceId,
      subject,
    }),
    raw: params.payload,
  };
}
