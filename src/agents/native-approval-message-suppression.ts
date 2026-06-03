import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMessageActionName } from "../channels/plugins/types.public.js";

function hasExplicitMessageRouteParam(
  params: Record<string, unknown>,
  currentChannelProvider?: string | null,
): boolean {
  for (const key of ["target", "to", "channelId"]) {
    if (normalizeOptionalString(params[key])) {
      return true;
    }
  }
  const channel = normalizeOptionalString(params.channel);
  const currentChannel = normalizeOptionalString(currentChannelProvider);
  if (channel && (!currentChannel || channel.toLowerCase() !== currentChannel.toLowerCase())) {
    return true;
  }
  return (
    Array.isArray(params.targets) && params.targets.some((value) => normalizeOptionalString(value))
  );
}

export function shouldSuppressNativeApprovalFallbackMessageSend(params: {
  action: ChannelMessageActionName;
  currentChannelProvider?: string | null;
  deterministicApprovalPromptSent: boolean;
  messageParams: Record<string, unknown>;
}): boolean {
  if (
    params.action !== "send" ||
    hasExplicitMessageRouteParam(params.messageParams, params.currentChannelProvider)
  ) {
    return false;
  }
  if (params.deterministicApprovalPromptSent) {
    return true;
  }
  return false;
}
