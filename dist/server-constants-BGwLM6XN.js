//#region src/gateway/server-constants.ts
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 50 * 1024 * 1024;
const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;
let maxChatHistoryMessagesBytes = 6 * 1024 * 1024;
const getMaxChatHistoryMessagesBytes = () => maxChatHistoryMessagesBytes;
const TICK_INTERVAL_MS = 3e4;
const HEALTH_REFRESH_INTERVAL_MS = 6e4;
const DEDUPE_TTL_MS = 5 * 6e4;
const DEDUPE_MAX = 1e3;
//#endregion
export { MAX_PAYLOAD_BYTES as a, getMaxChatHistoryMessagesBytes as c, MAX_BUFFERED_BYTES as i, DEDUPE_TTL_MS as n, MAX_PREAUTH_PAYLOAD_BYTES as o, HEALTH_REFRESH_INTERVAL_MS as r, TICK_INTERVAL_MS as s, DEDUPE_MAX as t };
