const CORE_MESSAGE_TOOL_SEND_ACTIONS = new Set([
  "send",
  "thread-reply",
  "reply",
  "sendAttachment",
  "upload-file",
]);

export function isCoreMessageToolSendAction(action: string): boolean {
  return CORE_MESSAGE_TOOL_SEND_ACTIONS.has(action);
}
