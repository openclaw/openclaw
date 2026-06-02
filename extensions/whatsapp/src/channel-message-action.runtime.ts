import { readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export { handleWhatsAppAction } from "./action-runtime.js";
export { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
export { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "./accounts.js";
export { normalizeWhatsAppTarget } from "./normalize.js";
export { sendMessageWhatsApp } from "./send.js";
export { readStringParam, type OpenClawConfig };
