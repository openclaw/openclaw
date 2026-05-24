/**
 * event-context.ts — 事件上下文封包 (ContextPacket) + 自动预计算
 *
 * 设计原则：
 *   - `ContextPacket` 是跨层传递的数据契约（摄入层→Playbook→step-executor）
 *   - `buildEventContext` 是纯函数：给定原始 payload，无需 I/O 即可推断领域、
 *     提取实体、判断情感、提取关键词——在 Playbook 初始化时零成本运行
 *   - 摄入层如果有更精确的信息（如已分类的 domain/severity），可直接
 *     在 payload 中携带，buildEventContext 会优先使用显式字段
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

// ─────────────────────────────────────────────────────────────────────────────
// buildEventContext — 纯函数，从原始事件 payload 自动提取 ContextPacket
// ─────────────────────────────────────────────────────────────────────────────

const DOMAIN_PATTERNS: Array<{ re: RegExp; domain: InferredDomain }> = [
  { re: /alarm|报警|告警|故障|设备异常/i, domain: "alarm" },
  { re: /quality|质量|检测|不良|缺陷|良品/i, domain: "quality" },
  { re: /maintenance|维修|保养|维护|巡检/i, domain: "maintenance" },
  { re: /logistics|物流|发货|收货|运输|仓储/i, domain: "logistics" },
  { re: /energy|能耗|电力|用电|水耗|gas|燃气/i, domain: "energy" },
  { re: /safety|安全|事故|危险|隐患/i, domain: "safety" },
  { re: /hr|人事|员工|考勤|绩效|招聘/i, domain: "hr" },
  { re: /it|系统|网络|服务器|数据库|接口/i, domain: "it" },
  { re: /production|生产|排产|工单|产线|工序/i, domain: "production" },
];

const CRITICAL_RE = /critical|紧急|P0|严重|重大|danger|危急|大量/i;
const WARNING_RE = /warning|警告|P1|异常|超标|偏差|注意/i;
const RECOVERY_RE = /recovery|恢复|解除|resolved|正常|已处理/i;

/** 从 payload 中提取文本用于分析 */
function extractText(payload: Record<string, unknown>): string {
  const candidates = ["content", "text", "message", "description", "body", "summary"];
  return candidates
    .map((k) => (typeof payload[k] === "string" ? (payload[k] as string) : ""))
    .join(" ")
    .trim();
}

/** 根据事件类型前缀快速推断领域 */
function domainFromEventType(eventType: string): InferredDomain | undefined {
  if (eventType.startsWith("alarm.")) return "alarm";
  if (eventType.startsWith("work_order.")) return "production";
  if (eventType.startsWith("task.")) return undefined; // 不确定，继续看内容
  if (eventType.startsWith("report.")) return undefined;
  return undefined;
}

/** 从文本内容推断领域 */
function domainFromText(text: string): InferredDomain | undefined {
  for (const { re, domain } of DOMAIN_PATTERNS) {
    if (re.test(text)) return domain;
  }
  return undefined;
}

/** 推断情感/严重程度 */
function inferSentiment(payload: Record<string, unknown>, text: string): ContextSentiment {
  const severity = String(payload["severity"] ?? payload["level"] ?? payload["priority"] ?? "");
  if (/critical|p0|high|紧急|严重/i.test(severity) || CRITICAL_RE.test(text)) return "critical";
  if (/warning|p1|medium|警告|异常/i.test(severity) || WARNING_RE.test(text)) return "warning";
  if (RECOVERY_RE.test(text) || RECOVERY_RE.test(severity)) return "recovery";
  return "normal";
}

/** 从 payload 已知字段提取业务实体 */
function extractEntities(payload: Record<string, unknown>): ContextEntity[] {
  const entities: ContextEntity[] = [];
  const add = (type: ContextEntity["type"], idKey: string, nameKey?: string) => {
    const id = payload[idKey];
    if (typeof id === "string" && id) {
      entities.push({
        type,
        id,
        name:
          nameKey && typeof payload[nameKey] === "string"
            ? (payload[nameKey] as string)
            : undefined,
      });
    }
  };
  add("device", "device_id", "device_name");
  add("line", "line_id", "line_name");
  add("order", "order_id", "order_no");
  add("user", "user_id", "user_name");
  add("user", "sender_id", "sender_name");
  add("location", "location_id", "location");
  return entities;
}

/** 从文本提取关键词（粗粒度，仅去重+截断） */
function extractKeywords(text: string, limit = 10): string[] {
  const tokens = text
    .split(/[\s,，。！？、：；\n\r]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 20);
  return [...new Set(tokens)].slice(0, limit);
}

/**
 * 从原始 Playbook 触发 payload 自动预计算 ContextPacket。
 *
 * 纯函数：无 I/O、无副作用，在 Playbook 初始化时同步执行。
 * 摄入层若已携带 `_ctx` 字段，则直接沿用（优先显式）。
 *
 * @param payload  Playbook 触发的原始输入对象
 * @param eventType  触发事件类型（如 "alarm.created"），可选
 */
export function buildEventContext(
  payload: Record<string, unknown>,
  eventType?: string,
): ContextPacket {
  // 若摄入层已携带完整 _ctx，直接沿用
  if (payload["_ctx"] && typeof payload["_ctx"] === "object") {
    return payload["_ctx"] as ContextPacket;
  }

  const text = extractText(payload);
  const entities = extractEntities(payload);
  const keywords = extractKeywords(text);

  const inferred_domain: InferredDomain | undefined =
    (typeof payload["domain"] === "string" ? payload["domain"] : undefined) ??
    (eventType ? domainFromEventType(eventType) : undefined) ??
    domainFromText(text);

  const pendingRuns = typeof payload.pending_runs === "number" ? payload.pending_runs : undefined;
  const playbookCount =
    typeof payload.playbook_count === "number" ? payload.playbook_count : undefined;
  const robotId = typeof payload.robot_id === "string" ? payload.robot_id : undefined;

  let sentiment = inferSentiment(payload, text);
  if (sentiment === "normal" && pendingRuns !== undefined && pendingRuns > 5) {
    sentiment = "warning";
  }

  const source_id =
    (typeof payload["source"] === "string" ? payload["source"] : undefined) ??
    (typeof payload["channel_id"] === "string" ? payload["channel_id"] : undefined) ??
    (typeof payload["source_id"] === "string" ? payload["source_id"] : undefined);

  const raw_ts = payload["timestamp"] ?? payload["ts"] ?? payload["event_ts"];
  const event_ts =
    typeof raw_ts === "number"
      ? raw_ts
      : typeof raw_ts === "string"
        ? Date.parse(raw_ts) || undefined
        : undefined;

  const ctx: ContextPacket = {};
  if (inferred_domain) ctx.inferred_domain = inferred_domain;
  if (sentiment !== "normal") ctx.sentiment = sentiment;
  if (source_id) ctx.source_id = source_id;
  if (event_ts) ctx.event_ts = event_ts;
  if (entities.length) ctx.entities = entities;
  if (keywords.length) ctx.keywords = keywords;
  const meta: Record<string, unknown> = {};
  if (pendingRuns !== undefined) meta.pending_runs = pendingRuns;
  if (playbookCount !== undefined) meta.playbook_count = playbookCount;
  if (robotId) meta.robot_id = robotId;
  if (Object.keys(meta).length) ctx.meta = meta;
  return ctx;
}
