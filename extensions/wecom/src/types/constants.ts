/**
 * WeCom dual-mode constant definitions
 */

/** Fixed Webhook paths */
export const WEBHOOK_PATHS = {
  /** Bot mode legacy compatibility path (no longer maintained) */
  BOT: "/wecom",
  /** Bot mode legacy alternate compatibility path (no longer maintained) */
  BOT_ALT: "/wecom/bot",
  /** Agent mode legacy compatibility path (no longer maintained) */
  AGENT: "/wecom/agent",
  /** Bot mode recommended path prefix */
  BOT_PLUGIN: "/plugins/wecom/bot",
  /** Agent mode recommended path prefix */
  AGENT_PLUGIN: "/plugins/wecom/agent",
} as const;

/** WeCom API endpoints */
export const API_ENDPOINTS = {
  GET_TOKEN: "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
  SEND_MESSAGE: "https://qyapi.weixin.qq.com/cgi-bin/message/send",
  SEND_APPCHAT: "https://qyapi.weixin.qq.com/cgi-bin/appchat/send",
  UPLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/upload",
  DOWNLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/get",
} as const;

/** Various limit constants */
export const LIMITS = {
  /** Maximum bytes for text messages */
  TEXT_MAX_BYTES: 2048,
  /** Token refresh buffer time (refresh early) */
  TOKEN_REFRESH_BUFFER_MS: 60_000,
  /** HTTP request timeout */
  REQUEST_TIMEOUT_MS: 15_000,
  /** Maximum request body size */
  MAX_REQUEST_BODY_SIZE: 1024 * 1024,
} as const;

/** AES encryption constants */
export const CRYPTO = {
  /** PKCS#7 block size */
  PKCS7_BLOCK_SIZE: 32,
  /** AES key length */
  AES_KEY_LENGTH: 32,
} as const;
