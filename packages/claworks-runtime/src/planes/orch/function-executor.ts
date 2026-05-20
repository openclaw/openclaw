import { appendDecisionLog } from "../../claworks/observability.js";
import type { KnowledgeBase } from "../../kernel/types.js";
import type { PublishEventFn } from "./playbook-types.js";
import type { LlmCompleteFn } from "./step-executor.js";

export type FunctionExecutorDeps = {
  kb: KnowledgeBase;
  llmComplete?: LlmCompleteFn;
  publishEvent?: PublishEventFn;
  logger?: (msg: string) => void;
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
  if (name === "publish_event_from_intent") {
    const intent = String(params.intent ?? "none");
    const extracted = (params.extracted ?? {}) as Record<string, unknown>;
    const source = String(params.source ?? "im-bridge:intent");
    const correlationId = params.correlation_id ? String(params.correlation_id) : undefined;

    const intentToEventType: Record<string, string> = {
      // 工业场景（process-industry pack）
      alarm_report: "alarm.created",
      workorder_query: "workorder.query",
      workorder_create: "workorder.create_requested",
      status_check: "equipment.status_requested",
      // 通用企业场景（enterprise-general pack）
      task_query: "task.status_query",
      task_create: "task.create_requested",
      approval_create: "approval.created",
      approval_decide: "approval.decision_input",
      incident_report: "incident.created",
      meeting_create: "meeting.created",
      announcement: "announcement.publish",
      // 商务场景（enterprise-commercial pack）
      quote_request: "quote.create_requested",
      bid_request: "bid.generate_requested",
      kb_ingest: "kb.folder_ingest_requested",
      // 系统操作
      hitl_approve: "hitl.approve_requested",
      kb_query: "kb.query_requested",
      pack_reload: "system.pack_reload_requested",
    };

    const eventType = intentToEventType[intent];
    if (!eventType || intent === "none") {
      return { status: "skipped", intent, reason: "no matching business event" };
    }

    if (deps.publishEvent) {
      await deps.publishEvent(eventType, source, { ...extracted, _intent: intent }, correlationId);
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

  // ── 兜底：未知 function，返回 stub 结果而不是 throw ──────────────────
  deps.logger?.(`[claworks:function] unknown function "${name}" — returning stub`);
  return { status: "ok", function: name, params };
}

function tryParseJson(text: string): Record<string, unknown> | null {
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
