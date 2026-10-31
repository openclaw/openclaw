/** Retry identity remains valid across a short reconnect or placement interruption. */
export const SESSION_CREATE_RETRY_WINDOW_MS = 4 * 60_000;

export const SESSIONS_FILES_ASSETS_MAX_REFS = 64;

/** Maximum stable session key length accepted by chat-send protocol requests. */
export const CHAT_SEND_SESSION_KEY_MAX_LENGTH = 512;
/** Maximum sessions one connection may declare as concurrently visible. */
export const SESSION_VIEWER_PRESENCE_MAX_KEYS = 32;

export const SESSIONS_FILES_ASSET_REF_MAX_CHARS = 4096;
