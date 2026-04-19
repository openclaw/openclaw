/**
 * Actions adapter layer — unified entry.
 *
 * Routes Action requests from OpenClaw Agent to corresponding handlers.
 * This file only assembles and exports the yuanbaoMessageActions adapter object.
 *
 * Actual processing logic is in:
 * - handler.ts: action dispatch & execution (calls createMessageSender directly, bypasses pipeline)
 * - resolve-target.ts: target resolution & type definitions
 */

import { handleAction } from "./handler.js";

export { handleAction };

const SUPPORTED_ACTIONS = ["sticker-search", "sticker", "react", "send"];

/**
 * Describe all supported Actions (for Agent tool selection reference).
 */
function describeMessageTool() {
  return { actions: SUPPORTED_ACTIONS };
}

/**
 * Legacy API compat.
 */
function listActions() {
  return SUPPORTED_ACTIONS;
}

// ============ Export adapter object ============

/**
 * yuanbaoMessageActions — adapter object registered to yuanbaoPlugin.actions.
 *
 * Since openclaw-plugin-sdk.d.ts declares ChannelPlugin and ChannelMessageActionAdapter as any,
 * Record compat type is used here; at runtime OpenClaw framework calls methods by convention.
 */
export const yuanbaoMessageActions: Record<string, unknown> = {
  describeMessageTool,
  handleAction,
  listActions,
  supportsAction: ({ action }: { action: string }) => SUPPORTED_ACTIONS.includes(action),
  // Yuanbao channel send/sticker actions don't require trusted sender identity verification;
  // explicitly return false to prevent framework dispatchChannelMessageAction from blocking.
  requiresTrustedRequesterSender: () => false,
};
