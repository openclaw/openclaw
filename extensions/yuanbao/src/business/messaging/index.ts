/**
 * Message processing core module
 *
 * Transport-agnostic message processing logic.
 *
 * Module split:
 * - context.ts           — 上下文类型、日志工具、常量
 * - extract.ts           — Message format conversion（MsgBody → 结构化文本）
 * - system-callbacks.ts  — 系统回调注册表（纯分发，不持有业务状态）
 * - handlers/            — 各Message type的独立 Handler（输入解析 + 输出构造）
 *
 * Note:
 * - 消息输入处理已移至 business/inbound/ Directory
 * - 所有发送相关逻辑已统一收归到 outbound/transport.ts
 */

export type { MessageHandlerContext } from "./context.js";
export { extractTextFromMsgBody } from "./extract.js";
export type { ExtractTextFromMsgBodyResult } from "./extract.js";
// 对外暴露注册接口，允许外部模块扩展系统回调（如新增禁言/入群通知等）
export { registerSystemCallback } from "./system-callbacks.js";
export type { SystemCallbackHandler, SystemCallbackParams } from "./system-callbacks.js";

// handlers 子模块导出
export {
  getHandler,
  getAllHandlers,
  buildMsgBody,
  prepareOutboundContent,
  buildOutboundMsgBody,
  buildAtUserMsgBodyItem,
  textHandler,
  customHandler,
  imageHandler,
  soundHandler,
  fileHandler,
  videoHandler,
} from "./handlers/index.js";
export type {
  MessageElemHandler,
  MsgBodyItemType,
  MediaItem,
  OutboundContentItem,
} from "./handlers/index.js";
