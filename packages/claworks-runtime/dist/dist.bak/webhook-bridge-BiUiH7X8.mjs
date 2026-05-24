import { N as applyIngressPublish } from "./agent-card-0vXLqNel.mjs";
//#region src/claworks/webhook-bridge.ts
/**
* webhook-bridge — 外部 Webhook 载荷 → Ingress（默认 intent_route）→ 分类 Playbook
*
* 与 im-bridge 对称；Ingress 默认策略见 DEFAULT_INGRESS_POLICIES（webhook-intent-route）。
*/
async function bridgeWebhookPayload(runtime, input) {
	const source = "webhook";
	const eventType = "webhook.payload.received";
	const subjectId = input.subjectId ?? `webhook:${input.source}`;
	const webhookId = input.webhookId ?? `wh-${Date.now()}`;
	const bodyText = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
	const decision = runtime.ingress.decide(source, eventType, subjectId);
	const rbacAction = decision.action === "intent_route" ? "playbook.trigger" : "event.publish";
	const rbacResource = decision.action === "intent_route" ? `playbook:${decision.hint ?? "classify_webhook_to_business_event"}` : "webhook.*";
	const rbacResult = runtime.rbac.check({
		action: rbacAction,
		resource: rbacResource,
		subjectType: "channel_user",
		subjectId,
		context: { webhook_source: input.source }
	});
	if (!rbacResult.allowed) {
		const reason = rbacResult.reason ?? "policy denied";
		await runtime.kernel.publish("rbac.denied", "webhook-bridge", {
			action: rbacAction,
			resource: rbacResource,
			subject_type: "channel_user",
			subject_id: subjectId,
			reason
		});
		return {
			action: "denied",
			reason
		};
	}
	const result = await applyIngressPublish(runtime, {
		source,
		eventType,
		subjectId,
		payload: {
			_webhook_source: input.source,
			_webhook_id: webhookId,
			_webhook_body: bodyText,
			_ingress_decision: decision.action,
			...input.extra
		},
		publishSource: `webhook-bridge:${input.source}`,
		idempotencyKey: `webhook:${input.source}:${webhookId}`,
		subjectType: "channel_user"
	});
	if (result.action === "denied") return {
		action: "denied",
		reason: result.reason
	};
	if (result.action === "observe_only") return { action: "observe_only" };
	if (result.action === "intent_routed") return {
		action: "intent_routed",
		playbookId: result.playbookId,
		runId: result.runId,
		status: result.status
	};
	return {
		action: "published",
		eventType: result.eventType,
		matchedPlaybooks: result.matchedPlaybooks
	};
}
//#endregion
export { bridgeWebhookPayload as t };
