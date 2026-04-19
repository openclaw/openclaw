/**
 * Action target resolution module.
 *
 * Unified action delivery target resolution, compatible with two sources:
 * 1. channel.ts sendText/sendMedia direct pass: top-level to + text
 * 2. Agent tool call: params.message / params.to / params.__sessionKey / params.__agentId + toolContext
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { parseTarget } from "../messaging/targets.js";

// ============ Type definitions ============

/**
 * Action params structure passed by framework.
 *
 * Compatible with two sources:
 * 1. channel.ts sendText/sendMedia direct pass: top-level to + text
 * 2. Agent tool call: params.message / params.to / params.__sessionKey / params.__agentId + toolContext
 */
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

/** Return type of resolveActionTarget */
export interface ResolvedTarget {
  isGroup: boolean;
  target: string;
  groupCode?: string;
  sessionKey?: string;
  agentId?: string;
}

// ============ Helper functions ============

/**
 * Extract group groupCode from toolContext.currentChannelId.
 *
 * Format example: `yuanbao:group:585003747`
 * Matches `yuanbao:group:` prefix and takes the remainder as groupCode.
 */
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

// ============ Core resolution ============

/**
 * Unified action target resolution.
 *
 * Priority:
 * 1. params.to / params.target (Agent tool call explicit)
 * 2. Top-level to (channel.ts sendText/sendMedia direct pass)
 * 3. toolContext.currentChannelId fallback (inferred from current session context)
 */
export function resolveActionTarget(input: ActionParams): ResolvedTarget {
  const { params, toolContext } = input;

  // Get raw target from params or top-level
  const rawTo = params?.to ?? params?.target ?? input.to ?? "";

  // Extract originating group from toolContext
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

  // Use parseTarget to uniformly parse user:xxx / direct:xxx / group:xxx / bare ID
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
