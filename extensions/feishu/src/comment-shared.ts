import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import {
  isRecord,
  normalizeOptionalString as normalizeString,
  normalizeStringEntries,
  normalizeTrimmedStringList,
  readStringValue as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeCommentFileType, type CommentFileType } from "./comment-target.js";
import { captureFeishuSendAuthority } from "./send-context.js";
import {
  getFeishuSendRateLimitCode,
  getFeishuSendRateLimitCodeFromResponse,
} from "./send-rate-limit.js";

export type FeishuDriveCommentReply = {
  reply_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  content?: { elements?: unknown[] };
};

export type FeishuDriveCommentCard = {
  comment_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  is_solved?: boolean;
  is_whole?: boolean;
  has_more?: boolean;
  page_token?: string;
  quote?: string;
  reply_list?: { replies?: FeishuDriveCommentReply[] };
};

export class FeishuReplyCommentError extends Error {
  httpStatus?: number;
  feishuCode?: number | string;
  feishuMsg?: string;
  feishuLogId?: string;

  constructor(params: {
    message: string;
    httpStatus?: number;
    feishuCode?: number | string;
    feishuMsg?: string;
    feishuLogId?: string;
  }) {
    super(params.message);
    this.name = "FeishuReplyCommentError";
    this.httpStatus = params.httpStatus;
    this.feishuCode = params.feishuCode;
    this.feishuMsg = params.feishuMsg;
    this.feishuLogId = params.feishuLogId;
  }
}

export function encodeQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim();
    if (trimmed) {
      query.set(key, trimmed);
    }
  }
  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

export function extractFeishuApiErrorMeta(error: unknown) {
  if (!isRecord(error)) {
    return { message: typeof error === "string" ? error : JSON.stringify(error) };
  }
  const response = isRecord(error.response) ? error.response : undefined;
  const responseData = isRecord(response?.data) ? response?.data : undefined;
  const nestedError = isRecord(responseData?.error) ? responseData.error : undefined;
  return {
    message: typeof error.message === "string" ? error.message : JSON.stringify(error),
    code: readString(error.code),
    config: isRecord(error.config) ? error.config : undefined,
    httpStatus: typeof response?.status === "number" ? response.status : undefined,
    feishuCode:
      typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
    feishuMsg: readString(responseData?.msg),
    feishuLogId: readString(responseData?.log_id),
    nestedErrorLogId: readString(nestedError?.log_id),
    troubleshooter:
      readString(responseData?.troubleshooter) || readString(nestedError?.troubleshooter),
  };
}

export function formatFeishuApiError(
  error: unknown,
  options: {
    includeConfigParams?: boolean;
    includeNestedErrorLogId?: boolean;
  } = {},
): string {
  if (!isRecord(error)) {
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  const meta = extractFeishuApiErrorMeta(error);
  return JSON.stringify({
    message: meta.message,
    code: meta.code,
    method: readString(meta.config?.method),
    url: readString(meta.config?.url),
    ...(options.includeConfigParams ? { params: meta.config?.params } : {}),
    http_status: meta.httpStatus,
    feishu_code: meta.feishuCode,
    feishu_msg: meta.feishuMsg,
    feishu_log_id:
      meta.feishuLogId || (options.includeNestedErrorLogId ? meta.nestedErrorLogId : undefined),
    feishu_troubleshooter: meta.troubleshooter,
  });
}

const FEISHU_SEND_MAX_RETRIES = 2;
const FEISHU_SEND_RETRY_BASE_MS = 500;

export async function requestFeishuApi<T>(
  request: () => Promise<T>,
  errorPrefix: string,
  options: {
    includeConfigParams?: boolean;
    includeNestedErrorLogId?: boolean;
  } = {},
): Promise<T> {
  const assertSendAuthority = captureFeishuSendAuthority();
  try {
    return await retryAsync(
      async () => {
        assertSendAuthority?.();
        const result = await request();
        // Feishu SDK may fulfill with a rate-limit body (e.g. { code: 11232, ... })
        // instead of throwing. Rethrow it in the AxiosError response shape so
        // getFeishuSendRateLimitCode classifies it retryable and exhaustion
        // wraps it exactly like an SDK throw.
        const fulfilledRateLimit = getFeishuSendRateLimitCodeFromResponse(result);
        if (fulfilledRateLimit !== undefined) {
          throw Object.assign(
            new Error(`Request fulfilled with rate-limit code ${fulfilledRateLimit}`),
            { response: { status: 200, data: result } },
          );
        }
        return result;
      },
      {
        attempts: FEISHU_SEND_MAX_RETRIES + 1,
        // With a 2-retry budget the core exponential schedule (1x, 2x base)
        // matches the previous linear attempt*base backoff exactly; revisit
        // the delay curve if FEISHU_SEND_MAX_RETRIES grows.
        minDelayMs: FEISHU_SEND_RETRY_BASE_MS,
        shouldRetry: (error) => getFeishuSendRateLimitCode(error) !== undefined,
      },
    );
  } catch (error) {
    const details = formatFeishuApiError(error, options);
    throw new Error(`${errorPrefix}: ${details || "unknown error"}`, { cause: error });
  }
}

type ParsedCommentDocumentRef = {
  fileType?: CommentFileType;
  fileToken?: string;
};

type ParsedCommentMention = {
  userId: string;
  displayText: string;
  isBotMention: boolean;
};

type ParsedCommentLinkedDocumentKind =
  | CommentFileType
  | "wiki"
  | "mindnote"
  | "bitable"
  | "base"
  | "unknown";

type ParsedCommentResolvedDocumentType = Exclude<
  ParsedCommentLinkedDocumentKind,
  "wiki" | "unknown"
>;

export type ParsedCommentLinkedDocument = {
  rawUrl: string;
  urlKind: ParsedCommentLinkedDocumentKind;
  wikiNodeToken?: string;
  resolvedObjType?: ParsedCommentResolvedDocumentType;
  resolvedObjToken?: string;
  isCurrentDocument?: boolean;
};

export type ParsedCommentContent = ReturnType<typeof parseCommentContentElements>;

function readDocsLinkUrl(element: Record<string, unknown>): string | undefined {
  const docsLink = isRecord(element.docs_link) ? element.docs_link : undefined;
  return (
    normalizeString(docsLink?.url) ||
    normalizeString(docsLink?.link) ||
    normalizeString(element.url) ||
    normalizeString(element.link) ||
    undefined
  );
}

function readMentionUserId(element: Record<string, unknown>): string | undefined {
  const mention = isRecord(element.mention) ? element.mention : undefined;
  const person = isRecord(element.person) ? element.person : undefined;
  return (
    normalizeString(person?.user_id) ||
    normalizeString(mention?.user_id) ||
    normalizeString(mention?.open_id) ||
    normalizeString(element.mention_user) ||
    normalizeString(element.user_id) ||
    undefined
  );
}

function readMentionDisplayText(element: Record<string, unknown>, userId: string): string {
  const mention = isRecord(element.mention) ? element.mention : undefined;
  const mentionName =
    normalizeString(mention?.name) ||
    normalizeString(mention?.display_name) ||
    normalizeString(element.name);
  return mentionName ? `@${mentionName}` : `@${userId}`;
}

function readElementTextPreservingWhitespace(element: Record<string, unknown>): string | undefined {
  return (
    (isRecord(element.text_run)
      ? readString(element.text_run.content) || readString(element.text_run.text)
      : undefined) ||
    readString(element.text) ||
    readString(element.content) ||
    readString(element.name) ||
    undefined
  );
}

const FEISHU_LINK_TOKEN_MIN_LENGTH = 22;
const FEISHU_LINK_TOKEN_MAX_LENGTH = 28;
const COMMENT_LINK_KIND_ALIASES = new Map<string, ParsedCommentResolvedDocumentType | "wiki">([
  ["doc", "doc"],
  ["docs", "doc"],
  ["docx", "docx"],
  ["sheet", "sheet"],
  ["sheets", "sheet"],
  ["slide", "slides"],
  ["slides", "slides"],
  ["file", "file"],
  ["files", "file"],
  ["wiki", "wiki"],
  ["mindnote", "mindnote"],
  ["mindnotes", "mindnote"],
  ["bitable", "bitable"],
  ["base", "base"],
]);

function isReasonableFeishuLinkToken(token: string | undefined): token is string {
  return (
    typeof token === "string" &&
    token.length >= FEISHU_LINK_TOKEN_MIN_LENGTH &&
    token.length <= FEISHU_LINK_TOKEN_MAX_LENGTH
  );
}

function parseCommentLinkedDocumentPath(pathname: string): {
  urlKind: ParsedCommentResolvedDocumentType | "wiki";
  token: string;
} | null {
  const segments = normalizeStringEntries(pathname.split("/"));
  const offset = segments[0]?.toLowerCase() === "space" ? 1 : 0;
  const kind = COMMENT_LINK_KIND_ALIASES.get(segments[offset]?.toLowerCase() ?? "");
  const token = segments[offset + 1];
  if (!kind || !isReasonableFeishuLinkToken(token)) {
    return null;
  }
  return { urlKind: kind, token };
}

function hasResolvedLinkedDocumentReference(link: ParsedCommentLinkedDocument): boolean {
  return (
    link.urlKind !== "unknown" && (Boolean(link.resolvedObjToken) || Boolean(link.wikiNodeToken))
  );
}

function resolveCommentLinkedDocumentFromUrl(params: {
  rawUrl: string;
  currentDocument?: ParsedCommentDocumentRef;
}): ParsedCommentLinkedDocument {
  const link: ParsedCommentLinkedDocument = {
    rawUrl: params.rawUrl,
    urlKind: "unknown",
  };
  const parsed = URL.parse(params.rawUrl);
  const parsedPath = parsed && parseCommentLinkedDocumentPath(parsed.pathname);
  if (!parsedPath) {
    return link;
  }
  const { urlKind, token } = parsedPath;
  link.urlKind = urlKind;
  if (urlKind === "wiki") {
    link.wikiNodeToken = token;
  } else {
    link.resolvedObjType = urlKind;
    link.resolvedObjToken = token;
  }
  if (
    link.resolvedObjType &&
    link.resolvedObjToken &&
    normalizeCommentFileType(link.resolvedObjType)
  ) {
    link.isCurrentDocument =
      params.currentDocument?.fileType === link.resolvedObjType &&
      params.currentDocument.fileToken === link.resolvedObjToken;
  }
  return link;
}

export function parseCommentContentElements(params: {
  elements?: unknown[];
  botOpenIds?: Iterable<string | undefined>;
  currentDocument?: ParsedCommentDocumentRef;
}) {
  const elements = Array.isArray(params.elements) ? params.elements : [];
  const plainTextParts: string[] = [];
  const semanticTextParts: string[] = [];
  const mentions: ParsedCommentMention[] = [];
  const linkedDocuments: ParsedCommentLinkedDocument[] = [];
  const botIds = new Set(normalizeTrimmedStringList(Array.from(params.botOpenIds ?? [])));
  const linkedDocumentKeys = new Set<string>();
  let botMentioned = false;

  for (const rawElement of elements) {
    if (!isRecord(rawElement)) {
      continue;
    }
    const element = rawElement;
    const type = normalizeString(element.type);
    if (type === "mention" || type === "mention_user" || type === "person") {
      const userId = readMentionUserId(element);
      if (userId) {
        const displayText = readMentionDisplayText(element, userId);
        const isBotMention = botIds.has(userId);
        mentions.push({ userId, displayText, isBotMention });
        plainTextParts.push(displayText);
        if (!isBotMention) {
          semanticTextParts.push(displayText);
        } else {
          botMentioned = true;
        }
        continue;
      }
    }

    if (type === "docs_link" || type === "link") {
      const rawUrl = readDocsLinkUrl(element);
      if (rawUrl) {
        plainTextParts.push(rawUrl);
        semanticTextParts.push(rawUrl);
        const linkedDocument = resolveCommentLinkedDocumentFromUrl({
          rawUrl,
          currentDocument: params.currentDocument,
        });
        if (hasResolvedLinkedDocumentReference(linkedDocument)) {
          const key = [
            linkedDocument.rawUrl,
            linkedDocument.urlKind,
            linkedDocument.resolvedObjType,
            linkedDocument.resolvedObjToken,
            linkedDocument.wikiNodeToken,
          ].join(":");
          if (!linkedDocumentKeys.has(key)) {
            linkedDocumentKeys.add(key);
            linkedDocuments.push(linkedDocument);
          }
        }
        continue;
      }
    }

    const text = readElementTextPreservingWhitespace(element);
    if (text) {
      plainTextParts.push(text);
      semanticTextParts.push(text);
    }
  }

  return {
    plainText: normalizeString(plainTextParts.join("")),
    semanticText: normalizeString(semanticTextParts.join("").replace(/\s+/g, " ")),
    mentions,
    linkedDocuments,
    botMentioned,
  };
}

export function extractReplyText(
  reply: { content?: { elements?: unknown[] } } | undefined,
): string | undefined {
  if (!reply || !isRecord(reply.content)) {
    return undefined;
  }
  return parseCommentContentElements({
    elements: Array.isArray(reply.content.elements) ? reply.content.elements : [],
  }).plainText;
}
