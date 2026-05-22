import { f as __exportAll } from "./ontology-engine-DYitirop.mjs";
import { t as DEFAULT_INGRESS_POLICIES } from "./ingress-CqjhZRWq.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
//#region src/claworks/robot-identity.ts
/**
* Robot Identity — 机器人自身的身份、记忆、规则与 RBAC 守卫。
*
* 设计原则：
* - 机器人有自己的 robot.md（角色宣言 + 规则），不依赖聊天会话记忆
* - RBAC 规则作为 ObjectType "RbacPolicy" 存入 ObjectStore（可靠数据，不是硬编码）
* - 权限校验发布 `rbac.denied` 事件，可被 Playbook 响应（智能化，而非硬拒绝后沉默）
* - 机器人记忆（声明性事实）存储为 ObjectType "RobotMemory"
*/
/**
* 加载 robot.md —— 按以下优先级查找：
* 1. packDir/robot.md（Pack 内置角色宣言）
* 2. stateDir/robot.md（运营方定制）
* 3. 内置默认（从 robot name + description 生成）
*/
function loadRobotMd(opts) {
	const custom = join(opts.stateDir ?? join(homedir(), ".claworks"), "robot.md");
	if (existsSync(custom)) return readFileSync(custom, "utf-8");
	for (const dir of opts.packDirs ?? []) {
		const packMd = join(dir, "robot.md");
		if (existsSync(packMd)) return readFileSync(packMd, "utf-8");
	}
	return buildDefaultRobotMd(opts);
}
function buildDefaultRobotMd(opts) {
	return `# Robot Identity: ${opts.robotName}

## 角色
- **名称**：${opts.robotName}
- **职能**：${opts.robotRole}
- **业务域**：${opts.domain ?? "通用"}

## 核心规则
1. 只响应在本业务域中有意义的事件；跨域决策通过 A2A 委托给邻域机器人。
2. 高置信度（>85%）的例行操作自动执行；低置信度的操作必须 HITL。
3. 所有写操作（创建工单、MES 下发、发送通知）需满足 RBAC 策略。
4. 系统保密：不向未授权主体透露内部本体结构或运行日志。
5. 首选确定性规则；只在不确定段使用 LLM。
6. 错误和异常触发 \`system.anomaly\` 事件；不静默失败。
7. 能量守恒：避免无意义的循环触发；相同事件 60 秒内同源不重复触发相同 Playbook。

## 可信主体
- **系统（system）**：内置 Connector、Scheduler、系统 Playbook —— 始终信任。
- **API Key（apikey）**：配置的 Bearer Token —— 信任 REST 写操作。
- **A2A Peer（peer）**：白名单内的对等机器人 —— 信任委托；不信任写操作。
- **IM 用户（channel_user）**：通过 HITL 确认后信任；默认只读。

## HITL 升级条件
- 置信度 < 85%
- 影响金额 / 物料价值 > 阈值（Pack 定义）
- 新型故障（KB 无匹配历史案例）
- 多域协作（需要其他机器人确认）
`;
}
/**
* 提取 robot.md 中「核心规则」段落作为 rules[] 列表。
*/
/**
* 从 robot.md 解析 Owner 段（支持 YAML 风格键或 Markdown 列表）。
*/
function extractOwnerFromMd(md) {
	const lines = md.split("\n");
	let inOwner = false;
	const fields = {};
	for (const line of lines) {
		if (/^## Owner\b/i.test(line) || line.startsWith("## 主人")) {
			inOwner = true;
			continue;
		}
		if (inOwner && line.startsWith("## ")) break;
		if (!inOwner) continue;
		const kv = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+)\s*$/);
		if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
		const bullet = line.match(/^\s*[-*]\s*\*\*?([^:*]+)\*\*?\s*[:：]\s*(.+)\s*$/);
		if (bullet) fields[bullet[1].trim().toLowerCase().replace(/\s+/g, "_")] = bullet[2].trim();
	}
	const ownerId = fields.owner_id ?? fields.ownerid ?? fields.id;
	if (!ownerId) return;
	return {
		ownerId,
		channelId: fields.channel_id ?? fields.channel,
		shiftSchedule: fields.shift_schedule ?? fields.shift
	};
}
function extractRulesFromMd(md) {
	const lines = md.split("\n");
	const rules = [];
	let inRulesSection = false;
	for (const line of lines) {
		if (line.startsWith("## 核心规则") || /^## Core Rules/i.test(line)) {
			inRulesSection = true;
			continue;
		}
		if (inRulesSection && line.startsWith("## ")) break;
		if (inRulesSection && /^\d+\./.test(line.trim())) rules.push(line.trim().replace(/^\d+\.\s*/, ""));
	}
	return rules;
}
/**
* 构建机器人身份对象（从 robot.md 派生）。
*/
function buildRobotIdentity(opts) {
	const agentMd = loadRobotMd(opts);
	const rules = extractRulesFromMd(agentMd);
	const owner = extractOwnerFromMd(agentMd);
	return {
		name: opts.robotName,
		role: opts.robotRole,
		domain: opts.domain ?? "general",
		description: `ClaWorks robot: ${opts.robotName}`,
		rules,
		agentMd,
		owner
	};
}
/**
* RBAC 守卫 —— 从 ObjectStore RbacPolicy 对象评估权限。
*
* 策略评估顺序：
* 1. 精确匹配（action + resource + subject）的 deny → 立即拒绝
* 2. 精确匹配的 allow → 通过
* 3. 通配符匹配（同顺序）
* 4. 默认 deny（如无任何策略匹配）
*
* 可靠性原则：RBAC 守卫本身是纯函数，策略来自 ObjectStore（可审计、可热更新）。
*/
function createRbacGuard(policies) {
	return {
		check(input) {
			const matches = policies.filter((p) => matchesPattern(p.action, input.action) && matchesPattern(p.resource, input.resource) && (p.subjectType === input.subjectType || p.subjectType === "system") && (p.subjectId === "*" || p.subjectId === input.subjectId));
			for (const p of matches) if (p.effect === "deny" && p.action === input.action && p.resource === input.resource && p.subjectId === input.subjectId) return {
				allowed: false,
				reason: `Denied by policy ${p.id}`,
				policy: p
			};
			for (const p of matches) if (p.effect === "deny") return {
				allowed: false,
				reason: `Denied by policy ${p.id}`,
				policy: p
			};
			for (const p of matches) if (p.effect === "allow") return { allowed: true };
			if (input.subjectType === "system") return { allowed: true };
			return {
				allowed: false,
				reason: "No matching allow policy (default deny)"
			};
		},
		/** 加载新策略列表（Pack 热重载后调用） */
		reload(newPolicies) {
			policies.length = 0;
			policies.push(...newPolicies);
		}
	};
}
function matchesPattern(pattern, value) {
	if (pattern === "*") return true;
	if (pattern.endsWith(".*")) return value.startsWith(pattern.slice(0, -1));
	if (pattern.endsWith(":*")) return value.startsWith(pattern.slice(0, -1));
	return pattern === value;
}
/**
* 内置默认策略（开机可用，不依赖 Pack）。
* 运营方可通过 ObjectStore 的 RbacPolicy 对象覆盖或扩展。
*/
const DEFAULT_RBAC_POLICIES = [
	{
		id: "sys-event-publish",
		action: "event.publish",
		resource: "*",
		subjectType: "system",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "apikey-write",
		action: "*",
		resource: "*",
		subjectType: "apikey",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "peer-a2a-allow",
		action: "a2a.delegate",
		resource: "*",
		subjectType: "peer",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "peer-event-allow",
		action: "event.publish",
		resource: "*",
		subjectType: "peer",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-read",
		action: "rest.read",
		resource: "*",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-hitl",
		action: "hitl.resolve",
		resource: "*",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-im-classify",
		action: "playbook.trigger",
		resource: "playbook:classify_im_to_business_event",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-webhook-classify",
		action: "playbook.trigger",
		resource: "playbook:classify_webhook_to_business_event",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-webhook-publish",
		action: "event.publish",
		resource: "webhook.*",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-im-publish",
		action: "event.publish",
		resource: "im.*",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "owner-admin",
		action: "*",
		resource: "*",
		subjectType: "channel_user",
		subjectId: "owner:*",
		effect: "allow"
	},
	{
		id: "owner-reload-packs",
		action: "playbook.reload",
		resource: "*",
		subjectType: "channel_user",
		subjectId: "owner:*",
		effect: "allow"
	},
	{
		id: "owner-modify-rbac",
		action: "rbac.reload",
		resource: "*",
		subjectType: "channel_user",
		subjectId: "owner:*",
		effect: "allow"
	},
	{
		id: "role-approver-approval-events",
		action: "event.publish",
		resource: "approval.*",
		subjectType: "channel_user",
		subjectId: "role:approver:*",
		effect: "allow"
	},
	{
		id: "role-approver-read",
		action: "rest.read",
		resource: "object:ApprovalRequest:*",
		subjectType: "channel_user",
		subjectId: "role:approver:*",
		effect: "allow"
	},
	{
		id: "role-manager-read-all",
		action: "rest.read",
		resource: "*",
		subjectType: "channel_user",
		subjectId: "role:manager:*",
		effect: "allow"
	},
	{
		id: "role-manager-trigger-report",
		action: "playbook.trigger",
		resource: "playbook:daily_report_generate",
		subjectType: "channel_user",
		subjectId: "role:manager:*",
		effect: "allow"
	},
	{
		id: "role-manager-trigger-quote",
		action: "playbook.trigger",
		resource: "playbook:quote_generate",
		subjectType: "channel_user",
		subjectId: "role:manager:*",
		effect: "allow"
	},
	{
		id: "role-manager-trigger-bid",
		action: "playbook.trigger",
		resource: "playbook:bid_document_generate",
		subjectType: "channel_user",
		subjectId: "role:manager:*",
		effect: "allow"
	},
	{
		id: "role-manager-business-events",
		action: "event.publish",
		resource: "quote.*",
		subjectType: "channel_user",
		subjectId: "role:manager:*",
		effect: "allow"
	},
	{
		id: "role-manager-bid-events",
		action: "event.publish",
		resource: "bid.*",
		subjectType: "channel_user",
		subjectId: "role:manager:*",
		effect: "allow"
	},
	{
		id: "role-admin-all",
		action: "*",
		resource: "*",
		subjectType: "channel_user",
		subjectId: "role:admin:*",
		effect: "allow"
	},
	{
		id: "channel-user-business-events",
		action: "event.publish",
		resource: "task.*",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-incident-events",
		action: "event.publish",
		resource: "incident.*",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	},
	{
		id: "channel-user-kb-events",
		action: "event.publish",
		resource: "kb.*",
		subjectType: "channel_user",
		subjectId: "*",
		effect: "allow"
	}
];
//#endregion
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
var rbac_sync_exports = /* @__PURE__ */ __exportAll({
	syncIngressFromObjectStore: () => syncIngressFromObjectStore,
	syncRbacFromObjectStore: () => syncRbacFromObjectStore
});
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
export { buildRobotIdentity as a, extractRulesFromMd as c, DEFAULT_RBAC_POLICIES as i, loadRobotMd as l, syncIngressFromObjectStore as n, createRbacGuard as o, syncRbacFromObjectStore as r, extractOwnerFromMd as s, rbac_sync_exports as t };
