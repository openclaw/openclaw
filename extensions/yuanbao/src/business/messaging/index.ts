/** Message processing core module. */

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
