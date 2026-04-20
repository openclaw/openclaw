import { handleAction } from "./handler.js";

export { handleAction };

const SUPPORTED_ACTIONS = ["sticker-search", "sticker", "react", "send"];

function describeMessageTool() {
  return { actions: SUPPORTED_ACTIONS };
}

function listActions() {
  return SUPPORTED_ACTIONS;
}

export const yuanbaoMessageActions: Record<string, unknown> = {
  describeMessageTool,
  handleAction,
  listActions,
  supportsAction: ({ action }: { action: string }) => SUPPORTED_ACTIONS.includes(action),
  requiresTrustedRequesterSender: () => false,
};
