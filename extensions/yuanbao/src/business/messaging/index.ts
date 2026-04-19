/**
 * Message processing core module.
 *
 * Transport-agnostic message processing logic.
 *
 * Module split:
 * - context.ts           — Context types, log utilities, constants
 * - extract.ts           — Message format conversion (MsgBody → structured text)
 * - system-callbacks.ts  — System callback registry (pure dispatch, no business state)
 * - handlers/            — Independent handlers per message type (input parsing + output construction)
 *
 * Note:
 * - Message inbound processing moved to business/inbound/
 * - All send-related logic consolidated into outbound/transport.ts
 */

export type { MessageHandlerContext } from "./context.js";
export { extractTextFromMsgBody } from "./extract.js";
export type { ExtractTextFromMsgBodyResult } from "./extract.js";
// Expose registration interface for external modules to extend system callbacks (e.g. mute/join notifications)
export { registerSystemCallback } from "./system-callbacks.js";
export type { SystemCallbackHandler, SystemCallbackParams } from "./system-callbacks.js";

// Handlers sub-module exports
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
