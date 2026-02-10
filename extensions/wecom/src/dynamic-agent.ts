/**
 * **动态 Agent 路由模块**
 *
 * 为每个用户/群组自动生成独立的 Agent ID，实现会话隔离。
 * 参考: openclaw-plugin-wecom/dynamic-agent.js
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface DynamicAgentConfig {
  enabled: boolean;
  dmCreateAgent: boolean;
  groupEnabled: boolean;
  adminUsers: string[];
}

/**
 * **getDynamicAgentConfig (读取动态 Agent 配置)**
 *
 * 从全局配置中读取动态 Agent 配置，提供默认值。
 */
export function getDynamicAgentConfig(config: OpenClawConfig): DynamicAgentConfig {
  const dynamicAgents = (
    config as { channels?: { wecom?: { dynamicAgents?: Partial<DynamicAgentConfig> } } }
  )?.channels?.wecom?.dynamicAgents;
  return {
    enabled: dynamicAgents?.enabled ?? false,
    dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
    groupEnabled: dynamicAgents?.groupEnabled ?? true,
    adminUsers: dynamicAgents?.adminUsers ?? [],
  };
}

/**
 * **generateAgentId (生成动态 Agent ID)**
 *
 * 根据聊天类型和对端 ID 生成确定性的 Agent ID。
 * 格式: wecom-{type}-{sanitizedPeerId}
 * - type: dm | group
 * - sanitizedPeerId: 小写，非字母数字下划线横线替换为下划线
 *
 * @example
 * generateAgentId("dm", "ZhangSan") // "wecom-dm-zhangsan"
 * generateAgentId("group", "wr123456") // "wecom-group-wr123456"
 */
export function generateAgentId(chatType: "dm" | "group", peerId: string): string {
  const sanitized = String(peerId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  return `wecom-${chatType}-${sanitized}`;
}

/**
 * **shouldUseDynamicAgent (检查是否使用动态 Agent)**
 *
 * 根据配置和发送者信息判断是否应使用动态 Agent。
 * 管理员（adminUsers）始终绕过动态路由，使用主 Agent。
 */
export function shouldUseDynamicAgent(params: {
  chatType: "dm" | "group";
  senderId: string;
  config: OpenClawConfig;
}): boolean {
  const { chatType, senderId, config } = params;
  const dynamicConfig = getDynamicAgentConfig(config);

  if (!dynamicConfig.enabled) {
    return false;
  }

  // 管理员绕过动态路由
  const sender = String(senderId).trim().toLowerCase();
  const isAdmin = dynamicConfig.adminUsers.some((admin) => admin.trim().toLowerCase() === sender);
  if (isAdmin) {
    return false;
  }

  if (chatType === "group") {
    return dynamicConfig.groupEnabled;
  }
  return dynamicConfig.dmCreateAgent;
}

/**
 * 内存中已确保的 Agent ID（避免重复写入）
 */
const ensuredDynamicAgentIds = new Set<string>();

/**
 * 写入队列（避免并发冲突）
 */
let ensureDynamicAgentWriteQueue: Promise<void> = Promise.resolve();

/**
 * 将 Agent ID 插入 agents.list（如果不存在）
 */
function upsertAgentIdOnlyEntry(cfg: Record<string, unknown>, agentId: string): boolean {
  if (!cfg.agents || typeof cfg.agents !== "object") {
    cfg.agents = {};
  }

  const agentsObj = cfg.agents as Record<string, unknown>;
  const currentList: Array<{ id: string }> = Array.isArray(agentsObj.list)
    ? (agentsObj.list as Array<{ id: string }>)
    : [];
  const existingIds = new Set(
    currentList
      .map((entry) => entry?.id?.trim().toLowerCase())
      .filter((id): id is string => Boolean(id)),
  );

  let changed = false;
  const nextList = [...currentList];

  // 首次创建时保留 main 作为默认
  if (nextList.length === 0) {
    nextList.push({ id: "main" });
    existingIds.add("main");
    changed = true;
  }

  if (!existingIds.has(agentId.toLowerCase())) {
    nextList.push({ id: agentId });
    changed = true;
  }

  if (changed) {
    agentsObj.list = nextList;
  }

  return changed;
}

/**
 * **ensureDynamicAgentListed (确保动态 Agent 已添加到 agents.list)**
 *
 * 将动态生成的 Agent ID 添加到 OpenClaw 配置中的 agents.list。
 * 特性：
 * - 幂等：使用内存 Set 避免重复写入
 * - 串行：使用 Promise 队列避免并发冲突
 * - 异步：不阻塞消息处理流程
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureDynamicAgentListed(agentId: string, runtime: any): Promise<void> {
  const normalizedId = String(agentId).trim().toLowerCase();
  if (!normalizedId) return;
  if (ensuredDynamicAgentIds.has(normalizedId)) return;

  const configRuntime = runtime?.config;
  if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) return;

  ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
    .then(async () => {
      if (ensuredDynamicAgentIds.has(normalizedId)) return;

      const latestConfig = configRuntime.loadConfig!();
      if (!latestConfig || typeof latestConfig !== "object") return;

      const changed = upsertAgentIdOnlyEntry(latestConfig as Record<string, unknown>, normalizedId);
      if (changed) {
        await configRuntime.writeConfigFile!(latestConfig as unknown);
      }

      ensuredDynamicAgentIds.add(normalizedId);
    })
    .catch((err) => {
      console.warn(`[wecom] 动态 Agent 添加失败: ${normalizedId}`, err);
    });

  await ensureDynamicAgentWriteQueue;
}

/**
 * **resetEnsuredCache (重置已确保缓存)**
 *
 * 主要用于测试场景，重置内存中的缓存状态。
 */
export function resetEnsuredCache(): void {
  ensuredDynamicAgentIds.clear();
}
