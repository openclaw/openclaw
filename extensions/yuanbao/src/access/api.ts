/**
 * 元宝 API 客户端
 *
 * 此文件保留为向后兼容的 re-export 入口。
 * Implementation split into:
 *   - http/request.ts  — 类型、Token 缓存、签名、鉴权头、通用 HTTP 工具
 *   - http/main.ts     — 业务 API（uploadInfo / downloadUrl）
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
