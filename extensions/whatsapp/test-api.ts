// WhatsApp test API exposes the attached-listener harness and the message cache without deep extension imports.
export { createAttachedTestListener } from "./src/inbound/attached-listener.test-support.js";
export type { ActiveWebListener } from "./src/inbound/types.js";
export { cacheInboundMessageMeta } from "./src/quoted-message.js";
export { setWhatsAppRuntime } from "./src/runtime.js";
