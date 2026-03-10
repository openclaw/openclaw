/**
 * Compaction Metrics - 上下文压缩指标系统
 *
 * 用于跟踪和监控上下文压缩效果，支持：
 * - 压缩前后token数量
 * - 压缩率
 * - 压缩耗时
 * - 分块统计
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * 单次压缩操作的指标
 */
export type CompactionMetricEntry = {
  timestamp: number;
  sessionId: string;
  agentId?: string;

  // Token统计
  inputTokens: number;
  outputTokens: number;
  compressionRatio: number;

  // 分块统计
  chunkCount: number;
  avgChunkTokens: number;
  maxChunkTokens: number;
  oversizedCount: number;

  // 耗时统计
  durationMs: number;
  parallelUsed: boolean;

  // 质量指标
  fallbackUsed: boolean;
  errorCount: number;
  droppedMessages: number;
  droppedTokens: number;

  // 模型信息
  model?: string;
  provider?: string;
};

/**
 * 聚合的压缩统计
 */
export type CompactionAggregatedStats = {
  // 时间范围
  startMs: number;
  endMs: number;
  sessionCount: number;
  totalCompactions: number;

  // Token统计
  totalInputTokens: number;
  totalOutputTokens: number;
  avgCompressionRatio: number;
  p95CompressionRatio: number;

  // 分块统计
  avgChunkCount: number;
  avgChunkTokens: number;
  totalOversized: number;

  // 性能统计
  avgDurationMs: number;
  p95DurationMs: number;
  parallelUsageRate: number;

  // 质量统计
  fallbackRate: number;
  errorRate: number;
  avgDroppedMessages: number;
  avgDroppedTokens: number;
};

/**
 * 压缩指标收集器
 */
export class CompactionMetricsCollector {
  private entries: CompactionMetricEntry[] = [];
  private maxEntries: number;
  private enabled: boolean;

  constructor(options?: { maxEntries?: number; enabled?: boolean }) {
    this.maxEntries = options?.maxEntries ?? 1000;
    this.enabled = options?.enabled ?? true;
  }

  /**
   * 记录一次压缩操作
   */
  record(entry: Omit<CompactionMetricEntry, "timestamp">): void {
    if (!this.enabled) {
      return;
    }

    const fullEntry: CompactionMetricEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    this.entries.push(fullEntry);

    // 超过最大数量时，移除最旧的记录
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /**
   * 获取指定会话的压缩历史
   */
  getSessionHistory(sessionId: string): CompactionMetricEntry[] {
    return this.entries.filter((e) => e.sessionId === sessionId);
  }

  /**
   * 获取指定时间范围的聚合统计
   */
  getAggregatedStats(
    startMs?: number,
    endMs?: number,
    agentId?: string,
  ): CompactionAggregatedStats | null {
    let filtered = this.entries;

    if (startMs !== undefined) {
      filtered = filtered.filter((e) => e.timestamp >= startMs);
    }
    if (endMs !== undefined) {
      filtered = filtered.filter((e) => e.timestamp <= endMs);
    }
    if (agentId !== undefined) {
      filtered = filtered.filter((e) => e.agentId === agentId);
    }

    if (filtered.length === 0) {
      return null;
    }

    const sorted = [...filtered].toSorted((a, b) => a.timestamp - b.timestamp);
    const ratios = filtered.map((e) => e.compressionRatio).toSorted((a, b) => a - b);
    const durations = filtered.map((e) => e.durationMs).toSorted((a, b) => a - b);

    const totalInput = filtered.reduce((sum, e) => sum + e.inputTokens, 0);
    const totalOutput = filtered.reduce((sum, e) => sum + e.outputTokens, 0);

    const p95Index = Math.ceil(filtered.length * 0.95) - 1;

    return {
      startMs: sorted[0].timestamp,
      endMs: sorted[sorted.length - 1].timestamp,
      sessionCount: new Set(filtered.map((e) => e.sessionId)).size,
      totalCompactions: filtered.length,

      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      avgCompressionRatio: totalOutput > 0 ? totalInput / totalOutput : 0,
      p95CompressionRatio: ratios[Math.max(0, p95Index)] ?? ratios[ratios.length - 1] ?? 0,

      avgChunkCount: filtered.reduce((sum, e) => sum + e.chunkCount, 0) / filtered.length,
      avgChunkTokens: filtered.reduce((sum, e) => sum + e.avgChunkTokens, 0) / filtered.length,
      totalOversized: filtered.reduce((sum, e) => sum + e.oversizedCount, 0),

      avgDurationMs: durations.reduce((sum, d) => sum + d, 0) / durations.length,
      p95DurationMs: durations[Math.max(0, p95Index)] ?? durations[durations.length - 1] ?? 0,
      parallelUsageRate: filtered.filter((e) => e.parallelUsed).length / filtered.length,

      fallbackRate: filtered.filter((e) => e.fallbackUsed).length / filtered.length,
      errorRate: filtered.filter((e) => e.errorCount > 0).length / filtered.length,
      avgDroppedMessages: filtered.reduce((sum, e) => sum + e.droppedMessages, 0) / filtered.length,
      avgDroppedTokens: filtered.reduce((sum, e) => sum + e.droppedTokens, 0) / filtered.length,
    };
  }

  /**
   * 格式化统计报告
   */
  formatReport(stats: CompactionAggregatedStats): string {
    const lines = [
      "=== Compaction Metrics Report ===",
      "",
      `Time Range: ${new Date(stats.startMs).toISOString()} - ${new Date(stats.endMs).toISOString()}`,
      `Sessions: ${stats.sessionCount} | Compactions: ${stats.totalCompactions}`,
      "",
      "--- Token Statistics ---",
      `Input Tokens:  ${stats.totalInputTokens.toLocaleString()}`,
      `Output Tokens: ${stats.totalOutputTokens.toLocaleString()}`,
      `Compression:   ${(stats.avgCompressionRatio * 100).toFixed(1)}% avg | ${(stats.p95CompressionRatio * 100).toFixed(1)}% p95`,
      "",
      "--- Chunk Statistics ---",
      `Avg Chunks:    ${stats.avgChunkCount.toFixed(1)}`,
      `Avg Chunk Size: ${stats.avgChunkTokens.toFixed(0)} tokens`,
      `Oversized:     ${stats.totalOversized}`,
      "",
      "--- Performance ---",
      `Avg Duration:  ${stats.avgDurationMs.toFixed(0)}ms`,
      `P95 Duration:  ${stats.p95DurationMs.toFixed(0)}ms`,
      `Parallel Rate: ${(stats.parallelUsageRate * 100).toFixed(1)}%`,
      "",
      "--- Quality ---",
      `Fallback Rate: ${(stats.fallbackRate * 100).toFixed(1)}%`,
      `Error Rate:    ${(stats.errorRate * 100).toFixed(1)}%`,
      `Avg Dropped:   ${stats.avgDroppedMessages.toFixed(1)} msgs / ${stats.avgDroppedTokens.toFixed(0)} tokens`,
    ];

    return lines.join("\n");
  }

  /**
   * 清除所有记录
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * 获取原始记录（用于导出）
   */
  getEntries(): CompactionMetricEntry[] {
    return [...this.entries];
  }

  /**
   * 启用/禁用收集
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// 全局单例
let globalCollector: CompactionMetricsCollector | null = null;

/**
 * 获取全局压缩指标收集器
 */
export function getCompactionMetricsCollector(): CompactionMetricsCollector {
  if (!globalCollector) {
    globalCollector = new CompactionMetricsCollector();
  }
  return globalCollector;
}

/**
 * 配置全局收集器
 */
export function configureCompactionMetrics(options?: {
  maxEntries?: number;
  enabled?: boolean;
}): void {
  globalCollector = new CompactionMetricsCollector(options);
}

/**
 * 辅助函数：计算压缩指标
 */
export function computeCompactionMetrics(params: {
  inputMessages: AgentMessage[];
  outputSummary: string;
  estimateTokens: (msg: AgentMessage | string) => number;
  chunkCount: number;
  oversizedCount: number;
  durationMs: number;
  parallelUsed: boolean;
  fallbackUsed: boolean;
  errorCount: number;
  droppedMessages: number;
  droppedTokens: number;
}): {
  inputTokens: number;
  outputTokens: number;
  compressionRatio: number;
  avgChunkTokens: number;
  maxChunkTokens: number;
} {
  const inputTokens = params.inputMessages.reduce(
    (sum, msg) => sum + params.estimateTokens(msg),
    0,
  );
  const outputTokens = params.estimateTokens(params.outputSummary);
  const compressionRatio = outputTokens > 0 ? inputTokens / outputTokens : 0;

  // 计算平均和最大分块大小
  const chunkSizes = params.inputMessages.map((m) => params.estimateTokens(m));
  const avgChunkTokens =
    chunkSizes.length > 0 ? chunkSizes.reduce((a, b) => a + b, 0) / chunkSizes.length : 0;
  const maxChunkTokens = chunkSizes.length > 0 ? Math.max(...chunkSizes) : 0;

  return {
    inputTokens,
    outputTokens,
    compressionRatio,
    avgChunkTokens,
    maxChunkTokens,
  };
}
