import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryKeywordWorkerQuery } from "./manager-search-types.js";
import { searchKeyword, searchPathKeyword } from "./manager-search.js";

export async function searchKeywordWithFallback(params: {
  db: DatabaseSync;
  body: Omit<MemoryKeywordWorkerQuery["body"], "matchAny">;
  path: MemoryKeywordWorkerQuery["path"];
}) {
  const runBody = (matchAny = false) =>
    searchKeyword({ ...params.body, db: params.db, matchAny })
      .then((rows) => ({ rows, error: undefined }))
      .catch((error: unknown) => ({ rows: [], error: formatErrorMessage(error) }));
  let body = await runBody();
  const path = await searchPathKeyword({ ...params.path, db: params.db })
    .then((rows) => ({ rows, error: undefined }))
    .catch((error: unknown) => ({ rows: [], error: formatErrorMessage(error) }));
  // A filename hit also preserves AND precision. Expand only an empty result.
  if (body.rows.length === 0 && path.rows.length === 0 && !body.error && !path.error) {
    body = await runBody(true);
  }
  return { body, path };
}
