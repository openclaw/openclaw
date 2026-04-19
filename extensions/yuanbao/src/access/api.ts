/**
 * Yuanbao API client.
 *
 * Backward-compatible re-export entry point.
 * Implementation split into:
 *   - http/request.ts  — Types, token cache, signing, auth headers, HTTP utilities
 *   - http/main.ts     — Business APIs (uploadInfo / downloadUrl)
 */

export type { SignTokenData, AuthHeaders, CosUploadConfig, Log } from "./http/request.js";
export {
  clearSignTokenCache,
  clearAllSignTokenCache,
  getTokenStatus,
  verifySignature,
  getSignToken,
  forceRefreshSignToken,
  getAuthHeaders,
  yuanbaoPost,
  yuanbaoGet,
} from "./http/request.js";
export { apiGetUploadInfo, apiGetDownloadUrl } from "./http/main.js";
