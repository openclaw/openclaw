import { encodeQuery, isRecord, normalizeString } from "./comment-shared.js";
import type { CommentFileType } from "./comment-target.js";
import type { FeishuCommentPolicy, FeishuCommentsConfig } from "./types.js";

const DEFAULT_FEISHU_COMMENT_POLICY: FeishuCommentPolicy = "pairing";
const FEISHU_COMMENT_WIKI_LOOKUP_TIMEOUT_MS = 3_000;

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function buildFeishuCommentDocumentKey(params: {
  fileType: string;
  fileToken: string;
}): string {
  return `${params.fileType}:${params.fileToken}`;
}

type FeishuCommentWikiLookupClient = {
  request(params: { method: "GET"; url: string; data: unknown; timeout: number }): Promise<unknown>;
};

export function hasFeishuCommentDirectDocumentRule(params: {
  comments?: FeishuCommentsConfig;
  fileType: string;
  fileToken: string;
}): boolean {
  const documentKey = buildFeishuCommentDocumentKey(params);
  return Object.prototype.hasOwnProperty.call(params.comments?.documents ?? {}, documentKey);
}

export function hasFeishuCommentWikiDocumentRule(comments?: FeishuCommentsConfig): boolean {
  return Object.keys(comments?.documents ?? {}).some((key) => key.startsWith("wiki:"));
}

export async function resolveFeishuCommentWikiDocumentKey(params: {
  client: FeishuCommentWikiLookupClient;
  comments?: FeishuCommentsConfig;
  fileType: CommentFileType;
  fileToken: string;
  accountId: string;
  logger?: (message: string) => void;
}): Promise<
  | {
      documentKey: string;
      wikiNodeToken: string;
      objectType: CommentFileType;
      objectToken: string;
    }
  | undefined
> {
  if (!hasFeishuCommentWikiDocumentRule(params.comments)) {
    return undefined;
  }
  let response:
    | {
        code?: number;
        msg?: string;
        log_id?: string;
        error?: { log_id?: string };
        data?: {
          node?: {
            node_token?: string;
            obj_type?: string;
            obj_token?: string;
          };
        };
      }
    | undefined;
  try {
    response = (await params.client.request({
      method: "GET",
      url:
        "/open-apis/wiki/v2/spaces/get_node" +
        encodeQuery({
          obj_type: params.fileType,
          token: params.fileToken,
        }),
      data: {},
      timeout: FEISHU_COMMENT_WIKI_LOOKUP_TIMEOUT_MS,
    })) as {
      code?: number;
      msg?: string;
      log_id?: string;
      error?: { log_id?: string };
      data?: {
        node?: {
          node_token?: string;
          obj_type?: string;
          obj_token?: string;
        };
      };
    };
  } catch (error) {
    params.logger?.(
      `feishu[${params.accountId}]: wiki document rule lookup threw ` +
        `object=${params.fileType}:${params.fileToken} error=${String(error)}`,
    );
    return undefined;
  }
  if (response.code === 131005) {
    return undefined;
  }
  if (response.code !== 0) {
    params.logger?.(
      `feishu[${params.accountId}]: wiki document rule lookup failed ` +
        `object=${params.fileType}:${params.fileToken} ` +
        `code=${response.code ?? "unknown"} msg=${response.msg ?? "unknown"} ` +
        `log_id=${response.log_id ?? response.error?.log_id ?? "unknown"}`,
    );
    return undefined;
  }
  const node = isRecord(response.data?.node) ? response.data?.node : undefined;
  const wikiNodeToken = normalizeString(node?.node_token);
  const objectType = normalizeString(node?.obj_type) as CommentFileType | undefined;
  const objectToken = normalizeString(node?.obj_token);
  if (!wikiNodeToken || !objectType || !objectToken) {
    return undefined;
  }
  const documentKey = buildFeishuCommentDocumentKey({
    fileType: "wiki",
    fileToken: wikiNodeToken,
  });
  if (!Object.prototype.hasOwnProperty.call(params.comments?.documents ?? {}, documentKey)) {
    return undefined;
  }
  return {
    documentKey,
    wikiNodeToken,
    objectType,
    objectToken,
  };
}

export function resolveFeishuCommentAccess(params: {
  comments?: FeishuCommentsConfig;
  fileType: string;
  fileToken: string;
  matchedDocumentKey?: string;
  wikiNodeToken?: string;
  wikiObjectType?: string;
  wikiObjectToken?: string;
}): {
  enabled: boolean;
  policy: FeishuCommentPolicy;
  allowFrom: Array<string | number>;
  documentKey: string;
  matchedRuleKey?: string;
  matchedRuleSource?: "document" | "wiki" | "wildcard";
  matchedDocumentType?: string;
  matchedDocumentToken?: string;
  wikiDocumentKey?: string;
  wikiNodeToken?: string;
  wikiObjectType?: string;
  wikiObjectToken?: string;
  usePairingStore: boolean;
} {
  const documentKey = buildFeishuCommentDocumentKey({
    fileType: params.fileType,
    fileToken: params.fileToken,
  });
  const matchedDocumentKey = params.matchedDocumentKey ?? documentKey;
  const documents = params.comments?.documents;
  const exactRule = documents?.[matchedDocumentKey];
  const wildcardRule = documents?.["*"];

  const enabled =
    firstDefined(exactRule?.enabled, wildcardRule?.enabled, params.comments?.enabled) ?? true;
  const policy =
    firstDefined(exactRule?.policy, wildcardRule?.policy, params.comments?.policy) ??
    DEFAULT_FEISHU_COMMENT_POLICY;
  const allowFrom =
    firstDefined(exactRule?.allowFrom, wildcardRule?.allowFrom, params.comments?.allowFrom) ?? [];

  return {
    enabled,
    policy,
    allowFrom: [...allowFrom],
    documentKey,
    matchedRuleKey: exactRule ? matchedDocumentKey : wildcardRule ? "*" : undefined,
    matchedRuleSource: exactRule
      ? matchedDocumentKey === documentKey
        ? "document"
        : "wiki"
      : wildcardRule
        ? "wildcard"
        : undefined,
    matchedDocumentType: exactRule
      ? matchedDocumentKey === documentKey
        ? params.fileType
        : "wiki"
      : undefined,
    matchedDocumentToken: exactRule
      ? matchedDocumentKey === documentKey
        ? params.fileToken
        : params.wikiNodeToken
      : undefined,
    wikiDocumentKey: params.wikiNodeToken
      ? buildFeishuCommentDocumentKey({
          fileType: "wiki",
          fileToken: params.wikiNodeToken,
        })
      : undefined,
    wikiNodeToken: params.wikiNodeToken,
    wikiObjectType: params.wikiObjectType,
    wikiObjectToken: params.wikiObjectToken,
    usePairingStore: policy === "pairing",
  };
}
