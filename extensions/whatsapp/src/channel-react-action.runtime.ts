import {
  readNumberParam,
  readStringOrNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

export { resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
export { handleWhatsAppAction } from "./action-runtime.js";
export { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";
export { readNumberParam, readStringOrNumberParam, readStringParam, type OpenClawConfig };
