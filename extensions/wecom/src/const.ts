/**
 * WeCom channel constant definitions
 */

/**
 * WeCom channel ID
 */
export const CHANNEL_ID = "wecom" as const;

/**
 * WeCom WebSocket command enum
 */
export enum WeComCommand {
  /** Auth subscription */
  SUBSCRIBE = "aibot_subscribe",
  /** Heartbeat */
  PING = "ping",
  /** WeCom push message */
  AIBOT_CALLBACK = "aibot_callback",
  /** clawdbot response message */
  AIBOT_RESPONSE = "aibot_response",
}

// ============================================================================
// Timeout and retry configuration
// ============================================================================

/** Image download timeout (ms) */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

/** File download timeout (ms) */
export const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Message send timeout (ms) */
export const REPLY_SEND_TIMEOUT_MS = 15_000;

/** Total message processing timeout (ms) */
export const MESSAGE_PROCESS_TIMEOUT_MS = 6 * 60 * 1000;

/** WebSocket heartbeat interval (ms) */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Max reconnect attempts on WebSocket disconnect */
export const WS_MAX_RECONNECT_ATTEMPTS = 10;

/** Max retry attempts on WebSocket auth failure */
export const WS_MAX_AUTH_FAILURE_ATTEMPTS = 5;

// ============================================================================
// Message state management configuration
// ============================================================================

/** Max TTL (ms) for messageStates Map entries to prevent memory leaks */
export const MESSAGE_STATE_TTL_MS = 10 * 60 * 1000;

/** Cleanup interval (ms) for messageStates Map */
export const MESSAGE_STATE_CLEANUP_INTERVAL_MS = 60_000;

/** Max entry count for messageStates Map */
export const MESSAGE_STATE_MAX_SIZE = 500;

// ============================================================================
// Message templates
// ============================================================================

/** "Thinking" streaming message placeholder content */
export const THINKING_MESSAGE = "<think></think>";

/** Placeholder for image-only messages */
export const MEDIA_IMAGE_PLACEHOLDER = "<media:image>";

/** Placeholder for file-only messages */
export const MEDIA_DOCUMENT_PLACEHOLDER = "<media:document>";
// ============================================================================
// Default values
// ============================================================================

// ============================================================================
// MCP configuration
// ============================================================================

/** WebSocket command for fetching MCP configuration */
export const MCP_GET_CONFIG_CMD = "aibot_get_mcp_config";

/** MCP config fetch timeout (ms) */
export const MCP_CONFIG_FETCH_TIMEOUT_MS = 15_000;

// ============================================================================
// Default values
// ============================================================================

/** Default media size limit (MB) */
export const DEFAULT_MEDIA_MAX_MB = 5;

/** Text chunk size limit */
export const TEXT_CHUNK_LIMIT = 4000;

// ============================================================================
// Media upload related constants
// ============================================================================

/** Image size limit (bytes): 10MB */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Video size limit (bytes): 10MB */
export const VIDEO_MAX_BYTES = 10 * 1024 * 1024;

/** Voice size limit (bytes): 2MB */
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;

/** File size limit (bytes): 20MB */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Absolute file size limit (bytes): files exceeding this cannot be sent; equals FILE_MAX_BYTES */
export const ABSOLUTE_MAX_BYTES = FILE_MAX_BYTES;

/** Upload chunk size (bytes, before Base64 encoding): 512KB */
export const UPLOAD_CHUNK_SIZE = 512 * 1024;

// ============================================================================
// Event/command name constants
// ============================================================================

/** Version check event name (for SDK event listeners) */
export const EVENT_ENTER_CHECK_UPDATE = "event.enter_check_update";

/** Version check event reply command name */
export const CMD_ENTER_EVENT_REPLY = "ww_ai_robot_enter_event";

// ============================================================================
// SDK connection configuration
// ============================================================================

/** WSClient scene parameter: WeCom OpenClaw scenario */
export const SCENE_WECOM_OPENCLAW = 1;
