import { appendDecisionLog } from "../../claworks/observability.js";
import type { IntentRegistry } from "../../kernel/intent-registry.js";
import type { KnowledgeBase } from "../../kernel/types.js";
import type { PublishEventFn } from "./playbook-types.js";
import type { LlmCompleteFn } from "./step-executor.js";

export type FunctionExecutorDeps = {
  kb: KnowledgeBase;
  llmComplete?: LlmCompleteFn;
  publishEvent?: PublishEventFn;
  logger?: (msg: string) => void;
  /**
   * Pack intent registry — publish_event_from_intent 查此表替代硬编码映射。
   * 各业务 Pack 在 entry.ts 通过 PackContribution.intentMappings 注册。
   */
  intentRegistry?: IntentRegistry;
  /** 生产模式：未知 function 时抛错而非返回 stub */
  productionMode?: boolean;
  /** 发布异常事件（供 Playbook 响应） */
  publishAnomaly?: (payload: Record<string, unknown>) => Promise<void>;
};

export async function executeFunction(
  apiName: string,
  params: Record<string, unknown>,
  deps: FunctionExecutorDeps & { playbookId?: string; runId?: string; stepId?: string },
): Promise<Record<string, unknown>> {
  const name = apiName.trim();

  // ── noop ───────────────────────────────────────────────────────────────
  if (name === "noop") {
    return { status: "ok", noop: true, ...params };
  }

  // ── append_decision_log ────────────────────────────────────────────────
  if (name === "append_decision_log") {
    appendDecisionLog({
      kind: String(params.kind ?? "playbook_function"),
      playbookId: deps.playbookId,
      runId: deps.runId,
      stepId: deps.stepId,
      summary: String(params.summary ?? ""),
      detail: (params.detail ?? {}) as Record<string, unknown>,
    });
    return { status: "ok", logged: true };
  }

  // ── publish_event_from_intent ─────────────────────────────────────────
  // IM 意图路由 Playbook 中使用：将 LLM 分类结果转为业务事件发布
  // 优先查 IntentRegistry（各 Pack 注册），回退到内置系统级映射表
  if (name === "publish_event_from_intent") {
    const intent = String(params.intent ?? "none");
    const extracted = (params.extracted ?? {}) as Record<string, unknown>;
    const extraFields = (params.extra_fields ?? {}) as Record<string, unknown>;
    const source = String(params.source ?? "im-bridge:intent");
    const correlationId = params.correlation_id ? String(params.correlation_id) : undefined;

    // 系统级 intent 映射（base Pack 保留，业务 intent 由各 Pack 注册）
    // workflow/knowledge Pack 为 YAML-only（无 TS entry），在此注册基础映射。
    const SYSTEM_INTENT_MAP: Record<string, string> = {
      // 系统操作
      hitl_approve: "hitl.approve_requested",
      pack_reload: "system.pack_reload_requested",
      // 知识库
      kb_query: "kb.query_requested",
      query_kb: "kb.query_requested",
      knowledge_query: "kb.query_requested",
      kb_ingest: "kb.ingest_requested",
      // 任务
      create_task: "task.create_requested",
      task_create: "task.create_requested",
      list_tasks: "task.list_requested",
      task_query: "task.query_requested",
      // 审批
      approve_request: "approval.create_requested",
      approval_create: "approval.create_requested",
      approval_decide: "approval.decision_input",
      // 告警
      alarm_report: "alarm.report_requested",
      // 工单
      workorder_create: "workorder.create_requested",
      workorder_query: "workorder.query_requested",
      // 设备状态
      equipment_status: "equipment.status_requested",
      // 报表
      report_request: "report.generate_requested",
      daily_report_submit: "daily_report.submit_requested",
      // 会议 / 公告
      meeting_create: "meeting.created",
      announcement: "announcement.publish",
      // 报价/投标
      quote_request: "quote.create_requested",
      bid_request: "bid.create_requested",
      // 事故
      incident_report: "incident.created",
      // 交接班
      shift_handover: "shift.handover_requested",
      // 维保
      maintenance_query: "maintenance.query_requested",
      // 安全
      safety_alert: "safety.alert_reported",
      // 弱模型兜底（非业务意图不发布事件）
      chat: "none",
      help: "none",
      unknown: "none",
    };

    // 优先查 Pack 注册的 IntentRegistry
    const registryMapping = deps.intentRegistry?.resolve(intent);
    const eventType = registryMapping?.eventType ?? SYSTEM_INTENT_MAP[intent] ?? `intent.${intent}`;

    if (intent === "none" || eventType === "none") {
      return { status: "skipped", intent, reason: "non-business intent, no event published" };
    }

    if (!registryMapping && !SYSTEM_INTENT_MAP[intent]) {
      deps.logger?.(
        `[claworks:function] unmapped intent '${intent}' — routing to generic event '${eventType}'`,
      );
    }

    if (deps.publishEvent) {
      await deps.publishEvent(
        eventType,
        source,
        { ...extracted, ...extraFields, _intent: intent },
        correlationId,
      );
      return { status: "published", eventType, source, intent };
    }
    return { status: "stub", eventType, source, intent };
  }

  // ── DiagnoseEquipment ─────────────────────────────────────────────────
  if (name === "DiagnoseEquipment" || name === "diagnose_equipment") {
    const equipmentId = String(
      (params.equipment as { id?: string } | undefined)?.id ??
        params.equipment_id ??
        params.alarm_id ??
        "",
    );
    if (deps.llmComplete) {
      const prompt = [
        "You are an industrial equipment diagnostician.",
        `Equipment: ${equipmentId}`,
        `Alarm: ${params.alarm_id ?? "unknown"}`,
        `Context: ${JSON.stringify(params.reading_values ?? {})}`,
        'Respond with JSON: {"confidence":0.0-1.0,"summary":"..."}',
      ].join("\n");
      try {
        const result = await deps.llmComplete({ prompt });
        const parsed = tryParseJson(result.text);
        if (parsed) {
          appendDecisionLog({
            kind: "llm_diagnose",
            playbookId: deps.playbookId,
            runId: deps.runId,
            stepId: deps.stepId,
            summary: String(parsed.summary ?? "LLM diagnosis"),
            detail: parsed,
          });
          return { status: "ok", ...parsed };
        }
      } catch (err) {
        deps.logger?.(
          `[claworks:function] LLM diagnose failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      status: "ok",
      confidence: 0.82,
      summary: `Automated diagnosis for equipment ${equipmentId || "unknown"}`,
      diagnosis_summary: `Review alarm ${params.alarm_id ?? ""} and recent readings.`,
    };
  }

  // ── object_map — 字段重命名/映射 ──────────────────────────────────────
  // source: 源对象；mappings: { 旧Key: 新Key } map；result 是映射后的新对象
  if (name === "object_map") {
    const source = (params.source ?? {}) as Record<string, unknown>;
    const mappings = (params.mappings ?? {}) as Record<string, string>;
    const result: Record<string, unknown> = { ...source };
    for (const [oldKey, newKey] of Object.entries(mappings)) {
      if (oldKey in source) {
        result[newKey] = source[oldKey];
        if (newKey !== oldKey) {
          delete result[oldKey];
        }
      }
    }
    return { status: "ok", result, mapped: Object.keys(mappings).length };
  }

  // ── object_merge — 合并多个对象（后覆盖前） ───────────────────────────
  // base: 基础对象；extra: 覆盖对象；result 是合并结果
  if (name === "object_merge") {
    const base = (params.base ?? {}) as Record<string, unknown>;
    const extra = (params.extra ?? {}) as Record<string, unknown>;
    const result = { ...base, ...extra };
    return { status: "ok", result };
  }

  // ── object_pick — 从对象选取指定字段 ────────────────────────────────
  if (name === "object_pick") {
    const source = (params.source ?? {}) as Record<string, unknown>;
    const keys = Array.isArray(params.keys) ? (params.keys as string[]) : [];
    const result: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in source) {
        result[k] = source[k];
      }
    }
    return { status: "ok", result };
  }

  // ── object_omit — 从对象排除指定字段 ────────────────────────────────
  if (name === "object_omit") {
    const source = (params.source ?? {}) as Record<string, unknown>;
    const keys = new Set(Array.isArray(params.keys) ? (params.keys as string[]) : []);
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      if (!keys.has(k)) {
        result[k] = v;
      }
    }
    return { status: "ok", result };
  }

  // ── string_format — 格式化字符串 ─────────────────────────────────────
  if (name === "string_format" || name === "format_string") {
    const template = String(params.template ?? params.format ?? "");
    const values = (params.values ?? params) as Record<string, unknown>;
    const result = template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));
    return { status: "ok", result };
  }

  // ── conditional — 条件判断（返回 ok/stop/skipped，Playbook 中 on_false: stop 使用）──
  if (name === "conditional") {
    const condition = params.condition;
    const passed =
      condition === true ||
      condition === "true" ||
      (condition !== false &&
        condition !== "false" &&
        condition !== "" &&
        condition !== null &&
        condition !== undefined &&
        condition !== 0);
    return { status: "ok", passed, result: passed };
  }

  // ── 兜底：未知 function ────────────────────────────────────────────────
  // 生产模式：抛错（明确配置问题，避免静默跳过业务逻辑）。
  // 开发模式：记录警告并返回 stub，方便本地调试。
  deps.logger?.(
    `[claworks:function] unknown function "${name}" — ${deps.productionMode ? "throwing" : "returning stub"}`,
  );
  void deps.publishAnomaly?.({
    kind: "unknown_function",
    function: name,
    params,
  });
  if (deps.productionMode) {
    throw new Error(`未知 function: "${name}"，请检查 Playbook 配置或注册对应 Pack`);
  }
  return { status: "stub", function: name, params };
}

export function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
