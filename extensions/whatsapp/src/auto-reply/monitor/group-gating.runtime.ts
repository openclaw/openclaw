export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
export { resolveMentionPatternsEnabled } from "openclaw/plugin-sdk/channel-inbound";
export { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
export { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
export { parseActivationCommand } from "openclaw/plugin-sdk/group-activation";
export { normalizeE164 } from "../../text-runtime.js";
