/**
 * event-context.ts — 事件上下文封包 (ContextPacket)
 *
 * 由摄入层（ingress）或信息流处理管道预计算，注入 Playbook 变量 `_ctx`，
 * 供 step-executor 的信息流丰富化模块消费。
 */

export type InferredDomain =
  | "alarm"
  | "production"
  | "quality"
  | "maintenance"
  | "logistics"
  | "energy"
  | "safety"
  | "it"
  | "hr"
  | string;

export type ContextSentiment = "normal" | "warning" | "critical" | "recovery";

export type ContextEntity = {
  type: "device" | "line" | "order" | "user" | "location" | string;
  id: string;
  name?: string;
  attributes?: Record<string, unknown>;
};

/**
 * 预计算的事件上下文封包，由 Playbook 引擎注入变量 `_ctx`。
 *
 * 字段均为可选——摄入层可按能力逐步填充；
 * step-executor 仅在字段存在时才利用它们增强 LLM 提示。
 */
export type ContextPacket = {
  /** 推断的业务领域 */
  inferred_domain?: InferredDomain;
  /** 情感/严重程度分类 */
  sentiment?: ContextSentiment;
  /** 事件来源标识 */
  source_id?: string;
  /** 原始事件时间戳（ms epoch） */
  event_ts?: number;
  /** 关联实体列表 */
  entities?: ContextEntity[];
  /** 摄入层提取的关键词，供 LLM 上下文注入 */
  keywords?: string[];
  /** 摄入层提供的预摘要（可选，减少 LLM token 消耗） */
  pre_summary?: string;
  /** 历史案例标识列表（由知识库检索填充） */
  similar_case_ids?: string[];
  /** 额外的任意元数据 */
  meta?: Record<string, unknown>;
};
