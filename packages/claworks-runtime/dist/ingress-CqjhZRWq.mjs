//#region src/kernel/ingress.ts
/**
* 内置默认 Ingress 策略（开机可用）：
* - Connector/REST/A2A/Scheduler/System → 直接进 Kernel
* - IM/Webhook → 意图路由（不直接进 Kernel，由意图 Playbook 分类后 publish）
*/
const DEFAULT_INGRESS_POLICIES = [
	{
		id: "connector-kernel",
		source: "connector",
		eventTypePattern: "*",
		decision: { action: "kernel" },
		priority: 100
	},
	{
		id: "rest-kernel",
		source: "rest",
		eventTypePattern: "*",
		decision: { action: "kernel" },
		priority: 100
	},
	{
		id: "a2a-kernel",
		source: "a2a",
		eventTypePattern: "*",
		decision: { action: "kernel" },
		priority: 100
	},
	{
		id: "scheduler-kernel",
		source: "scheduler",
		eventTypePattern: "*",
		decision: { action: "kernel" },
		priority: 100
	},
	{
		id: "system-kernel",
		source: "system",
		eventTypePattern: "*",
		decision: { action: "kernel" },
		priority: 100
	},
	{
		id: "mcp-kernel",
		source: "mcp",
		eventTypePattern: "*",
		decision: { action: "kernel" },
		priority: 100
	},
	{
		id: "im-intent-route",
		source: "im",
		eventTypePattern: "*",
		decision: {
			action: "intent_route",
			hint: "classify_im_to_business_event"
		},
		priority: 50
	},
	{
		id: "webhook-intent-route",
		source: "webhook",
		eventTypePattern: "*",
		decision: {
			action: "intent_route",
			hint: "classify_webhook_to_business_event"
		},
		priority: 50
	}
];
function createIngressRouter(initialPolicies) {
	let policies = [...initialPolicies ?? DEFAULT_INGRESS_POLICIES];
	return {
		decide(source, eventType, subjectId) {
			const sorted = [...policies].toSorted((a, b) => b.priority - a.priority);
			for (const policy of sorted) {
				if (policy.source !== "*" && policy.source !== source) continue;
				if (!matchEventTypePattern(policy.eventTypePattern, eventType)) continue;
				if (policy.subjectId && policy.subjectId !== "*" && policy.subjectId !== subjectId) continue;
				return policy.decision;
			}
			return { action: "observe_only" };
		},
		reload(newPolicies) {
			policies = [...newPolicies];
		}
	};
}
function matchEventTypePattern(pattern, eventType) {
	if (pattern === "*") return true;
	if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1));
	return pattern === eventType;
}
//#endregion
export { createIngressRouter as n, DEFAULT_INGRESS_POLICIES as t };
