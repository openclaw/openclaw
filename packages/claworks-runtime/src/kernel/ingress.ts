/**
 * EventIngress — 事件入站策略路由。
 *
 * 解决「IM 消息不应默认进 EventKernel」问题：
 * 不同来源的消息经策略路由后，决定是：
 *   A) 直接进 EventKernel（Connector / OT / REST / peer）
 *   B) 经意图路由处理（IM 自然语言 → 意图分类 → 结构化事件）
 *   C) 拒绝（RBAC 或速率限制）
 *   D) 仅记录观测（observe-only）
 *
 * 路由规则可存储为 ObjectType "IngressPolicy"，从而实现 Playbook 化配置，
 * 而非硬编码 if-else。
 */

export type IngressSource =
  | "connector" // OT / SCADA / Modbus / MQTT / OPC-UA
  | "rest" // POST /v1/events（API Key 认证）
  | "a2a" // A2A peer 委托
  | "scheduler" // Cron trigger
  | "system" // 内部 Playbook publish
  | "im" // IM 频道用户消息（经过意图路由后才可能进 Kernel）
  | "mcp" // MCP 工具调用
  | "webhook"; // Webhook 外部推送

export type IngressDecision =
  | { action: "kernel"; eventType?: string } // 直接进 EventKernel（可改写 type）
  | { action: "intent_route"; hint?: string } // 意图路由（交给 LLM 分类 Playbook）
  | { action: "observe_only" } // 仅观测记录，不触发 Playbook
  | { action: "deny"; reason: string }; // 拒绝

export type IngressPolicy = {
  id: string;
  /** 来源类型匹配（* 匹配所有） */
  source: IngressSource | "*";
  /** 事件类型通配（* 匹配所有） */
  eventTypePattern: string;
  /** 主体 ID 匹配（* 匹配所有） */
  subjectId?: string;
  decision: IngressDecision;
  /** 优先级（数字越大越先评估） */
  priority: number;
};

/**
 * 内置默认 Ingress 策略（开机可用）：
 * - Connector/REST/A2A/Scheduler/System → 直接进 Kernel
 * - IM/Webhook → 意图路由（不直接进 Kernel，由意图 Playbook 分类后 publish）
 */
export const DEFAULT_INGRESS_POLICIES: IngressPolicy[] = [
  {
    id: "connector-kernel",
    source: "connector",
    eventTypePattern: "*",
    decision: { action: "kernel" },
    priority: 100,
  },
  {
    id: "rest-kernel",
    source: "rest",
    eventTypePattern: "*",
    decision: { action: "kernel" },
    priority: 100,
  },
  {
    id: "a2a-kernel",
    source: "a2a",
    eventTypePattern: "*",
    decision: { action: "kernel" },
    priority: 100,
  },
  {
    id: "scheduler-kernel",
    source: "scheduler",
    eventTypePattern: "*",
    decision: { action: "kernel" },
    priority: 100,
  },
  {
    id: "system-kernel",
    source: "system",
    eventTypePattern: "*",
    decision: { action: "kernel" },
    priority: 100,
  },
  {
    id: "mcp-kernel",
    source: "mcp",
    eventTypePattern: "*",
    decision: { action: "kernel" },
    priority: 100,
  },
  // IM 默认走意图路由，不直接进 Kernel
  {
    id: "im-intent-route",
    source: "im",
    eventTypePattern: "*",
    decision: { action: "intent_route", hint: "classify_im_to_business_event" },
    priority: 50,
  },
  // Webhook 默认走意图路由（可被 Pack 覆盖为 kernel）
  {
    id: "webhook-intent-route",
    source: "webhook",
    eventTypePattern: "*",
    decision: { action: "intent_route", hint: "classify_webhook_to_business_event" },
    priority: 50,
  },
];

export type IngressRouter = {
  decide(source: IngressSource, eventType: string, subjectId?: string): IngressDecision;
  reload(policies: IngressPolicy[]): void;
};

export function createIngressRouter(initialPolicies?: IngressPolicy[]): IngressRouter {
  let policies: IngressPolicy[] = [...(initialPolicies ?? DEFAULT_INGRESS_POLICIES)];

  return {
    decide(source, eventType, subjectId) {
      const sorted = [...policies].sort((a, b) => b.priority - a.priority);

      for (const policy of sorted) {
        if (policy.source !== "*" && policy.source !== source) {
          continue;
        }
        if (!matchEventTypePattern(policy.eventTypePattern, eventType)) {
          continue;
        }
        if (policy.subjectId && policy.subjectId !== "*" && policy.subjectId !== subjectId) {
          continue;
        }
        return policy.decision;
      }

      // 默认：非已知来源走观测
      return { action: "observe_only" };
    },

    reload(newPolicies) {
      policies = [...newPolicies];
    },
  };
}

function matchEventTypePattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return eventType.startsWith(pattern.slice(0, -1));
  }
  return pattern === eventType;
}
