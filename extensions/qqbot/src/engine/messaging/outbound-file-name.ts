/**
 * Recipient-facing filename resolution for outbound attachments.
 */

import { sanitizeFileName } from "../utils/string-normalize.js";

/**
 * Resolve the filename a QQ recipient should see for an outbound attachment.
 *
 * Outbound media is staged in the media store as `<name>---<uuid>.<ext>`
 * (src/media/store.ts), so the bare basename would leak the internal UUID
 * suffix to recipients. `extractOriginalFilename` strips only that staging
 * shape and otherwise returns the plain basename (the same helper the msteams
 * and signal channels use), so non-staged paths and URLs are unchanged.
 *
 * `media-runtime` is imported lazily because the qqbot bridge deliberately
 * keeps that heavy barrel off the static startup graph (bridge/bootstrap.ts
 * loads it on demand); a static import here would make that dynamic import
 * ineffective.
 */
export async function resolveOutboundFileName(filePath: string): Promise<string> {
  const { extractOriginalFilename } = await import("openclaw/plugin-sdk/media-runtime");
  return sanitizeFileName(extractOriginalFilename(filePath));
}
