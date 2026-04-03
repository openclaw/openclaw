/**
 * 动态路由统一处理模块
 * 提供统一的路由注入接口。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { shouldUseDynamicAgent, generateAgentId } from "./dynamic-agent.js";

/**
 * 路由对象（从 core.channel.routing.resolveAgentRoute 返回）
 */
export interface AgentRoute {
  agentId: string;
  sessionKey: string;
  matchedBy: string;
  accountId: string;
  mainSessionKey?: string;
}

/**
 * 动态路由处理参数
 */
export interface DynamicRoutingParams {
  /** 原始路由对象 */
  route: AgentRoute;
  /** 全局配置 */
  config: OpenClawConfig;
  /** 插件运行时 */
  core: PluginRuntime;
  /** 账号 ID */
  accountId: string;
  /** 会话类型 */
  chatType: "group" | "dm";
  /** 对话 ID（群聊为 chatId，私聊为 userId） */
  chatId: string;
  /** 发送者用户 ID */
  senderId: string;
  /** 日志输出函数（可选） */
  log?: (msg: string) => void;
  /** 错误日志输出函数（可选） */
  error?: (msg: string) => void;
}

/**
 * 动态路由处理结果
 */
export interface DynamicRoutingResult {
  /** 是否使用动态 Agent */
  useDynamicAgent: boolean;
  /** 最终的 agentId（可能被动态注入修改） */
  finalAgentId: string;
  /** 最终的 sessionKey（可能被动态注入修改） */
  finalSessionKey: string;
  /** 是否修改了路由（注入了动态 Agent） */
  routeModified: boolean;
}

/**
 * 统一处理动态路由注入逻辑
 * 
 * 功能：
 * 1. 判断是否需要使用动态 Agent
 * 2. 根据 matchedBy 判断配置类型
 * 3. 返回最终的路由信息（不修改传入的 route 对象）
 * 4. 输出详细的调试日志
 * 
 * @param params 动态路由处理参数
 * @returns 处理结果
 */
export function processDynamicRouting(params: DynamicRoutingParams): DynamicRoutingResult {
  const { route, config, accountId, chatType, chatId, senderId, log } = params;

  log?.(`[dynamic-routing] 🔍 调试 - matchedBy=${route.matchedBy}, agentId=${route.agentId}`);
  
  if (route.matchedBy !== "default") {
    log?.(`[dynamic-routing] ℹ️  检测到匹配的 bindings (matchedBy=${route.matchedBy})，跳过动态路由`);
    return {
      useDynamicAgent: false,
      finalAgentId: route.agentId,
      finalSessionKey: route.sessionKey,
      routeModified: false,
    };
  }

  // 判断是否使用动态 Agent
  const useDynamicAgent = shouldUseDynamicAgent({
    chatType,
    senderId,
    config,
  });
  log?.(`[dynamic-routing] 是否使用动态路由: useDynamicAgent=${useDynamicAgent}`);

  // 使用动态 Agent
  if (useDynamicAgent) {
    log?.(`[dynamic-routing] 原始路由信息: agentId=${route.agentId}, matchedBy=${route.matchedBy}, sessionKey=${route.sessionKey}`);
    
    const targetAgentId = generateAgentId(chatType, chatId, accountId);
    const targetSessionKey = `agent:${targetAgentId}:wecom:${accountId}:${chatType}:${chatId}`;

    log?.(`[dynamic-routing] 🔄 路由注入: agentId=${targetAgentId}, sessionKey=${targetSessionKey}`);

    return {
      useDynamicAgent: true,
      finalAgentId: targetAgentId,
      finalSessionKey: targetSessionKey,
      routeModified: true,
    };
  }
  
  log?.('[dynamic-routing] 🔄不使用动态路由');
  // 不使用动态 Agent，返回原始路由
  return {
    useDynamicAgent: false,
    finalAgentId: route.agentId,
    finalSessionKey: route.sessionKey,
    routeModified: false,
  };
}
