import type { CodexDynamicToolCallParams } from "./protocol.js";

export function canProduceFinalSourceReplyDelivery(call: CodexDynamicToolCallParams): boolean {
  // before_tool_call may rewrite finality, so the original arguments cannot
  // safely narrow which message calls can produce an authoritative receipt.
  return call.tool === "message";
}

export function applyCurrentMessageProvider(
  toolName: string,
  args: Record<string, unknown>,
  currentProvider: string | undefined,
): Record<string, unknown> {
  const hasProvider =
    typeof args.provider === "string" && args.provider.trim().length > 0
      ? true
      : typeof args.channel === "string" && args.channel.trim().length > 0;
  const provider = currentProvider?.trim();
  if (toolName !== "message" || hasProvider || !provider) {
    return args;
  }
  return { ...args, provider };
}
