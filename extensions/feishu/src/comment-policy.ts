import type { FeishuCommentPolicy, FeishuCommentsConfig } from "./types.js";

const DEFAULT_FEISHU_COMMENT_POLICY: FeishuCommentPolicy = "pairing";

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

export function resolveFeishuCommentAccess(params: {
  comments?: FeishuCommentsConfig;
  fileType: string;
  fileToken: string;
}): {
  enabled: boolean;
  policy: FeishuCommentPolicy;
  allowFrom: Array<string | number>;
  documentKey: string;
  matchedRuleKey?: string;
  usePairingStore: boolean;
} {
  const documentKey = buildFeishuCommentDocumentKey({
    fileType: params.fileType,
    fileToken: params.fileToken,
  });
  const documents = params.comments?.documents;
  const exactRule = documents?.[documentKey];
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
    matchedRuleKey: exactRule ? documentKey : wildcardRule ? "*" : undefined,
    usePairingStore: policy === "pairing",
  };
}
