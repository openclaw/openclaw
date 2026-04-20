/**
 * Chunked media upload — skeleton only.
 *
 * ## Status
 *
 * **Not implemented yet.** This file reserves the import surface and type
 * contract so that the main upload pipeline (`messaging/sender.ts#sendMedia`)
 * can dispatch to a future chunked uploader without downstream churn.
 *
 * ## Why reserve it now
 *
 * The media-upload refactor (see plan `qqbot-media-upload-unification`)
 * funnels every rich-media call through a single dispatch point:
 *
 * ```
 * sendMediaInternal(source) → if source.size > LARGE_FILE_THRESHOLD
 *                               → uploadChunked(...)      // <- this file
 *                             else
 *                               → MediaApi.uploadMedia(...) // one-shot
 * ```
 *
 * The one-shot path is the only code path actually exercised in the current
 * PR; the 20MB `MAX_UPLOAD_SIZE` hard limit in `utils/file-utils.ts` still
 * applies. Once this module is fleshed out, the one-shot limit can be
 * raised to the server-side true maximum.
 *
 * ## Server endpoints already defined in `routes.ts`
 *
 * - `uploadPreparePath(scope, targetId)`   → `/v2/{users|groups}/{id}/upload_prepare`
 * - `uploadPartFinishPath(scope, targetId)` → `/v2/{users|groups}/{id}/upload_part_finish`
 * - `uploadCompletePath(scope, targetId)`  → same as `mediaUploadPath`
 *
 * ## Retry policy constants already defined in `retry.ts`
 *
 * - `PART_FINISH_RETRY_POLICY`
 * - `COMPLETE_UPLOAD_RETRY_POLICY`
 * - `PART_FINISH_RETRYABLE_CODES = { 40093001 }`
 * - `UPLOAD_PREPARE_FALLBACK_CODE = 40093002`  // fall back to one-shot upload
 *
 * ## Implementation sketch (for the follow-up PR)
 *
 * 1. Call `upload_prepare` with `file_size`, `file_type`, `file_name?`, and
 *    the canonical hash → receive `{ upload_id, part_size, upload_urls[] }`
 *    or an `UploadPrepareResponse.reuse_file_info` shortcut.
 * 2. For each part:
 *    - Stream bytes from `MediaSource` (`localPath` via
 *      `fs.createReadStream`, `buffer` via `Buffer.subarray`).
 *    - PUT the part to its `upload_url` (multipart or raw bytes — per the
 *      prepare response).
 *    - POST `upload_part_finish` with `{ upload_id, part_number, etag }`,
 *      retrying per `PART_FINISH_RETRY_POLICY`.
 * 3. POST `uploadCompletePath` → receive `UploadMediaResponse` identical to
 *    the one-shot path (`file_info`, `file_uuid`, `ttl`).
 * 4. On `UPLOAD_PREPARE_FALLBACK_CODE (40093002)` from step 1, fall back to
 *    the one-shot uploader (`MediaApi.uploadMedia`) — behaves as if the
 *    chunked path never existed.
 *
 * ## What NOT to do here
 *
 * - Do not duplicate caching logic — the existing `upload-cache` in
 *   `MediaApi` should wrap the final `file_info` regardless of path.
 * - Do not re-implement token retry — reuse `MediaApi`'s token manager.
 * - Do not introduce a second `ApiClient` instance — accept the existing
 *   one via constructor injection, same as `MediaApi`.
 */

import type { MediaSource } from "../messaging/media-source.js";
import type { ChatScope, MediaFileType, UploadMediaResponse } from "../types.js";

export interface UploadChunkedOptions {
  scope: ChatScope;
  targetId: string;
  fileType: MediaFileType;
  source: MediaSource;
  creds: { appId: string; clientSecret: string };
  fileName?: string;
}

/**
 * Perform a chunked upload against the QQ Open Platform.
 *
 * @throws Always — not yet implemented. Callers must gate on
 *   {@link isChunkedUploadImplemented} or catch and fall back to the
 *   one-shot uploader.
 */
export async function uploadChunked(_opts: UploadChunkedOptions): Promise<UploadMediaResponse> {
  throw new Error(
    "Chunked upload is not implemented yet. See qqbot/src/engine/api/media-chunked.ts TODO.",
  );
}

/**
 * Feature flag for the chunked uploader.
 *
 * Returns `false` in the current codebase; flip to `true` in the follow-up
 * PR that fills in {@link uploadChunked}. Callers MUST check this before
 * dispatching to {@link uploadChunked}, otherwise the one-shot path should
 * remain in use even for files above `LARGE_FILE_THRESHOLD` (capped by
 * `MAX_UPLOAD_SIZE`).
 */
export function isChunkedUploadImplemented(): boolean {
  return false;
}
