import { P as DEFAULT_RBAC_POLICIES } from "./agent-card-0vXLqNel.mjs";
import { t as DEFAULT_INGRESS_POLICIES } from "./ingress-EG_kwJvU.mjs";
//#region src/claworks/rbac-sync.ts
/**
* rbac-sync — 从 ObjectStore 中加载 RbacPolicy 对象，刷新 runtime.rbac。
*
* 设计：
* - Pack 热重载后自动调用
* - 也可通过 REST POST /v1/rbac/reload 手动触发
* - ObjectStore 中的 RbacPolicy 与 DEFAULT_RBAC_POLICIES 合并（ObjectStore 策略优先）
* - 这样权限策略本身就是「可靠数据」，不是硬编码
*/
async function syncRbacFromObjectStore(runtime) {
	try {
		const { items } = await runtime.objectStore.query("RbacPolicy", { limit: 500 });
		if (items.length === 0) {
			runtime.rbac.reload([...DEFAULT_RBAC_POLICIES]);
			return;
		}
		const customPolicies = items.flatMap((item) => {
			try {
				return [{
					id: String(item.id),
					action: String(item.action ?? "*"),
					resource: String(item.resource ?? "*"),
					subjectType: item.subjectType ?? item.subject_type ?? "apikey",
					subjectId: String(item.subjectId ?? item.subject_id ?? "*"),
					effect: item.effect ?? "allow",
					condition: item.condition ? String(item.condition) : void 0
				}];
			} catch {
				return [];
			}
		});
		runtime.rbac.reload([...customPolicies, ...DEFAULT_RBAC_POLICIES]);
		runtime.logger?.(`[claworks:rbac] loaded ${customPolicies.length} custom policies from ObjectStore`);
	} catch {
		runtime.logger?.("[claworks:rbac] RbacPolicy type not available yet, using defaults");
		runtime.rbac.reload([...DEFAULT_RBAC_POLICIES]);
	}
}
/**
* IngressPolicy 同样从 ObjectStore 加载后刷新 runtime.ingress。
*/
async function syncIngressFromObjectStore(runtime) {
	try {
		const { items } = await runtime.objectStore.query("IngressPolicy", { limit: 500 });
		if (items.length === 0) {
			runtime.ingress.reload([...DEFAULT_INGRESS_POLICIES]);
			return;
		}
		const customPolicies = items.flatMap((item) => {
			try {
				return [{
					id: String(item.id),
					source: item.source ?? "*",
					eventTypePattern: String(item.eventTypePattern ?? item.event_type_pattern ?? "*"),
					subjectId: item.subjectId ? String(item.subjectId) : void 0,
					decision: item.decision ?? { action: "kernel" },
					priority: Number(item.priority ?? 50)
				}];
			} catch {
				return [];
			}
		});
		runtime.ingress.reload([...customPolicies, ...DEFAULT_INGRESS_POLICIES]);
		runtime.logger?.(`[claworks:ingress] loaded ${customPolicies.length} custom policies from ObjectStore`);
	} catch {
		runtime.ingress.reload([...DEFAULT_INGRESS_POLICIES]);
	}
}
//#endregion
export { syncRbacFromObjectStore as n, syncIngressFromObjectStore as t };
