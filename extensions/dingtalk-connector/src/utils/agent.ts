/**
 * Agent 相关工具函数
 * 
 * 提供 Agent 配置解析、工作空间路径解析等功能
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";

/**
 * 解析 Agent 工作空间路径
 * 
 * 参考 OpenClaw SDK 的 resolveAgentWorkspaceDir 实现逻辑：
 * 1. 优先从 agents.list 中查找用户配置的 workspace
 * 2. 如果没有配置，使用默认路径规则：
 *    - 默认 Agent (main): ~/.openclaw/workspace
 *    - 其他 Agent: ~/.openclaw/workspace-{agentId}
 * 
 * @param cfg - OpenClaw 配置对象
 * @param agentId - Agent ID
 * @returns Agent 工作空间的绝对路径
 * 
 * @example
 * ```typescript
 * // 用户自定义工作空间
 * const cfg = {
 *   agents: {
 *     list: [{ id: 'bot1', workspace: '~/my-workspace' }]
 *   }
 * };
 * resolveAgentWorkspaceDir(cfg, 'bot1'); // => '/Users/xxx/my-workspace'
 * 
 * // 默认 Agent
 * resolveAgentWorkspaceDir(cfg, 'main'); // => '/Users/xxx/.openclaw/workspace'
 * 
 * // 其他 Agent
 * resolveAgentWorkspaceDir(cfg, 'bot2'); // => '/Users/xxx/.openclaw/workspace-bot2'
 * ```
 */
export function resolveAgentWorkspaceDir(
  cfg: ClawdbotConfig,
  agentId: string,
): string {
  // 1. 先从 agents.list 中查找配置的 workspace
  const agentConfig = cfg.agents?.list?.find((a: any) => a.id === agentId);
  
  if (agentConfig?.workspace) {
    // 用户配置了自定义工作空间路径
    // 支持 ~ 路径展开
    return agentConfig.workspace.startsWith('~') 
      ? path.join(os.homedir(), agentConfig.workspace.slice(1))
      : agentConfig.workspace;
  }
  
  // 2. 使用默认路径规则
  if (agentId === 'main' || agentId === cfg.defaultAgent) {
    // 默认 Agent 使用 ~/.openclaw/workspace
    return path.join(os.homedir(), '.openclaw', 'workspace');
  }
  
  // 其他 Agent 使用 ~/.openclaw/workspace-{agentId}
  return path.join(os.homedir(), '.openclaw', `workspace-${agentId}`);
}
