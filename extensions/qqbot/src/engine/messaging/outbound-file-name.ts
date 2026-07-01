/**
 * Recipient-facing filename resolution for outbound attachments.
 */

import path from "node:path";
import { sanitizeFileName } from "../utils/string-normalize.js";

/**
 * Resolve the filename a QQ recipient should see for an outbound attachment.
 *
 * UUID suffix stripping is scoped to paths inside the OpenClaw media store,
 * mirroring the guard in `src/media/web-media.ts::resolveLocalMediaFileName`.
 * Arbitrary local paths or URLs whose basename happens to match the
 * `name---<uuid>.ext` shape are preserved as-is.
 *
 * `media-runtime` is imported lazily because the qqbot bridge deliberately
 * keeps that heavy barrel off the static startup graph (bridge/bootstrap.ts
 * loads it on demand); a static import here would make that dynamic import
 * ineffective.
 */
export async function resolveOutboundFileName(filePath: string): Promise<string> {
  const { extractOriginalFilename, getMediaDir } =
    await import("openclaw/plugin-sdk/media-runtime");
  const basename = path.basename(filePath);
  if (isPathInsideRoot(filePath, getMediaDir())) {
    return sanitizeFileName(extractOriginalFilename(basename));
  }
  return sanitizeFileName(basename);
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
