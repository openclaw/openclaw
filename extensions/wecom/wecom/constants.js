import { join } from "node:path";

export const DEFAULT_ACCOUNT_ID = "default";

// Placeholder shown while the LLM is processing or the message is queued.
export const THINKING_PLACEHOLDER = "思考中...";

// Image cache directory.
export const MEDIA_CACHE_DIR = join(process.env.HOME || "/tmp", ".openclaw", "media", "wecom");

// Slash commands that are allowed by default.
export const DEFAULT_COMMAND_ALLOWLIST = ["/new", "/compact", "/help", "/status"];
export const HIGH_PRIORITY_COMMANDS = new Set(["/stop", "/new"]);

// Default message shown when a command is blocked.
export const DEFAULT_COMMAND_BLOCK_MESSAGE = `⚠️ 该命令不可用。

支持的命令：
• **/new** - 新建会话
• **/compact** - 压缩会话（保留上下文摘要）
• **/help** - 查看帮助
• **/status** - 查看状态`;

// Files recognised by openclaw core as bootstrap files.
export const BOOTSTRAP_FILENAMES = new Set([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
]);

// Per-user message debounce buffer.
// Collects messages arriving within DEBOUNCE_MS into a single dispatch.
export const DEBOUNCE_MS = 2000;

export const MAIN_RESPONSE_IDLE_CLOSE_MS = 30 * 1000;
export const SAFETY_NET_IDLE_CLOSE_MS = 90 * 1000;
export const RESPONSE_URL_ERROR_BODY_PREVIEW_MAX = 300;

// Agent API endpoints (self-built application mode).
export const AGENT_API_ENDPOINTS = {
  GET_TOKEN: "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
  SEND_MESSAGE: "https://qyapi.weixin.qq.com/cgi-bin/message/send",
  SEND_APPCHAT: "https://qyapi.weixin.qq.com/cgi-bin/appchat/send",
  UPLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/upload",
  DOWNLOAD_MEDIA: "https://qyapi.weixin.qq.com/cgi-bin/media/get",
};

export const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
export const AGENT_API_REQUEST_TIMEOUT_MS = 15 * 1000;
export const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1 MB

// Webhook Bot endpoints (group robot notifications).
export const WEBHOOK_BOT_SEND_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";
export const WEBHOOK_BOT_UPLOAD_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media";
