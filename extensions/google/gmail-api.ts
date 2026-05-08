import type {
  GmailDraftCreateRequest,
  GmailDraftMessageInput,
  GmailEncodedMessageRequest,
  GmailSearchParams,
} from "./gmail-types.js";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MIME_CRLF = "\r\n";

function normalizeRecipientList(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => entry.trim()).filter(Boolean);
}

function encodeHeaderValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function buildHeader(name: string, value?: string | string[]): string | null {
  const list = normalizeRecipientList(value);
  if (typeof value === "string" && name.toLowerCase() === "subject") {
    return `${name}: ${encodeHeaderValue(value)}`;
  }
  if (list.length === 0) {
    return null;
  }
  return `${name}: ${list.map(encodeHeaderValue).join(", ")}`;
}

function buildTextMime(params: GmailDraftMessageInput): string {
  const headers = [
    buildHeader("From", params.from),
    buildHeader("To", params.to),
    buildHeader("Cc", params.cc),
    buildHeader("Bcc", params.bcc),
    buildHeader("Subject", params.subject),
    buildHeader("In-Reply-To", params.inReplyTo),
    buildHeader("References", params.references),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ].filter((value): value is string => Boolean(value));
  return `${headers.join(MIME_CRLF)}${MIME_CRLF}${MIME_CRLF}${params.textBody ?? ""}`;
}

function buildHtmlMime(params: GmailDraftMessageInput): string {
  const boundary = `openclaw-gmail-${Math.random().toString(16).slice(2)}`;
  const headers = [
    buildHeader("From", params.from),
    buildHeader("To", params.to),
    buildHeader("Cc", params.cc),
    buildHeader("Bcc", params.bcc),
    buildHeader("Subject", params.subject),
    buildHeader("In-Reply-To", params.inReplyTo),
    buildHeader("References", params.references),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter((value): value is string => Boolean(value));
  const parts: string[] = [];
  if (params.textBody) {
    parts.push(
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
      "",
      params.textBody,
    );
  }
  parts.push(
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    params.htmlBody ?? "",
    `--${boundary}--`,
  );
  return `${headers.join(MIME_CRLF)}${MIME_CRLF}${MIME_CRLF}${parts.join(MIME_CRLF)}`;
}

export function encodeBase64UrlUtf8(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function buildGmailDraftMime(params: GmailDraftMessageInput): string {
  if (!normalizeRecipientList(params.to).length) {
    throw new Error("Draft requires at least one 'to' recipient");
  }
  if (!params.subject.trim()) {
    throw new Error("Draft requires a subject");
  }
  if (!params.textBody && !params.htmlBody) {
    throw new Error("Draft requires textBody or htmlBody");
  }
  return params.htmlBody ? buildHtmlMime(params) : buildTextMime(params);
}

export function buildGmailEncodedMessageRequest(
  params: GmailDraftMessageInput,
): GmailEncodedMessageRequest {
  return {
    raw: encodeBase64UrlUtf8(buildGmailDraftMime(params)),
    ...(params.threadId ? { threadId: params.threadId } : {}),
  };
}

export function buildGmailDraftCreateRequest(
  params: GmailDraftMessageInput,
): GmailDraftCreateRequest {
  return {
    message: buildGmailEncodedMessageRequest(params),
  };
}

export function buildGmailSearchQuery(params: GmailSearchParams): string {
  const parts: string[] = [];
  if (params.inInbox) {
    parts.push("in:inbox");
  }
  if (params.unread) {
    parts.push("is:unread");
  }
  for (const label of params.labels ?? []) {
    const trimmed = label.trim();
    if (trimmed) {
      parts.push(`label:${trimmed}`);
    }
  }
  if (params.newerThanDays && Number.isFinite(params.newerThanDays) && params.newerThanDays > 0) {
    parts.push(`newer_than:${Math.floor(params.newerThanDays)}d`);
  }
  if (params.from?.trim()) {
    parts.push(`from:${params.from.trim()}`);
  }
  if (params.to?.trim()) {
    parts.push(`to:${params.to.trim()}`);
  }
  if (params.subject?.trim()) {
    parts.push(`subject:(${params.subject.trim()})`);
  }
  for (const word of params.hasWords ?? []) {
    const trimmed = word.trim();
    if (trimmed) {
      parts.push(`"${trimmed.replace(/"/g, '\\"')}"`);
    }
  }
  if (params.query?.trim()) {
    parts.push(params.query.trim());
  }
  return parts.join(" ").trim();
}

export function buildGmailApiUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${GMAIL_API_BASE_URL}${normalizedPath}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === false || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
