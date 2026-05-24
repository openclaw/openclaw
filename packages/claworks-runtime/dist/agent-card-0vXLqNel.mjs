import { l as runtimeUptimeSeconds } from "./kb-types-JeIAB0Dq.mjs";
import { r as installPackFromNexus } from "./pack-loader-DLYx0S-x.mjs";
import os, { homedir } from "node:os";
import path, { join, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import "yaml";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
//#region src/claworks/product-env.ts
/** Default ClaWorks gateway port (OpenClaw default is 18789). */
const CLAWORKS_DEFAULT_GATEWAY_PORT = 18800;
function isClaworksProduct(env = process.env) {
	return env.CLAWORKS_PRODUCT === "1";
}
/**
* 生产模式：显式 config.production_mode 优先；未设置时读 CLAWORKS_PRODUCTION=1。
*/
function isClaworksProductionMode(config, env = process.env) {
	if (config.production_mode === true) return true;
	if (config.production_mode === false) return false;
	return env.CLAWORKS_PRODUCTION === "1";
}
/**
* 判断环境变量是否指向 ClaWorks 专属路径
* (.claworks 目录或 claworks.json 配置路径)
*/
function looksLikeClaworksStateEnv(env) {
	const stateDir = env.OPENCLAW_STATE_DIR ?? "";
	if (stateDir && (stateDir.endsWith("/.claworks") || stateDir.endsWith("\\.claworks") || stateDir === ".claworks")) return true;
	const configPath = env.OPENCLAW_CONFIG_PATH ?? "";
	if (configPath && configPath.endsWith("claworks.json")) return true;
	return false;
}
/**
* 当使用 openclaw 入口文件但 state 目录指向 ClaWorks 时，发出一次性警告。
*/
let _misEntryWarned = false;
function warnIfOpenClawEntryWithClaworksState(env = process.env) {
	if (env._CLAWORKS_MISENTRY_WARNED === "1") return;
	const argv1 = env._CLAWORKS_ARGV1 ?? "";
	const base = path.basename(argv1);
	if (!(base === "openclaw" || base === "openclaw.mjs" || base === "openclaw.js")) return;
	if (!looksLikeClaworksStateEnv(env)) return;
	if (_misEntryWarned) return;
	_misEntryWarned = true;
	env._CLAWORKS_MISENTRY_WARNED = "1";
	process.stderr.write(`[claworks] Warning: you launched via '${base}' but your state directory points to ClaWorks (.claworks). Use 'claworks.mjs' instead to ensure correct product isolation.\n`);
}
/**
* Isolate ClaWorks from a co-installed OpenClaw:
* - state/config under ~/.claworks (not ~/.openclaw)
* - default gateway port 18800
* Call before config path resolution (entry + claworks.mjs wrapper).
*/
function applyClaworksProductEnv(env = process.env) {
	if (!isClaworksProduct(env)) return;
	const home = os.homedir();
	const stateDir = env.CLAWORKS_STATE_DIR?.trim() || env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".claworks");
	const configPath = env.CLAWORKS_CONFIG?.trim() || env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "claworks.json");
	env.CLAWORKS_PRODUCT = "1";
	env.CLAWORKS_STATE_DIR ??= stateDir;
	env.OPENCLAW_STATE_DIR ??= stateDir;
	env.CLAWORKS_CONFIG ??= configPath;
	env.OPENCLAW_CONFIG_PATH ??= configPath;
	env.CLAWORKS_GATEWAY_PORT ??= String(CLAWORKS_DEFAULT_GATEWAY_PORT);
	env.OPENCLAW_GATEWAY_PORT ??= String(CLAWORKS_DEFAULT_GATEWAY_PORT);
}
/** Detect `claworks` CLI invocation and enable product mode. */
function detectAndApplyClaworksCli(env = process.env) {
	const argv1 = env._CLAWORKS_ARGV1 ?? process.argv[1] ?? "";
	const base = path.basename(argv1);
	if (base === "claworks" || base === "claworks.mjs" || base === "claworks.js") env.CLAWORKS_PRODUCT = "1";
	if (!env.CLAWORKS_PRODUCT && looksLikeClaworksStateEnv(env)) env.CLAWORKS_PRODUCT = "1";
	applyClaworksProductEnv(env);
}
//#endregion
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
		if (/^## Owner\b/i.test(line) || /^## 主人/.test(line)) {
			inOwner = true;
			continue;
		}
		if (inOwner && /^## /.test(line)) break;
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
		if (/^## 核心规则/.test(line) || /^## Core Rules/i.test(line)) {
			inRulesSection = true;
			continue;
		}
		if (inRulesSection && /^## /.test(line)) break;
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
			const matches = policies.filter((p) => matchesPattern(p.action, input.action) && matchesPattern(p.resource, input.resource) && (p.subjectType === input.subjectType || p.subjectType === "system") && (p.subjectId === "*" || matchesPattern(p.subjectId, input.subjectId)));
			const isExactSubject = (p) => p.subjectId === input.subjectId;
			for (const p of matches) if (p.effect === "deny" && isExactSubject(p)) return {
				allowed: false,
				reason: `Denied by policy ${p.id}`,
				policy: p
			};
			for (const p of matches) if (p.effect === "allow" && isExactSubject(p)) return { allowed: true };
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
//#region src/claworks/robot-constitution.ts
const DEFAULT_ROBOT_CONSTITUTION = {
	autoAllow: [
		"query.object_store",
		"notify",
		"query.alarms",
		"event.publish:system.*"
	],
	hitlRequired: [
		"a2a_delegate",
		"create.work_order",
		"modify.device_config"
	],
	deny: [
		"delete.*",
		"modify.production.*",
		"share.credentials"
	],
	trustedSources: [
		"system",
		"connector",
		"peer",
		"channel_user",
		"apikey",
		"openclaw_agent",
		"test",
		"playbook",
		"im",
		"im-bridge",
		"webhook",
		"webhook-bridge",
		"rest",
		"rest-api",
		"playbook-action",
		"mcp",
		"a2a"
	],
	dedupWindowMs: 6e4
};
function isTrustedEventSource(constitution, source) {
	if (!constitution) return true;
	const prefix = source.split(":")[0]?.toLowerCase() ?? source;
	return constitution.trustedSources.some((t) => {
		if (t === prefix) return true;
		if (t === "openclaw_agent" && (prefix === "agent" || source.startsWith("openclaw:"))) return true;
		if (source.startsWith(`${t}:`)) return true;
		if (t === "im" && (prefix === "im" || source.startsWith("im:"))) return true;
		if (prefix.endsWith("-bridge") && (prefix === t || prefix.startsWith(`${t}-`))) return true;
		return false;
	});
}
//#endregion
//#region src/claworks/ingress-publish.ts
async function applyIngressPublish(runtime, params) {
	const publishSource = params.publishSource ?? params.subjectId;
	if (!isTrustedEventSource(DEFAULT_ROBOT_CONSTITUTION, publishSource)) {
		runtime.logger?.(`[claworks:ingress] untrusted source "${publishSource}" — denied by robot constitution`);
		return {
			action: "denied",
			reason: `untrusted event source: ${publishSource}`
		};
	}
	const decision = runtime.ingress.decide(params.source, params.eventType, params.subjectId);
	if (decision.action === "deny") return {
		action: "denied",
		reason: decision.reason ?? "ingress policy denied"
	};
	if (decision.action === "observe_only") return { action: "observe_only" };
	if (decision.action === "intent_route") return routeIntentPlaybook(runtime, decision, params);
	const effectiveType = decision.action === "kernel" && decision.eventType ? decision.eventType : params.eventType;
	return {
		action: "published",
		eventType: effectiveType,
		matchedPlaybooks: (await runtime.kernel.publish(effectiveType, params.publishSource ?? params.subjectId, params.payload, {
			correlationId: params.correlationId,
			idempotencyKey: params.idempotencyKey,
			subjectType: params.subjectType,
			subjectId: params.subjectId
		})).map((m) => m.playbookId)
	};
}
async function routeIntentPlaybook(runtime, decision, params) {
	const hint = decision.hint ?? "classify_im_to_business_event";
	if (!runtime.playbookEngine.list().find((p) => p.id === hint)) {
		runtime.logger?.(`[claworks:ingress] intent_route playbook missing: ${hint} — observe only`);
		return { action: "observe_only" };
	}
	const payload = {
		...params.payload,
		_ingress_decision: "intent_route",
		_ingress_event_type: params.eventType,
		_ingress_source: params.source
	};
	const run = await runtime.playbookEngine.trigger(hint, payload);
	return {
		action: "intent_routed",
		playbookId: hint,
		runId: run.id,
		status: run.status
	};
}
//#endregion
//#region src/claworks/direct-llm-bridge.ts
/**
* 从环境变量和配置自动探测可用 LLM，返回 llmComplete 函数。
* 返回 null 表示无可用 LLM（系统将以 stub 模式运行）。
*/
function createDirectLlmBridge(config) {
	const baseUrl = config?.base_url ?? process.env["CLAWORKS_LLM_BASE_URL"] ?? process.env["OPENAI_BASE_URL"];
	const apiKey = config?.api_key ?? process.env["CLAWORKS_LLM_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? process.env["ANTHROPIC_API_KEY"];
	const defaultModel = config?.model ?? process.env["CLAWORKS_LLM_MODEL"] ?? "gpt-4o-mini";
	const timeoutMs = config?.timeout_ms ?? 6e4;
	if (!baseUrl && process.env["ANTHROPIC_API_KEY"] && !process.env["OPENAI_API_KEY"]) return createAnthropicBridge(process.env["ANTHROPIC_API_KEY"], defaultModel, timeoutMs);
	const ollamaUrl = baseUrl ?? process.env["OLLAMA_BASE_URL"];
	if (ollamaUrl) {
		const url = ollamaUrl;
		return createOpenAICompatibleBridge(url.endsWith("/v1") ? url : `${url}/v1`, apiKey ?? "ollama", defaultModel, timeoutMs);
	}
	if (process.env["OPENAI_API_KEY"]) return createOpenAICompatibleBridge("https://api.openai.com/v1", process.env["OPENAI_API_KEY"], defaultModel, timeoutMs);
	return null;
}
function createOpenAICompatibleBridge(baseUrl, apiKey, defaultModel, timeoutMs) {
	return async ({ prompt, model, system }) => {
		const messages = [];
		if (system) messages.push({
			role: "system",
			content: system
		});
		messages.push({
			role: "user",
			content: prompt
		});
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const resp = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`
				},
				body: JSON.stringify({
					model: model ?? defaultModel,
					messages,
					stream: false
				}),
				signal: controller.signal
			});
			if (!resp.ok) {
				const body = await resp.text().catch(() => "");
				throw new Error(`LLM API ${resp.status}: ${body.slice(0, 200)}`);
			}
			return { text: (await resp.json()).choices?.[0]?.message?.content ?? "" };
		} finally {
			clearTimeout(timer);
		}
	};
}
function createAnthropicBridge(apiKey, defaultModel, timeoutMs) {
	const model = defaultModel.startsWith("claude") ? defaultModel : "claude-3-5-haiku-20241022";
	return async ({ prompt, system }) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const body = {
				model,
				max_tokens: 4096,
				messages: [{
					role: "user",
					content: prompt
				}]
			};
			if (system) body.system = system;
			const resp = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01"
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});
			if (!resp.ok) {
				const errBody = await resp.text().catch(() => "");
				throw new Error(`Anthropic API ${resp.status}: ${errBody.slice(0, 200)}`);
			}
			return { text: (await resp.json()).content?.find((c) => c.type === "text")?.text ?? "" };
		} finally {
			clearTimeout(timer);
		}
	};
}
//#endregion
//#region src/claworks/pack-runtime.ts
const INSTALLED_STATE_FILE = "packs-installed.json";
function resolvePacksInstallRoot() {
	return join(homedir(), ".claworks", "packs");
}
function resolveInstalledStatePath() {
	return join(homedir(), ".claworks", INSTALLED_STATE_FILE);
}
async function loadPersistedInstalled() {
	try {
		const raw = JSON.parse(await readFile(resolveInstalledStatePath(), "utf8"));
		return Array.isArray(raw.installed) ? raw.installed.map(String) : [];
	} catch {
		return [];
	}
}
async function persistInstalled(installed) {
	await writeFile(resolveInstalledStatePath(), `${JSON.stringify({ installed: [...new Set(installed)] }, null, 2)}\n`, "utf8");
}
function mergePackConfig(config, persisted) {
	const installed = [...new Set([...config?.installed ?? [], ...persisted])];
	const paths = [
		...config?.paths ?? [],
		resolvePacksInstallRoot(),
		join(process.cwd(), "packs"),
		join(process.cwd(), "../claworks-packs")
	];
	return {
		...config,
		paths: [...new Set(paths)],
		installed
	};
}
async function applyPackContributions(runtime, packs, opts) {
	if (opts?.clearRegistries) {
		runtime.actionRegistry.clear();
		runtime.intentRegistry.clear();
	}
	for (const pack of packs) if (pack.scaffolds?.length && runtime.scaffoldEngine) {
		for (const scaffold of pack.scaffolds) runtime.scaffoldEngine.loadFromJson(scaffold);
		runtime.logger?.(`[claworks:packs] registered ${pack.scaffolds.length} scaffolds from pack '${pack.manifest.id}'`);
	}
	for (const pack of packs) {
		if (!pack.factory) continue;
		try {
			const contribution = await pack.factory(runtime);
			if (contribution.capabilities?.length) {
				runtime.capabilities.registerAll(contribution.capabilities);
				runtime.logger?.(`[claworks:packs] registered ${contribution.capabilities.length} capabilities from pack '${pack.manifest.id}'`);
			}
			if (contribution.actionHandlers && Object.keys(contribution.actionHandlers).length > 0) {
				runtime.actionRegistry.registerAll(pack.manifest.id, contribution.actionHandlers);
				runtime.logger?.(`[claworks:packs] registered ${Object.keys(contribution.actionHandlers).length} action handlers from pack '${pack.manifest.id}'`);
			}
			if (contribution.intentMappings?.length) {
				runtime.intentRegistry.registerAll(pack.manifest.id, contribution.intentMappings);
				runtime.logger?.(`[claworks:packs] registered ${contribution.intentMappings.length} intent mappings from pack '${pack.manifest.id}'`);
			}
			if (contribution.scripts?.length) {
				runtime.scriptLibrary?.registerFromPack(pack.manifest.id, contribution.scripts);
				runtime.logger?.(`[claworks:packs] registered ${contribution.scripts.length} scripts from pack '${pack.manifest.id}'`);
			}
			if (contribution.scaffolds?.length && runtime.scaffoldEngine) {
				for (const scaffold of contribution.scaffolds) runtime.scaffoldEngine.loadFromJson(scaffold);
				runtime.logger?.(`[claworks:packs] registered ${contribution.scaffolds.length} code scaffolds from pack '${pack.manifest.id}'`);
			}
			if (contribution.objectTypes?.length) {
				for (const typeDef of contribution.objectTypes) runtime.ontology?.registerType?.(typeDef);
				runtime.logger?.(`[claworks:packs] registered ${contribution.objectTypes.length} object types from pack '${pack.manifest.id}'`);
			}
			if (contribution.playbooks?.length) {
				for (const playbook of contribution.playbooks) runtime.playbookEngine.load(playbook);
				runtime.kernel.matcher.load(runtime.playbookEngine.list());
				runtime.scheduler.reload(runtime.playbookEngine.list());
				runtime.logger?.(`[claworks:packs] registered ${contribution.playbooks.length} code playbooks from pack '${pack.manifest.id}'`);
			}
			if (contribution.hooks?.length) {
				for (const hook of contribution.hooks) runtime.kernel?.bus?.subscribe?.(hook.event, async (e) => {
					await hook.handler(e.payload);
				});
				runtime.logger?.(`[claworks:packs] registered ${contribution.hooks.length} hooks from pack '${pack.manifest.id}'`);
			}
			if (contribution.promptTemplates?.length && runtime.scaffoldEngine) {
				for (const tmpl of contribution.promptTemplates) runtime.scaffoldEngine.loadFromJson(tmpl);
				runtime.logger?.(`[claworks:packs] registered ${contribution.promptTemplates.length} prompt templates from pack '${pack.manifest.id}'`);
			}
			if (contribution.onLoad) await contribution.onLoad(runtime);
		} catch (err) {
			runtime.logger?.(`[claworks:packs] factory error in pack '${pack.manifest.id}': ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
async function reloadClaworksPacks(runtime) {
	const persisted = await loadPersistedInstalled();
	const packConfig = mergePackConfig(runtime.config.packs, persisted);
	runtime.config.packs = packConfig;
	const packs = await runtime.packLoader.loadInstalled(packConfig, runtime.logger);
	runtime.loadedPacks.splice(0, runtime.loadedPacks.length, ...packs);
	await runtime.ontology.loadFromPacks(packs);
	await runtime.playbookEngine.loadFromPacks(packs);
	runtime.kernel.matcher.load(runtime.playbookEngine.list());
	runtime.scheduler.reload(runtime.playbookEngine.list());
	await applyPackContributions(runtime, packs, { clearRegistries: true });
	const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync-B-SXi7LG.mjs");
	await syncRbacFromObjectStore(runtime);
	await syncIngressFromObjectStore(runtime);
}
async function reloadClaworksPackById(runtime, packId) {
	const { resolvePackDir } = await import("./pack-loader/index.mjs");
	const dir = await resolvePackDir(packId, runtime.config.packs?.paths ?? []);
	if (!dir) return null;
	const pack = await runtime.packLoader.load(dir, runtime.logger);
	const idx = runtime.loadedPacks.findIndex((p) => p.manifest.id === packId);
	if (idx >= 0) runtime.loadedPacks[idx] = pack;
	else runtime.loadedPacks.push(pack);
	await runtime.ontology.reloadPack(packId, pack);
	await runtime.playbookEngine.loadFromPacks(runtime.loadedPacks);
	runtime.kernel.matcher.load(runtime.playbookEngine.list());
	runtime.scheduler.reload(runtime.playbookEngine.list());
	if (pack.scaffolds?.length && runtime.scaffoldEngine) {
		for (const scaffold of pack.scaffolds) runtime.scaffoldEngine.loadFromJson(scaffold);
		runtime.logger?.(`[claworks:packs] registered ${pack.scaffolds.length} scaffolds from pack '${packId}'`);
	}
	if (pack.factory) try {
		const contribution = await pack.factory(runtime);
		if (contribution.capabilities?.length) {
			runtime.capabilities.registerAll(contribution.capabilities);
			runtime.logger?.(`[claworks:packs] registered ${contribution.capabilities.length} capabilities from pack '${packId}'`);
		}
		if (contribution.actionHandlers && Object.keys(contribution.actionHandlers).length > 0) {
			runtime.actionRegistry.registerAll(packId, contribution.actionHandlers);
			runtime.logger?.(`[claworks:packs] registered ${Object.keys(contribution.actionHandlers).length} action handlers from pack '${packId}'`);
		}
		if (contribution.intentMappings?.length) {
			runtime.intentRegistry.registerAll(packId, contribution.intentMappings);
			runtime.logger?.(`[claworks:packs] registered ${contribution.intentMappings.length} intent mappings from pack '${packId}'`);
		}
		if (contribution.scripts?.length) {
			runtime.scriptLibrary?.registerFromPack(packId, contribution.scripts);
			runtime.logger?.(`[claworks:packs] registered ${contribution.scripts.length} scripts from pack '${packId}'`);
		}
		if (contribution.scaffolds?.length && runtime.scaffoldEngine) {
			for (const scaffold of contribution.scaffolds) runtime.scaffoldEngine.loadFromJson(scaffold);
			runtime.logger?.(`[claworks:packs] registered ${contribution.scaffolds.length} code scaffolds from pack '${packId}'`);
		}
		if (contribution.onLoad) await contribution.onLoad(runtime);
	} catch (err) {
		runtime.logger?.(`[claworks:packs] factory error in pack '${packId}': ${err instanceof Error ? err.message : String(err)}`);
	}
	return pack;
}
async function markInstalled(packId) {
	const persisted = await loadPersistedInstalled();
	if (!persisted.includes(packId)) {
		persisted.push(packId);
		await persistInstalled(persisted);
	}
}
async function installClaworksPack(runtime, source) {
	const registry = runtime.config.packs?.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080";
	let packId;
	if (source.startsWith("file://")) {
		packId = (await runtime.packLoader.load(source.slice(7))).manifest.id;
		await markInstalled(packId);
	} else if (source.startsWith("nexus://") || !source.includes("/")) {
		const { slug } = await installPackFromNexus({
			registry,
			source: source.startsWith("nexus://") ? source : `nexus://${source}`,
			installRoot: resolvePacksInstallRoot()
		});
		packId = slug;
		await markInstalled(packId);
	} else {
		packId = (await runtime.packLoader.install(source, runtime.config.packs ?? {})).manifest.id;
		await markInstalled(packId);
	}
	await reloadClaworksPacks(runtime);
	const pack = runtime.loadedPacks.find((p) => p.manifest.id === packId);
	if (!pack) throw new Error(`Pack install completed but pack not loaded: ${packId}`);
	return {
		pack,
		installed: runtime.config.packs?.installed ?? []
	};
}
async function uninstallClaworksPack(runtime, packId) {
	await persistInstalled((await loadPersistedInstalled()).filter((id) => id !== packId));
	runtime.config.packs = {
		...runtime.config.packs,
		installed: (runtime.config.packs?.installed ?? []).filter((id) => id !== packId)
	};
	await reloadClaworksPacks(runtime);
	return runtime.config.packs?.installed ?? [];
}
/** Re-install pack from Nexus or local path (same as install; refreshes artifacts). */
async function updateClaworksPack(runtime, source) {
	return await installClaworksPack(runtime, source);
}
async function reloadClaworksPacksFromDisk(runtime) {
	await reloadClaworksPacks(runtime);
	return { packs: runtime.loadedPacks };
}
async function searchNexusPackages(runtime, q) {
	const { listNexusPackages } = await import("./pack-loader/index.mjs");
	return await listNexusPackages(runtime.config.packs?.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080", { q });
}
//#endregion
//#region src/claworks/notify-config-repair.ts
function pickAllowFromEntry(allowFrom) {
	if (!Array.isArray(allowFrom)) return;
	for (const entry of allowFrom) {
		const value = String(entry ?? "").trim();
		if (!value || value === "*") continue;
		return value;
	}
}
function deriveFeishuTarget(channels) {
	const feishu = channels?.feishu;
	if (!feishu) return;
	const top = pickAllowFromEntry(feishu.allowFrom);
	if (top) return top;
	const accounts = feishu.accounts;
	if (accounts) {
		const defaultAccount = typeof feishu.defaultAccount === "string" ? feishu.defaultAccount : void 0;
		const ordered = defaultAccount ? [defaultAccount, ...Object.keys(accounts).filter((id) => id !== defaultAccount)] : Object.keys(accounts);
		for (const accountId of ordered) {
			const account = accounts[accountId];
			const fromAccount = pickAllowFromEntry(account?.allowFrom);
			if (fromAccount) return fromAccount;
		}
	}
}
function deriveTelegramTarget(channels) {
	const telegram = channels?.telegram;
	if (!telegram) return;
	const top = pickAllowFromEntry(telegram.allowFrom);
	if (top) return top;
	const accounts = telegram.accounts;
	if (accounts) for (const account of Object.values(accounts)) {
		const fromAccount = pickAllowFromEntry(account?.allowFrom);
		if (fromAccount) return fromAccount;
	}
}
function deriveOwnerTarget(stateDir) {
	const robotMd = join(stateDir, "robot.md");
	if (!existsSync(robotMd)) return;
	try {
		const owner = extractOwnerFromMd(readFileSync(robotMd, "utf8"));
		if (!owner?.ownerId) return;
		return {
			channel: owner.channelId ?? "feishu",
			to: owner.ownerId
		};
	} catch {
		return;
	}
}
/** Derive notify.targets from OpenClaw channel allowFrom + robot.md Owner. */
function deriveNotifyTargetsFromOpenClawConfig(config, opts) {
	const targets = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (target) => {
		const key = `${target.channel}:${target.to}`;
		if (!target.to || seen.has(key)) return;
		seen.add(key);
		targets.push(target);
	};
	const channels = config.channels;
	const feishuTo = deriveFeishuTarget(channels);
	if (feishuTo) push({
		channel: "feishu",
		to: feishuTo
	});
	const telegramTo = deriveTelegramTarget(channels);
	if (telegramTo) push({
		channel: "telegram",
		to: telegramTo
	});
	const ownerTarget = deriveOwnerTarget(opts?.stateDir?.trim() || defaultClaworksStateDir());
	if (ownerTarget) push(ownerTarget);
	return targets;
}
function repairNotifyTargets(config, robotConfig, opts) {
	const actions = [];
	robotConfig.notify ??= {};
	if ((robotConfig.notify.targets ?? []).length > 0) return {
		changed: false,
		actions
	};
	const derived = deriveNotifyTargetsFromOpenClawConfig(config, opts);
	if (derived.length === 0) return {
		changed: false,
		actions
	};
	robotConfig.notify.targets = derived;
	actions.push(`notify.targets derived: ${derived.map((t) => `${t.channel}:${t.to}`).join(", ")}`);
	if (!robotConfig.notify.default_channel) {
		robotConfig.notify.default_channel = derived[0]?.channel ?? "feishu";
		actions.push(`notify.default_channel = ${robotConfig.notify.default_channel}`);
	}
	return {
		changed: true,
		actions
	};
}
//#endregion
//#region src/claworks/personal-enterprise-repair.ts
/** Plugins for solo enterprise (Feishu + KB + docs); excludes Ali `qwen` channel plugin. */
const PERSONAL_WORK_PLUGIN_ALLOW = [
	"claworks-robot",
	"feishu",
	"webhooks",
	"memory-core",
	"memory-lancedb",
	"skill-workshop",
	"openai",
	"file-transfer",
	"document-extract"
];
const PERSONAL_WORK_PACK_IDS = [
	"base",
	"enterprise-general",
	"enterprise-commercial",
	"personal-enterprise"
];
function detectSelfHostedProviderFromConfig(config) {
	const providers = config.models?.providers;
	if (!providers) return null;
	for (const [providerId, spec] of Object.entries(providers)) {
		if (spec.api !== "openai-completions" || typeof spec.baseUrl !== "string") continue;
		const modelList = spec.models;
		const chatModel = (Array.isArray(modelList) && modelList.length > 0 ? modelList[0] : void 0)?.id?.trim();
		if (!chatModel) continue;
		return {
			providerId,
			baseUrl: spec.baseUrl.replace(/\/$/, ""),
			apiKey: typeof spec.apiKey === "string" ? spec.apiKey : "local",
			chatModel,
			embedModel: process.env.CLAWORKS_QWEN_EMBED_MODEL?.trim() || process.env.CLAWORKS_KB_EMBED_MODEL?.trim() || "text-embedding-v3"
		};
	}
	return null;
}
function resolveSelfHostedQwenFromEnv(config) {
	const fromEnvUrl = process.env.CLAWORKS_QWEN_BASE_URL?.trim();
	if (fromEnvUrl) return {
		providerId: "qwen-local",
		baseUrl: (fromEnvUrl || process.env.OPENAI_BASE_URL?.trim() || "http://127.0.0.1:8000/v1").replace(/\/$/, ""),
		apiKey: process.env.CLAWORKS_QWEN_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "local",
		chatModel: process.env.CLAWORKS_QWEN_CHAT_MODEL?.trim() || "qwen3",
		embedModel: process.env.CLAWORKS_QWEN_EMBED_MODEL?.trim() || process.env.CLAWORKS_KB_EMBED_MODEL?.trim() || "text-embedding-v3"
	};
	const existing = config ? detectSelfHostedProviderFromConfig(config) : null;
	if (existing) return existing;
	return {
		providerId: "qwen-local",
		baseUrl: (process.env.OPENAI_BASE_URL?.trim() || "http://127.0.0.1:8000/v1").replace(/\/$/, ""),
		apiKey: process.env.CLAWORKS_QWEN_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "local",
		chatModel: process.env.CLAWORKS_QWEN_CHAT_MODEL?.trim() || "qwen3",
		embedModel: process.env.CLAWORKS_QWEN_EMBED_MODEL?.trim() || process.env.CLAWORKS_KB_EMBED_MODEL?.trim() || "text-embedding-v3"
	};
}
function parseKbWatchDirs() {
	const raw = process.env.CLAWORKS_KB_WATCH_DIRS?.trim();
	if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
	const home = homedir();
	return [
		join(home, "Projects", "claworks", "docs"),
		join(home, "Projects", "claworks-packs"),
		join(home, "Documents")
	].filter((p) => p.length > 0);
}
/**
* Personal enterprise profile: Feishu OA packs, vector KB, self-hosted Qwen via `models.providers.qwen-local` + `openai` plugin (not `qwen` extension).
*/
function repairPersonalEnterpriseProfile(config) {
	const actions = [];
	const warnings = [];
	let changed = false;
	const qwen = resolveSelfHostedQwenFromEnv(config);
	const plugins = config.plugins ?? {};
	config.plugins = plugins;
	const allow = [...PERSONAL_WORK_PLUGIN_ALLOW];
	if (JSON.stringify(plugins.allow) !== JSON.stringify(allow)) {
		plugins.allow = allow;
		actions.push(`plugins.allow -> personal_work (${allow.length} plugins, no Ali qwen channel)`);
		changed = true;
	}
	plugins.slots = {
		memory: "memory-lancedb",
		...plugins.slots ?? {}
	};
	const models = config.models ?? {};
	config.models = models;
	const providers = models.providers ?? {};
	const providerId = qwen.providerId;
	const existingProvider = providers[providerId];
	const nextProvider = {
		...existingProvider,
		baseUrl: qwen.baseUrl,
		apiKey: existingProvider?.apiKey ?? qwen.apiKey,
		api: "openai-completions",
		models: existingProvider?.models ?? [{
			id: qwen.chatModel,
			name: "Qwen (self-hosted)"
		}]
	};
	if (JSON.stringify(existingProvider) !== JSON.stringify(nextProvider)) {
		providers[providerId] = nextProvider;
		models.providers = providers;
		actions.push(`models.providers.${providerId} preserved (${qwen.chatModel})`);
		changed = true;
	}
	const agents = config.agents ?? {};
	config.agents = agents;
	const defaults = agents.defaults ?? {};
	agents.defaults = defaults;
	const primary = `${providerId}/${qwen.chatModel}`;
	const model = defaults.model ?? {};
	if (!model.primary) {
		defaults.model = {
			...model,
			primary
		};
		actions.push(`agents.defaults.model.primary -> ${primary}`);
		changed = true;
	}
	const entries = plugins.entries ?? {};
	plugins.entries = entries;
	entries["claworks-robot"] ??= {
		enabled: true,
		config: {}
	};
	entries["claworks-robot"].enabled = true;
	const robotCfg = entries["claworks-robot"].config ?? {};
	entries["claworks-robot"].config = robotCfg;
	robotCfg.data ??= {};
	if (robotCfg.data.kb_provider !== "memory-core") {
		robotCfg.data.kb_provider = "memory-core";
		changed = true;
		actions.push("data.kb_provider = memory-core");
	}
	if (robotCfg.data.kb_embed_model !== qwen.embedModel) {
		robotCfg.data.kb_embed_model = qwen.embedModel;
		changed = true;
		actions.push(`data.kb_embed_model = ${qwen.embedModel}`);
	}
	const watchDirs = parseKbWatchDirs();
	const existingDirs = robotCfg.data.kb_watch_dirs ?? [];
	if (JSON.stringify(existingDirs) !== JSON.stringify(watchDirs)) {
		robotCfg.data.kb_watch_dirs = watchDirs;
		changed = true;
		actions.push(`data.kb_watch_dirs (${watchDirs.length} paths)`);
	}
	robotCfg.model_router ??= {};
	if (robotCfg.model_router.chat !== primary) {
		robotCfg.model_router.chat = primary;
		changed = true;
	}
	if (robotCfg.model_router.embed !== qwen.embedModel) {
		robotCfg.model_router.embed = qwen.embedModel;
		changed = true;
	}
	robotCfg.kernel ??= {};
	if (robotCfg.kernel.scheduler_timezone !== "Asia/Shanghai") {
		robotCfg.kernel.scheduler_timezone = "Asia/Shanghai";
		changed = true;
		actions.push("kernel.scheduler_timezone = Asia/Shanghai");
	}
	robotCfg.im_bridge ??= {};
	if (robotCfg.im_bridge.auto_on_message_received !== true) {
		robotCfg.im_bridge.auto_on_message_received = true;
		changed = true;
		actions.push("im_bridge.auto_on_message_received = true");
	}
	robotCfg.notify ??= {};
	if (robotCfg.notify.default_channel !== "feishu") {
		robotCfg.notify.default_channel = "feishu";
		changed = true;
	}
	robotCfg.packs ??= {
		paths: [],
		installed: []
	};
	const packPaths = [
		...robotCfg.packs.paths ?? [],
		process.env.CLAWORKS_PACKS_DIR?.trim(),
		join(process.cwd(), "..", "claworks-packs"),
		join(process.cwd(), "claworks-packs")
	].filter((p) => typeof p === "string" && Boolean(p.trim()) && existsSync(p));
	robotCfg.packs.paths = [...new Set(packPaths)];
	const installed = [...new Set([...PERSONAL_WORK_PACK_IDS, ...robotCfg.packs.installed ?? []])];
	if (JSON.stringify(robotCfg.packs.installed) !== JSON.stringify(installed)) {
		robotCfg.packs.installed = installed;
		changed = true;
		actions.push(`packs.installed: ${installed.join(", ")}`);
	}
	robotCfg.connectors ??= {};
	const fsConnector = {
		preset: "filesystem-kb",
		enabled: true,
		env: {
			CLAWORKS_KB_WATCH_DIRS: watchDirs.join(","),
			CLAWORKS_KB_WATCH_INTERVAL_MS: process.env.CLAWORKS_KB_WATCH_INTERVAL_MS?.trim() || "300000",
			CLAWORKS_KB_NAMESPACE: process.env.CLAWORKS_KB_NAMESPACE?.trim() || "work"
		}
	};
	const prev = robotCfg.connectors["filesystem-kb"];
	if (JSON.stringify(prev) !== JSON.stringify(fsConnector)) {
		robotCfg.connectors["filesystem-kb"] = fsConnector;
		changed = true;
		actions.push("connectors.filesystem-kb enabled");
	}
	entries["memory-lancedb"] ??= {
		enabled: true,
		config: {}
	};
	entries["memory-lancedb"].enabled = true;
	const lanceCfg = entries["memory-lancedb"].config ?? {};
	entries["memory-lancedb"].config = lanceCfg;
	const embedding = lanceCfg.embedding ?? {};
	const nextEmbed = {
		...embedding,
		provider: "openai",
		model: qwen.embedModel,
		baseUrl: qwen.baseUrl,
		apiKey: qwen.apiKey
	};
	if (JSON.stringify(embedding) !== JSON.stringify(nextEmbed)) {
		lanceCfg.embedding = nextEmbed;
		actions.push("memory-lancedb.embedding -> self-hosted OpenAI-compatible");
		changed = true;
	}
	const vectorRepair = repairVectorKnowledgeBase(config, { force: true });
	actions.push(...vectorRepair.actions);
	warnings.push(...vectorRepair.warnings);
	if (vectorRepair.changed) changed = true;
	if (!process.env.CLAWORKS_QWEN_BASE_URL?.trim() && !detectSelfHostedProviderFromConfig(config)) warnings.push("Set CLAWORKS_QWEN_BASE_URL or models.providers.*.baseUrl for self-hosted Qwen");
	else if (!process.env.CLAWORKS_QWEN_BASE_URL?.trim()) warnings.push(`Using existing models.providers.${providerId} (self-hosted, not Ali qwen plugin)`);
	warnings.push("LLM uses models.providers.qwen-local + openai plugin — do NOT enable plugins/qwen (Alibaba cloud API key)");
	return {
		changed,
		actions,
		warnings
	};
}
function isPersonalWorkProfile() {
	return process.env.CLAWORKS_PRODUCT_PROFILE?.trim() === "personal_work";
}
//#endregion
//#region src/claworks/product-config-repair.ts
/** OpenClaw personal install default; ClaWorks product must not bind here. */
const OPENCLAW_RESERVED_GATEWAY_PORT = 18789;
const CLAWORKS_STANDARD_GATEWAY_PORT = 18800;
const DEFAULT_CLAWORKS_PACK_IDS = [
	"base",
	"enterprise-foundation",
	"process-industry",
	"enterprise-general",
	"enterprise-commercial"
];
const OT_SIMULATE_PRESET_SUFFIX = "-simulate";
/** Normalize OT connector presets for production (no simulate / no *-simulate presets). */
function repairOtConnectorSimulateFlags(connectors, opts = {}) {
	const env = opts.env ?? process.env;
	const enforceProduction = opts.productionMode === true || env.CLAWORKS_PRODUCTION === "1" || env.CLAWORKS_INIT_SECURE === "1";
	if (!connectors) return {
		connectors: {},
		actions: [],
		changed: false
	};
	const next = { ...connectors };
	let changed = false;
	const actions = [];
	for (const [id, raw] of Object.entries(next)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = { ...raw };
		let entryChanged = false;
		if (typeof entry.preset === "string" && entry.preset.endsWith(OT_SIMULATE_PRESET_SUFFIX)) {
			entry.preset = entry.preset.slice(0, -9);
			entry.simulate = false;
			entryChanged = true;
			actions.push(`connectors.${id}.preset → ${entry.preset} (removed -simulate suffix)`);
		}
		if (enforceProduction && entry.simulate === true) {
			entry.simulate = false;
			entryChanged = true;
			actions.push(`connectors.${id}.simulate = false (production)`);
		}
		if (entryChanged) {
			next[id] = entry;
			changed = true;
		}
	}
	return {
		connectors: next,
		actions,
		changed
	};
}
const LEGACY_L0_PACK = "core";
const NEW_L0_PACK = "base";
const LEGACY_CHAIN_PACKS = new Set([
	"core",
	"comms",
	"knowledge",
	"workflow"
]);
const NEW_CHAIN_MARKERS = new Set([
	"base",
	"enterprise-foundation",
	"process-industry"
]);
/** Detect core (legacy) + base (new) L0 both installed — causes playbook ID collisions. */
function detectPackLayerSystemConflict(installed) {
	const ids = new Set(installed);
	const hasCore = ids.has(LEGACY_L0_PACK);
	const hasBase = ids.has(NEW_L0_PACK);
	if (hasCore && hasBase) return {
		conflict: true,
		message: "Both legacy L0 (core) and new L0 (base) installed — use one system (see claworks-packs/PACK-LAYER-SYSTEMS.md)"
	};
	const legacyOther = [...LEGACY_CHAIN_PACKS].some((p) => ids.has(p) && p !== LEGACY_L0_PACK);
	const newOther = [...NEW_CHAIN_MARKERS].some((p) => ids.has(p));
	if (hasCore && newOther) return {
		conflict: true,
		message: "Mixed legacy core-chain and new base-chain packs — pick one profile from claworks.packs.json"
	};
	if (hasBase && legacyOther && !hasCore) return {
		conflict: false,
		message: "base + legacy comms/knowledge/workflow — prefer new profiles only"
	};
	return {
		conflict: false,
		message: null
	};
}
function discoverPackSourceDir(cwd = process.cwd()) {
	const env = process.env.CLAWORKS_PACKS_DIR?.trim();
	if (env && existsSync(env)) return resolve(env);
	const candidates = [
		join(cwd, "claworks-packs"),
		join(cwd, "..", "claworks-packs"),
		join(fileURLToPath(new URL("../../../..", import.meta.url)), "..", "claworks-packs")
	];
	for (const dir of candidates) if (existsSync(join(dir, "base", "claworks.pack.json"))) return resolve(dir);
	return null;
}
/** True when sibling claworks-packs or ~/.claworks/packs has at least one pack. */
function hasPackSourcesAvailable(opts) {
	if (discoverPackSourceDir(opts?.cwd)) return true;
	const packsRoot = join(opts?.stateDir?.trim() || join(homedir(), ".claworks"), "packs");
	if (!existsSync(packsRoot)) return false;
	for (const name of readdirSync(packsRoot)) if (existsSync(join(packsRoot, name, "claworks.pack.json"))) return true;
	return false;
}
function discoverProductPluginAllowPath(cwd = process.cwd()) {
	const candidates = [
		join(cwd, "contrib/claworks-product.plugins.allow.json"),
		join(cwd, "..", "claworks", "contrib/claworks-product.plugins.allow.json"),
		join(fileURLToPath(new URL("../../../..", import.meta.url)), "contrib/claworks-product.plugins.allow.json")
	];
	for (const p of candidates) if (existsSync(p)) return resolve(p);
	return null;
}
function loadProductPluginAllow(profile = "extended") {
	const allowPath = discoverProductPluginAllowPath();
	if (!allowPath) return [
		"claworks-robot",
		"feishu",
		"webhooks",
		"memory-core",
		"memory-lancedb"
	];
	try {
		const raw = JSON.parse(readFileSync(allowPath, "utf8"));
		const core = raw.core ?? ["claworks-robot"];
		if (profile === "personal_work") return raw.personal_work ?? core;
		if (profile === "full") return [...new Set([
			...core,
			...raw.optional_domestic_llm ?? [],
			...raw.optional_enterprise ?? []
		])];
		if (profile === "core") return core;
		return [...new Set([...core, ...raw.optional_domestic_llm ?? []])];
	} catch {
		return [
			"claworks-robot",
			"feishu",
			"webhooks",
			"memory-core",
			"memory-lancedb"
		];
	}
}
function repairProductPluginsAllow(config, opts) {
	const actions = [];
	const warnings = [];
	let changed = false;
	const desired = loadProductPluginAllow(opts?.profile?.trim() || process.env.CLAWORKS_PRODUCT_PROFILE?.trim() || (process.env.CLAWORKS_INIT_PROFILE?.trim() === "core" ? "core" : "extended"));
	const plugins = config.plugins ?? {};
	config.plugins = plugins;
	const allow = new Set(Array.isArray(plugins.allow) ? plugins.allow : []);
	for (const id of desired) if (!allow.has(id)) {
		allow.add(id);
		actions.push(`plugins.allow: added ${id}`);
		changed = true;
	}
	if (changed) plugins.allow = [...allow];
	const entries = plugins.entries ?? {};
	plugins.entries = entries;
	entries["claworks-robot"] ??= { enabled: true };
	if (entries["claworks-robot"].enabled !== true) {
		entries["claworks-robot"].enabled = true;
		actions.push("plugins.entries.claworks-robot.enabled = true");
		changed = true;
	}
	if (allow.has("feishu") && entries.feishu?.enabled !== true) {
		entries.feishu = {
			...entries.feishu,
			enabled: true
		};
		actions.push("plugins.entries.feishu.enabled = true");
		changed = true;
	}
	return {
		changed,
		actions,
		warnings
	};
}
function resolvePackSourcePath(packId, primaryDir) {
	if (!primaryDir) return null;
	const primary = join(primaryDir, packId);
	if (existsSync(primary)) return primary;
	return null;
}
function seedPacksToStateDir(opts) {
	const destRoot = join(opts?.stateDir?.trim() || join(homedir(), ".claworks"), "packs");
	const primaryDir = opts?.sourceDir?.trim() || discoverPackSourceDir();
	const packIds = opts?.packIds ?? DEFAULT_CLAWORKS_PACK_IDS;
	const linked = [];
	const missing = [];
	const warnings = [];
	mkdirSync(destRoot, { recursive: true });
	if (!primaryDir) {
		warnings.push("No claworks-packs source found — clone sibling repo or set CLAWORKS_PACKS_DIR to a directory containing base/, process-industry/, etc.");
		return {
			linked,
			missing: [...packIds],
			warnings
		};
	}
	for (const packId of packIds) {
		const src = resolvePackSourcePath(packId, primaryDir);
		const dest = join(destRoot, packId);
		if (!src) {
			missing.push(packId);
			continue;
		}
		if (existsSync(dest)) {
			linked.push(packId);
			continue;
		}
		try {
			symlinkSync(src, dest, "dir");
			linked.push(packId);
		} catch (err) {
			warnings.push(`Could not symlink ${packId}: ${err instanceof Error ? err.message : String(err)}`);
			missing.push(packId);
		}
	}
	return {
		linked,
		missing,
		warnings
	};
}
const VECTOR_KB_PLUGIN_IDS = ["memory-core", "memory-lancedb"];
/** Wire OpenClaw memory-core + LanceDB for semantic KB (vector search). */
function repairVectorKnowledgeBase(config, opts) {
	const actions = [];
	const warnings = [];
	let changed = false;
	const plugins = config.plugins ?? {};
	config.plugins = plugins;
	const allow = new Set(Array.isArray(plugins.allow) ? plugins.allow : []);
	for (const id of VECTOR_KB_PLUGIN_IDS) if (!allow.has(id)) {
		allow.add(id);
		actions.push(`plugins.allow: added ${id}`);
		changed = true;
	}
	plugins.allow = [...allow];
	const entries = plugins.entries ?? {};
	plugins.entries = entries;
	if (entries["memory-core"] !== void 0) {
		delete entries["memory-core"];
		actions.push("plugins.entries.memory-core: removed (memory slot uses memory-lancedb)");
		changed = true;
	}
	const memoryLance = entries["memory-lancedb"] ?? {};
	if (memoryLance.enabled === false) warnings.push("memory-lancedb disabled — vector store slot may fail");
	else {
		const prev = JSON.stringify(memoryLance);
		entries["memory-lancedb"] = {
			...memoryLance,
			enabled: true
		};
		if (prev !== JSON.stringify(entries["memory-lancedb"])) {
			actions.push("plugins.entries.memory-lancedb: enabled");
			changed = true;
		}
	}
	const slots = plugins.slots ?? {};
	if (slots.memory !== "memory-lancedb") {
		plugins.slots = {
			...slots,
			memory: "memory-lancedb"
		};
		actions.push("plugins.slots.memory = memory-lancedb");
		changed = true;
	}
	const robotEntry = entries["claworks-robot"] ?? {};
	entries["claworks-robot"] = robotEntry;
	const robotConfig = robotEntry.config ?? {};
	robotEntry.config = robotConfig;
	robotConfig.data ??= {};
	const kbPath = join(defaultClaworksStateDir(), "kb", "lancedb");
	if (!robotConfig.data.kb_path || opts?.force) {
		robotConfig.data.kb_path = kbPath;
		actions.push(`data.kb_path -> ${kbPath}`);
		changed = true;
	}
	if (robotConfig.data.kb_provider !== "memory-core") {
		robotConfig.data.kb_provider = "memory-core";
		actions.push("data.kb_provider = memory-core");
		changed = true;
	}
	const embedModel = robotConfig.data.kb_embed_model?.trim() || robotConfig.model_router?.embed?.trim() || "text-embedding-3-small";
	if (!robotConfig.data.kb_embed_model) {
		robotConfig.data.kb_embed_model = embedModel;
		actions.push(`data.kb_embed_model = ${embedModel}`);
		changed = true;
	}
	const lanceEntry = entries["memory-lancedb"] ?? {};
	const lanceCfg = lanceEntry.config ?? {};
	const embedding = lanceCfg.embedding ?? {};
	if (embedding.model !== embedModel) {
		entries["memory-lancedb"] = {
			...lanceEntry,
			enabled: lanceEntry.enabled !== false,
			config: {
				...lanceCfg,
				embedding: {
					...embedding,
					model: embedModel
				}
			}
		};
		actions.push(`plugins.entries.memory-lancedb.embedding.model = ${embedModel}`);
		changed = true;
	}
	return {
		changed,
		actions,
		warnings
	};
}
function repairClaworksRobotPluginConfig(config, opts) {
	const actions = [];
	const warnings = [];
	let changed = false;
	const plugins = config.plugins ?? {};
	config.plugins = plugins;
	const allow = Array.isArray(plugins.allow) ? [...plugins.allow] : [];
	if (!allow.includes("claworks-robot")) {
		allow.unshift("claworks-robot");
		plugins.allow = allow;
		actions.push("plugins.allow: added claworks-robot");
		changed = true;
	}
	const entries = plugins.entries ?? {};
	plugins.entries = entries;
	const entry = entries["claworks-robot"] ?? {};
	entries["claworks-robot"] = entry;
	if (entry.enabled === false) {
		entry.enabled = true;
		actions.push("plugins.entries.claworks-robot.enabled: true");
		changed = true;
	} else if (entry.enabled !== true) {
		entry.enabled = true;
		actions.push("plugins.entries.claworks-robot: created/enabled");
		changed = true;
	}
	const pluginConfig = entry.config ?? {};
	entry.config = pluginConfig;
	pluginConfig.robot ??= {
		name: "local-robot",
		role: "monolith",
		host: "127.0.0.1",
		port: Number(process.env.CLAWORKS_GATEWAY_PORT || 18800)
	};
	pluginConfig.data ??= { database_url: `sqlite://${join(homedir(), ".claworks", "robot.db")}` };
	const packs = pluginConfig.packs ?? {};
	pluginConfig.packs = packs;
	const statePacks = join(homedir(), ".claworks", "packs");
	const sourceDir = opts?.packSourceDir ?? discoverPackSourceDir();
	const paths = new Set([
		...packs.paths ?? [],
		statePacks,
		sourceDir
	].filter((p) => typeof p === "string" && p.length > 0));
	if (paths.size > (packs.paths?.length ?? 0)) {
		packs.paths = [...paths];
		actions.push(`packs.paths: ${[...paths].join(", ")}`);
		changed = true;
	}
	const installed = new Set([...packs.installed ?? [], ...DEFAULT_CLAWORKS_PACK_IDS]);
	if (installed.size > (packs.installed?.length ?? 0)) {
		packs.installed = [...installed];
		actions.push(`packs.installed: ${[...installed].join(", ")}`);
		changed = true;
	}
	const layerConflict = detectPackLayerSystemConflict(packs.installed ?? []);
	if (layerConflict.conflict && layerConflict.message) warnings.push(layerConflict.message);
	else if (layerConflict.message) warnings.push(layerConflict.message);
	const connectors = pluginConfig.connectors ?? {};
	if (opts?.enableEchoConnector !== false && !connectors.echo) {
		pluginConfig.connectors = {
			...connectors,
			echo: {
				preset: "echo",
				enabled: true
			}
		};
		actions.push("connectors.echo: enabled (demo OT/events)");
		changed = true;
	}
	pluginConfig.im_bridge ??= {};
	if (pluginConfig.im_bridge.auto_on_message_received !== true) {
		pluginConfig.im_bridge.auto_on_message_received = true;
		actions.push("im_bridge.auto_on_message_received = true (OpenClaw channel → EventKernel)");
		changed = true;
	}
	pluginConfig.notify ??= {};
	if (!pluginConfig.notify.default_channel) {
		pluginConfig.notify.default_channel = "feishu";
		actions.push("notify.default_channel = feishu");
		changed = true;
	}
	const notifyRepair = repairNotifyTargets(config, pluginConfig, { stateDir: defaultClaworksStateDir() });
	if (notifyRepair.changed) {
		actions.push(...notifyRepair.actions);
		changed = true;
	}
	const otRepair = repairOtConnectorSimulateFlags(pluginConfig.connectors, { productionMode: pluginConfig.production_mode === true || isClaworksProductionMode(pluginConfig) });
	if (otRepair.changed) {
		pluginConfig.connectors = otRepair.connectors;
		actions.push(...otRepair.actions);
		changed = true;
	}
	const seed = seedPacksToStateDir({
		sourceDir: sourceDir ?? void 0,
		packIds: packs.installed
	});
	if (seed.linked.length > 0) {
		actions.push(`~/.claworks/packs linked: ${seed.linked.join(", ")}`);
		changed = true;
	}
	warnings.push(...seed.warnings);
	if (seed.missing.length > 0) warnings.push(`Pack sources missing on disk: ${seed.missing.join(", ")}`);
	return {
		changed,
		actions,
		warnings
	};
}
function isClaworksRobotConfigPresent(config) {
	return (config.plugins?.entries?.["claworks-robot"])?.enabled !== false;
}
function defaultClaworksStateDir() {
	return process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".claworks");
}
function discoverRobotMdExamplePath(cwd = process.cwd()) {
	const candidates = [
		join(cwd, "contrib/examples/robot.md"),
		join(cwd, "..", "claworks", "contrib/examples/robot.md"),
		join(fileURLToPath(new URL("../../../..", import.meta.url)), "contrib/examples/robot.md")
	];
	for (const p of candidates) if (existsSync(p)) return resolve(p);
	return null;
}
/** Seed ~/.claworks/robot.md from contrib/examples when missing. */
function seedRobotMdFromExample(opts) {
	const stateDir = opts?.stateDir?.trim() || defaultClaworksStateDir();
	const dest = join(stateDir, "robot.md");
	if (existsSync(dest)) return {
		seeded: false,
		path: dest,
		message: null
	};
	const example = opts?.examplePath?.trim() || discoverRobotMdExamplePath();
	if (!example || !existsSync(example)) return {
		seeded: false,
		path: dest,
		message: "robot.md example not found — copy contrib/examples/robot.md manually"
	};
	mkdirSync(stateDir, { recursive: true });
	copyFileSync(example, dest);
	return {
		seeded: true,
		path: dest,
		message: `robot.md seeded from ${example}`
	};
}
/**
* Full claworks.json repair: gateway port, plugins/packs/connectors, kb_provider, robot.md seed.
* Mutates `config` in place (same object returned).
*/
function repairClaworksJsonConfig(config, opts) {
	const actions = [];
	const warnings = [];
	let changed = false;
	const gateway = config.gateway ?? {};
	config.gateway = gateway;
	const gwPort = gateway.port;
	if (typeof gwPort !== "number" || gwPort === 18789 || !Number.isFinite(gwPort) || gwPort <= 0) {
		gateway.port = CLAWORKS_STANDARD_GATEWAY_PORT;
		actions.push(`gateway.port -> ${CLAWORKS_STANDARD_GATEWAY_PORT} (OpenClaw reserves ${OPENCLAW_RESERVED_GATEWAY_PORT})`);
		changed = true;
	}
	const pluginAllowRepair = repairProductPluginsAllow(config);
	actions.push(...pluginAllowRepair.actions);
	warnings.push(...pluginAllowRepair.warnings);
	if (pluginAllowRepair.changed) changed = true;
	const pluginRepair = repairClaworksRobotPluginConfig(config, {
		packSourceDir: opts?.packSourceDir,
		enableEchoConnector: opts?.enableEchoConnector
	});
	actions.push(...pluginRepair.actions);
	warnings.push(...pluginRepair.warnings);
	if (pluginRepair.changed) changed = true;
	const plugins = config.plugins;
	const robotConfig = (plugins?.entries?.["claworks-robot"])?.config;
	if (robotConfig?.robot?.port === 18789) {
		robotConfig.robot.port = CLAWORKS_STANDARD_GATEWAY_PORT;
		actions.push(`robot.port -> ${CLAWORKS_STANDARD_GATEWAY_PORT}`);
		changed = true;
	}
	if (isPersonalWorkProfile()) {
		const personal = repairPersonalEnterpriseProfile(config);
		actions.push(...personal.actions);
		warnings.push(...personal.warnings);
		if (personal.changed) changed = true;
	}
	if (process.env.CLAWORKS_VECTOR_KB === "1" || process.env.CLAWORKS_PRODUCT_PROFILE?.trim() === "personal_work" || process.env.CLAWORKS_INIT_PROFILE?.trim() === "enterprise" || process.env.CLAWORKS_PRODUCT === "1" || (plugins?.allow ?? []).includes("memory-core") || (plugins?.allow ?? []).includes("memory-lancedb")) {
		const vectorRepair = repairVectorKnowledgeBase(config);
		actions.push(...vectorRepair.actions);
		warnings.push(...vectorRepair.warnings);
		if (vectorRepair.changed) changed = true;
	} else if ((plugins?.allow ?? []).includes("memory-core") && robotConfig?.data) {
		if (!robotConfig.data.kb_provider) {
			robotConfig.data.kb_provider = "memory-core";
			actions.push("data.kb_provider = memory-core");
			changed = true;
		}
	}
	let robotMd;
	if (opts?.seedRobotMd !== false) {
		robotMd = seedRobotMdFromExample({ stateDir: opts?.stateDir });
		if (robotMd.seeded) {
			actions.push(robotMd.message ?? "robot.md seeded");
			changed = true;
		} else if (robotMd.message) warnings.push(robotMd.message);
	}
	return {
		changed,
		actions,
		warnings,
		robotMd
	};
}
//#endregion
//#region src/claworks/doctor.ts
function runClaworksDoctor(runtime) {
	const checks = [];
	checks.push({
		id: "kernel",
		status: "ok",
		message: null
	});
	const playbooks = runtime.playbookEngine.list();
	checks.push({
		id: "playbooks",
		status: playbooks.length > 0 ? "ok" : "warn",
		message: playbooks.length > 0 ? null : "No playbooks loaded — check packs.paths and packs.installed in config"
	});
	const types = runtime.ontology.listTypes();
	checks.push({
		id: "ontology",
		status: types.length > 0 ? "ok" : "warn",
		message: types.length > 0 ? null : "No object types loaded — install process-industry or other packs"
	});
	checks.push({
		id: "packs",
		status: runtime.loadedPacks.length > 0 ? "ok" : "warn",
		message: runtime.loadedPacks.length > 0 ? `Loaded: ${runtime.loadedPacks.map((p) => `${p.manifest.id}@${p.manifest.version}`).join(", ")}` : "No packs loaded"
	});
	const layerConflict = detectPackLayerSystemConflict([...new Set([...runtime.loadedPacks.map((p) => p.manifest.id), ...runtime.config.packs?.installed ?? []])]);
	checks.push({
		id: "pack_layer_system",
		status: layerConflict.conflict ? "error" : layerConflict.message ? "warn" : "ok",
		message: layerConflict.message
	});
	try {
		runtime.db.prepare("SELECT 1").get();
		checks.push({
			id: "database",
			status: "ok",
			message: null
		});
	} catch (err) {
		checks.push({
			id: "database",
			status: "error",
			message: err instanceof Error ? err.message : String(err)
		});
	}
	if ((runtime.config.data?.database_url ?? "").startsWith("postgres")) if (runtime.databaseNote) checks.push({
		id: "database_postgres",
		status: "warn",
		message: runtime.databaseNote
	});
	else if (runtime.databaseDialect === "postgresql") checks.push({
		id: "database_postgres",
		status: "ok",
		message: "PostgreSQL ObjectStore active (run `pnpm claworks:migrate` on fresh clusters)"
	});
	else checks.push({
		id: "database_postgres",
		status: "warn",
		message: "postgresql:// configured but dialect is not postgresql — check `pg` install and URL"
	});
	const kbProvider = runtime.config.data?.kb_provider ?? "stub";
	const kbEmbed = runtime.config.data?.kb_embed_model?.trim();
	checks.push({
		id: "kb",
		status: kbProvider === "memory-core" ? "ok" : "warn",
		message: kbProvider === "memory-core" ? `Vector KB via memory-core + memory-lancedb${kbEmbed ? ` (embed: ${kbEmbed})` : ""} — GET /v1/kb/status for live bridge` : "Using stub/file KB — set data.kb_provider=memory-core and run CLAWORKS_VECTOR_KB=1 pnpm claworks:repair"
	});
	const connectorIds = Object.keys(runtime.config.connectors ?? {}).filter((id) => runtime.config.connectors[id]?.enabled !== false);
	checks.push({
		id: "connectors",
		status: connectorIds.length > 0 ? "ok" : "warn",
		message: connectorIds.length > 0 ? `Active: ${connectorIds.join(", ")}` : "No connectors enabled — set connectors.echo in config or CLAWORKS_DEMO_CONNECTORS=1 on init"
	});
	checks.push({
		id: "robot",
		status: "ok",
		message: `${runtime.robot.name} (${runtime.robot.role}) @ ${runtime.robot.endpoint}`
	});
	if (!hasPackSourcesAvailable()) checks.push({
		id: "packs_source",
		status: "warn",
		message: "No pack sources — clone ../claworks-packs or set CLAWORKS_PACKS_DIR"
	});
	const modelRouter = runtime.config.model_router ?? {};
	const hasLlmRoute = Boolean(modelRouter.chat?.trim() || modelRouter.complete?.trim() || modelRouter.fast?.trim() || modelRouter.default?.trim());
	checks.push({
		id: "openclaw_bridge_llm",
		status: hasLlmRoute ? "ok" : "warn",
		message: hasLlmRoute ? "model_router configured for OpenClaw LLM bridge" : "No model_router — Playbook llm/subagent steps need agents.defaults.model + bridge at runtime"
	});
	const notifyTargets = runtime.config.notify?.targets ?? [];
	checks.push({
		id: "openclaw_bridge_notify",
		status: notifyTargets.length > 0 ? "ok" : "warn",
		message: notifyTargets.length > 0 ? `Notify targets: ${notifyTargets.map((t) => `${t.channel}:${t.to}`).join(", ")}` : "notify.targets empty — run claworks doctor --fix to derive from channels.feishu.allowFrom or set notify.targets"
	});
	const imAuto = runtime.config.im_bridge?.auto_on_message_received === true;
	checks.push({
		id: "openclaw_bridge_im",
		status: imAuto ? "ok" : "warn",
		message: imAuto ? "IM auto-bridge enabled (message_received → classify_im)" : "im_bridge.auto_on_message_received=false — users must POST /v1/bridge/im or enable auto bridge"
	});
	const isProduction = isClaworksProductionMode(runtime.config);
	const apiKey = runtime.config.api?.api_key?.trim();
	checks.push({
		id: "security_api_key",
		status: apiKey ? "ok" : "warn",
		message: apiKey ? "API key configured" : "No api.api_key — all requests authorized as system; set api.api_key for production"
	});
	const requireApiKey = runtime.config.api?.require_api_key === true;
	checks.push({
		id: "security_require_api_key",
		status: requireApiKey ? "ok" : isProduction ? "error" : "warn",
		message: requireApiKey ? "require_api_key=true" : "api.require_api_key not set — recommended for production (set to true)"
	});
	const dbUrlForCheck = runtime.config.data?.database_url ?? "";
	checks.push({
		id: "database_production",
		status: dbUrlForCheck.startsWith("postgres") ? "ok" : isProduction ? "warn" : "ok",
		message: dbUrlForCheck.startsWith("postgres") ? "PostgreSQL configured" : isProduction ? "SQLite in production — consider PostgreSQL for reliability & scale" : "SQLite (development default)"
	});
	const a2aPeers = runtime.config.a2a?.peers ?? [];
	if (a2aPeers.length > 0) {
		const httpsA2a = runtime.config.security?.require_https_a2a === true;
		checks.push({
			id: "security_a2a_https",
			status: httpsA2a ? "ok" : isProduction ? "warn" : "ok",
			message: httpsA2a ? "A2A HTTPS enforcement enabled" : `${a2aPeers.length} A2A peer(s) configured — set security.require_https_a2a=true for production`
		});
	}
	checks.push({
		id: "production_mode",
		status: "ok",
		message: isProduction ? "production_mode=true — stub steps fail-closed, full security enforcement" : "production_mode=false (dev mode) — stub steps return gracefully"
	});
	const connectors = runtime.config.connectors ?? {};
	const simulating = Object.entries(connectors).filter(([, cfg]) => cfg && typeof cfg === "object" && cfg.simulate === true);
	if (simulating.length > 0) checks.push({
		id: "connectors_simulate",
		status: isProduction ? "error" : "warn",
		message: isProduction ? `OT connectors in simulate mode: ${simulating.map(([id]) => id).join(", ")} — run claworks doctor --fix or set simulate: false` : `Dev simulate connectors: ${simulating.map(([id]) => id).join(", ")}`
	});
	return checks;
}
async function runClaworksDoctorFix(runtime) {
	const applied = [];
	const warnings = [];
	const wrapped = { plugins: {
		allow: ["claworks-robot"],
		entries: { "claworks-robot": {
			enabled: true,
			config: runtime.config
		} }
	} };
	const sourceDir = discoverPackSourceDir();
	const pluginRepair = repairClaworksRobotPluginConfig(wrapped, {
		packSourceDir: sourceDir,
		enableEchoConnector: true
	});
	if (pluginRepair.changed) {
		const repaired = wrapped.plugins?.entries?.["claworks-robot"]?.config;
		if (repaired) runtime.config = repaired;
		applied.push(...pluginRepair.actions);
	}
	warnings.push(...pluginRepair.warnings);
	const seed = seedPacksToStateDir({
		sourceDir: sourceDir ?? void 0,
		packIds: runtime.config.packs?.installed ?? void 0
	});
	if (seed.linked.length > 0) applied.push(`Linked packs under ~/.claworks/packs: ${seed.linked.join(", ")}`);
	warnings.push(...seed.warnings);
	const persisted = await loadPersistedInstalled();
	const packConfig = mergePackConfig(runtime.config.packs, persisted);
	const extraPaths = [sourceDir].filter((p) => Boolean(p));
	packConfig.paths = [...new Set([...packConfig.paths ?? [], ...extraPaths])];
	runtime.config.packs = packConfig;
	if (!runtime.config.connectors || Object.keys(runtime.config.connectors).length === 0) {
		runtime.config.connectors = { echo: {
			preset: "echo",
			enabled: true
		} };
		applied.push("connectors.echo: enabled");
	}
	if (!runtime.llmComplete) {
		const bridge = createDirectLlmBridge();
		if (bridge) {
			runtime.llmComplete = bridge;
			const provider = process.env["ANTHROPIC_API_KEY"] && !process.env["OPENAI_API_KEY"] ? "Anthropic" : process.env["OLLAMA_BASE_URL"] ? "Ollama" : "OpenAI";
			applied.push(`llmComplete: auto-configured direct LLM bridge (${provider})`);
		} else warnings.push("LLM bridge 未配置且无可用环境变量 (OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_BASE_URL)；LLM 相关步骤将降级");
	}
	const packsDir = join(homedir(), ".claworks", "packs");
	if (!existsSync(packsDir)) try {
		mkdirSync(packsDir, { recursive: true });
		applied.push(`Created pack directory: ${packsDir}`);
	} catch (err) {
		warnings.push(`无法创建 pack 目录 ${packsDir}: ${String(err)}`);
	}
	const dbUrl = runtime.config.data?.database_url ?? `sqlite://${join(homedir(), ".claworks", "robot.db")}`;
	if (dbUrl.startsWith("sqlite://")) {
		const dbPath = dbUrl.slice(9);
		const shmPath = `${dbPath}-shm`;
		const walPath = `${dbPath}-wal`;
		let dbAccessible = true;
		try {
			runtime.db.prepare("SELECT 1").get();
		} catch {
			dbAccessible = false;
		}
		if (!dbAccessible) {
			for (const lockFile of [shmPath, walPath]) if (existsSync(lockFile)) try {
				rmSync(lockFile, { force: true });
				applied.push(`Removed stale SQLite lock file: ${lockFile}`);
			} catch (err) {
				warnings.push(`无法删除锁文件 ${lockFile}: ${String(err)}`);
			}
		}
	}
	await reloadClaworksPacksFromDisk(runtime);
	applied.push(`Reloaded ${runtime.loadedPacks.length} pack(s), ${runtime.playbookEngine.list().length} playbook(s), ${runtime.ontology.listTypes().length} object type(s)`);
	return {
		applied,
		warnings,
		repair: {
			changed: applied.length > 0,
			actions: applied,
			warnings
		}
	};
}
//#endregion
//#region src/claworks/health.ts
function resolveHealthStatus(checks) {
	if (checks.some((c) => c.status === "error")) return "unavailable";
	if (checks.some((c) => c.status === "warn")) return "degraded";
	return "ok";
}
function buildHealthPayload(runtime) {
	const checks = runClaworksDoctor(runtime);
	const status = resolveHealthStatus(checks);
	return {
		status,
		robot: runtime.robot.name,
		role: runtime.robot.role,
		version: runtime.robot.version,
		kb_provider: runtime.config.data?.kb_provider ?? "stub",
		kb_vector: runtime.config.data?.kb_provider === "memory-core",
		kb_embed_model: runtime.config.data?.kb_embed_model,
		uptime_s: runtimeUptimeSeconds(),
		planes: {
			kernel: status === "unavailable" ? "error" : "ok",
			data: checks.find((c) => c.id === "database")?.status === "error" ? "error" : "ok",
			orch: checks.find((c) => c.id === "playbooks")?.status === "error" ? "error" : "ok"
		},
		subsystems: {
			llm: !!runtime.llmComplete || !!runtime.bridges?.get("llm"),
			notify: !!runtime.bridges?.get("notify"),
			cbr: !!runtime.cbrStore,
			context_engine: !!runtime.contextEngine,
			autonomy_scan: !!runtime._autonomyScanTimer,
			evolution_sync: !!runtime.evolutionSync,
			hook_engine: !!runtime.hookEngine,
			structured_output: !!runtime.structuredOutput
		},
		playbook_count: runtime.playbookEngine?.list().length ?? 0,
		capability_count: runtime.capabilities?.list().length ?? 0,
		checks
	};
}
//#endregion
//#region src/claworks/a2a-peer-auth.ts
/** 从 metadata / source 解析对等机器人 ID。 */
function resolveA2aPeerId(meta) {
	if (typeof meta.peer_id === "string" && meta.peer_id.trim()) return meta.peer_id.trim();
	if (typeof meta.peer === "string" && meta.peer.trim()) return meta.peer.trim();
	const match = (typeof meta.source === "string" ? meta.source : "").match(/^a2a:\/\/([^/?#]+)/i);
	if (match?.[1]) return match[1];
	return null;
}
function resolveA2aPeer(meta, configuredPeers) {
	const peerId = resolveA2aPeerId(meta);
	if (!peerId) return { error: "missing peer_id (metadata.peer_id or a2a://<peer>/ source)" };
	if (configuredPeers.length > 0 && !configuredPeers.some((p) => p.name === peerId)) return { error: `unknown A2A peer "${peerId}"` };
	return {
		peerId,
		subjectType: "peer",
		subjectId: peerId
	};
}
function checkA2aPeerRbac(runtime, peer, action, resource) {
	const input = {
		action,
		resource,
		subjectType: peer.subjectType,
		subjectId: peer.subjectId
	};
	return runtime.rbac.check(input);
}
//#endregion
//#region src/claworks/im-bridge.ts
/**
* im-bridge — IM 消息 → ClaWorks EventKernel 的意图路由桥梁
*
* 设计原则：
* - IM 消息默认不自动进入 EventKernel（避免垃圾事件洪泛）
* - 由 Pi Agent（Pi代理）或 Webhook 调用本桥显式转发
* - IngressRouter 决策：kernel直达 | intent_route（LLM分类后再决定是否发布）| observe_only | deny
* - intent_route 时直接 trigger classify_im_to_business_event（不经 EventBus 泛洪）
* - Playbook 再用 LLM 判断意图，若匹配业务模式则发布具体业务事件
*
* 调用路径：
* 1. Pi Agent 在聊天循环末尾调用工具 cw_bridge_im_message
* 2. IM Connector（飞书/企微/钉钉 Webhook）POST /v1/bridge/im
* 3. 未来：OpenClaw 提供 api.onChannelMessage hook 后可自动注册
*/
/** Accept REST/legacy snake_case aliases before routing. */
function normalizeImBridgeInput(input) {
	const channel = String(input.channel ?? input.channel_id ?? "").trim();
	const userId = String(input.userId ?? input.user_id ?? "").trim();
	const text = String(input.text ?? input.message ?? "").trim();
	const messageId = String(input.messageId ?? input.message_id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const groupRaw = input.groupId ?? input.group_id;
	const extra = input.extra ?? (input.tenant_id != null ? { tenant_id: input.tenant_id } : void 0);
	return {
		channel,
		messageId,
		userId: userId || "anonymous",
		text,
		groupId: groupRaw != null ? String(groupRaw) : void 0,
		extra
	};
}
async function bridgeImMessage(runtime, input) {
	const normalized = normalizeImBridgeInput(input);
	const source = "im";
	const eventType = "im.message.received";
	const subjectId = `${normalized.channel}:${normalized.userId}`;
	const decision = runtime.ingress.decide(source, eventType, subjectId);
	const rbacAction = decision.action === "intent_route" ? "playbook.trigger" : "event.publish";
	const rbacResource = decision.action === "intent_route" ? `playbook:${decision.hint ?? "classify_im_to_business_event"}` : eventType;
	const rbacResult = runtime.rbac.check({
		action: rbacAction,
		resource: rbacResource,
		subjectType: "channel_user",
		subjectId,
		context: { channel: normalized.channel }
	});
	if (!rbacResult.allowed) {
		const reason = rbacResult.reason ?? "policy denied";
		await runtime.kernel.publish("rbac.denied", "im-bridge", {
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
	const sessionId = normalized.groupId ? `${normalized.channel}:group:${normalized.groupId}` : `${normalized.channel}:user:${normalized.userId}`;
	const payload = {
		_im_channel: normalized.channel,
		_im_message_id: normalized.messageId,
		_im_user_id: normalized.userId,
		_im_group_id: normalized.groupId,
		_im_message: normalized.text,
		_ingress_decision: decision.action,
		text: normalized.text,
		user_id: normalized.userId,
		channel: normalized.channel,
		message_id: normalized.messageId,
		group_id: normalized.groupId ?? null,
		session_id: sessionId,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		...normalized.extra
	};
	runtime.contextEngine?.append(sessionId, "user", normalized.text, {
		channel: normalized.channel,
		userId: normalized.userId,
		messageId: normalized.messageId
	});
	const result = await applyIngressPublish(runtime, {
		source,
		eventType,
		subjectId,
		payload,
		publishSource: "im-bridge",
		idempotencyKey: `im:${normalized.channel}:${normalized.messageId}`,
		subjectType: "channel_user"
	});
	if (result.action !== "denied" && runtime.userProfileStore && normalized.userId !== "anonymous") {
		const profile = runtime.userProfileStore.get(normalized.userId);
		if (!profile || profile.interactionCount === 0) await runtime.kernel.publish("user.first_interaction", "im-bridge", {
			channel: normalized.channel,
			user_id: normalized.userId,
			group_id: normalized.groupId,
			first_message: normalized.text
		}).catch(() => {});
	}
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
//#region src/interfaces/connectors/connector-manager.ts
const INVOKE_TIMEOUT_MS = 1e4;
var ConnectorManager = class {
	constructor(opts) {
		this.connectors = /* @__PURE__ */ new Map();
		this.pendingInvokes = /* @__PURE__ */ new Map();
		this.onEvent = opts?.onEvent;
		this.logger = opts?.logger;
	}
	setEventHandler(handler) {
		this.onEvent = handler;
	}
	async start(connectorId, config) {
		if (config.enabled === false) return;
		await this.stop(connectorId);
		const proc = spawn(config.command, config.args ?? [], {
			cwd: config.cwd,
			env: {
				...process.env,
				...config.env,
				CLAWORKS_CONNECTOR_ID: connectorId
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		const instance = {
			id: connectorId,
			config,
			proc,
			ready: false
		};
		this.connectors.set(connectorId, instance);
		createInterface({ input: proc.stdout }).on("line", (line) => {
			this.handleLine(connectorId, line);
		});
		proc.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8").trim();
			if (text) this.logger?.(`[connector:${connectorId}:stderr] ${text}`);
		});
		proc.on("exit", (code) => {
			instance.ready = false;
			if (code !== 0 && code !== null) {
				instance.lastError = `exited with code ${code}`;
				this.logger?.(`[connector:${connectorId}] ${instance.lastError}`);
			}
			for (const [id, pending] of this.pendingInvokes) {
				clearTimeout(pending.timer);
				pending.reject(/* @__PURE__ */ new Error(`connector ${connectorId} exited`));
				this.pendingInvokes.delete(id);
			}
		});
	}
	async stop(connectorId) {
		const instance = this.connectors.get(connectorId);
		if (!instance) return;
		this.send(instance, { type: "shutdown" });
		instance.proc.kill("SIGTERM");
		this.connectors.delete(connectorId);
	}
	async stopAll() {
		for (const id of [...this.connectors.keys()]) await this.stop(id);
	}
	async invoke(connectorId, method, params) {
		const instance = this.connectors.get(connectorId);
		if (!instance) throw new Error(`Connector not running: ${connectorId}`);
		const invokeId = `${connectorId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingInvokes.delete(invokeId);
				reject(/* @__PURE__ */ new Error(`connector invoke timed out after ${INVOKE_TIMEOUT_MS}ms`));
			}, INVOKE_TIMEOUT_MS);
			this.pendingInvokes.set(invokeId, {
				resolve,
				reject,
				timer
			});
			this.send(instance, {
				type: "invoke",
				id: invokeId,
				method,
				params
			});
		});
	}
	list() {
		return [...this.connectors.values()].map((c) => ({
			id: c.id,
			running: !c.proc.killed,
			pid: c.proc.pid,
			ready: c.ready,
			lastError: c.lastError
		}));
	}
	send(instance, msg) {
		instance.proc.stdin.write(`${JSON.stringify(msg)}\n`);
	}
	handleLine(connectorId, line) {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			this.logger?.(`[connector:${connectorId}] invalid JSON: ${trimmed.slice(0, 120)}`);
			return;
		}
		const instance = this.connectors.get(connectorId);
		if (!instance) return;
		if (msg.type === "ready") {
			instance.ready = true;
			this.logger?.(`[connector:${connectorId}] ready`);
			return;
		}
		if (msg.type === "log") {
			this.logger?.(`[connector:${connectorId}] ${msg.message}`);
			return;
		}
		if (msg.type === "result") {
			const pending = this.pendingInvokes.get(msg.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingInvokes.delete(msg.id);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "connector invoke failed"));
			}
			return;
		}
		if (msg.type === "event") this.onEvent?.({
			connectorId,
			type: msg.event_type,
			source: msg.source || `connector://${connectorId}`,
			payload: msg.payload ?? {},
			correlationId: msg.correlation_id
		});
	}
	/**
	* 返回所有连接器的状态快照（供能力/UI 查询）。
	* ready: 进程已就绪; error: 进程出错或已退出; idle: 尚未启动
	*/
	status() {
		return [...this.connectors.values()].map((c) => ({
			id: c.id,
			ready: c.ready,
			lastError: c.lastError
		}));
	}
};
//#endregion
//#region src/interfaces/connectors/presets.ts
function resolveClaworksRoot() {
	const envRoot = process.env.CLAWORKS_ROOT?.trim();
	if (envRoot && existsSync(envRoot)) return envRoot;
	const cwd = process.cwd();
	if (existsSync(join(cwd, "connectors"))) return cwd;
	return cwd;
}
function presetPath(root, ...parts) {
	return join(root, "connectors", ...parts);
}
function getConnectorPreset(preset, claworksRoot = resolveClaworksRoot()) {
	const root = claworksRoot;
	switch (preset) {
		case "echo": return {
			command: process.execPath,
			args: [presetPath(root, "echo", "echo-bridge.mjs")]
		};
		case "rest-poll": return {
			command: process.execPath,
			args: [presetPath(root, "rest-poll", "rest-poll-bridge.mjs")]
		};
		case "mqtt": return {
			command: process.execPath,
			args: [presetPath(root, "mqtt", "mqtt-bridge.mjs")]
		};
		case "mqtt-simulate": return {
			command: process.execPath,
			args: [presetPath(root, "mqtt", "mqtt-bridge.mjs")],
			env: { CLAWORKS_MQTT_SIMULATE: "1" }
		};
		case "opcua": return {
			command: process.env.CLAWORKS_PYTHON ?? "python3",
			args: [presetPath(root, "opcua", "opcua-bridge.py")]
		};
		case "opcua-simulate": return {
			command: process.env.CLAWORKS_PYTHON ?? "python3",
			args: [presetPath(root, "opcua", "opcua-bridge.py")],
			env: { CLAWORKS_OPCUA_SIMULATE: "1" }
		};
		case "modbus": return {
			command: process.env.CLAWORKS_PYTHON ?? "python3",
			args: [presetPath(root, "modbus", "modbus-bridge.py")]
		};
		case "modbus-simulate": return {
			command: process.env.CLAWORKS_PYTHON ?? "python3",
			args: [presetPath(root, "modbus", "modbus-bridge.py")],
			env: { CLAWORKS_MODBUS_SIMULATE: "1" }
		};
		case "database-poll": return {
			command: process.execPath,
			args: [presetPath(root, "database-poll", "database-poll-bridge.mjs")]
		};
		default: return null;
	}
}
function resolveConnectorConfigs(connectors, claworksRoot = resolveClaworksRoot()) {
	const resolved = {};
	for (const [id, raw] of Object.entries(connectors ?? {})) {
		const effectivePreset = raw.preset && raw.simulate === true ? `${raw.preset}-simulate` : raw.preset;
		const preset = effectivePreset ? getConnectorPreset(effectivePreset, claworksRoot) : null;
		if (effectivePreset && !preset) {
			const fallback = raw.preset ? getConnectorPreset(raw.preset, claworksRoot) : null;
			if (!fallback) throw new Error(`Unknown connector preset: ${effectivePreset}`);
			const { preset: _presetKey, simulate: _simulate, ...rest } = raw;
			resolved[id] = {
				...fallback,
				...rest,
				command: rest.command ?? fallback.command ?? "",
				args: rest.args ?? fallback.args,
				env: {
					...fallback.env,
					...rest.env
				}
			};
		} else {
			const { preset: _presetKey, simulate: _simulate, ...rest } = raw;
			resolved[id] = {
				...preset,
				...rest,
				command: rest.command ?? preset?.command ?? "",
				args: rest.args ?? preset?.args,
				env: {
					...preset?.env,
					...rest.env
				}
			};
		}
		if (!resolved[id].command) throw new Error(`Connector ${id} missing command`);
	}
	return resolved;
}
//#endregion
//#region src/interfaces/a2a/agent-card.ts
function buildA2aAgentCard(runtime, baseUrl) {
	const url = baseUrl ?? runtime.robot.endpoint;
	const role = runtime.robot.role ?? "";
	const description = role ? `ClaWorks robot — ${role}` : "ClaWorks industrial robot";
	return {
		name: runtime.robot.name,
		description,
		url,
		version: runtime.robot.version,
		capabilities: {
			streaming: true,
			pushNotifications: false
		},
		defaultInputModes: ["text"],
		defaultOutputModes: ["text"],
		skills: runtime.playbookEngine.list().map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description
		})),
		endpoints: { tasks: `${url.replace(/\/$/, "")}/a2a/tasks` },
		claworks: {
			role: runtime.robot.role,
			playbooks: runtime.playbookEngine.list().map((p) => p.id),
			objectTypes: runtime.ontology.listTypes().map((t) => t.name)
		}
	};
}
//#endregion
export { uninstallClaworksPack as A, CLAWORKS_DEFAULT_GATEWAY_PORT as B, persistInstalled as C, resolveInstalledStatePath as D, reloadClaworksPacksFromDisk as E, buildRobotIdentity as F, looksLikeClaworksStateEnv as G, detectAndApplyClaworksCli as H, createRbacGuard as I, warnIfOpenClawEntryWithClaworksState as K, extractOwnerFromMd as L, createDirectLlmBridge as M, applyIngressPublish as N, resolvePacksInstallRoot as O, DEFAULT_RBAC_POLICIES as P, extractRulesFromMd as R, mergePackConfig as S, reloadClaworksPacks as T, isClaworksProduct as U, applyClaworksProductEnv as V, isClaworksProductionMode as W, repairClaworksJsonConfig as _, normalizeImBridgeInput as a, installClaworksPack as b, resolveA2aPeerId as c, runClaworksDoctor as d, runClaworksDoctorFix as f, isClaworksRobotConfigPresent as g, hasPackSourcesAvailable as h, bridgeImMessage as i, updateClaworksPack as j, searchNexusPackages as k, buildHealthPayload as l, discoverPackSourceDir as m, resolveConnectorConfigs as n, checkA2aPeerRbac as o, defaultClaworksStateDir as p, ConnectorManager as r, resolveA2aPeer as s, buildA2aAgentCard as t, resolveHealthStatus as u, repairOtConnectorSimulateFlags as v, reloadClaworksPackById as w, loadPersistedInstalled as x, applyPackContributions as y, loadRobotMd as z };
