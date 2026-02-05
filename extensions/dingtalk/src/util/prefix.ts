import { resolveResponsePrefix } from "../send/reply.js";

export function isGroupChatType(chatType?: string): boolean {
  return /group|chat|2|multi/i.test(chatType ?? "");
}

export function shouldEnforcePrefix(
  requirePrefix: string | undefined,
  chatType?: string
): boolean {
  return Boolean(requirePrefix) && isGroupChatType(chatType);
}

export function applyResponsePrefix(params: {
  originalText: string;
  cleanedText?: string;
  responsePrefix?: string;
  context?: { model?: string; provider?: string; identity?: string };
  applyPrefix?: boolean;
}): string {
  const {
    originalText,
    cleanedText,
    responsePrefix,
    context,
    applyPrefix,
  } = params;
  const baseText = cleanedText?.trim() ? cleanedText : originalText;

  if (!applyPrefix || !responsePrefix) {
    return baseText;
  }

  const prefix = resolveResponsePrefix(responsePrefix, context ?? {});
  return prefix ? `${prefix} ${baseText}` : baseText;
}
