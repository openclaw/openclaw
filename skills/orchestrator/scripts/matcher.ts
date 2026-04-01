import type { Subtask } from './types.js';

export interface AgentMatcherConfig {
  /** 类型到agentId的映射 */
  agentMap: Record<string, string>;
  /** 默认agentId（当匹配失败时使用） */
  defaultAgent: string;
}

/**
 * 为子任务匹配最合适的agent
 */
export function matchAgent(
  subtask: Subtask,
  config: AgentMatcherConfig,
  availableAgents: string[] = [],
): { agentId: string; reason: string } {
  // 策略1: 根据type字段直接映射
  if (subtask.type && config.agentMap[subtask.type]) {
    return {
      agentId: config.agentMap[subtask.type],
      reason: `type='${subtask.type}' → ${config.agentMap[subtask.type]}`,
    };
  }
  
  // 策略2: 如果subtask指定了requiredTools，尝试匹配能提供这些工具的agent
  if (subtask.requiredTools && subtask.requiredTools.length > 0) {
    // TODO: 这里需要通过工具发现机制检查agent的工具集
    // 暂时简化：如果availableAgents为空，跳过
    for (const agentId of availableAgents) {
      // 未来实现：toolsAvailable(agentId, subtask.requiredTools)
      // 现在只做简单映射
    }
  }
  
  // 策略3: 默认回退
  return {
    agentId: config.defaultAgent,
    reason: `使用默认agent: ${config.defaultAgent}`,
  };
}

/**
 * 批量匹配（orchestrator主要入口）
 */
export function matchAgents(
  subtasks: Subtask[],
  config: AgentMatcherConfig,
  availableAgents: string[] = [],
): Map<string, { agentId: string; reason: string }> {
  const result = new Map<string, { agentId: string; reason: string }>();
  
  subtasks.forEach(st => {
    const match = matchAgent(st, config, availableAgents);
    result.set(st.id, match);
  });
  
  return result;
}

/**
 * 生成匹配摘要
 */
export function generateMatchSummary(
  subtasks: Subtask[],
  matches: Map<string, { agentId: string; reason: string }>,
): string {
  const lines: string[] = ['Agent分配结果:'];
  
  subtasks.forEach(st => {
    const match = matches.get(st.id);
    lines.push(`  ${st.id} (${st.type}): ${match?.agentId} (${match?.reason})`);
  });
  
  // 统计使用频率
  const counts = new Map<string, number>();
  matches.forEach(m => {
    counts.set(m.agentId, (counts.get(m.agentId) ?? 0) + 1);
  });
  
  lines.push('\nAgent使用统计:');
  counts.forEach((count, agentId) => {
    lines.push(`  ${agentId}: ${count} 个任务`);
  });
  
  return lines.join('\n');
}
