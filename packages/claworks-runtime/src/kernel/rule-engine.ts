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
   * 向已有决策表动态追加一条规则（表不存在时自动创建）。
   * 用于在线学习：用户纠正后立即生效，秒级响应，无需重启。
   */
  addRule(tableId: string, rule: Rule): void;

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

    addRule(tableId, rule) {
      const existing = tables.get(tableId);
      if (existing) {
        // 避免重复插入相同 id 的规则
        const idx = existing.rules.findIndex((r) => r.id === rule.id);
        if (idx >= 0) {
          existing.rules[idx] = rule;
        } else {
          existing.rules.push(rule);
        }
      } else {
        tables.set(tableId, {
          id: tableId,
          name: tableId,
          rules: [rule],
        });
      }
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
          { field: "text", op: "eq", value: "?" },
          { field: "text", op: "contains", value: "功能" },
          { field: "text", op: "contains", value: "怎么用" },
          { field: "text", op: "contains", value: "教程" },
          { field: "text", op: "contains", value: "使用指南" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "im.help_requested", route_intent: "help" },
      },
      stopOnMatch: true,
    },
    {
      id: "system_status",
      name: "系统状态查询",
      priority: 90,
      condition: {
        or: [
          { field: "text", op: "contains", value: "状态" },
          { field: "text", op: "contains", value: "运行情况" },
          { field: "text", op: "contains", value: "在线吗" },
          { field: "text", op: "contains", value: "健康" },
          { field: "text", op: "contains", value: "运行中" },
          { field: "text", op: "contains", value: "正常吗" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "system.status_requested", route_intent: "system_status" },
      },
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
          { field: "text", op: "contains", value: "故障" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "alarm.query_requested", route_intent: "alarm_query" },
      },
      stopOnMatch: true,
    },
    {
      id: "alarm_acknowledge",
      name: "报警确认",
      priority: 83,
      condition: {
        or: [
          { field: "text", op: "contains", value: "确认" },
          { field: "text", op: "contains", value: "知道了" },
          { field: "text", op: "contains", value: "我知道了" },
          { field: "text", op: "contains", value: "收到" },
          { field: "text", op: "contains", value: "已处理" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "alarm.acknowledge_requested", route_intent: "alarm_acknowledge" },
      },
      stopOnMatch: true,
    },
    {
      id: "work_order_query",
      name: "工单查询",
      priority: 80,
      condition: {
        or: [
          { field: "text", op: "contains", value: "工单" },
          { field: "text", op: "contains", value: "维修单" },
          { field: "text", op: "contains", value: "任务单" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "work_order.query_requested", route_intent: "workorder_query" },
      },
      stopOnMatch: true,
    },
    {
      id: "report_request",
      name: "报告请求",
      priority: 75,
      condition: {
        or: [
          { field: "text", op: "contains", value: "报告" },
          { field: "text", op: "contains", value: "统计" },
          { field: "text", op: "contains", value: "总结" },
          { field: "text", op: "contains", value: "汇总" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "report.generate_requested", route_intent: "report_request" },
      },
      stopOnMatch: true,
    },
    {
      id: "shift_handover",
      name: "交接班",
      priority: 72,
      condition: {
        or: [
          { field: "text", op: "contains", value: "交班" },
          { field: "text", op: "contains", value: "交接" },
          { field: "text", op: "contains", value: "接班" },
          { field: "text", op: "contains", value: "班次" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "shift.handover_requested", route_intent: "shift_handover" },
      },
      stopOnMatch: true,
    },
    {
      id: "greeting",
      name: "问候/打招呼",
      priority: 10,
      condition: {
        or: [
          { field: "text", op: "eq", value: "你好" },
          { field: "text", op: "eq", value: "hello" },
          { field: "text", op: "eq", value: "hi" },
          { field: "text", op: "contains", value: "早上好" },
          { field: "text", op: "contains", value: "下午好" },
          { field: "text", op: "contains", value: "晚上好" },
        ],
      },
      action: {
        kind: "publish_event",
        params: { event_type: "im.greeting_received", route_intent: "chat" },
      },
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
