/**
 * WeCom 双模式常量定义
 */

/** 固定 Webhook 路径 */
export const WEBHOOK_PATHS = {
    /** Bot 模式 (智能体) - 兼容原有路径 */
    BOT: "/wecom",
    /** Bot 模式备用路径 */
    BOT_ALT: "/wecom/bot",
    /** Agent 模式 (自建应用) */
    AGENT: "/wecom/agent",
} as const;

/** 企业微信 API 端点 */
export const API_ENDPOINTS = {
    GET_TOKEN: "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
    SEND_MESSAGE: "https://qyapi.weixin.qq.com/cgi-bin/message/send",
    SEND_APPCHAT: "https://qyapi.weixin.qq.com/cgi-bin/appchat/send",
    UPLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/upload",
    DOWNLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/get",
} as const;

/** 各类限制常量 */
export const LIMITS = {
    /** 文本消息最大字节数 */
    TEXT_MAX_BYTES: 2048,
    /** Token 刷新缓冲时间 (提前刷新) */
    TOKEN_REFRESH_BUFFER_MS: 60_000,
    /** HTTP 请求超时 */
    REQUEST_TIMEOUT_MS: 15_000,
    /** 最大请求体大小 */
    MAX_REQUEST_BODY_SIZE: 1024 * 1024,
} as const;

/** AES 加密常量 */
export const CRYPTO = {
    /** PKCS#7 块大小 */
    PKCS7_BLOCK_SIZE: 32,
    /** AES Key 长度 */
    AES_KEY_LENGTH: 32,
} as const;
