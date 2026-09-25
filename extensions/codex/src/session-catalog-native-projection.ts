import type { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isJsonObject, type JsonObject, type CodexThread } from "./app-server/protocol.js";
import { detachCodexCatalogString } from "./session-catalog-limits.js";
import {
  boundedCatalogString,
  MAX_CURSOR_LENGTH,
  MAX_CWD_LENGTH,
  MAX_SESSION_ID_LENGTH,
  selectCodexCatalogPreviewInput,
  truncateCodexCatalogPreview,
} from "./session-catalog-parsing.js";
import { copyCodexCatalogSource } from "./session-catalog-source.js";

export const CODEX_CATALOG_NATIVE_PAGE_LIMIT = 64;
type CodexCatalogNativeThread = Pick<
  CodexThread,
  | "id"
  | "projectId"
  | "sessionId"
  | "ephemeral"
  | "name"
  | "cwd"
  | "modelProvider"
  | "cliVersion"
  | "path"
  | "originator"
  | "createdAt"
  | "updatedAt"
  | "recencyAt"
  | "preview"
  | "source"
  | "gitInfo"
  | "status"
>;
export type CodexCatalogPreviewCache = (
  thread: Pick<CodexThread, "id" | "path" | "updatedAt" | "recencyAt">,
) => string | undefined;

const STRING_FIELDS = [
  ["name", 500, "truncate"],
  ["cwd", MAX_CWD_LENGTH, "omit"],
  ["modelProvider", 500, "truncate"],
  ["cliVersion", 500, "truncate"],
] as const;

/** Drop unused native fields before catalog-owned asynchronous work can retain them. */
export function projectCodexCatalogNativeThread(
  thread: unknown,
  sanitize: typeof sanitizeTerminalText,
  cachedPreview?: CodexCatalogPreviewCache,
): CodexCatalogNativeThread {
  if (!isJsonObject(thread)) {
    throw new Error("Codex catalog response contains an invalid thread");
  }
  const id = boundedCatalogString(thread.id, MAX_SESSION_ID_LENGTH);
  if (!id) {
    throw new Error("Codex catalog response contains an invalid thread id");
  }
  const row: CodexCatalogNativeThread = {
    id,
    projectId: boundedCatalogString(thread.projectId, MAX_SESSION_ID_LENGTH, "omit") ?? null,
  };
  const sessionId = boundedCatalogString(thread.sessionId, MAX_SESSION_ID_LENGTH, "omit");
  if (sessionId) {
    row.sessionId = sessionId;
  }
  if (thread.ephemeral === true) {
    return copyCodexCatalogSource(thread, { ...row, ephemeral: true });
  }
  for (const [field, limit, overflow] of STRING_FIELDS) {
    const value = thread[field];
    const bounded = boundedCatalogString(value, limit, overflow);
    if (value === null || bounded !== undefined) {
      row[field] = bounded ?? null;
    }
  }
  if (typeof thread.path === "string") {
    if (thread.path.length > MAX_CWD_LENGTH) {
      throw new Error("Codex catalog rollout path exceeds its length limit");
    }
    row.path = detachCodexCatalogString(thread.path);
  } else if (thread.path === null) {
    row.path = null;
  }
  if (typeof thread.originator === "string") {
    // Provenance tests exact native identity, unlike trimmed display metadata;
    // when truncation splits a surrogate pair, the whole pair is dropped.
    row.originator = detachCodexCatalogString(truncateUtf16Safe(thread.originator, 500));
  }
  for (const field of ["createdAt", "updatedAt", "recencyAt"] as const) {
    const value = thread[field];
    if (value === null || (typeof value === "number" && Number.isFinite(value))) {
      row[field] = value;
    }
  }
  const rawPreview = thread.preview;
  const preview = reuseCodexCatalogPreview(
    row,
    typeof rawPreview === "string" ? Boolean(rawPreview) : undefined,
    cachedPreview,
  );
  if (preview !== undefined) {
    row.preview = preview;
  } else if (typeof rawPreview === "string") {
    row.preview = rawPreview
      ? truncateCodexCatalogPreview(selectCodexCatalogPreviewInput(rawPreview), sanitize)
      : "";
  } else if (rawPreview === null) {
    row.preview = null;
  }
  const source =
    typeof thread.source === "string"
      ? detachCodexCatalogString(truncateUtf16Safe(thread.source, 500))
      : undefined;
  if (
    source === "cli" ||
    source === "vscode" ||
    source === "exec" ||
    source === "appServer" ||
    source === "unknown"
  ) {
    row.source = source;
  } else if (
    isJsonObject(thread.source) &&
    typeof thread.source.custom === "string" &&
    thread.source.custom.length <= 500
  ) {
    row.source = { custom: detachCodexCatalogString(thread.source.custom) };
  }
  if (isJsonObject(thread.gitInfo)) {
    const branch = boundedCatalogString(thread.gitInfo.branch, 500, "truncate");
    if (branch !== undefined) {
      row.gitInfo = { branch };
    }
  }
  if (isJsonObject(thread.status)) {
    const type = boundedCatalogString(thread.status.type, 64);
    if (type === "active" || type === "idle" || type === "notLoaded" || type === "systemError") {
      const activeFlags =
        type === "active" && Array.isArray(thread.status.activeFlags)
          ? thread.status.activeFlags.slice(0, 16).flatMap((flag) => {
              const bounded = boundedCatalogString(flag, 128, "omit");
              return bounded ? [bounded] : [];
            })
          : undefined;
      row.status = type === "active" ? { type, ...(activeFlags ? { activeFlags } : {}) } : { type };
    }
  }
  return copyCodexCatalogSource(thread, row);
}

/** Keep only the admitted prefix before an RPC promise retains its response. */
export function projectCodexCatalogNativeResponse(
  response: JsonObject,
  sanitize: typeof sanitizeTerminalText,
  cachedPreview?: CodexCatalogPreviewCache,
  remainingRows = CODEX_CATALOG_NATIVE_PAGE_LIMIT,
): JsonObject {
  if (!Array.isArray(response.data) || response.data.length > CODEX_CATALOG_NATIVE_PAGE_LIMIT) {
    throw new Error("Codex catalog response exceeds its native page limit");
  }
  const limit = Number.isFinite(remainingRows)
    ? Math.max(0, Math.min(CODEX_CATALOG_NATIVE_PAGE_LIMIT, Math.floor(remainingRows)))
    : 0;
  const data = response.data
    .slice(0, limit)
    .map((thread) => projectCodexCatalogNativeThread(thread, sanitize, cachedPreview));
  const page: JsonObject = { data };
  for (const field of ["nextCursor", "backwardsCursor"] as const) {
    const value = response[field];
    if (value === null) {
      page[field] = null;
    } else if (value !== undefined) {
      if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH) {
        throw new Error("Codex catalog response contains an invalid cursor");
      }
      page[field] = detachCodexCatalogString(value);
    }
  }
  return page;
}

/** Reuse resident text without transferring a cache or an unbounded native preview. */
export function reuseCodexCatalogPreview(
  thread: Pick<CodexThread, "id" | "path" | "updatedAt" | "recencyAt">,
  rawPreviewNonempty: boolean | undefined,
  cachedPreview?: CodexCatalogPreviewCache,
): string | undefined {
  const preview = cachedPreview?.({
    id: thread.id,
    path: typeof thread.path === "string" ? thread.path : null,
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : null,
    recencyAt: typeof thread.recencyAt === "number" ? thread.recencyAt : null,
  });
  return preview !== undefined &&
    preview.length <= 500 &&
    (rawPreviewNonempty === undefined || rawPreviewNonempty === Boolean(preview))
    ? preview
    : undefined;
}
