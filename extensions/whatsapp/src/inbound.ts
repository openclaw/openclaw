// Whatsapp plugin module implements inbound behavior.
export { resetWebInboundDedupe } from "./inbound/dedupe.js";
export {
  extractContactContext,
  extractInteractiveListContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractText,
} from "./inbound/extract.js";
export { monitorWebInbox } from "./inbound/monitor.js";
export type {
  WebInboundMessage,
  WebListenerCloseReason,
  WhatsAppInteractiveListContext,
  WhatsAppInteractiveListRow,
} from "./inbound/types.js";
