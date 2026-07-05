// Telegram plugin module implements bot message dispatch behavior.
export {
<<<<<<< HEAD
  getSessionEntry,
  resolveStorePath,
  type SessionEntry,
=======
  loadSessionStore,
  readLatestAssistantTextFromSessionTranscript,
  resolveAndPersistSessionFile,
  resolveSessionStoreEntry,
  updateSessionStoreEntry,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
} from "openclaw/plugin-sdk/session-store-runtime";
export { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
export { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
export { resolveChunkMode } from "openclaw/plugin-sdk/reply-dispatch-runtime";
export {
  generateTelegramTopicLabel as generateTopicLabel,
  resolveAutoTopicLabelConfig,
} from "./auto-topic-label.js";
