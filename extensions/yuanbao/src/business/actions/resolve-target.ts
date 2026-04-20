import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { parseTarget } from "../messaging/targets.js";

export interface ActionParams {
  cfg: OpenClawConfig;
  to?: string;
  text?: string;
  accountId?: string | null;
  params?: {
    action?: string;
    channel?: string;
    message?: string;
    to?: string;
    target?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    sticker_id?: string;
    stickerId?: string;
    __sessionKey?: string;
    __agentId?: string;
    [key: string]: unknown;
  };
  toolContext?: {
    currentChannelId?: string;
    currentChannelProvider?: string;
    currentMessageId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface ResolvedTarget {
  isGroup: boolean;
  target: string;
  groupCode?: string;
  sessionKey?: string;
  agentId?: string;
}

export function extractGroupFromChannelId(channelId?: string): string | undefined {
  if (!channelId) {
    return undefined;
  }
  const prefix = "yuanbao:group:";
  if (channelId.startsWith(prefix)) {
    return channelId.slice(prefix.length);
  }
  return undefined;
}

export function resolveActionTarget(input: ActionParams): ResolvedTarget {
  const { params, toolContext } = input;

  const rawTo = params?.to ?? params?.target ?? input.to ?? "";
  const contextGroupCode = extractGroupFromChannelId(toolContext?.currentChannelId);

  if (!rawTo && contextGroupCode) {
    return {
      isGroup: true,
      target: contextGroupCode,
      groupCode: contextGroupCode,
      sessionKey: params?.__sessionKey,
      agentId: params?.__agentId,
    };
  }

  if (!rawTo) {
    throw new Error(
      "[resolveActionTarget] Unable to determine delivery target: to / params.to / toolContext.currentChannelId are all empty",
    );
  }

  const { isGroup, target } = parseTarget(rawTo);

  return {
    isGroup,
    target,
    // Group chat uses parsed.target; non-group falls back to toolContext group (may be undefined)
    groupCode: contextGroupCode,
    sessionKey: params?.__sessionKey,
    agentId: params?.__agentId,
  };
}
