/**
 * MCP Apps (io.modelcontextprotocol/ui extension) metadata parsing shared by
 * the bundle MCP runtime. Detects tools that declare an interactive ui://
 * resource and extracts the sandboxed HTML document from resources/read
 * results so UI surfaces can render it. Everything parsed here is untrusted
 * MCP server output.
 */
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { isRecord } from "../utils.js";

/** MCP Apps extension key declared in client capabilities. */
export const MCP_APPS_EXTENSION_KEY = "io.modelcontextprotocol/ui";
/** HTML profile MIME type for MCP App resources. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/**
 * Upper bound for inline app HTML carried on tool result details. Documents
 * beyond this are dropped (the tool still returns its normal content).
 */
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
const MCP_APP_MAX_BASE64_CHARS = Math.ceil(MCP_APP_MAX_HTML_BYTES / 3) * 4;

export type McpToolUiVisibility = "model" | "app";

/** Parsed `_meta.ui` metadata attached to an MCP tool definition. */
export type McpToolUiMeta = {
  resourceUri?: string;
  visibility?: McpToolUiVisibility[];
};

/** CSP origin lists declared by an app resource (`_meta.ui.csp`). */
export type McpAppCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

/** Inline app document extracted from a resources/read result. */
export type McpAppResource = {
  uri: string;
  mimeType: string;
  html: string;
  csp?: McpAppCsp;
  /** Permission names requested via `_meta.ui.permissions` (e.g. clipboardWrite). */
  permissions?: string[];
  prefersBorder?: boolean;
};

/** Full MCP App payload kept outside transcripts in bounded SQLite storage. */
export type McpAppViewPayload = {
  serverName: string;
  toolName: string;
  resource: McpAppResource;
  /**
   * Original tool-call arguments mirrored for ui/notifications/tool-input.
   * Persisted here because durable transcripts split the tool call and its
   * result into separate messages, losing call-site args on reload.
   */
  toolInput?: unknown;
  /** Raw MCP tool result mirrored for the app's ui/notifications/tool-result. */
  result: {
    content?: unknown[];
    structuredContent?: unknown;
    _meta?: unknown;
  };
};

/** Bounded tool-result descriptor surfaced to UI hosts under `details.mcpApp`. */
export type McpAppToolDetails = {
  viewId: string;
  serverName: string;
  toolName: string;
  resourceUri?: string;
};

function normalizeStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw.filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
  );
  return values.length > 0 ? values : undefined;
}

function normalizeVisibility(raw: unknown): McpToolUiVisibility[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  // An explicitly present list is preserved even when empty (or when every
  // entry is unknown): a declared visibility that omits "model" must keep the
  // tool hidden from the agent rather than silently exposing it.
  return raw.filter((entry): entry is McpToolUiVisibility => entry === "model" || entry === "app");
}

/**
 * Parses `_meta.ui` from an MCP tool definition. Supports the nested
 * `_meta.ui.resourceUri` shape plus the deprecated flat
 * `_meta["ui/resourceUri"]` key still emitted by pre-GA servers.
 */
export function parseMcpToolUiMeta(meta: unknown): McpToolUiMeta | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const ui = isRecord(meta.ui) ? meta.ui : undefined;
  const nestedUri = typeof ui?.resourceUri === "string" ? ui.resourceUri.trim() : "";
  const legacyUri = typeof meta["ui/resourceUri"] === "string" ? meta["ui/resourceUri"].trim() : "";
  const rawUri = nestedUri || legacyUri;
  // Only ui:// URIs are valid app resource bindings; anything else is ignored.
  const resourceUri = rawUri.startsWith("ui://") ? rawUri : "";
  const visibility = normalizeVisibility(ui?.visibility);
  if (!resourceUri && visibility === undefined) {
    return undefined;
  }
  return {
    ...(resourceUri ? { resourceUri } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  };
}

/**
 * True when the tool is app-only (`visibility` excludes "model"). App-only
 * tools must not materialize as agent tools; they exist for the app iframe.
 */
export function isAppOnlyMcpTool(meta: unknown): boolean {
  const visibility = parseMcpToolUiMeta(meta)?.visibility;
  return Boolean(visibility && !visibility.includes("model"));
}

function isMcpAppMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().replaceAll(" ", "");
  return normalized.startsWith("text/html") && normalized.includes("profile=mcp-app");
}

function decodeResourceHtml(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.text === "string" && entry.text) {
    return entry.text;
  }
  if (typeof entry.blob === "string" && entry.blob) {
    if (entry.blob.length > MCP_APP_MAX_BASE64_CHARS) {
      return undefined;
    }
    const canonicalBlob = canonicalizeBase64(entry.blob);
    if (!canonicalBlob || estimateBase64DecodedBytes(canonicalBlob) > MCP_APP_MAX_HTML_BYTES) {
      return undefined;
    }
    try {
      return Buffer.from(canonicalBlob, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseResourceCsp(raw: unknown): McpAppCsp | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const csp: McpAppCsp = {
    ...(normalizeStringList(raw.connectDomains)
      ? { connectDomains: normalizeStringList(raw.connectDomains) }
      : {}),
    ...(normalizeStringList(raw.resourceDomains)
      ? { resourceDomains: normalizeStringList(raw.resourceDomains) }
      : {}),
    ...(normalizeStringList(raw.frameDomains)
      ? { frameDomains: normalizeStringList(raw.frameDomains) }
      : {}),
    ...(normalizeStringList(raw.baseUriDomains)
      ? { baseUriDomains: normalizeStringList(raw.baseUriDomains) }
      : {}),
  };
  return Object.keys(csp).length > 0 ? csp : undefined;
}

/**
 * Extracts the first MCP App HTML document from a raw resources/read result.
 * Returns undefined when the result carries no `text/html;profile=mcp-app`
 * content or when the document exceeds {@link MCP_APP_MAX_HTML_BYTES}.
 */
export function parseMcpAppResource(readResult: unknown): McpAppResource | undefined {
  if (!isRecord(readResult) || !Array.isArray(readResult.contents)) {
    return undefined;
  }
  for (const rawEntry of readResult.contents) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    const mimeType = typeof rawEntry.mimeType === "string" ? rawEntry.mimeType : "";
    if (!isMcpAppMimeType(mimeType)) {
      continue;
    }
    const html = decodeResourceHtml(rawEntry);
    if (!html || Buffer.byteLength(html, "utf8") > MCP_APP_MAX_HTML_BYTES) {
      continue;
    }
    const entryMeta = isRecord(rawEntry["_meta"]) ? rawEntry["_meta"] : undefined;
    const uiMeta = isRecord(entryMeta?.ui) ? entryMeta.ui : undefined;
    const permissions = isRecord(uiMeta?.permissions) ? Object.keys(uiMeta.permissions) : undefined;
    return {
      uri: typeof rawEntry.uri === "string" ? rawEntry.uri : "",
      mimeType,
      html,
      ...(parseResourceCsp(uiMeta?.csp) ? { csp: parseResourceCsp(uiMeta?.csp) } : {}),
      ...(permissions && permissions.length > 0 ? { permissions } : {}),
      ...(uiMeta?.prefersBorder === true ? { prefersBorder: true } : {}),
    };
  }
  return undefined;
}
