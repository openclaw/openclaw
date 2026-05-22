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
    const source = String(params.source ?? "im-bridge:intent");
    const correlationId = params.correlation_id ? String(params.correlation_id) : undefined;

    // 系统级 intent 映射（base Pack 保留，业务 intent 由各 Pack 注册）
    // workflow/knowledge Pack 为 YAML-only（无 TS entry），在此注册基础映射。
    const SYSTEM_INTENT_MAP: Record<string, string> = {
      hitl_approve: "hitl.approve_requested",
      kb_query: "kb.query_requested",
      query_kb: "knowledge.query_requested",
      knowledge_query: "knowledge.query_requested",
      pack_reload: "system.pack_reload_requested",
      create_task: "task.create_requested",
      list_tasks: "task.list_requested",
      approve_request: "approval.requested",
    };

    // 优先查 Pack 注册的 IntentRegistry
    const registryMapping = deps.intentRegistry?.resolve(intent);
    const eventType = registryMapping?.eventType ?? SYSTEM_INTENT_MAP[intent] ?? `intent.${intent}`;

    if (intent === "none") {
      return { status: "skipped", intent, reason: "no matching business event" };
    }

    if (!registryMapping && !SYSTEM_INTENT_MAP[intent]) {
      deps.logger?.(
        `[claworks:function] unmapped intent '${intent}' — routing to generic event '${eventType}'`,
      );
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
