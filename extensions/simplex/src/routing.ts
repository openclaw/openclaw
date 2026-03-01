/**
 * SimpleX Message Routing Module
 *
 * Handles routing of incoming messages to different OpenClaw agents
 * based on contact/group configuration. This replaces router.py with
 * a more flexible TypeScript implementation.
 */

import type { SimplexConfig, SimplexUserRouting, SimplexGroupRouting } from "./config-schema.js";

export interface RoutingContext {
  /** Contact name of the sender */
  senderName: string;
  /** Contact ID of the sender */
  senderId: string;
  /** Whether this is a group message */
  isGroup: boolean;
  /** Group name (if group message) */
  groupName?: string;
  /** Group ID (if group message) */
  groupId?: string;
  /** Member ID (for group messages) */
  memberId?: string;
}

export interface RoutingResult {
  /** Agent name to route to */
  agent: string;
  /** Language code (ISO 639-1) */
  language: string;
  /** Model to use */
  model?: string;
  /** Whether to reply with voice (TTS) */
  voiceReplies: boolean;
  /** System prompt override */
  systemPrompt?: string;
  /** Include conversation history */
  includeHistory: boolean;
  /** Max history messages */
  maxHistoryMessages: number;
}

/**
 * Resolve routing for an incoming message.
 *
 * Priority order:
 * 1. User routing (exact contact name match) - highest priority
 * 2. Group routing with member filtering (for group messages)
 * 3. Default agent (if configured)
 */
export function resolveRouting(config: SimplexConfig, ctx: RoutingContext): RoutingResult | null {
  const {
    userRouting = [],
    groupRouting = [],
    defaultAgent,
    defaultLanguage = "en",
    defaultModel,
    defaultVoiceReplies = false,
  } = config;

  // 1. Check user routing (direct messages)
  if (!ctx.isGroup) {
    // Filter matching routes and sort by priority (highest first)
    const userRoute = userRouting
      .filter((r) => r.contactName.toLowerCase() === ctx.senderName.toLowerCase())
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];

    if (userRoute) {
      return {
        agent: userRoute.agent,
        language: userRoute.language,
        model: userRoute.model,
        voiceReplies: userRoute.voiceReplies,
        systemPrompt: userRoute.systemPrompt,
        includeHistory: userRoute.includeHistory,
        maxHistoryMessages: userRoute.maxHistoryMessages,
      };
    }
  }

  // 2. Check group routing
  if (ctx.isGroup && ctx.groupName) {
    // Find matching group routes, sorted by priority (highest first)
    const matchingGroups = groupRouting
      .filter((r) => r.groupName.toLowerCase() === ctx.groupName!.toLowerCase())
      .sort((a, b) => b.priority - a.priority);

    for (const groupRoute of matchingGroups) {
      // Check member exclusions first
      if (groupRoute.memberExclude) {
        const isExcluded = groupRoute.memberExclude.some(
          (excluded) => excluded.toLowerCase() === ctx.senderName.toLowerCase(),
        );
        if (isExcluded) {
          // Sender is excluded - continue to next group route or fall through
          continue;
        }
      }

      // Check member filter (if specified, only these members match)
      if (groupRoute.memberFilter && groupRoute.memberFilter.length > 0) {
        const isIncluded = groupRoute.memberFilter.some(
          (member) => member.toLowerCase() === ctx.senderName.toLowerCase(),
        );
        if (!isIncluded) {
          // Sender not in filter - continue
          continue;
        }
      }

      // This route matches!
      return {
        agent: groupRoute.agent,
        language: groupRoute.language,
        model: groupRoute.model,
        voiceReplies: groupRoute.voiceReplies,
        systemPrompt: groupRoute.systemPrompt,
        includeHistory: groupRoute.includeHistory,
        maxHistoryMessages: groupRoute.maxHistoryMessages,
      };
    }
  }

  // 3. Fall back to default agent
  if (defaultAgent) {
    return {
      agent: defaultAgent,
      language: defaultLanguage,
      model: defaultModel,
      voiceReplies: defaultVoiceReplies,
      includeHistory: true,
      maxHistoryMessages: 10,
    };
  }

  // No routing found - return null to use default OpenClaw pipeline
  return null;
}

/**
 * Check if a message should be routed to a specific agent.
 * Returns true if routing was found.
 */
export function shouldRouteToAgent(config: SimplexConfig, ctx: RoutingContext): boolean {
  return resolveRouting(config, ctx) !== null;
}

/**
 * Build routing info for logging/debugging.
 */
export function describeRouting(config: SimplexConfig, ctx: RoutingContext): string {
  const result = resolveRouting(config, ctx);

  if (!result) {
    return `No routing configured for ${ctx.isGroup ? `group:${ctx.groupName}/` : ""}${ctx.senderName}`;
  }

  return `Routed ${ctx.isGroup ? `group:${ctx.groupName}/` : ""}${ctx.senderName} → agent:${result.agent} (lang:${result.language}, voice:${result.voiceReplies})`;
}
