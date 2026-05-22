/**
 * rule-engine.ts — 决策表引擎（Rule Engine）
 *
 * 弱模型补偿：if-then 规则完全不走 LLM，速度快、结果确定。
 * 解决弱模型复杂推理能力差的痛点：简单分类、路由、阈值判断用规则表达。
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type RuleCondition =
  | {
      field: string;
      op:
        | "eq"
        | "ne"
        | "gt"
        | "lt"
        | "gte"
        | "lte"
        | "contains"
        | "not_contains"
        | "starts_with"
        | "ends_with"
        | "in"
        | "not_in"
        | "between";
      value: unknown;
    }
  | { and: RuleCondition[] }
  | { or: RuleCondition[] };

export type RuleAction = {
  kind: "set_variable" | "publish_event" | "trigger_playbook" | "return";
  params: Record<string, unknown>;
};

export type Rule = {
  id: string;
  name?: string;
  priority: number;
  condition: RuleCondition;
  action: RuleAction;
  /** 匹配后是否停止（默认 false — 继续匹配低优先级规则） */
  stopOnMatch?: boolean;
};

export type DecisionTable = {
  id: string;
  name: string;
  description?: string;
  rules: Rule[];
};

export type EvaluateResult = {
  rule: Rule;
  matched: boolean;
  action?: RuleAction;
};

export type EvaluateSummary = {
  matched_rules: Array<{ rule: { id: string; name?: string }; action: RuleAction }>;
  actions_taken: RuleAction[];
  total_evaluated: number;
};

export interface RuleEngine {
  registerTable(table: DecisionTable): void;
  removeTable(id: string): void;
  listTables(): DecisionTable[];

  /**
   * 对上下文数据执行决策表，返回触发的规则及动作。
   * 规则按 priority 降序排列。stopOnMatch=true 时命中即停止。
   */
  evaluate(tableId: string, context: Record<string, unknown>): Promise<EvaluateSummary>;
}

// ── 条件求值 ──────────────────────────────────────────────────────────────

function getFieldValue(context: Record<string, unknown>, field: string): unknown {
  // 支持简单的点路径，如 "alarm.severity"
  const parts = field.split(".");
  let val: unknown = context;
  for (const part of parts) {
    if (typeof val !== "object" || val === null) {
      return undefined;
    }
    val = (val as Record<string, unknown>)[part];
  }
  return val;
}

function evaluateCondition(condition: RuleCondition, context: Record<string, unknown>): boolean {
  if ("and" in condition) {
    return condition.and.every((c) => evaluateCondition(c, context));
  }
  if ("or" in condition) {
    return condition.or.some((c) => evaluateCondition(c, context));
  }

  const { field, op, value } = condition;
  const fieldVal = getFieldValue(context, field);

  switch (op) {
    case "eq":
      return fieldVal === value;
    case "ne":
      return fieldVal !== value;
    case "gt":
      return typeof fieldVal === "number" && typeof value === "number" && fieldVal > value;
    case "lt":
      return typeof fieldVal === "number" && typeof value === "number" && fieldVal < value;
    case "gte":
      return typeof fieldVal === "number" && typeof value === "number" && fieldVal >= value;
    case "lte":
      return typeof fieldVal === "number" && typeof value === "number" && fieldVal <= value;
    case "contains":
      return typeof fieldVal === "string" && typeof value === "string" && fieldVal.includes(value);
    case "not_contains":
      return typeof fieldVal === "string" && typeof value === "string" && !fieldVal.includes(value);
    case "starts_with":
      return (
        typeof fieldVal === "string" && typeof value === "string" && fieldVal.startsWith(value)
      );
    case "ends_with":
      return typeof fieldVal === "string" && typeof value === "string" && fieldVal.endsWith(value);
    case "in":
      return Array.isArray(value) && value.includes(fieldVal);
    case "not_in":
      return Array.isArray(value) && !value.includes(fieldVal);
    case "between": {
      // value: [min, max]（包含边界）
      if (!Array.isArray(value) || value.length < 2) {
        return false;
      }
      const [min, max] = value as [number, number];
      return typeof fieldVal === "number" && fieldVal >= min && fieldVal <= max;
    }
    default:
      return false;
  }
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createRuleEngine(opts?: {
  onAction?: (action: RuleAction, context: Record<string, unknown>, runtime?: unknown) => void;
}): RuleEngine {
  const tables = new Map<string, DecisionTable>();

  return {
    registerTable(table) {
      tables.set(table.id, table);
    },

    removeTable(id) {
      tables.delete(id);
    },

    listTables() {
      return [...tables.values()];
    },

    async evaluate(tableId, context) {
      const table = tables.get(tableId);
      if (!table) {
        return { matched_rules: [], actions_taken: [], total_evaluated: 0 };
      }

      // 按 priority 降序排列
      const sortedRules = [...table.rules].toSorted((a, b) => b.priority - a.priority);
      const matchedRules: Array<{ rule: { id: string; name?: string }; action: RuleAction }> = [];
      const actionsTaken: RuleAction[] = [];

      for (const rule of sortedRules) {
        const matched = evaluateCondition(rule.condition, context);
        if (matched) {
          matchedRules.push({ rule: { id: rule.id, name: rule.name }, action: rule.action });
          actionsTaken.push(rule.action);
          opts?.onAction?.(rule.action, context);
          if (rule.stopOnMatch) {
            break;
          }
        }
      }

      return {
        matched_rules: matchedRules,
        actions_taken: actionsTaken,
        total_evaluated: sortedRules.length,
      };
    },
  };
}

// ── 内置决策表 ────────────────────────────────────────────────────────────

/** 报警路由规则（完全不需要 LLM） */
export const BUILTIN_ALARM_ROUTING_TABLE: DecisionTable = {
  id: "alarm.routing",
  name: "报警路由规则",
  description: "根据报警严重程度路由到不同处理流程，完全不需要 LLM",
  rules: [
    {
      id: "critical_event",
      name: "紧急报警发布事件",
      priority: 100,
      condition: { field: "severity", op: "eq", value: "critical" },
      action: {
        kind: "publish_event",
        params: { event_type: "alarm.critical", priority: "critical" },
      },
    },
    {
      id: "high_or_critical_notify",
      name: "高级及紧急报警通知班组长",
      priority: 90,
      condition: { field: "severity", op: "in", value: ["high", "critical"] },
      action: {
        kind: "set_variable",
        params: { notify_role: "shift_supervisor", card_template: "alarm" },
      },
    },
    {
      id: "auto_acknowledge",
      name: "自动确认触发 Playbook",
      priority: 80,
      condition: { field: "auto_acknowledge", op: "eq", value: true },
      action: {
        kind: "trigger_playbook",
        params: { playbook_id: "alarm_auto_ack" },
      },
    },
  ],
};

/** 工单优先级分配规则 */
export const BUILTIN_WORK_ORDER_PRIORITY_TABLE: DecisionTable = {
  id: "work_order.priority_assign",
  name: "工单优先级分配规则",
  description: "根据工单类型和设备状态自动分配优先级",
  rules: [
    {
      id: "safety_urgent",
      name: "安全隐患工单紧急",
      priority: 100,
      condition: { field: "type", op: "eq", value: "safety_hazard" },
      action: { kind: "set_variable", params: { priority: "urgent", sla_hours: 2 } },
      stopOnMatch: true,
    },
    {
      id: "equipment_down_high",
      name: "设备停机高优先级",
      priority: 90,
      condition: { field: "equipment_status", op: "eq", value: "down" },
      action: { kind: "set_variable", params: { priority: "high", sla_hours: 4 } },
      stopOnMatch: true,
    },
    {
      id: "maintenance_normal",
      name: "日常维保普通优先级",
      priority: 50,
      condition: { field: "type", op: "eq", value: "maintenance" },
      action: { kind: "set_variable", params: { priority: "normal", sla_hours: 24 } },
      stopOnMatch: true,
    },
  ],
};

/** 小金额/低风险自动审批规则 */
export const BUILTIN_APPROVAL_AUTO_APPROVE_TABLE: DecisionTable = {
  id: "approval.auto_approve",
  name: "自动审批规则",
  description: "小金额、低风险采购申请自动审批，无需人工介入",
  rules: [
    {
      id: "small_amount",
      name: "小额自动审批",
      priority: 100,
      condition: {
        and: [
          { field: "amount", op: "lte", value: 500 },
          { field: "category", op: "in", value: ["consumable", "tool", "safety"] },
        ],
      },
      action: {
        kind: "return",
        params: { decision: "auto_approved", reason: "金额不超过500且属于日常耗材/工具/安全类" },
      },
      stopOnMatch: true,
    },
    {
      id: "large_amount_review",
      name: "大额需审批",
      priority: 50,
      condition: { field: "amount", op: "gt", value: 500 },
      action: {
        kind: "return",
        params: { decision: "review_required", reason: "金额超过500，需要主管审批" },
      },
      stopOnMatch: true,
    },
  ],
};

/** IM 消息快速规则（无需 LLM，直接路由） */
export const BUILTIN_IM_QUICK_RULES_TABLE: DecisionTable = {
  id: "im.quick_rules",
  name: "IM 消息快速规则",
  description: "精确匹配常见词汇，直接路由到业务事件，跳过 LLM 意图识别",
  rules: [
    {
      id: "help",
      name: "帮助请求",
      priority: 100,
      condition: {
        or: [
          { field: "text", op: "contains", value: "帮助" },
          { field: "text", op: "eq", value: "help" },
          { field: "text", op: "contains", value: "功能" },
          { field: "text", op: "contains", value: "怎么用" },
        ],
      },
      action: { kind: "publish_event", params: { event_type: "im.help_requested" } },
      stopOnMatch: true,
    },
    {
      id: "status",
      name: "状态查询",
      priority: 90,
      condition: {
        or: [
          { field: "text", op: "contains", value: "状态" },
          { field: "text", op: "contains", value: "运行情况" },
          { field: "text", op: "contains", value: "在线吗" },
        ],
      },
      action: { kind: "publish_event", params: { event_type: "system.status_requested" } },
      stopOnMatch: true,
    },
    {
      id: "alarm_query",
      name: "报警查询",
      priority: 85,
      condition: {
        or: [
          { field: "text", op: "contains", value: "报警" },
          { field: "text", op: "contains", value: "告警" },
          { field: "text", op: "contains", value: "异常" },
        ],
      },
      action: { kind: "publish_event", params: { event_type: "alarm.query_requested" } },
      stopOnMatch: true,
    },
  ],
};

/** 注册所有内置决策表到规则引擎 */
export function registerBuiltinDecisionTables(engine: RuleEngine): void {
  engine.registerTable(BUILTIN_ALARM_ROUTING_TABLE);
  engine.registerTable(BUILTIN_WORK_ORDER_PRIORITY_TABLE);
  engine.registerTable(BUILTIN_APPROVAL_AUTO_APPROVE_TABLE);
  engine.registerTable(BUILTIN_IM_QUICK_RULES_TABLE);
}
