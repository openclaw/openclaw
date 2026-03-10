/**
 * Enhanced Compaction - 增强版上下文压缩系统
 *
 * 整合三个改进：
 * 1. 压缩指标 (compaction-metrics.ts)
 * 2. 并行处理 (compaction-parallel.ts)
 * 3. 共享上下文 (shared-context.ts)
 *
 * 使用方式：
 * ```typescript
 * import { enhancedCompaction } from "./compaction-enhanced.js";
 *
 * const result = await enhancedCompaction({
 *   messages,
 *   model,
 *   apiKey,
 *   sessionId: "session-123",
 *   agentId: "agent-main",
 * });
 * ```
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import {
  CompactionMetricsCollector,
  configureCompactionMetrics,
  getCompactionMetricsCollector,
  type CompactionAggregatedStats,
} from "./compaction-metrics.js";
import {
  compactWithParallel,
  shouldUseParallelCompaction,
  type ParallelCompactionConfig,
} from "./compaction-parallel.js";
import {
  estimateMessagesTokens,
  resolveContextWindowTokens,
  summarizeInStages,
} from "./compaction.js";
import {
  extractShareableInfo,
  getSharedContextManager,
  type SharedContextConfig,
} from "./shared-context.js";

/**
 * 增强版压缩配置
 */
export type EnhancedCompactionConfig = {
  // 指标收集
  metrics: {
    enabled: boolean;
    maxEntries: number;
  };

  // 并行处理
  parallel: ParallelCompactionConfig;

  // 共享上下文
  sharedContext: SharedContextConfig;

  // 压缩策略
  strategy: {
    // 使用并行压缩的阈值（消息数）
    parallelThreshold: number;
    // 共享上下文的阈值（token数）
    sharedContextThreshold: number;
    // 是否在压缩前提取共享信息
    extractSharedInfo: boolean;
  };
};

const DEFAULT_ENHANCED_CONFIG: EnhancedCompactionConfig = {
  metrics: {
    enabled: true,
    maxEntries: 1000,
  },
  parallel: {
    maxConcurrency: 4,
    taskTimeoutMs: 60_000,
    minChunksForParallel: 2,
    enabled: true,
  },
  sharedContext: {
    enabled: true,
    maxSharedTokens: 10_000,
    defaultTtlMs: 30 * 60 * 1000,
    maxEntries: 100,
    cleanupIntervalMs: 60_000,
    defaultScope: "group",
  },
  strategy: {
    parallelThreshold: 10,
    sharedContextThreshold: 5000,
    extractSharedInfo: true,
  },
};

/**
 * 增强版压缩结果
 */
export type EnhancedCompactionResult = {
  summary: string;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    compressionRatio: number;
    durationMs: number;
    parallelUsed: boolean;
    sharedContextUsed: boolean;
    chunkCount: number;
  };
  sharedInfo?: {
    created: boolean;
    id?: string;
    scope?: string;
  };
};

/**
 * 全局配置
 */
let globalConfig: EnhancedCompactionConfig = DEFAULT_ENHANCED_CONFIG;

/**
 * 配置增强版压缩系统
 */
export function configureEnhancedCompaction(config?: Partial<EnhancedCompactionConfig>): void {
  globalConfig = {
    ...DEFAULT_ENHANCED_CONFIG,
    ...config,
    metrics: { ...DEFAULT_ENHANCED_CONFIG.metrics, ...config?.metrics },
    parallel: { ...DEFAULT_ENHANCED_CONFIG.parallel, ...config?.parallel },
    sharedContext: { ...DEFAULT_ENHANCED_CONFIG.sharedContext, ...config?.sharedContext },
    strategy: { ...DEFAULT_ENHANCED_CONFIG.strategy, ...config?.strategy },
  };

  // 配置子系统
  configureCompactionMetrics(globalConfig.metrics);
}

/**
 * 增强版上下文压缩
 *
 * 自动选择最优策略：
 * 1. 检查是否适合并行压缩
 * 2. 提取可共享信息
 * 3. 执行压缩（并行或串行）
 * 4. 创建共享上下文
 * 5. 记录指标
 */
export async function enhancedCompaction(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow?: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
  sessionId: string;
  agentId?: string;
  parentAgentId?: string;
  groupId?: string;
  config?: Partial<EnhancedCompactionConfig>;
}): Promise<EnhancedCompactionResult> {
  const config: EnhancedCompactionConfig = {
    ...globalConfig,
    ...params.config,
  };

  const startTime = Date.now();
  const contextWindow = params.contextWindow ?? resolveContextWindowTokens(params.model);

  // 1. 注册Agent到组（如果提供了groupId）
  if (params.groupId && params.agentId) {
    getSharedContextManager().registerAgentToGroup(params.agentId, params.groupId);
  }

  // 2. 获取共享上下文（如果有）
  let sharedContextPrefix = "";
  let sharedContextUsed = false;

  if (config.sharedContext.enabled && params.agentId) {
    const formattedContext = getSharedContextManager().getFormattedSharedContext(params.agentId);
    if (formattedContext) {
      sharedContextPrefix = formattedContext;
      sharedContextUsed = true;
    }
  }

  // 3. 提取可共享信息（压缩前）
  let extractedInfo: ReturnType<typeof extractShareableInfo> | null = null;
  if (
    config.strategy.extractSharedInfo &&
    params.messages.length >= config.strategy.parallelThreshold
  ) {
    extractedInfo = extractShareableInfo(params.messages);
  }

  // 4. 决定是否使用并行压缩
  const useParallel = shouldUseParallelCompaction(
    params.messages,
    config.parallel,
    params.maxChunkTokens,
  );

  let summary: string;

  if (useParallel) {
    // 并行压缩
    summary = await compactWithParallel({
      messages: params.messages,
      model: params.model,
      apiKey: params.apiKey,
      signal: params.signal,
      reserveTokens: params.reserveTokens,
      maxChunkTokens: params.maxChunkTokens,
      contextWindow,
      customInstructions: params.customInstructions,
      previousSummary: params.previousSummary,
      parallelConfig: config.parallel,
      sessionId: params.sessionId,
      agentId: params.agentId,
    });
  } else {
    // 串行压缩（使用原有逻辑）
    summary = await summarizeInStages({
      messages: params.messages,
      model: params.model,
      apiKey: params.apiKey,
      signal: params.signal,
      reserveTokens: params.reserveTokens,
      maxChunkTokens: params.maxChunkTokens,
      contextWindow,
      customInstructions: params.customInstructions,
      previousSummary: params.previousSummary,
      parts: params.parts,
      minMessagesForSplit: params.minMessagesForSplit,
    });
  }

  // 5. 合并共享上下文
  if (sharedContextPrefix) {
    summary = sharedContextPrefix + "\n\n## Current Session Summary\n\n" + summary;
  }

  // 6. 创建共享上下文（如果提取了信息且满足阈值）
  let sharedInfoCreated = false;
  let sharedContextId: string | undefined;

  const totalTokens = estimateMessagesTokens(params.messages);
  if (
    extractedInfo &&
    config.sharedContext.enabled &&
    params.agentId &&
    totalTokens >= config.strategy.sharedContextThreshold
  ) {
    const entry = getSharedContextManager().createSharedContext({
      ownerAgentId: params.agentId,
      scope: params.parentAgentId ? "parent-child" : "group",
      summary,
      keyDecisions: extractedInfo.keyDecisions,
      openQuestions: extractedInfo.openQuestions,
      constraints: extractedInfo.constraints,
      importantFacts: extractedInfo.importantFacts,
    });

    if (entry) {
      sharedInfoCreated = true;
      sharedContextId = entry.id;
    }
  }

  // 7. 计算并返回结果
  const outputTokens = estimateTokens({
    role: "assistant",
    content: summary,
  } as unknown as AgentMessage);
  const inputTokens = totalTokens;
  const compressionRatio = outputTokens > 0 ? inputTokens / outputTokens : 0;
  const durationMs = Date.now() - startTime;

  return {
    summary,
    metrics: {
      inputTokens,
      outputTokens,
      compressionRatio,
      durationMs,
      parallelUsed: useParallel,
      sharedContextUsed,
      chunkCount: Math.ceil(inputTokens / params.maxChunkTokens),
    },
    sharedInfo: sharedInfoCreated
      ? {
          created: true,
          id: sharedContextId,
          scope: params.parentAgentId ? "parent-child" : "group",
        }
      : { created: false },
  };
}

/**
 * 获取压缩统计报告
 */
export function getCompactionReport(
  startMs?: number,
  endMs?: number,
  agentId?: string,
): CompactionAggregatedStats | null {
  return getCompactionMetricsCollector().getAggregatedStats(startMs, endMs, agentId);
}

/**
 * 格式化压缩报告
 */
export function formatCompactionReport(startMs?: number, endMs?: number, agentId?: string): string {
  const stats = getCompactionReport(startMs, endMs, agentId);
  if (!stats) {
    return "No compaction metrics available.";
  }
  return getCompactionMetricsCollector().formatReport(stats);
}

/**
 * 获取共享上下文统计
 */
export function getSharedContextStats(): ReturnType<
  ReturnType<typeof getSharedContextManager>["getStats"]
> {
  return getSharedContextManager().getStats();
}

// 导出子模块
export { CompactionMetricsCollector, type CompactionMetricEntry } from "./compaction-metrics.js";
export { type ParallelCompactionConfig } from "./compaction-parallel.js";
export { SharedContextManager, type SharedContextScope } from "./shared-context.js";
