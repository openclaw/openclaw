/**
 * llm-context-builder.ts — 信息流驱动的 LLM 上下文构建器
 *
 * 核心思想：弱模型 + 丰富上下文 ≈ 强模型效果
 *
 * 该模块接受 Playbook 步骤元数据和预计算的 ContextPacket，
 * 将相关上下文片段（领域知识、历史案例、实体信息等）注入提示，
 * 并根据注入量建议下游模型路由器选择合适的模型层级。
 *
 * 设计原则：
 *   - 纯函数逻辑：无 I/O，仅对传入数据做变换，可在任意环境中测试
 *   - 依赖注入：知识库检索、日志等由调用方注入（`LlmContextBuilderDeps`）
 *   - 可选依赖：所有 deps 字段均可选，缺失时退化为透传模式（无副作用）
 */

import type { ContextPacket } from "./event-context.js";

/** LLM 上下文丰富度级别 */
export type ContextLevel = "fast" | "standard" | "rich";

/** 推荐的模型层级（给 ModelRouter 参考） */
export type ModelTier = "fast" | "default" | "strong";

/** buildLlmContext 的输入 */
export type LlmContextInput = {
  /** 原始提示（来自 Playbook 步骤插值后的 prompt 字段） */
  prompt: string;
  /** 任务类型（影响上下文注入策略） */
  task_type?: "classify" | "extract" | "generate" | "analyze" | "chat";
  /** 显式领域提示（优先于 event_context.inferred_domain） */
  domain?: string;
  /** 显式上下文级别（优先于自动推断） */
  context_level?: ContextLevel;
  /** 期望的输出字段列表（用于生成格式提示） */
  output_fields?: string[];
  /** 预计算的事件上下文封包 */
  event_context?: ContextPacket;
};

/** buildLlmContext 的结果 */
export type LlmContextResult = {
  /** 注入了上下文片段后的增强提示 */
  enriched_prompt: string;
  /** 实际注入的案例数 */
  injected_cases: number;
  /** 基于注入量给出的推荐模型层级 */
  recommended_model_tier: ModelTier;
  /** 最终确定的上下文级别 */
  effective_context_level: ContextLevel;
};

/** 可注入的外部依赖（均为可选） */
export type LlmContextBuilderDeps = {
  /** 结构化日志函数 */
  logger?: (msg: string) => void;
  /**
   * 案例知识库检索函数（可选）。
   * 接受查询字符串，返回最多 `limit` 条案例摘要。
   */
  fetchCases?: (query: string, limit: number) => Promise<string[]>;
  /**
   * 领域知识片段检索函数（可选）。
   * 接受领域名称，返回补充说明文本（最多 512 tokens 建议）。
   */
  fetchDomainKnowledge?: (domain: string) => Promise<string | null>;
};

// ──────────────────────────────────────────────────────────────
// 内部工具函数
// ──────────────────────────────────────────────────────────────

function inferContextLevel(input: LlmContextInput): ContextLevel {
  if (input.context_level) return input.context_level;
  if (input.task_type === "classify") return "fast";
  if (input.task_type === "analyze" || input.task_type === "generate") return "rich";
  return "standard";
}

function buildEntitySummary(packet: ContextPacket): string | null {
  if (!packet.entities?.length) return null;
  const parts = packet.entities.slice(0, 5).map((e) => `${e.type}:${e.name ?? e.id}`);
  return `关联实体: ${parts.join(", ")}`;
}

function buildMetaStatusSummary(meta: Record<string, unknown>): string | null {
  const pendingRuns = meta.pending_runs;
  const playbookCount = meta.playbook_count;
  const hasPending = typeof pendingRuns === "number";
  const hasPlaybooks = typeof playbookCount === "number";
  if (!hasPending && !hasPlaybooks) return null;

  const parts: string[] = [];
  if (hasPending) parts.push(`运行中 Playbook ${pendingRuns} 个`);
  if (hasPlaybooks) parts.push(`共 ${playbookCount} 个 Playbook`);
  return `系统状态: ${parts.join(", ")}`;
}

// ──────────────────────────────────────────────────────────────
// 主函数
// ──────────────────────────────────────────────────────────────

/**
 * 构建增强后的 LLM 上下文提示。
 *
 * 在 context_level=fast 时直接透传；
 * standard/rich 时按能力逐步注入领域知识、案例、实体信息、格式要求。
 */
export async function buildLlmContext(
  input: LlmContextInput,
  deps: LlmContextBuilderDeps = {},
): Promise<LlmContextResult> {
  const contextLevel = inferContextLevel(input);
  const domain = input.domain ?? input.event_context?.inferred_domain;

  // fast 模式：不注入任何上下文，直接返回
  if (contextLevel === "fast") {
    deps.logger?.(`[llm-ctx] fast mode, no injection. domain=${domain ?? "none"}`);
    return {
      enriched_prompt: input.prompt,
      injected_cases: 0,
      recommended_model_tier: "fast",
      effective_context_level: "fast",
    };
  }

  const injectedParts: string[] = [];

  // 1. 事件摘要（预计算）
  if (input.event_context?.pre_summary) {
    injectedParts.push(`事件摘要: ${input.event_context.pre_summary}`);
  } else if (contextLevel === "rich" && input.event_context?.meta) {
    const metaSummary = buildMetaStatusSummary(input.event_context.meta);
    if (metaSummary) injectedParts.push(metaSummary);
  }

  // 2. 关联实体
  if (input.event_context) {
    const entitySummary = buildEntitySummary(input.event_context);
    if (entitySummary) injectedParts.push(entitySummary);
  }

  // 3. 领域知识（rich 模式 + 有 fetchDomainKnowledge）
  if (contextLevel === "rich" && domain && deps.fetchDomainKnowledge) {
    try {
      const knowledge = await deps.fetchDomainKnowledge(domain);
      if (knowledge) injectedParts.push(`领域知识 [${domain}]: ${knowledge}`);
    } catch {
      deps.logger?.(`[llm-ctx] fetchDomainKnowledge failed, skipping.`);
    }
  }

  // 4. 历史案例（rich 模式 + 有 fetchCases）
  let injectedCases = 0;
  if (contextLevel === "rich" && deps.fetchCases) {
    const query = [
      input.prompt.slice(0, 200),
      input.event_context?.keywords?.slice(0, 5).join(" ") ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    try {
      const caseLimit = 3;
      const cases = await deps.fetchCases(query, caseLimit);
      if (cases.length > 0) {
        injectedCases = cases.length;
        injectedParts.push(
          `参考案例 (${cases.length}):\n${cases.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`,
        );
      }
    } catch {
      deps.logger?.(`[llm-ctx] fetchCases failed, skipping.`);
    }
  }

  // 5. 输出字段格式要求
  if (input.output_fields?.length) {
    injectedParts.push(`期望输出字段: ${input.output_fields.join(", ")}`);
  }

  // 组装增强提示
  let enrichedPrompt = input.prompt;
  if (injectedParts.length > 0) {
    enrichedPrompt = `${injectedParts.join("\n")}\n\n---\n\n${input.prompt}`;
  }

  // 推荐模型层级：注入案例 ≥2 时可降级以节省成本
  const recommendedModelTier: ModelTier =
    injectedCases >= 2 ? "default" : contextLevel === "rich" ? "strong" : "default";

  deps.logger?.(
    `[llm-ctx] level=${contextLevel} domain=${domain ?? "none"} cases=${injectedCases} tier=${recommendedModelTier}`,
  );

  return {
    enriched_prompt: enrichedPrompt,
    injected_cases: injectedCases,
    recommended_model_tier: recommendedModelTier,
    effective_context_level: contextLevel,
  };
}
