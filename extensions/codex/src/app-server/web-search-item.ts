import {
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type CodexThreadItem } from "./protocol.js";

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
  return {
    ...(query ? { query } : {}),
    ...(queries.length > 0 ? { queries } : {}),
    ...(actionType && actionType !== "search" ? { action: actionType } : {}),
    ...(url ? { url } : {}),
    ...(pattern ? { pattern } : {}),
  };
}
