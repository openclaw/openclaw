import {
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type CodexThreadItem } from "./protocol.js";

/** Discovery metadata only: a provider snippet is not an independently fetched passage. */
export function readCodexWebSearchResults(
  item: CodexThreadItem,
): Array<{ url: string; title?: string }> {
  if (!Array.isArray(item.results)) {
    return [];
  }
  return item.results.flatMap((result) => {
    if (!isJsonObject(result) || typeof result.url !== "string") {
      return [];
    }
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      return [];
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return [];
    }
    const title = normalizeOptionalString(result.title);
    return [{ url: url.href, ...(title ? { title } : {}) }];
  });
}

export function projectCodexWebSearchItem(item: CodexThreadItem): Record<string, unknown> {
  const action = isJsonObject(item.action) ? item.action : undefined;
  const actionType = normalizeOptionalString(action?.type);
  const queries = actionType === "search" ? normalizeTrimmedStringList(action?.queries) : [];
  const query =
    normalizeOptionalString(item.query) ??
    (actionType === "search" ? normalizeOptionalString(action?.query) : undefined) ??
    queries[0];
  const url = normalizeOptionalString(action?.url);
  const pattern = normalizeOptionalString(action?.pattern);
  const results = readCodexWebSearchResults(item);
  return {
    ...(results.length > 0 ? { results } : {}),
    ...(query ? { query } : {}),
    ...(queries.length > 0 ? { queries } : {}),
    ...(actionType && actionType !== "search" ? { action: actionType } : {}),
    ...(url ? { url } : {}),
    ...(pattern ? { pattern } : {}),
  };
}
