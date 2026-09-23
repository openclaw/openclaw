import {
  buildQaTarget,
  parseQaTarget,
  sanitizeQaBusToolCalls,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaBusConversation } from "./runtime-api.js";

// This subpath is part of the published package used by package-acceptance mounts.
export { parseQaTarget, sanitizeQaBusToolCalls };

export function buildQaConversationTarget(params: {
  chatType: QaBusConversation["kind"];
  conversationId: string;
}): string {
  return buildQaTarget(params);
}
