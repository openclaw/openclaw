/**
 * Unified dynamic routing handler module.
 * Provides a unified route injection interface.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { shouldUseDynamicAgent, generateAgentId } from "./dynamic-agent.js";

/**
 * Route object (returned from core.channel.routing.resolveAgentRoute)
 */
export interface AgentRoute {
  agentId: string;
  sessionKey: string;
  matchedBy: string;
  accountId: string;
  mainSessionKey?: string;
}

/**
 * Dynamic routing handler parameters
 */
export interface DynamicRoutingParams {
  /** Original route object */
  route: AgentRoute;
  /** Global configuration */
  config: OpenClawConfig;
  /** Plugin runtime */
  core: PluginRuntime;
  /** Account ID */
  accountId: string;
  /** Chat type */
  chatType: "group" | "dm";
  /** Chat ID (groupId for group chats, userId for DMs) */
  chatId: string;
  /** Sender user ID */
  senderId: string;
  /** Log output function (optional) */
  log?: (msg: string) => void;
  /** Error log output function (optional) */
  error?: (msg: string) => void;
}

/**
 * Dynamic routing handler result
 */
export interface DynamicRoutingResult {
  /** Whether dynamic Agent is used */
  useDynamicAgent: boolean;
  /** Final agentId (may be modified by dynamic injection) */
  finalAgentId: string;
  /** Final sessionKey (may be modified by dynamic injection) */
  finalSessionKey: string;
  /** Whether the route was modified (dynamic Agent was injected) */
  routeModified: boolean;
}

/**
 * Unified dynamic routing injection logic handler.
 *
 * Functionality:
 * 1. Determine whether a dynamic Agent is needed
 * 2. Determine config type based on matchedBy
 * 3. Return the final routing info (does not mutate the input route object)
 * 4. Output detailed debug logs
 *
 * @param params Dynamic routing handler parameters
 * @returns Processing result
 */
export function processDynamicRouting(params: DynamicRoutingParams): DynamicRoutingResult {
  const { route, config, accountId, chatType, chatId, senderId, log } = params;

  log?.(`[dynamic-routing] 🔍 Debug - matchedBy=${route.matchedBy}, agentId=${route.agentId}`);

  if (route.matchedBy !== "default") {
    log?.(
      `[dynamic-routing] ℹ️  Detected matching bindings (matchedBy=${route.matchedBy}), skipping dynamic routing`,
    );
    return {
      useDynamicAgent: false,
      finalAgentId: route.agentId,
      finalSessionKey: route.sessionKey,
      routeModified: false,
    };
  }

  // Determine whether to use dynamic Agent (account-aware)
  const useDynamicAgent = shouldUseDynamicAgent({
    chatType,
    senderId,
    config,
    accountId,
  });
  log?.(`[dynamic-routing] Whether to use dynamic routing: useDynamicAgent=${useDynamicAgent}`);

  // Use dynamic Agent
  if (useDynamicAgent) {
    log?.(
      `[dynamic-routing] Original route info: agentId=${route.agentId}, matchedBy=${route.matchedBy}, sessionKey=${route.sessionKey}`,
    );

    const targetAgentId = generateAgentId(chatType, chatId, accountId);
    const targetSessionKey = `agent:${targetAgentId}:wecom:${accountId}:${chatType}:${chatId}`;

    log?.(
      `[dynamic-routing] 🔄 Route injection: agentId=${targetAgentId}, sessionKey=${targetSessionKey}`,
    );

    return {
      useDynamicAgent: true,
      finalAgentId: targetAgentId,
      finalSessionKey: targetSessionKey,
      routeModified: true,
    };
  }

  log?.("[dynamic-routing] 🔄 Not using dynamic routing");
  // Not using dynamic Agent, return original route
  return {
    useDynamicAgent: false,
    finalAgentId: route.agentId,
    finalSessionKey: route.sessionKey,
    routeModified: false,
  };
}
