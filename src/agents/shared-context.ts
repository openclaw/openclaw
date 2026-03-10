/**
 * Shared Context - 跨Agent共享上下文系统
 *
 * 允许多个Agent共享部分上下文信息，减少重复传输和存储：
 * - 共享内存池
 * - 上下文继承
 * - 自动过期清理
 * - 读写隔离
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * 共享上下文条目
 */
export type SharedContextEntry = {
  id: string;
  scope: SharedContextScope;
  ownerAgentId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;

  // 内容
  summary: string;
  keyDecisions: string[];
  openQuestions: string[];
  constraints: string[];
  importantFacts: string[];

  // 元数据
  tokenCount: number;
  accessCount: number;
  lastAccessedBy: string[];
};

/**
 * 共享上下文作用域
 */
export type SharedContextScope =
  | "global" // 全局共享
  | "group" // 组内共享
  | "parent-child"; // 父子Agent共享

/**
 * 共享上下文配置
 */
export type SharedContextConfig = {
  // 是否启用
  enabled: boolean;
  // 最大共享token数
  maxSharedTokens: number;
  // 默认过期时间(ms)
  defaultTtlMs: number;
  // 最大条目数
  maxEntries: number;
  // 清理间隔(ms)
  cleanupIntervalMs: number;
  // 默认作用域
  defaultScope: SharedContextScope;
};

const DEFAULT_CONFIG: SharedContextConfig = {
  enabled: true,
  maxSharedTokens: 10000,
  defaultTtlMs: 30 * 60 * 1000, // 30分钟
  maxEntries: 100,
  cleanupIntervalMs: 60 * 1000, // 1分钟
  defaultScope: "group",
};

/**
 * 共享上下文管理器
 */
export class SharedContextManager {
  private entries: Map<string, SharedContextEntry> = new Map();
  private config: SharedContextConfig;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private groupMemberships: Map<string, Set<string>> = new Map(); // groupId -> agentIds
  private agentGroups: Map<string, string> = new Map(); // agentId -> groupId

  constructor(config?: Partial<SharedContextConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.enabled) {
      this.startCleanupTimer();
    }
  }

  /**
   * 注册Agent到组
   */
  registerAgentToGroup(agentId: string, groupId: string): void {
    // 从旧组移除
    const oldGroup = this.agentGroups.get(agentId);
    if (oldGroup) {
      const members = this.groupMemberships.get(oldGroup);
      if (members) {
        members.delete(agentId);
      }
    }

    // 添加到新组
    this.agentGroups.set(agentId, groupId);
    if (!this.groupMemberships.has(groupId)) {
      this.groupMemberships.set(groupId, new Set());
    }
    this.groupMemberships.get(groupId)!.add(agentId);
  }

  /**
   * 创建共享上下文
   */
  createSharedContext(params: {
    ownerAgentId: string;
    scope?: SharedContextScope;
    summary: string;
    keyDecisions?: string[];
    openQuestions?: string[];
    constraints?: string[];
    importantFacts?: string[];
    ttlMs?: number;
  }): SharedContextEntry | null {
    if (!this.config.enabled) {
      return null;
    }

    const scope = params.scope ?? this.config.defaultScope;
    const id = this.generateId();

    const entry: SharedContextEntry = {
      id,
      scope,
      ownerAgentId: params.ownerAgentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: params.ttlMs ? Date.now() + params.ttlMs : undefined,
      summary: params.summary,
      keyDecisions: params.keyDecisions ?? [],
      openQuestions: params.openQuestions ?? [],
      constraints: params.constraints ?? [],
      importantFacts: params.importantFacts ?? [],
      tokenCount: this.estimateEntryTokens({
        summary: params.summary,
        keyDecisions: params.keyDecisions ?? [],
        openQuestions: params.openQuestions ?? [],
        constraints: params.constraints ?? [],
        importantFacts: params.importantFacts ?? [],
      }),
      accessCount: 0,
      lastAccessedBy: [],
    };

    // 检查token限制
    if (entry.tokenCount > this.config.maxSharedTokens) {
      console.warn(
        `Shared context entry exceeds max tokens: ${entry.tokenCount} > ${this.config.maxSharedTokens}`,
      );
      return null;
    }

    this.entries.set(id, entry);
    this.evictIfNeeded();

    return entry;
  }

  /**
   * 获取Agent可访问的共享上下文
   */
  getAccessibleContexts(agentId: string): SharedContextEntry[] {
    const accessible: SharedContextEntry[] = [];
    const groupId = this.agentGroups.get(agentId);

    for (const entry of Array.from(this.entries.values())) {
      if (this.canAccess(agentId, groupId, entry)) {
        entry.accessCount++;
        if (!entry.lastAccessedBy.includes(agentId)) {
          entry.lastAccessedBy.push(agentId);
        }
        accessible.push(entry);
      }
    }

    return accessible;
  }

  /**
   * 获取格式化的共享上下文（用于注入到消息中）
   */
  getFormattedSharedContext(agentId: string): string {
    const contexts = this.getAccessibleContexts(agentId);

    if (contexts.length === 0) {
      return "";
    }

    const sections: string[] = ["## Shared Context from Other Agents\n"];

    for (const ctx of contexts) {
      sections.push(`### From Agent: ${ctx.ownerAgentId}`);
      sections.push(`Scope: ${ctx.scope}`);
      sections.push("");

      if (ctx.summary) {
        sections.push("**Summary:**");
        sections.push(ctx.summary);
        sections.push("");
      }

      if (ctx.keyDecisions.length > 0) {
        sections.push("**Key Decisions:**");
        for (const decision of ctx.keyDecisions) {
          sections.push(`- ${decision}`);
        }
        sections.push("");
      }

      if (ctx.constraints.length > 0) {
        sections.push("**Constraints:**");
        for (const constraint of ctx.constraints) {
          sections.push(`- ${constraint}`);
        }
        sections.push("");
      }

      if (ctx.openQuestions.length > 0) {
        sections.push("**Open Questions:**");
        for (const question of ctx.openQuestions) {
          sections.push(`- ${question}`);
        }
        sections.push("");
      }

      sections.push("---\n");
    }

    return sections.join("\n");
  }

  /**
   * 更新共享上下文
   */
  updateSharedContext(
    id: string,
    updates: Partial<
      Pick<
        SharedContextEntry,
        "summary" | "keyDecisions" | "openQuestions" | "constraints" | "importantFacts"
      >
    >,
  ): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }

    Object.assign(entry, updates);
    entry.updatedAt = Date.now();
    entry.tokenCount = this.estimateEntryTokens(entry);

    return true;
  }

  /**
   * 删除共享上下文
   */
  deleteSharedContext(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * 清理过期条目
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of Array.from(this.entries.entries())) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.entries.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalEntries: number;
    totalTokens: number;
    byScope: Record<SharedContextScope, number>;
    groupCount: number;
    agentCount: number;
  } {
    const byScope: Record<SharedContextScope, number> = {
      global: 0,
      group: 0,
      "parent-child": 0,
    };

    let totalTokens = 0;

    for (const entry of Array.from(this.entries.values())) {
      byScope[entry.scope]++;
      totalTokens += entry.tokenCount;
    }

    return {
      totalEntries: this.entries.size,
      totalTokens,
      byScope,
      groupCount: this.groupMemberships.size,
      agentCount: this.agentGroups.size,
    };
  }

  /**
   * 关闭管理器
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.entries.clear();
    this.groupMemberships.clear();
    this.agentGroups.clear();
  }

  // ===== 私有方法 =====

  private canAccess(
    agentId: string,
    groupId: string | undefined,
    entry: SharedContextEntry,
  ): boolean {
    // 所有者始终可访问
    if (entry.ownerAgentId === agentId) {
      return true;
    }

    switch (entry.scope) {
      case "global":
        return true;

      case "group":
        return groupId !== undefined && this.agentGroups.get(entry.ownerAgentId) === groupId;

      case "parent-child":
        // 检查是否是父子关系（简化实现）
        return this.areRelatedAgents(agentId, entry.ownerAgentId);

      default:
        return false;
    }
  }

  private areRelatedAgents(agentId1: string, agentId2: string): boolean {
    // 简化实现：检查是否在同一组或有父子命名关系
    const group1 = this.agentGroups.get(agentId1);
    const group2 = this.agentGroups.get(agentId2);

    if (group1 && group1 === group2) {
      return true;
    }

    // 检查命名关系 (e.g., "main-agent" and "main-agent-sub-1")
    if (agentId1.startsWith(agentId2) || agentId2.startsWith(agentId1)) {
      return true;
    }

    return false;
  }

  private estimateEntryTokens(
    params:
      | Pick<
          SharedContextEntry,
          "summary" | "keyDecisions" | "openQuestions" | "constraints" | "importantFacts"
        >
      | SharedContextEntry,
  ): number {
    const text = [
      params.summary,
      ...params.keyDecisions,
      ...params.openQuestions,
      ...params.constraints,
      ...params.importantFacts,
    ].join("\n");

    return Math.ceil(text.length / 4); // 粗略估计
  }

  private generateId(): string {
    return `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.config.maxEntries) {
      return;
    }

    // LRU 淘汰：移除访问次数最少且最旧的条目
    const sorted = Array.from(this.entries.entries()).toSorted((a, b) => {
      const accessDiff = a[1].accessCount - b[1].accessCount;
      if (accessDiff !== 0) {
        return accessDiff;
      }
      return a[1].createdAt - b[1].createdAt;
    });

    const toEvict = sorted.slice(0, this.entries.size - this.config.maxEntries);
    for (const [id] of toEvict) {
      this.entries.delete(id);
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
  }
}

// 全局单例
let globalManager: SharedContextManager | null = null;

/**
 * 获取全局共享上下文管理器
 */
export function getSharedContextManager(): SharedContextManager {
  if (!globalManager) {
    globalManager = new SharedContextManager();
  }
  return globalManager;
}

/**
 * 配置全局共享上下文管理器
 */
export function configureSharedContext(config?: Partial<SharedContextConfig>): void {
  if (globalManager) {
    globalManager.shutdown();
  }
  globalManager = new SharedContextManager(config);
}

/**
 * 辅助函数：从Agent消息中提取可共享的信息
 */
export function extractShareableInfo(messages: AgentMessage[]): {
  summary: string;
  keyDecisions: string[];
  openQuestions: string[];
  constraints: string[];
  importantFacts: string[];
} {
  const keyDecisions: string[] = [];
  const openQuestions: string[] = [];
  const constraints: string[] = [];
  const importantFacts: string[] = [];

  // 关键词检测
  const decisionKeywords = [
    "决定",
    "decision",
    "确定",
    "confirmed",
    "选择",
    "chose",
    "agree",
    "共识",
  ];
  const questionKeywords = [
    "问题",
    "question",
    "待定",
    "pending",
    "需要确认",
    "need to confirm",
    "不清楚",
    "unclear",
  ];
  const constraintKeywords = [
    "限制",
    "constraint",
    "必须",
    "must",
    "不能",
    "cannot",
    "要求",
    "requirement",
  ];
  const factKeywords = [
    "重要",
    "important",
    "关键",
    "critical",
    "注意",
    "note",
    "记住",
    "remember",
  ];

  for (const msg of messages) {
    // 检查消息类型是否有 content 属性
    const content = "content" in msg && typeof msg.content === "string" ? msg.content : "";
    const lines = content.split("\n");

    for (const line of lines) {
      const lowerLine = line.toLowerCase();

      if (decisionKeywords.some((k) => lowerLine.includes(k))) {
        keyDecisions.push(line.trim());
      }
      if (questionKeywords.some((k) => lowerLine.includes(k))) {
        openQuestions.push(line.trim());
      }
      if (constraintKeywords.some((k) => lowerLine.includes(k))) {
        constraints.push(line.trim());
      }
      if (factKeywords.some((k) => lowerLine.includes(k))) {
        importantFacts.push(line.trim());
      }
    }
  }

  // 去重并限制数量
  return {
    summary: "", // 需要外部生成
    keyDecisions: Array.from(new Set(keyDecisions)).slice(0, 10),
    openQuestions: Array.from(new Set(openQuestions)).slice(0, 5),
    constraints: Array.from(new Set(constraints)).slice(0, 10),
    importantFacts: Array.from(new Set(importantFacts)).slice(0, 10),
  };
}
