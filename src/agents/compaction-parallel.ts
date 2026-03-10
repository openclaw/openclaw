/**
 * Parallel Compaction - 并行上下文压缩处理器
 *
 * 将压缩任务并行化，提升大上下文的压缩性能：
 * - 并行分块压缩
 * - 智能合并策略
 * - 超时控制
 * - 错误隔离
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { estimateTokens, generateSummary } from "@mariozechner/pi-coding-agent";
import { computeCompactionMetrics, getCompactionMetricsCollector } from "./compaction-metrics.js";
import { chunkMessagesByMaxTokens, estimateMessagesTokens } from "./compaction.js";

const MERGE_SUMMARIES_INSTRUCTIONS =
  "Merge these partial summaries into a single cohesive summary. " +
  "Preserve decisions, TODOs, open questions, and any constraints. " +
  "Remove redundancy while keeping key information.";

const DEFAULT_SUMMARY_FALLBACK = "No prior history.";

/**
 * 并行压缩配置
 */
export type ParallelCompactionConfig = {
  // 最大并行度
  maxConcurrency: number;
  // 单个压缩任务超时(ms)
  taskTimeoutMs: number;
  // 最小分块数才启用并行
  minChunksForParallel: number;
  // 是否启用
  enabled: boolean;
};

const DEFAULT_PARALLEL_CONFIG: ParallelCompactionConfig = {
  maxConcurrency: 4,
  taskTimeoutMs: 60_000,
  minChunksForParallel: 2,
  enabled: true,
};

/**
 * 单个分块的压缩结果
 */
type ChunkSummaryResult = {
  chunkIndex: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: Error;
};

/**
 * 并行压缩多个分块
 */
async function summarizeChunksParallel(
  chunks: AgentMessage[][],
  params: {
    model: NonNullable<ExtensionContext["model"]>;
    apiKey: string;
    signal: AbortSignal;
    reserveTokens: number;
    customInstructions?: string;
    previousSummary?: string;
    config: ParallelCompactionConfig;
  },
): Promise<ChunkSummaryResult[]> {
  const { maxConcurrency, taskTimeoutMs } = params.config;
  const results: ChunkSummaryResult[] = [];

  // 分批处理，控制并发度
  for (let i = 0; i < chunks.length; i += maxConcurrency) {
    const batch = chunks.slice(i, i + maxConcurrency);

    // 并行处理当前批次
    const batchPromises = batch.map(async (chunk, batchIndex) => {
      const chunkIndex = i + batchIndex;
      const startTime = Date.now();
      const inputTokens = estimateMessagesTokens(chunk);

      try {
        // 创建带超时的 AbortController
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), taskTimeoutMs);

        // 支持外部取消
        const abortHandler = () => timeoutController.abort();
        params.signal.addEventListener("abort", abortHandler);

        try {
          const summary = await generateSummary(
            chunk,
            params.model,
            params.reserveTokens,
            params.apiKey,
            timeoutController.signal,
            params.customInstructions,
            params.previousSummary,
          );

          const outputTokens = estimateTokens({
            role: "assistant",
            content: summary,
          } as unknown as AgentMessage);

          return {
            chunkIndex,
            summary,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - startTime,
          };
        } finally {
          clearTimeout(timeoutId);
          params.signal.removeEventListener("abort", abortHandler);
        }
      } catch (error) {
        return {
          chunkIndex,
          summary: `[Chunk ${chunkIndex} summarization failed]`,
          inputTokens,
          outputTokens: 0,
          durationMs: Date.now() - startTime,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // 检查是否被取消
    if (params.signal.aborted) {
      break;
    }
  }

  return results;
}

/**
 * 合并多个分块摘要
 */
async function mergeSummaries(
  summaries: string[],
  params: {
    model: NonNullable<ExtensionContext["model"]>;
    apiKey: string;
    signal: AbortSignal;
    reserveTokens: number;
    customInstructions?: string;
  },
): Promise<string> {
  if (summaries.length === 0) {
    return DEFAULT_SUMMARY_FALLBACK;
  }

  if (summaries.length === 1) {
    return summaries[0];
  }

  // 将摘要转换为消息格式
  const summaryMessages: AgentMessage[] = summaries.map((summary, index) => ({
    role: "user" as const,
    content: `Part ${index + 1}: ${summary}`,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return generateSummary(
    summaryMessages,
    params.model,
    params.reserveTokens,
    params.apiKey,
    params.signal,
    mergeInstructions,
  );
}

/**
 * 并行压缩入口函数
 */
export async function compactWithParallel(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow?: number;
  customInstructions?: string;
  previousSummary?: string;
  parallelConfig?: Partial<ParallelCompactionConfig>;
  sessionId: string;
  agentId?: string;
}): Promise<string> {
  const config: ParallelCompactionConfig = {
    ...DEFAULT_PARALLEL_CONFIG,
    ...params.parallelConfig,
  };

  const startTime = Date.now();

  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // 分块
  const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
  const shouldUseParallel = config.enabled && chunks.length >= config.minChunksForParallel;

  // 不需要并行时，串行处理
  if (!shouldUseParallel) {
    let summary = params.previousSummary;
    for (const chunk of chunks) {
      summary = await generateSummary(
        chunk,
        params.model,
        params.reserveTokens,
        params.apiKey,
        params.signal,
        params.customInstructions,
        summary,
      );
    }

    // 记录指标
    const metrics = computeCompactionMetrics({
      inputMessages: params.messages,
      outputSummary: summary ?? DEFAULT_SUMMARY_FALLBACK,
      estimateTokens: (msg) =>
        typeof msg === "string"
          ? estimateTokens({ role: "assistant", content: msg } as unknown as AgentMessage)
          : estimateTokens(msg),
      chunkCount: chunks.length,
      oversizedCount: 0,
      durationMs: Date.now() - startTime,
      parallelUsed: false,
      fallbackUsed: false,
      errorCount: 0,
      droppedMessages: 0,
      droppedTokens: 0,
    });

    getCompactionMetricsCollector().record({
      sessionId: params.sessionId,
      agentId: params.agentId,
      ...metrics,
      chunkCount: chunks.length,
      oversizedCount: 0,
      durationMs: Date.now() - startTime,
      parallelUsed: false,
      fallbackUsed: false,
      errorCount: 0,
      droppedMessages: 0,
      droppedTokens: 0,
    });

    return summary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // 并行处理
  const chunkResults = await summarizeChunksParallel(chunks, {
    ...params,
    config,
  });

  // 收集成功和失败的摘要
  const successSummaries: string[] = [];
  const errors: Error[] = [];

  for (const result of [...chunkResults].toSorted((a, b) => a.chunkIndex - b.chunkIndex)) {
    if (result.error) {
      errors.push(result.error);
    } else {
      successSummaries.push(result.summary);
    }
  }

  // 如果所有分块都失败了，回退到串行
  if (successSummaries.length === 0) {
    console.warn("All parallel chunks failed, falling back to sequential");
    let summary = params.previousSummary;
    for (const chunk of chunks) {
      summary = await generateSummary(
        chunk,
        params.model,
        params.reserveTokens,
        params.apiKey,
        params.signal,
        params.customInstructions,
        summary,
      );
    }

    const metrics = computeCompactionMetrics({
      inputMessages: params.messages,
      outputSummary: summary ?? DEFAULT_SUMMARY_FALLBACK,
      estimateTokens: (msg) =>
        typeof msg === "string"
          ? estimateTokens({ role: "assistant", content: msg } as unknown as AgentMessage)
          : estimateTokens(msg),
      chunkCount: chunks.length,
      oversizedCount: 0,
      durationMs: Date.now() - startTime,
      parallelUsed: true,
      fallbackUsed: true,
      errorCount: errors.length,
      droppedMessages: 0,
      droppedTokens: 0,
    });

    getCompactionMetricsCollector().record({
      sessionId: params.sessionId,
      agentId: params.agentId,
      ...metrics,
      chunkCount: chunks.length,
      oversizedCount: 0,
      durationMs: Date.now() - startTime,
      parallelUsed: true,
      fallbackUsed: true,
      errorCount: errors.length,
      droppedMessages: 0,
      droppedTokens: 0,
    });

    return summary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // 合并摘要
  const mergedSummary = await mergeSummaries(successSummaries, params);

  // 记录指标
  const metrics = computeCompactionMetrics({
    inputMessages: params.messages,
    outputSummary: mergedSummary,
    estimateTokens: (msg) =>
      typeof msg === "string"
        ? estimateTokens({ role: "assistant", content: msg } as unknown as AgentMessage)
        : estimateTokens(msg),
    chunkCount: chunks.length,
    oversizedCount: 0,
    durationMs: Date.now() - startTime,
    parallelUsed: true,
    fallbackUsed: false,
    errorCount: errors.length,
    droppedMessages: 0,
    droppedTokens: 0,
  });

  getCompactionMetricsCollector().record({
    sessionId: params.sessionId,
    agentId: params.agentId,
    ...metrics,
    chunkCount: chunks.length,
    oversizedCount: 0,
    durationMs: Date.now() - startTime,
    parallelUsed: true,
    fallbackUsed: errors.length > 0,
    errorCount: errors.length,
    droppedMessages: 0,
    droppedTokens: 0,
  });

  return mergedSummary;
}

/**
 * 检测是否适合并行压缩
 */
export function shouldUseParallelCompaction(
  messages: AgentMessage[],
  config: ParallelCompactionConfig,
  maxChunkTokens: number,
): boolean {
  if (!config.enabled) {
    return false;
  }

  const totalTokens = estimateMessagesTokens(messages);
  const estimatedChunks = Math.ceil(totalTokens / maxChunkTokens);

  return estimatedChunks >= config.minChunksForParallel;
}
