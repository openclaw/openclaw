import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export type FeishuDocumentLinkKind =
  | "doc"
  | "docx"
  | "sheet"
  | "slides"
  | "file"
  | "wiki"
  | "mindnote"
  | "bitable"
  | "base";

export type ParsedFeishuDocumentLink = {
  rawUrl: string;
  urlKind: FeishuDocumentLinkKind;
  token: string;
  tableId?: string;
};

const FEISHU_LINK_TOKEN_MIN_LENGTH = 22;
const FEISHU_LINK_TOKEN_MAX_LENGTH = 28;
const FEISHU_DOCUMENT_LINK_ALIASES = new Map<string, FeishuDocumentLinkKind>([
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

export function parseFeishuDocumentLinkPath(pathname: string): {
  urlKind: FeishuDocumentLinkKind;
  token: string;
} | null {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const offset = segments[0]?.toLowerCase() === "space" ? 1 : 0;
  const urlKind = FEISHU_DOCUMENT_LINK_ALIASES.get(segments[offset]?.toLowerCase() ?? "");
  const token = normalizeOptionalString(segments[offset + 1]) ?? undefined;
  if (!urlKind || !isReasonableFeishuLinkToken(token)) {
    return null;
  }
  return { urlKind, token };
}

export function parseFeishuDocumentLink(rawUrl: string): ParsedFeishuDocumentLink | null {
  try {
    const parsedUrl = new URL(rawUrl);
    const parsedPath = parseFeishuDocumentLinkPath(parsedUrl.pathname);
    if (!parsedPath) {
      return null;
    }
    const tableId = normalizeOptionalString(parsedUrl.searchParams.get("table") ?? undefined);
    return {
      rawUrl,
      urlKind: parsedPath.urlKind,
      token: parsedPath.token,
      ...(tableId ? { tableId } : {}),
    };
  } catch {
    return null;
  }
}
