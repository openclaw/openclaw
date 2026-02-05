/**
 * Send module exports.
 */

export { sendReplyViaSessionWebhook, resolveResponsePrefix } from "./reply.js";
export type { ReplyOptions, ReplyResult, ReplyLogger } from "./reply.js";
export { chunkText, chunkMarkdownText, toCleanString, normalizeForTextMessage } from "./chunker.js";
export { convertMarkdownForDingTalk } from "./markdown.js";
export type { MarkdownOptions } from "./markdown.js";

// Re-export proactive messaging API for convenience
export {
  sendProactiveMessage,
  sendBatchDirectMessage,
  parseTarget,
} from "../api/send-message.js";
export type {
  MessageTarget,
  SendMessageOptions,
  SendMessageResult,
} from "../api/send-message.js";
