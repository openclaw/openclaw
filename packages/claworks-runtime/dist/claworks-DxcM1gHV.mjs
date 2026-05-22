import { a as createKnowledgeBase, n as createObjectStore, o as createFileKnowledgeBase, s as openDatabase, t as createOntologyEngine } from "./ontology-engine-DYitirop.mjs";
import { o as markRuntimeStarted, r as appendObservationEvent, t as A2aClient } from "./client-sSruxTff.mjs";
import { p as resolveA2aTarget } from "./step-executor-Dgu_uWbI.mjs";
import { a as buildRobotIdentity, i as DEFAULT_RBAC_POLICIES, o as createRbacGuard } from "./rbac-sync-CZlL_vuW.mjs";
import { E as applyIngressPublish, S as buildHealthPayload, _ as bridgeImMessage, a as loadPersistedInstalled, d as reloadClaworksPacksFromDisk, f as resolveInstalledStatePath, i as installClaworksPack, l as reloadClaworksPackById, n as resolveConnectorConfigs, o as mergePackConfig, r as ConnectorManager, t as buildA2aAgentCard } from "./agent-card-COf94zUM.mjs";
import { n as createIngressRouter, t as DEFAULT_INGRESS_POLICIES } from "./ingress-CqjhZRWq.mjs";
import { a as parseNexusSource, f as createPackLoader, i as listNexusPackages } from "./pack-loader-ttcUSOdi.mjs";
import { l as createActionRegistry, n as createIntentRegistry, r as createEventKernel, t as createPlaybookScheduler } from "./scheduler-D4h7sG5e.mjs";
import { t as createPlaybookEngine } from "./playbook-engine-Cux1LZFy.mjs";
import os, { homedir } from "node:os";
import path, { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
//#region src/claworks/product-env.ts
/** Default ClaWorks gateway port (OpenClaw default is 18789). */
const CLAWORKS_DEFAULT_GATEWAY_PORT = 18800;
function isClaworksProduct(env = process.env) {
	return env.CLAWORKS_PRODUCT === "1";
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
	const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".claworks");
	env.CLAWORKS_PRODUCT = "1";
	env.OPENCLAW_STATE_DIR ??= stateDir;
	env.OPENCLAW_CONFIG_PATH ??= path.join(stateDir, "claworks.json");
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
//#region src/claworks/model-router.ts
/**
* Resolves LLM model for playbook steps. Explicit step.model always wins.
*/
function createModelRouter(config) {
	const defaults = {
		default: config?.default ?? "sonnet-4.6",
		fast: config?.fast ?? config?.default ?? "sonnet-4.6",
		embed: config?.embed
	};
	const taskModelMap = {
		classify: config?.classification_model ?? config?.fast ?? defaults.default,
		chat: defaults.default,
		reason: config?.reasoning_model ?? defaults.default,
		code: config?.code_model ?? config?.reasoning_model ?? defaults.default,
		document: config?.document_model ?? defaults.default
	};
	return {
		resolve(stepKind, explicitModel) {
			if (explicitModel?.trim()) return explicitModel.trim();
			switch (stepKind) {
				case "llm":
				case "function": return defaults.default;
				case "subagent": return defaults.default;
				default: return;
			}
		},
		resolveForTask(taskType) {
			return taskModelMap[taskType] ?? defaults.default;
		}
	};
}
//#endregion
//#region src/claworks/policy-sync.ts
const debounceTimers = /* @__PURE__ */ new Map();
/**
* Debounced sync of RBAC/Ingress policies after ObjectStore writes.
*/
function schedulePolicySync(runtime, typeName) {
	if (typeName !== "RbacPolicy" && typeName !== "IngressPolicy") return;
	const existing = debounceTimers.get(typeName);
	if (existing) clearTimeout(existing);
	debounceTimers.set(typeName, setTimeout(() => {
		debounceTimers.delete(typeName);
		flushPolicySync(runtime, typeName);
	}, 500));
}
async function flushPolicySync(runtime, typeName) {
	const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync-CZlL_vuW.mjs").then((n) => n.t);
	if (typeName === "RbacPolicy") await syncRbacFromObjectStore(runtime);
	if (typeName === "IngressPolicy") await syncIngressFromObjectStore(runtime);
}
//#endregion
//#region src/claworks/notify-targets.ts
/** 从 ObjectStore RobotOwner + robot.md Owner 解析通知目标。 */
async function resolveNotifyTargets(runtime, channelId) {
	const targets = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (channel, to) => {
		const key = `${channel}:${to}`;
		if (!to || seen.has(key)) return;
		seen.add(key);
		targets.push({
			channel,
			to
		});
	};
	try {
		const { items } = await runtime.objectStore.query("RobotOwner", { limit: 50 });
		for (const row of items) {
			const ownerChannel = typeof row.channel_id === "string" ? row.channel_id : void 0;
			if (ownerChannel && ownerChannel !== channelId) continue;
			const ownerId = typeof row.owner_id === "string" ? row.owner_id : row.id;
			if (typeof ownerId === "string") push(channelId, ownerId);
		}
	} catch {}
	const owner = runtime.identity.owner;
	if (owner?.ownerId) push(owner.channelId ?? channelId, owner.ownerId);
	return targets;
}
function robotOwnerFromObject(row) {
	const ownerId = typeof row.owner_id === "string" ? row.owner_id : void 0;
	if (!ownerId) return null;
	return {
		ownerId,
		channelId: typeof row.channel_id === "string" ? row.channel_id : void 0,
		shiftSchedule: typeof row.shift_schedule === "string" ? row.shift_schedule : void 0
	};
}
//#endregion
//#region src/claworks/im-channel-hook.ts
/**
* OpenClaw message_received → ClaWorks IM 桥（可选自动转发）。
*/
async function bridgeChannelMessageReceived(runtime, params) {
	const userId = params.senderId ?? params.conversationId ?? "unknown";
	const messageId = params.messageId ?? `hook-${Date.now()}`;
	const text = params.text.trim();
	if (!text) return;
	await bridgeImMessage(runtime, {
		channel: params.channelId,
		messageId,
		userId,
		text,
		groupId: params.conversationId,
		extra: params.metadata
	});
}
//#endregion
//#region src/agents/research-agent.ts
function createResearchAgent(runtime) {
	const results = /* @__PURE__ */ new Map();
	const monitors = /* @__PURE__ */ new Map();
	async function doResearch(id, query, sources, depth, saveToKb) {
		const startTime = Date.now();
		const findings = [];
		const tasks = [];
		if (sources.includes("kb")) tasks.push(runtime.kb.search(query, { limit: depth === "thorough" ? 10 : 5 }).then((items) => {
			for (const r of items) findings.push({
				source: "kb",
				content: String(r.text ?? r.content ?? ""),
				relevance: Number(r.score ?? .5)
			});
		}).catch(() => {}));
		if (sources.includes("web")) {
			const scanner = runtime.environmentScanner;
			if (scanner?.webSearch) tasks.push(scanner.webSearch(query, depth === "thorough" ? 8 : 3).then((webResults) => {
				for (const r of webResults) findings.push({
					source: "web",
					content: `${r.title}\n${r.snippet}`,
					relevance: .6,
					url: r.url
				});
			}).catch(() => {}));
		}
		if (sources.includes("events")) tasks.push(Promise.resolve().then(() => {
			const events = runtime.kernel.getRecentEvents?.(50) ?? [];
			const queryPrefix = query.toLowerCase().slice(0, 15);
			for (const e of events.filter((ev) => JSON.stringify(ev.payload ?? "").toLowerCase().includes(queryPrefix)).slice(0, 5)) findings.push({
				source: `event:${e.type}`,
				content: JSON.stringify(e.payload ?? ""),
				relevance: .7
			});
		}).catch(() => {}));
		await Promise.allSettled(tasks);
		findings.sort((a, b) => b.relevance - a.relevance);
		let synthesis = `关于「${query}」共找到 ${findings.length} 条相关信息。`;
		if (findings.length > 0) {
			const llm = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;
			if (llm) try {
				const res = await llm({ prompt: `基于以下信息回答：${query}\n\n` + findings.slice(0, 5).map((f) => `[${f.source}] ${f.content.slice(0, 300)}`).join("\n\n") });
				if (res.text) synthesis = res.text;
			} catch {}
		}
		const confidence = findings.length > 3 ? .8 : findings.length > 0 ? .5 : .2;
		const result = {
			task_id: id,
			query,
			findings,
			synthesis,
			confidence,
			duration_ms: Date.now() - startTime
		};
		if (saveToKb && findings.length > 0 && runtime.kb.add) await runtime.kb.add({
			id: `research:${id}`,
			content: `研究：${query}\n结论：${synthesis}`,
			source: "research_agent"
		}).catch(() => {});
		return result;
	}
	function publishMonitorUpdate(monitorId, topic, result) {
		runtime.kernel.publish("research.monitor_update", "research-agent", {
			monitor_id: monitorId,
			topic,
			...result
		}).catch(() => {});
	}
	return {
		async research({ id, query, sources = ["kb", "web"], depth = "quick", save_to_kb = false }) {
			const taskId = id ?? `rq-${Date.now()}`;
			const result = await doResearch(taskId, query, sources, depth, save_to_kb);
			results.set(taskId, result);
			return result;
		},
		async monitor(topic, intervalHours = 6) {
			const mId = `monitor-${Date.now()}`;
			doResearch(mId, topic, ["kb", "web"], "quick", true).then((r) => {
				results.set(mId, r);
				publishMonitorUpdate(mId, topic, r);
			}).catch(() => {});
			const timer = setInterval(() => {
				doResearch(`${mId}-${Date.now()}`, topic, ["kb", "web"], "quick", true).then((r) => publishMonitorUpdate(mId, topic, r)).catch(() => {});
			}, intervalHours * 36e5);
			monitors.set(mId, timer);
			return mId;
		},
		stopMonitor(mId) {
			const t = monitors.get(mId);
			if (t) {
				clearInterval(t);
				monitors.delete(mId);
			}
		},
		getResult: (id) => results.get(id)
	};
}
//#endregion
//#region src/claworks/auto-connect.ts
/**
* auto-connect.ts — ClaWorks 自动对接检测
*
* 通过扫描环境变量和网络服务，自动发现可以配置的连接器，
* 并生成对接建议，待用户确认后应用。
*
* 维度覆盖：感知（Perception）+ 主动（Proactivity）
*/
function hasEnv(...keys) {
	return keys.every((k) => !!process.env[k]);
}
function getEnv(key) {
	return process.env[key];
}
function probePort$1(host, port, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const socket = createConnection({
			host,
			port
		});
		const t = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);
		socket.on("connect", () => {
			clearTimeout(t);
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			clearTimeout(t);
			resolve(false);
		});
	});
}
const SERVICE_RULES = [
	{
		service: "feishu",
		category: "im",
		recommendation: "设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 以启用飞书渠道",
		check: async () => {
			if (hasEnv("FEISHU_APP_ID", "FEISHU_APP_SECRET")) return {
				available: true,
				config: {
					app_id: getEnv("FEISHU_APP_ID"),
					app_secret: "***",
					webhook: getEnv("FEISHU_WEBHOOK_URL")
				}
			};
			return {
				available: false,
				missingVars: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
			};
		}
	},
	{
		service: "weixin_work",
		category: "im",
		recommendation: "设置 WEIXIN_WORK_CORPID 和 WEIXIN_WORK_CORP_SECRET 以启用企业微信渠道",
		check: async () => {
			if (hasEnv("WEIXIN_WORK_CORPID", "WEIXIN_WORK_CORP_SECRET")) return {
				available: true,
				config: {
					corpid: getEnv("WEIXIN_WORK_CORPID"),
					agent_id: getEnv("WEIXIN_WORK_AGENT_ID")
				}
			};
			return {
				available: false,
				missingVars: ["WEIXIN_WORK_CORPID", "WEIXIN_WORK_CORP_SECRET"]
			};
		}
	},
	{
		service: "dingtalk",
		category: "im",
		recommendation: "设置 DINGTALK_APP_KEY 和 DINGTALK_APP_SECRET 以启用钉钉渠道",
		check: async () => {
			if (hasEnv("DINGTALK_APP_KEY", "DINGTALK_APP_SECRET")) return {
				available: true,
				config: { app_key: getEnv("DINGTALK_APP_KEY") }
			};
			if (getEnv("DINGTALK_ROBOT_TOKEN")) return {
				available: true,
				config: {
					robot_token: "***",
					mode: "webhook"
				}
			};
			return {
				available: false,
				missingVars: ["DINGTALK_APP_KEY", "DINGTALK_APP_SECRET"]
			};
		}
	},
	{
		service: "telegram",
		category: "im",
		recommendation: "设置 TELEGRAM_BOT_TOKEN 以启用 Telegram 渠道",
		check: async () => {
			if (hasEnv("TELEGRAM_BOT_TOKEN")) return {
				available: true,
				config: { token_set: true }
			};
			return {
				available: false,
				missingVars: ["TELEGRAM_BOT_TOKEN"]
			};
		}
	},
	{
		service: "openai",
		category: "ai",
		recommendation: "设置 OPENAI_API_KEY 以启用 OpenAI LLM",
		check: async () => {
			if (hasEnv("OPENAI_API_KEY")) return {
				available: true,
				config: {
					base_url: getEnv("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
					model: getEnv("OPENAI_MODEL") ?? "gpt-4o"
				}
			};
			return {
				available: false,
				missingVars: ["OPENAI_API_KEY"]
			};
		}
	},
	{
		service: "anthropic",
		category: "ai",
		recommendation: "设置 ANTHROPIC_API_KEY 以启用 Claude LLM",
		check: async () => {
			if (hasEnv("ANTHROPIC_API_KEY")) return {
				available: true,
				config: { provider: "anthropic" }
			};
			return {
				available: false,
				missingVars: ["ANTHROPIC_API_KEY"]
			};
		}
	},
	{
		service: "ollama",
		category: "ai",
		recommendation: "启动 Ollama 服务（localhost:11434）以使用本地 LLM",
		check: async () => {
			const reachable = await probePort$1("127.0.0.1", 11434);
			return {
				available: reachable,
				config: reachable ? { endpoint: "http://localhost:11434/v1" } : void 0
			};
		}
	},
	{
		service: "openai_compatible",
		category: "ai",
		recommendation: "设置 OPENAI_BASE_URL 以使用 OpenAI 兼容接口（本地/云端）",
		check: async () => {
			const baseUrl = getEnv("OPENAI_BASE_URL");
			if (baseUrl && baseUrl !== "https://api.openai.com/v1") return {
				available: true,
				config: {
					base_url: baseUrl,
					api_key_set: hasEnv("OPENAI_API_KEY")
				}
			};
			return { available: false };
		}
	},
	{
		service: "postgresql",
		category: "database",
		recommendation: "设置 DATABASE_URL 或启动 PostgreSQL 服务（port 5432）",
		check: async () => {
			if (hasEnv("DATABASE_URL") || hasEnv("POSTGRES_URL")) return {
				available: true,
				config: { url_set: true }
			};
			const reachable = await probePort$1("127.0.0.1", 5432, 1e3);
			return {
				available: reachable,
				config: reachable ? {
					host: "localhost",
					port: 5432
				} : void 0
			};
		}
	},
	{
		service: "redis",
		category: "database",
		recommendation: "设置 REDIS_URL 或启动 Redis 服务（port 6379）",
		check: async () => {
			if (hasEnv("REDIS_URL")) return {
				available: true,
				config: { url_set: true }
			};
			const reachable = await probePort$1("127.0.0.1", 6379, 1e3);
			return {
				available: reachable,
				config: reachable ? {
					host: "localhost",
					port: 6379
				} : void 0
			};
		}
	},
	{
		service: "mqtt",
		category: "iot",
		recommendation: "设置 MQTT_BROKER_URL 或在 localhost:1883 启动 MQTT Broker",
		check: async () => {
			if (hasEnv("MQTT_BROKER_URL")) return {
				available: true,
				config: { url: getEnv("MQTT_BROKER_URL") }
			};
			const reachable = await probePort$1("127.0.0.1", 1883, 1e3);
			return {
				available: reachable,
				config: reachable ? { broker: "mqtt://localhost:1883" } : void 0
			};
		}
	},
	{
		service: "opcua",
		category: "iot",
		recommendation: "配置 OPC-UA 服务器地址（port 4840）以接入工业设备数据",
		check: async () => {
			if (hasEnv("OPCUA_ENDPOINT_URL")) return {
				available: true,
				config: { endpoint: getEnv("OPCUA_ENDPOINT_URL") }
			};
			const reachable = await probePort$1("127.0.0.1", 4840, 1e3);
			return {
				available: reachable,
				config: reachable ? { endpoint: "opc.tcp://localhost:4840" } : void 0
			};
		}
	}
];
async function probeServiceUrl(url) {
	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(2e3) });
		return resp.ok || resp.status < 500;
	} catch {
		return false;
	}
}
function createAutoConnectManager(runtime, _config) {
	return {
		async detect() {
			const results = await Promise.all(SERVICE_RULES.map(async (rule) => {
				try {
					const { available, config, missingVars } = await rule.check();
					return {
						service: rule.service,
						available,
						category: rule.category,
						config,
						missingVars,
						recommendation: rule.recommendation
					};
				} catch {
					return {
						service: rule.service,
						available: false,
						category: rule.category,
						recommendation: rule.recommendation
					};
				}
			}));
			runtime.logger?.(`[auto-connect] 扫描完成：${results.filter((r) => r.available).length}/${results.length} 个服务可用`);
			return results;
		},
		async applyConnections(services) {
			const results = [];
			for (const svc of services) try {
				if (svc === "feishu") {
					const appId = process.env.FEISHU_APP_ID;
					const appSecret = process.env.FEISHU_APP_SECRET;
					if (appId && appSecret) {
						const existing = runtime.config.connectors ?? {};
						runtime.config.connectors = {
							...existing,
							feishu: {
								...existing.feishu,
								app_id: appId,
								app_secret: appSecret,
								webhook: process.env.FEISHU_WEBHOOK_URL
							}
						};
						await runtime.kernel.publish("connect.applied", "auto-connect", {
							service: svc,
							connector_id: "feishu"
						});
						results.push({
							service: svc,
							status: "connected",
							error: `飞书已连接 (App ID: ${appId.slice(0, 8)}...)`
						});
						runtime.logger?.(`[auto-connect] 飞书配置已应用 (${appId.slice(0, 8)}...)`);
					} else results.push({
						service: svc,
						status: "failed",
						error: "缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET"
					});
				} else if (svc === "ollama") {
					const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
					if (await probeServiceUrl(`${baseUrl}/api/tags`)) {
						runtime.config.model_router = {
							...runtime.config.model_router,
							default: `${baseUrl}/v1`
						};
						await runtime.kernel.publish("connect.applied", "auto-connect", {
							service: svc,
							base_url: baseUrl
						});
						results.push({
							service: svc,
							status: "connected",
							error: `Ollama 已连接 (${baseUrl})`
						});
						runtime.logger?.(`[auto-connect] Ollama 配置已应用 (${baseUrl})`);
					} else results.push({
						service: svc,
						status: "failed",
						error: `无法访问 Ollama (${baseUrl})`
					});
				} else if (svc === "openai") if (process.env.OPENAI_API_KEY) {
					const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
					runtime.config.model_router = {
						...runtime.config.model_router,
						default: baseUrl
					};
					await runtime.kernel.publish("connect.applied", "auto-connect", { service: svc });
					results.push({
						service: svc,
						status: "connected",
						error: "OpenAI 已连接"
					});
				} else results.push({
					service: svc,
					status: "failed",
					error: "缺少 OPENAI_API_KEY"
				});
				else {
					await runtime.kernel.publish("connect.apply_requested", "auto-connect", {
						service: svc,
						requested_at: (/* @__PURE__ */ new Date()).toISOString()
					});
					results.push({
						service: svc,
						status: "connected"
					});
					runtime.logger?.(`[auto-connect] 已请求连接：${svc}`);
				}
			} catch (err) {
				results.push({
					service: svc,
					status: "failed",
					error: err instanceof Error ? err.message : String(err)
				});
			}
			return results;
		},
		async generateRecommendations() {
			const detected = await this.detect();
			const recommendations = [];
			const available = detected.filter((d) => d.available);
			const unavailable = detected.filter((d) => !d.available);
			if (available.length > 0) recommendations.push(`✅ 已发现 ${available.length} 个可用服务：${available.map((d) => d.service).join(", ")}`);
			const missingByCategory = /* @__PURE__ */ new Map();
			for (const svc of unavailable) {
				if (!svc.recommendation) continue;
				const arr = missingByCategory.get(svc.category) ?? [];
				arr.push(svc.recommendation);
				missingByCategory.set(svc.category, arr);
			}
			if (missingByCategory.has("im")) recommendations.push(`📱 IM 渠道：${missingByCategory.get("im").join("；")}`);
			if (missingByCategory.has("ai")) recommendations.push(`🤖 AI 服务：${missingByCategory.get("ai").join("；")}`);
			if (missingByCategory.has("iot")) recommendations.push(`🏭 IoT 设备：${missingByCategory.get("iot").join("；")}`);
			return recommendations;
		}
	};
}
//#endregion
//#region src/claworks/harness-sync.ts
/**
* harness-sync.ts — ClaWorks + OpenClaw Harness 双向同步
*
* 职责：
* 1. 检测本机 OpenClaw 安装（~/.openclaw/agents）
* 2. 从 OpenClaw 同步模型配置到 ClaWorks model-router
* 3. 向 OpenClaw agent 注册 ClaWorks cw_ 工具
*
* 边界：
* - 不依赖 OpenClaw SDK（runtime 包独立测试）
* - 通过文件系统读写进行配置同步
* - 不修改 OpenClaw 运行时，只扩展 agent tools 列表
*/
const CW_TOOLS_FOR_OPENCLAW = [
	{
		name: "cw_bridge_im_message",
		description: "通过 ClaWorks IM 桥发送消息（飞书/企微/钉钉）",
		parameters: {
			type: "object",
			required: [
				"channel",
				"recipient",
				"content"
			],
			properties: {
				channel: {
					type: "string",
					description: "渠道类型：feishu | weixin_work | dingtalk"
				},
				recipient: {
					type: "string",
					description: "收件人 ID"
				},
				content: {
					type: "string",
					description: "消息内容"
				},
				card_template: {
					type: "string",
					description: "卡片模板名称（可选）"
				}
			}
		}
	},
	{
		name: "cw_trigger_playbook",
		description: "在 ClaWorks 中触发一个 Playbook 执行",
		parameters: {
			type: "object",
			required: ["playbook_id"],
			properties: {
				playbook_id: {
					type: "string",
					description: "Playbook ID"
				},
				params: {
					type: "object",
					description: "Playbook 参数"
				}
			}
		}
	},
	{
		name: "cw_query_kb",
		description: "在 ClaWorks 知识库中语义搜索",
		parameters: {
			type: "object",
			required: ["query"],
			properties: {
				query: {
					type: "string",
					description: "搜索关键词"
				},
				top_k: {
					type: "integer",
					default: 5
				}
			}
		}
	},
	{
		name: "cw_get_equipment_status",
		description: "查询工业设备状态（通过 ClaWorks 工业域能力）",
		parameters: {
			type: "object",
			properties: { equipment_id: {
				type: "string",
				description: "设备 ID（可选，不填返回所有）"
			} }
		}
	},
	{
		name: "cw_create_work_order",
		description: "在 ClaWorks 中创建维护工单",
		parameters: {
			type: "object",
			required: ["title", "equipment_id"],
			properties: {
				title: { type: "string" },
				equipment_id: { type: "string" },
				priority: {
					type: "string",
					enum: [
						"low",
						"medium",
						"high",
						"critical"
					]
				},
				description: { type: "string" }
			}
		}
	}
];
function tryReadJson(filePath) {
	try {
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}
function findOpenClawBase() {
	const candidates = [join(homedir(), ".openclaw"), join(homedir(), ".config", "openclaw")];
	const envBase = process.env.OPENCLAW_CONFIG_PATH;
	if (envBase) candidates.unshift(envBase);
	for (const base of candidates) if (existsSync(base)) return base;
	return null;
}
function scanAgents(base) {
	const agentsDir = join(base, "agents");
	if (!existsSync(agentsDir)) return [];
	const agents = [];
	let entries;
	try {
		entries = readdirSync(agentsDir);
	} catch {
		return [];
	}
	for (const entry of entries) {
		const agentDir = join(agentsDir, entry);
		try {
			if (!statSync(agentDir).isDirectory()) continue;
		} catch {
			continue;
		}
		const configCandidates = [join(agentDir, "agent", "config.json"), join(agentDir, "config.json")];
		for (const cp of configCandidates) {
			const config = tryReadJson(cp);
			if (config) {
				agents.push({
					agentId: entry,
					configPath: cp,
					config: {
						agentId: entry,
						...config
					}
				});
				break;
			}
		}
	}
	return agents;
}
let _lastSyncAt;
let _syncedModelsCount = 0;
let _pushedTools = [];
function createHarnessSync(runtime) {
	return {
		async detectOpenClaw() {
			const base = findOpenClawBase();
			if (!base) {
				const envAgentId = process.env.OPENCLAW_AGENT_ID;
				if (envAgentId) return {
					found: true,
					configPath: join(homedir(), ".openclaw"),
					agentConfigs: [{
						agentId: envAgentId,
						configPath: "env",
						config: { agentId: envAgentId }
					}]
				};
				return { found: false };
			}
			const agentConfigs = scanAgents(base);
			let version;
			for (const vp of [join(base, "version"), join(base, ".version")]) if (existsSync(vp)) {
				try {
					version = readFileSync(vp, "utf8").trim();
				} catch {}
				break;
			}
			return {
				found: true,
				configPath: base,
				agentConfigs,
				version
			};
		},
		async syncFromOpenClaw(configPath) {
			const result = {
				synced: false,
				models_imported: 0,
				skills_discovered: 0,
				channels_found: 0,
				recommendations: []
			};
			try {
				const agents = scanAgents(configPath);
				if (agents.length === 0) {
					result.recommendations.push("未找到 OpenClaw Agent 配置，请确认 ~/.openclaw/agents/ 目录");
					return result;
				}
				const targetAgentId = process.env.OPENCLAW_AGENT_ID;
				const agent = (targetAgentId ? agents.find((a) => a.agentId === targetAgentId) : void 0) ?? agents[0];
				if (!agent) return result;
				result.agent_id = agent.agentId;
				if (agent.config.models && agent.config.models.length > 0) for (const model of agent.config.models) try {
					await runtime.kb.ingest(`# OpenClaw 模型：${model.displayName ?? model.id}\n- provider: ${model.provider}\n- modelId: ${model.modelId}\n- id: ${model.id}`, {
						source: "harness:openclaw_sync",
						namespace: "openclaw-models"
					});
					result.models_imported++;
				} catch {}
				if (agent.config.skills) result.skills_discovered = agent.config.skills.length;
				if (agent.config.channels) result.channels_found = agent.config.channels.length;
				if (result.models_imported === 0) result.recommendations.push("OpenClaw agent 中未发现模型配置，请在 OpenClaw 中先配置 LLM Provider");
				if (result.channels_found === 0) result.recommendations.push("OpenClaw agent 中未发现渠道配置，ClaWorks 将使用独立配置的 IM 渠道");
				result.synced = true;
				_lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
				_syncedModelsCount = result.models_imported;
				await runtime.kernel.publish("harness.sync_completed", "harness-sync", {
					agent_id: agent.agentId,
					models_imported: result.models_imported,
					skills_discovered: result.skills_discovered
				});
			} catch (err) {
				result.recommendations.push(`同步失败：${err instanceof Error ? err.message : String(err)}`);
			}
			return result;
		},
		async pushToOpenClaw(opts) {
			const base = findOpenClawBase();
			if (!base) return {
				pushed: false,
				tools_registered: [],
				error: "未找到 OpenClaw 安装目录"
			};
			const agents = scanAgents(base);
			const targetAgentId = opts?.agentId ?? process.env.OPENCLAW_AGENT_ID ?? agents[0]?.agentId;
			if (!targetAgentId) return {
				pushed: false,
				tools_registered: [],
				error: "未找到可用的 OpenClaw Agent"
			};
			const agentEntry = agents.find((a) => a.agentId === targetAgentId);
			if (!agentEntry) return {
				pushed: false,
				tools_registered: [],
				error: `Agent ${targetAgentId} 未找到`
			};
			try {
				const existingConfig = agentEntry.config;
				const existingToolNames = new Set((existingConfig.tools ?? []).map((t) => t.name));
				const toolsToAdd = CW_TOOLS_FOR_OPENCLAW.filter((t) => !existingToolNames.has(t.name));
				const updatedConfig = {
					...existingConfig,
					tools: [...existingConfig.tools ?? [], ...toolsToAdd]
				};
				writeFileSync(agentEntry.configPath, JSON.stringify(updatedConfig, null, 2), "utf8");
				const registered = toolsToAdd.map((t) => t.name);
				_pushedTools = registered;
				runtime.logger?.(`[harness-sync] 已向 OpenClaw Agent ${targetAgentId} 注册 ${registered.length} 个 ClaWorks 工具`);
				return {
					pushed: true,
					tools_registered: registered,
					target_agent_id: targetAgentId
				};
			} catch (err) {
				return {
					pushed: false,
					tools_registered: [],
					error: err instanceof Error ? err.message : String(err)
				};
			}
		},
		async bidirectionalSync() {
			const detection = await this.detectOpenClaw();
			if (!detection.found || !detection.configPath) return {
				synced: false,
				models_imported: 0,
				skills_discovered: 0,
				channels_found: 0,
				recommendations: ["未找到 OpenClaw 安装，跳过双向同步"]
			};
			const syncResult = await this.syncFromOpenClaw(detection.configPath);
			const pushResult = await this.pushToOpenClaw();
			if (!pushResult.pushed && pushResult.error) syncResult.recommendations.push(`推送工具失败：${pushResult.error}`);
			return syncResult;
		},
		async status() {
			return {
				lastSyncAt: _lastSyncAt,
				openclaw_found: !!(await this.detectOpenClaw()).found,
				models_synced: _syncedModelsCount,
				tools_pushed: _pushedTools
			};
		}
	};
}
//#endregion
//#region src/kernel/bridge-registry.ts
const BRIDGE_NOTIFY = "notify";
//#endregion
//#region src/kernel/capability-registry.ts
var CapabilityDenied = class extends Error {
	constructor(capabilityId, tier, reason) {
		super(`Capability "${capabilityId}" denied by constitution (tier ${tier}): ${reason}`);
		this.name = "CapabilityDenied";
		this.capabilityId = capabilityId;
		this.tier = tier;
		this.constitutionReason = reason;
	}
};
var CapabilityHitlRequired = class extends Error {
	constructor(capabilityId, tier, reason) {
		super(`Capability "${capabilityId}" requires HITL (tier ${tier}): ${reason}`);
		this.name = "CapabilityHitlRequired";
		this.capabilityId = capabilityId;
		this.tier = tier;
		this.constitutionReason = reason;
	}
};
var CapabilityNotFound = class extends Error {
	constructor(capabilityId) {
		super(`Capability "${capabilityId}" not found in registry`);
		this.name = "CapabilityNotFound";
		this.capabilityId = capabilityId;
	}
};
/** 熔断器配置 */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_OPEN_DURATION_MS = 3e4;
const CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS = 1e4;
function createCapabilityRegistry() {
	const map = /* @__PURE__ */ new Map();
	let _constitution;
	const circuitBreakers = /* @__PURE__ */ new Map();
	function getCb(id) {
		if (!circuitBreakers.has(id)) circuitBreakers.set(id, {
			failureCount: 0,
			state: "closed",
			lastFailureAt: 0,
			openUntil: 0,
			halfOpenSince: 0
		});
		return circuitBreakers.get(id);
	}
	function recordSuccess(id) {
		const cb = circuitBreakers.get(id);
		if (!cb) return;
		cb.failureCount = 0;
		cb.state = "closed";
		cb.openUntil = 0;
		cb.halfOpenSince = 0;
	}
	function recordFailure(id) {
		const cb = getCb(id);
		cb.failureCount += 1;
		cb.lastFailureAt = Date.now();
		if (cb.state === "half-open" || cb.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
			cb.state = "open";
			cb.openUntil = Date.now() + CIRCUIT_BREAKER_OPEN_DURATION_MS;
		}
	}
	function checkCircuitBreaker(id) {
		const cb = circuitBreakers.get(id);
		if (!cb || cb.state === "closed") return "allow";
		const now = Date.now();
		if (cb.state === "open") {
			if (now >= cb.openUntil) {
				cb.state = "half-open";
				cb.halfOpenSince = now;
				return "half-open";
			}
			return "open";
		}
		if (cb.state === "half-open") {
			if (now - cb.halfOpenSince > CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS) {
				cb.state = "open";
				cb.openUntil = now + CIRCUIT_BREAKER_OPEN_DURATION_MS;
				return "open";
			}
			return "half-open";
		}
		return "allow";
	}
	function register(descriptor) {
		if (!descriptor.id.trim()) throw new Error("CapabilityRegistry: id must not be empty");
		if (map.has(descriptor.id)) throw new Error(`CapabilityRegistry: capability already registered: ${descriptor.id}`);
		map.set(descriptor.id, descriptor);
	}
	return {
		register,
		registerAll(descriptors) {
			for (const d of descriptors) register(d);
		},
		unregisterPack(packId) {
			for (const [id, desc] of map.entries()) if (desc.owner.kind === "pack" && desc.owner.packId === packId) map.delete(id);
		},
		get(id) {
			return map.get(id);
		},
		list() {
			return [...map.values()].filter((d) => d.advertise !== false).map((d) => ({
				id: d.id,
				verb: d.verb,
				description: d.description,
				paramsSchema: d.paramsSchema,
				owner: d.owner
			}));
		},
		listAll() {
			return [...map.keys()];
		},
		setConstitution(constitution) {
			_constitution = constitution;
		},
		listCircuitBreakers() {
			return [...circuitBreakers.entries()].map(([id, cb]) => ({
				capabilityId: id,
				state: cb.state,
				failureCount: cb.failureCount,
				lastFailureAt: cb.lastFailureAt || void 0,
				openUntil: cb.openUntil || void 0
			}));
		},
		resetCircuitBreaker(capabilityId) {
			circuitBreakers.delete(capabilityId);
		},
		async invoke(id, ctx, params, opts = {}) {
			const descriptor = map.get(id);
			if (!descriptor) throw new CapabilityNotFound(id);
			const cbStatus = checkCircuitBreaker(id);
			if (cbStatus === "open") {
				const cb = circuitBreakers.get(id);
				throw new Error(`Capability "${id}" circuit breaker is OPEN (${cb.failureCount} failures). Retry after ${Math.ceil((cb.openUntil - Date.now()) / 1e3)}s`);
			}
			if (descriptor.rbac) {
				if (descriptor.rbac.decision === "deny") throw new CapabilityDenied(id, 1, descriptor.rbac.reason ?? "Denied by capability descriptor");
				if (descriptor.rbac.decision === "hitl_required") throw new CapabilityHitlRequired(id, 1, descriptor.rbac.reason ?? "HITL required by capability descriptor");
			}
			if (_constitution) {
				const decision = _constitution.check(id, opts.constitutionCheck);
				if (decision.action === "deny") throw new CapabilityDenied(id, decision.tier, decision.reason);
				if (decision.action === "hitl_required") throw new CapabilityHitlRequired(id, decision.tier, decision.reason);
			}
			try {
				const result = await descriptor.handler(ctx, params);
				if (cbStatus === "half-open") recordSuccess(id);
				return result;
			} catch (err) {
				recordFailure(id);
				throw err;
			}
		}
	};
}
//#endregion
//#region src/kernel/environment-scanner.ts
/**
* environment-scanner.ts — ClaWorks 环境感知引擎
*
* 感知维度（L1 增强）：
*   - 环境变量扫描（IM Token、API Key、数据库 URL）
*   - 文件系统扫描（配置文件、行为规范文档、项目文件）
*   - 网络服务探测（常见服务端口）
*   - OpenClaw 安装检测
*
* 事件发布：
*   environment.new_resource_detected — 发现新资源
*   environment.scan_completed       — 扫描完成摘要
*/
const ENV_PATTERNS = [
	{
		pattern: /^FEISHU_(APP_ID|APP_SECRET|TOKEN|WEBHOOK)$/,
		type: "im_token",
		hint: "飞书 IM 凭证，可自动对接飞书渠道",
		suggestedService: "feishu"
	},
	{
		pattern: /^LARK_(APP_ID|APP_SECRET|TOKEN)$/,
		type: "im_token",
		hint: "Lark IM 凭证（飞书国际版），可自动对接",
		suggestedService: "feishu"
	},
	{
		pattern: /^WEIXIN_WORK_(CORPID|CORP_SECRET|TOKEN|AGENT_ID)$/,
		type: "im_token",
		hint: "企业微信凭证，可自动对接企微渠道",
		suggestedService: "weixin_work"
	},
	{
		pattern: /^DINGTALK_(APP_KEY|APP_SECRET|TOKEN|ROBOT_TOKEN)$/,
		type: "im_token",
		hint: "钉钉凭证，可自动对接钉钉渠道",
		suggestedService: "dingtalk"
	},
	{
		pattern: /^TELEGRAM_(BOT_TOKEN|TOKEN)$/,
		type: "im_token",
		hint: "Telegram Bot Token，可自动对接 Telegram",
		suggestedService: "telegram"
	},
	{
		pattern: /^OPENAI_API_KEY$/,
		type: "api_key",
		hint: "OpenAI API Key，可用于 LLM 推理",
		suggestedService: "openai"
	},
	{
		pattern: /^ANTHROPIC_API_KEY$/,
		type: "api_key",
		hint: "Anthropic API Key，可用于 Claude 推理",
		suggestedService: "anthropic"
	},
	{
		pattern: /^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|PG_URL)$/,
		type: "database_url",
		hint: "PostgreSQL 数据库 URL",
		suggestedService: "postgresql"
	},
	{
		pattern: /^MYSQL_URL$/,
		type: "database_url",
		hint: "MySQL 数据库 URL",
		suggestedService: "mysql"
	},
	{
		pattern: /^(REDIS_URL|REDIS_URI)$/,
		type: "database_url",
		hint: "Redis URL",
		suggestedService: "redis"
	},
	{
		pattern: /^MONGODB_(URL|URI)$/,
		type: "database_url",
		hint: "MongoDB URL",
		suggestedService: "mongodb"
	},
	{
		pattern: /^OPENCLAW_/,
		type: "openclaw_config",
		hint: "OpenClaw 配置变量，可自动同步",
		suggestedService: "openclaw"
	},
	{
		pattern: /^CLAWORKS_/,
		type: "claworks_config",
		hint: "ClaWorks 配置变量",
		suggestedService: "claworks"
	},
	{
		pattern: /(_TOKEN|_API_KEY|_SECRET|_PASSWORD|_CREDENTIAL)$/,
		type: "other_credential",
		hint: "可能是 API 凭证或密钥"
	}
];
const FILE_PATTERNS = [
	{
		pattern: /^ROBOT\.md$/i,
		type: "behavior_doc",
		name: "机器人行为规范",
		autoConnectable: true,
		suggestedConnector: "kb_ingest"
	},
	{
		pattern: /^AGENTS\.md$/i,
		type: "behavior_doc",
		name: "Agent 行为规范",
		autoConnectable: true,
		suggestedConnector: "kb_ingest"
	},
	{
		pattern: /^CLAUDE\.md$/i,
		type: "behavior_doc",
		name: "Claude 行为规范",
		autoConnectable: true,
		suggestedConnector: "kb_ingest"
	},
	{
		pattern: /^claworks\.robot\.json$/i,
		type: "config_file",
		name: "ClaWorks 机器人配置",
		autoConnectable: true,
		suggestedConnector: "robot_config_loader"
	},
	{
		pattern: /^openclaw\.json$/i,
		type: "config_file",
		name: "OpenClaw 配置",
		autoConnectable: true,
		suggestedConnector: "harness_sync"
	},
	{
		pattern: /\.openclaw\.fragment\.json$/i,
		type: "config_file",
		name: "OpenClaw 配置片段",
		autoConnectable: false
	},
	{
		pattern: /^\.env$/,
		type: "config_file",
		name: "环境变量文件",
		autoConnectable: false
	},
	{
		pattern: /\.ya?ml$/i,
		type: "config_file",
		name: "YAML 配置文件",
		autoConnectable: false
	},
	{
		pattern: /^requirements\.txt$/i,
		type: "config_file",
		name: "Python 依赖清单",
		autoConnectable: false
	},
	{
		pattern: /^package\.json$/i,
		type: "config_file",
		name: "Node.js 项目配置",
		autoConnectable: false
	}
];
const KNOWN_SERVICES = [
	{
		port: 5432,
		name: "PostgreSQL",
		type: "database",
		suggestedConnector: "postgresql"
	},
	{
		port: 3306,
		name: "MySQL",
		type: "database",
		suggestedConnector: "mysql"
	},
	{
		port: 6379,
		name: "Redis",
		type: "database",
		suggestedConnector: "redis"
	},
	{
		port: 27017,
		name: "MongoDB",
		type: "database",
		suggestedConnector: "mongodb"
	},
	{
		port: 1883,
		name: "MQTT Broker",
		type: "iot_device",
		suggestedConnector: "mqtt"
	},
	{
		port: 8883,
		name: "MQTT Broker (TLS)",
		type: "iot_device",
		suggestedConnector: "mqtt"
	},
	{
		port: 4840,
		name: "OPC-UA Server",
		type: "iot_device",
		suggestedConnector: "opcua"
	},
	{
		port: 502,
		name: "Modbus TCP",
		type: "iot_device",
		suggestedConnector: "modbus"
	},
	{
		port: 11434,
		name: "Ollama LLM",
		type: "ai_agent",
		suggestedConnector: "openai_compatible"
	},
	{
		port: 8e3,
		name: "ClaWorks/OpenClaw Gateway",
		type: "ai_agent"
	},
	{
		port: 18800,
		name: "ClaWorks Gateway (product)",
		type: "ai_agent"
	}
];
function probePort(host, port, timeoutMs) {
	const start = Date.now();
	return new Promise((resolve) => {
		const socket = createConnection({
			host,
			port
		});
		const timer = setTimeout(() => {
			socket.destroy();
			resolve({
				reachable: false,
				host,
				port
			});
		}, timeoutMs);
		socket.on("connect", () => {
			clearTimeout(timer);
			const latencyMs = Date.now() - start;
			socket.destroy();
			resolve({
				reachable: true,
				host,
				port,
				latencyMs
			});
		});
		socket.on("error", () => {
			clearTimeout(timer);
			resolve({
				reachable: false,
				host,
				port
			});
		});
	});
}
function detectOpenClawSync() {
	const candidates = [join(homedir(), ".openclaw"), join(homedir(), ".config", "openclaw")];
	for (const base of candidates) {
		if (!existsSync(base)) continue;
		const agentsDir = join(base, "agents");
		let agentCount = 0;
		if (existsSync(agentsDir)) try {
			agentCount = readdirSync(agentsDir).filter((entry) => {
				return statSync(join(agentsDir, entry)).isDirectory();
			}).length;
		} catch {}
		let version;
		const versionCandidates = [join(base, "version"), join(base, ".version")];
		for (const vp of versionCandidates) if (existsSync(vp)) {
			try {
				version = readFileSync(vp, "utf8").trim();
			} catch {}
			break;
		}
		return {
			found: true,
			configPath: base,
			version,
			agentCount
		};
	}
	const envAgentId = process.env.OPENCLAW_AGENT_ID;
	const envConfigPath = process.env.OPENCLAW_CONFIG_PATH;
	if (envAgentId || envConfigPath) return {
		found: true,
		configPath: envConfigPath ?? join(homedir(), ".openclaw"),
		version: process.env.OPENCLAW_VERSION
	};
	return { found: false };
}
function scanDir(dirPath, patterns, maxDepth, currentDepth, results) {
	if (currentDepth > maxDepth) return;
	if (!existsSync(dirPath)) return;
	let entries;
	try {
		entries = readdirSync(dirPath);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.startsWith(".") && currentDepth > 0) continue;
		if (entry === "node_modules" || entry === ".git" || entry === "__pycache__") continue;
		const fullPath = join(dirPath, entry);
		let stat;
		try {
			stat = statSync(fullPath);
		} catch {
			continue;
		}
		if (stat.isDirectory()) scanDir(fullPath, patterns, maxDepth, currentDepth + 1, results);
		else if (stat.isFile()) {
			for (const fp of FILE_PATTERNS) if (fp.pattern.test(entry)) {
				const id = `fs:${fullPath}`;
				if (!results.some((r) => r.id === id)) results.push({
					id,
					type: fp.type,
					name: fp.name,
					location: fullPath,
					status: "available",
					autoConnectable: fp.autoConnectable,
					suggestedConnector: fp.suggestedConnector,
					metadata: {
						size: stat.size,
						mtime: stat.mtime.toISOString()
					},
					discoveredAt: /* @__PURE__ */ new Date()
				});
				break;
			}
			for (const pat of patterns) if (pat.test(entry)) {
				const id = `fs:${fullPath}`;
				if (!results.some((r) => r.id === id)) results.push({
					id,
					type: "file_system",
					name: entry,
					location: fullPath,
					status: "available",
					autoConnectable: false,
					metadata: {
						size: stat.size,
						mtime: stat.mtime.toISOString()
					},
					discoveredAt: /* @__PURE__ */ new Date()
				});
			}
		}
	}
}
function createEnvironmentScanner() {
	return {
		async scanEnvVars() {
			const hints = [];
			const seen = /* @__PURE__ */ new Set();
			for (const [key, value] of Object.entries(process.env)) {
				if (!value || seen.has(key)) continue;
				for (const pattern of ENV_PATTERNS) if (pattern.pattern.test(key)) {
					hints.push({
						key,
						type: pattern.type,
						hint: pattern.hint,
						suggestedService: pattern.suggestedService
					});
					seen.add(key);
					break;
				}
			}
			return hints;
		},
		async scanFileSystem(paths, opts) {
			const results = [];
			const maxDepth = opts?.maxDepth ?? 3;
			const customPatterns = (opts?.patterns ?? []).map((p) => new RegExp(p, "i"));
			for (const p of paths) scanDir(p, customPatterns, maxDepth, 0, results);
			return results;
		},
		async probeNetworkService(host, port, timeoutMs = 2e3) {
			return probePort(host, port, timeoutMs);
		},
		async detectOpenClaw() {
			return detectOpenClawSync();
		},
		async webSearch(query, limit = 5) {
			const searxng = process.env.SEARXNG_URL;
			const brave = process.env.BRAVE_SEARCH_API_KEY;
			const serper = process.env.SERPER_API_KEY;
			if (searxng) try {
				const url = `${searxng}/search?q=${encodeURIComponent(query)}&format=json&results=${limit}`;
				return ((await fetch(url).then((r) => r.json())).results ?? []).slice(0, limit).map((r) => ({
					title: r.title ?? "",
					url: r.url ?? "",
					snippet: r.content ?? ""
				}));
			} catch {}
			if (brave) try {
				return ((await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, { headers: {
					Accept: "application/json",
					"X-Subscription-Token": brave
				} }).then((r) => r.json())).web?.results ?? []).slice(0, limit).map((r) => ({
					title: r.title ?? "",
					url: r.url ?? "",
					snippet: r.description ?? ""
				}));
			} catch {}
			if (serper) try {
				return ((await fetch("https://google.serper.dev/search", {
					method: "POST",
					headers: {
						"X-API-KEY": serper,
						"Content-Type": "application/json"
					},
					body: JSON.stringify({
						q: query,
						num: limit
					})
				}).then((r) => r.json())).organic ?? []).slice(0, limit).map((r) => ({
					title: r.title ?? "",
					url: r.link ?? "",
					snippet: r.snippet ?? ""
				}));
			} catch {}
			return [];
		},
		async scan(scope) {
			const start = Date.now();
			const resources = [];
			let envVars = [];
			if (scope?.environment !== false) envVars = await this.scanEnvVars();
			if (scope?.fileSystem !== false) {
				const paths = scope?.fileSystem?.paths ?? [process.cwd(), homedir()];
				const maxDepth = scope?.fileSystem?.maxDepth ?? 2;
				const patterns = scope?.fileSystem?.patterns;
				const fsResults = await this.scanFileSystem(paths, {
					maxDepth,
					patterns
				});
				resources.push(...fsResults);
			}
			if (scope?.knownServices !== false) {
				const host = "127.0.0.1";
				const timeoutMs = scope?.network?.timeoutMs ?? 1500;
				const probes = KNOWN_SERVICES.map(async (svc) => {
					const result = await probePort(host, svc.port, timeoutMs);
					if (result.reachable) resources.push({
						id: `net:${host}:${svc.port}`,
						type: svc.type,
						name: svc.name,
						location: `${host}:${svc.port}`,
						status: "available",
						autoConnectable: !!svc.suggestedConnector,
						suggestedConnector: svc.suggestedConnector,
						metadata: {
							host,
							port: svc.port,
							latency_ms: result.latencyMs
						},
						discoveredAt: /* @__PURE__ */ new Date()
					});
				});
				await Promise.all(probes);
			}
			if (scope?.network?.ports && scope.network.hosts) {
				const timeoutMs = scope.network.timeoutMs ?? 1500;
				const probes = scope.network.hosts.flatMap((host) => (scope.network?.ports ?? []).map(async (port) => {
					const result = await probePort(host, port, timeoutMs);
					if (result.reachable) resources.push({
						id: `net:${host}:${port}`,
						type: "network_service",
						name: `${host}:${port}`,
						location: `${host}:${port}`,
						status: "available",
						autoConnectable: false,
						metadata: {
							host,
							port,
							latency_ms: result.latencyMs
						},
						discoveredAt: /* @__PURE__ */ new Date()
					});
				}));
				await Promise.all(probes);
			}
			const openClaw = await this.detectOpenClaw();
			return {
				resources,
				envVars,
				openClaw,
				scannedAt: /* @__PURE__ */ new Date(),
				durationMs: Date.now() - start
			};
		}
	};
}
//#endregion
//#region src/kernel/evolve-engine.ts
function buildSystemPrompt(capIds, playbookExamples) {
	return `你是 ClaWorks 机器人的 Playbook 工程师。
用户描述一个业务需求，你需要生成一个可执行的 Playbook YAML。

## 已注册的能力（从这些中选择 action）：
${capIds || "（暂无，请使用通用能力）"}

## Playbook YAML 格式示例：
${playbookExamples || "（暂无已有 Playbook）"}

## 完整 Playbook YAML 格式说明：
\`\`\`yaml
id: unique_playbook_id          # 唯一标识符，snake_case
name: 可读名称
pack: user_evolved              # 固定为 user_evolved
trigger:
  kind: event
  pattern: event.name           # 触发事件
  condition: "{{ expr }}"       # 可选过滤条件
priority: 500
steps:
  - kind: action
    id: step_id
    action: capability.id       # 必须是已注册的能力 ID
    params:
      key: "{{ event.payload.key }}"
    store_result_as: result_var
    on_failure: continue

  - kind: condition
    id: check_something
    if: "{{ result_var.value > 85 }}"
    then:
      - kind: action
        id: sub_step
        action: another.capability
        params: {}

  - kind: hitl
    id: confirm
    message: "确认执行？"
    timeout_seconds: 300
\`\`\`

## 重要规则：
1. action: 字段必须使用已注册的能力 ID
2. notify.dispatch 用于跨渠道通知，comms.send 用于回复 IM 消息
3. object.create 用于创建工单/记录
4. 模板使用 Jinja2 语法：{{ event.payload.field }}
5. 触发事件 pattern 可以是标准事件（如 sensor.reading_received）也可以是自定义事件

以 JSON 格式返回，包含：
{
  "title": "方案名称",
  "description": "方案说明",
  "playbook_yaml": "完整YAML字符串",
  "required_capabilities": ["能力id"],
  "missing_capabilities": ["不在列表中但需要的能力"],
  "trigger_event": "触发事件名",
  "test_event": "测试时发布的事件名",
  "test_payload": {"测试载荷"},
  "confidence": 0.85,
  "warnings": ["潜在问题"]
}`;
}
const PROPOSAL_SCHEMA = {
	type: "object",
	required: [
		"title",
		"description",
		"playbook_yaml",
		"required_capabilities",
		"trigger_event",
		"test_event",
		"test_payload",
		"confidence"
	],
	properties: {
		title: { type: "string" },
		description: { type: "string" },
		playbook_yaml: { type: "string" },
		required_capabilities: { type: "array" },
		missing_capabilities: { type: "array" },
		trigger_event: { type: "string" },
		test_event: { type: "string" },
		test_payload: { type: "object" },
		confidence: { type: "number" },
		warnings: { type: "array" }
	}
};
function createEvolveEngine(runtime) {
	return {
		async propose(req) {
			const capIds = runtime.capabilities.list().slice(0, 60).map((c) => `${c.id}  # ${c.description ?? ""}`).join("\n");
			const playbookExamples = runtime.playbookEngine.listPlaybooks().slice(0, 3).map((p) => {
				const trigger = p.trigger?.pattern ?? "some.event";
				return `# 示例: ${p.id}\ntrigger:\n  kind: event\n  pattern: ${trigger}\nsteps: [...]`;
			}).join("\n\n");
			const cbrExamples = req.examples ?? [];
			if (runtime.cbrStore) {
				const cases = runtime.cbrStore.search(req.description, 2);
				for (const c of cases) {
					const prob = String(c.problem ?? "");
					const sol = String(c.solution ?? "").slice(0, 200);
					cbrExamples.push(`# 历史案例（相似度高）\n问题: ${prob}\n方案摘要: ${sol}`);
				}
			}
			const systemPrompt = buildSystemPrompt(capIds, playbookExamples);
			const userPrompt = [
				`用户需求：${req.description}`,
				req.context ? `\n额外上下文：${req.context}` : "",
				cbrExamples.length > 0 ? `\n参考案例：\n${cbrExamples.join("\n")}` : ""
			].filter(Boolean).join("");
			if (runtime.structuredOutput) {
				const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
				const { data } = await runtime.structuredOutput.complete(combinedPrompt, PROPOSAL_SCHEMA, {
					maxRetries: 3,
					fallback: buildFallbackProposal(req.description)
				});
				return normalizeProposal(data, req.description);
			}
			const completeFn = (runtime.bridges?.get("llm"))?.complete ?? runtime.llmComplete;
			if (!completeFn) {
				runtime.logger?.("[EvolveEngine] no LLM configured, returning minimal fallback proposal");
				return {
					id: `evolved_${Date.now()}`,
					...buildFallbackProposal(req.description)
				};
			}
			const result = await completeFn({ prompt: `${systemPrompt}\n\n${userPrompt}\n\n请直接返回 JSON，不要 markdown 代码块。` });
			try {
				const match = result.text.match(/\{[\s\S]*\}/);
				const parsed = match ? JSON.parse(match[0]) : null;
				if (parsed) return normalizeProposal(parsed, req.description);
			} catch {}
			return {
				id: `evolved_${Date.now()}`,
				...buildFallbackProposal(req.description)
			};
		},
		async deploy(proposal, opts = {}) {
			const packId = opts.packId ?? "user_evolved";
			const packDir = join(join(process.cwd(), "contrib", "packs"), packId);
			const playbooksDir = join(packDir, "ontology", "playbooks");
			await mkdir(playbooksDir, { recursive: true });
			const filePath = join(playbooksDir, `${proposal.id}.yaml`);
			await writeFile(filePath, proposal.playbook_yaml, "utf8");
			const packJsonPath = join(packDir, "claworks.pack.json");
			try {
				await mkdir(packDir, { recursive: true });
				await writeFile(packJsonPath, JSON.stringify({
					id: packId,
					name: "用户进化 Pack",
					version: "1.0.0",
					description: "用户通过对话自动生成的 Playbook",
					license: "proprietary",
					provides: {
						objectTypes: [],
						playbooks: [],
						actionTypes: []
					}
				}, null, 2), { flag: "wx" });
			} catch {}
			let deployed = false;
			try {
				const loadedPack = await runtime.packLoader.load(packDir, runtime.logger);
				await runtime.playbookEngine.loadFromPacks([loadedPack]);
				const existingIdx = runtime.loadedPacks.findIndex((p) => p.manifest.id === loadedPack.manifest.id);
				if (existingIdx >= 0) runtime.loadedPacks[existingIdx] = loadedPack;
				else runtime.loadedPacks.push(loadedPack);
				deployed = true;
				runtime.logger?.(`[EvolveEngine] deployed playbook ${proposal.id} to ${filePath}`);
			} catch (err) {
				runtime.logger?.(`[EvolveEngine] hot-reload failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return {
				proposal,
				deployed,
				playbook_path: filePath
			};
		},
		async verify(playbookId, testEvent, testPayload) {
			try {
				const log = [];
				const unsubCompleted = runtime.kernel.subscribe("playbook.run.completed", (payload) => {
					if (payload["playbook_id"] === playbookId) log.push({
						...payload,
						kind: "completed"
					});
				});
				const unsubFailed = runtime.kernel.subscribe("playbook.run.failed", (payload) => {
					if (payload["playbook_id"] === playbookId) log.push({
						...payload,
						kind: "failed"
					});
				});
				await runtime.kernel.publish(testEvent, "evolve-verify", testPayload);
				await new Promise((resolve) => setTimeout(resolve, 5e3));
				unsubCompleted();
				unsubFailed();
				if (log.length > 0) return {
					passed: !log.some((l) => l["kind"] === "failed"),
					output: log[0]
				};
				const runs = await runtime.playbookEngine.listRuns({
					playbookId,
					limit: 1
				});
				if (runs.length > 0) {
					const run = runs[0];
					return {
						passed: run.status === "completed",
						output: {
							run_id: run.id,
							status: run.status
						}
					};
				}
				return {
					passed: false,
					error: `测试事件 '${testEvent}' 已发布，但 Playbook '${playbookId}' 未在 5s 内触发。请检查 trigger.pattern 是否匹配。`
				};
			} catch (err) {
				return {
					passed: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		},
		async learn(result, feedback) {
			if (!runtime.cbrStore) return;
			const tags = [
				"evolved",
				`trigger:${result.proposal.trigger_event}`,
				...result.proposal.required_capabilities.map((c) => `cap:${c}`)
			];
			const caseEntry = runtime.cbrStore.add({
				id: `evolved-${result.proposal.id}`,
				problem: result.proposal.description,
				solution: result.proposal.playbook_yaml,
				outcome: result.test_passed ? "success" : "partial",
				tags,
				playbookId: result.proposal.id
			});
			const entryId = String(caseEntry?.id ?? `evolved-${result.proposal.id}`);
			if (feedback) runtime.logger?.(`[EvolveEngine] learn feedback for ${entryId}: ${feedback}`);
			return entryId;
		},
		async listEvolved() {
			const playbooksDir = join(process.cwd(), "contrib", "packs", "user_evolved", "ontology", "playbooks");
			try {
				return (await readdir(playbooksDir)).filter((f) => f.endsWith(".yaml")).map((f) => ({
					id: f.replace(/\.yaml$/, ""),
					title: f.replace(/\.yaml$/, "").replace(/_/g, " ").replace(/^evolved\s+\d+$/, "用户进化 Playbook"),
					deployedAt: /* @__PURE__ */ new Date()
				}));
			} catch {
				return [];
			}
		},
		async remove(playbookId) {
			await unlink(join(process.cwd(), "contrib", "packs", "user_evolved", "ontology", "playbooks", `${playbookId}.yaml`)).catch(() => {});
			runtime.playbookEngine.unload?.(playbookId);
		}
	};
}
function buildFallbackProposal(description) {
	const id = `evolved_${Date.now()}`;
	return {
		title: description.slice(0, 40),
		description,
		playbook_yaml: [
			`id: ${id}`,
			`name: ${description.slice(0, 40)}`,
			"pack: user_evolved",
			`trigger:`,
			`  kind: event`,
			`  pattern: user.custom_event`,
			`steps: []`,
			`# TODO: LLM 未返回有效方案，请手动编辑此文件`
		].join("\n"),
		required_capabilities: [],
		missing_capabilities: [],
		trigger_event: "user.custom_event",
		test_event: "user.custom_event",
		test_payload: { _test: true },
		confidence: .1,
		warnings: ["LLM 未配置或未返回有效方案，已生成空模板，请手动完善"]
	};
}
function normalizeProposal(raw, description) {
	const id = typeof raw["id"] === "string" && raw["id"] ? raw["id"] : `evolved_${Date.now()}`;
	let yaml = String(raw["playbook_yaml"] ?? "");
	if (yaml && !yaml.includes(`id: ${id}`)) yaml = yaml.replace(/^id:\s*.+$/m, `id: ${id}`);
	return {
		id,
		title: String(raw["title"] ?? description.slice(0, 40)),
		description: String(raw["description"] ?? description),
		playbook_yaml: yaml || buildFallbackProposal(description).playbook_yaml,
		required_capabilities: Array.isArray(raw["required_capabilities"]) ? raw["required_capabilities"] : [],
		missing_capabilities: Array.isArray(raw["missing_capabilities"]) ? raw["missing_capabilities"] : [],
		trigger_event: String(raw["trigger_event"] ?? "user.custom_event"),
		test_event: String(raw["test_event"] ?? raw["trigger_event"] ?? "user.custom_event"),
		test_payload: raw["test_payload"] && typeof raw["test_payload"] === "object" ? raw["test_payload"] : { _test: true },
		confidence: typeof raw["confidence"] === "number" ? raw["confidence"] : .5,
		warnings: Array.isArray(raw["warnings"]) ? raw["warnings"] : []
	};
}
//#endregion
//#region src/kernel/robot-swarm.ts
async function fetchJson(url, timeoutMs = 5e3) {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}
function cardToPeer(endpoint, card) {
	const caps = [];
	if (card.capabilities?.skills) caps.push(...card.capabilities.skills.map((s) => s.name));
	if (card.metadata?.capabilities) caps.push(...card.metadata.capabilities);
	const id = `peer:${new URL(endpoint).host}`;
	return {
		id,
		name: card.name ?? id,
		endpoint,
		capabilities: [...new Set(caps)],
		role: card.metadata?.role,
		organization: card.metadata?.organization,
		domain: card.metadata?.domain,
		lastSeen: /* @__PURE__ */ new Date(),
		status: "online"
	};
}
function createRobotSwarm(runtime) {
	const peers = /* @__PURE__ */ new Map();
	const configPeers = runtime.config.a2a?.peers ?? [];
	for (const p of configPeers) {
		const id = `peer:${new URL(p.url).host}`;
		peers.set(id, {
			id,
			name: p.name ?? id,
			endpoint: p.url,
			capabilities: [],
			lastSeen: /* @__PURE__ */ new Date(0),
			status: "unknown"
		});
	}
	function updatePeer(peer) {
		const existing = peers.get(peer.id);
		peers.set(peer.id, {
			...existing,
			...peer
		});
	}
	return {
		async discover(broadcastOrRegistry) {
			const discovered = [];
			const endpointsToProbe = configPeers.map((p) => p.url);
			if (broadcastOrRegistry) {
				const registry = await fetchJson(broadcastOrRegistry);
				if (registry?.peers) endpointsToProbe.push(...registry.peers.map((p) => p.endpoint));
			}
			await Promise.all(endpointsToProbe.map(async (endpoint) => {
				const card = await fetchJson(`${endpoint.replace(/\/$/, "")}/a2a/agent-card`, 3e3);
				if (card) {
					const peer = cardToPeer(endpoint, card);
					updatePeer(peer);
					discovered.push(peer);
					await runtime.kernel.publish("swarm.peer_discovered", "robot-swarm", {
						peer_id: peer.id,
						peer_name: peer.name,
						capabilities: peer.capabilities,
						endpoint
					});
					runtime.logger?.(`[swarm] 发现对等机器人：${peer.name} @ ${endpoint}`);
				} else {
					const id = `peer:${new URL(endpoint).host}`;
					const existing = peers.get(id);
					if (existing && existing.status === "online") {
						updatePeer({
							...existing,
							status: "offline"
						});
						await runtime.kernel.publish("swarm.peer_lost", "robot-swarm", {
							peer_id: id,
							last_seen: existing.lastSeen.toISOString()
						});
					}
				}
			}));
			return discovered;
		},
		async syncFrom(peerId, what) {
			const start = Date.now();
			const peer = peers.get(peerId);
			const synced = {
				skills: 0,
				playbooks: 0,
				identity: 0,
				kb: 0
			};
			if (!peer) return {
				synced,
				peerId,
				duration_ms: Date.now() - start
			};
			const baseUrl = peer.endpoint.replace(/\/$/, "");
			if (what.includes("skills")) {
				const card = await fetchJson(`${baseUrl}/a2a/agent-card`, 3e3);
				if (card?.capabilities?.skills) for (const skill of card.capabilities.skills) {
					await runtime.kb.ingest(`# 对等机器人技能：${skill.name}\n${skill.description ?? ""}\n\n来源：${peer.name} (${peer.endpoint ?? String(peer.url ?? "")})`, {
						source: `swarm:${peerId}`,
						namespace: "swarm"
					}).catch(() => null);
					synced.skills++;
				}
			}
			if (what.includes("identity")) {
				const status = await fetchJson(`${baseUrl}/v1/status`, 3e3);
				if (status?.robot) {
					updatePeer({
						...peer,
						name: status.robot.name ?? peer.name,
						role: status.robot.role ?? peer.role,
						organization: status.robot.organization ?? peer.organization,
						syncedAt: /* @__PURE__ */ new Date()
					});
					synced.identity++;
				}
			}
			await runtime.kernel.publish("swarm.sync_completed", "robot-swarm", {
				peer_id: peerId,
				synced,
				duration_ms: Date.now() - start
			});
			return {
				synced,
				peerId,
				duration_ms: Date.now() - start
			};
		},
		async announce() {
			const announcement = {
				id: runtime.robot.name,
				name: runtime.robot.name,
				endpoint: runtime.robot.endpoint ?? `http://localhost:${runtime.config.robot?.port ?? 8e3}`,
				capabilities: runtime.capabilities.list().map((c) => c.id),
				role: runtime.robot.role,
				organization: runtime.config.robot?.organization,
				domain: runtime.config.robot?.domain,
				announced_at: (/* @__PURE__ */ new Date()).toISOString()
			};
			const endpointsToNotify = configPeers.map((p) => p.url);
			await Promise.all(endpointsToNotify.map(async (endpoint) => {
				try {
					const url = `${endpoint.replace(/\/$/, "")}/a2a/tasks/send`;
					await fetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							id: `announce-${Date.now()}`,
							message: {
								role: "user",
								parts: [{
									type: "text",
									text: `SWARM_ANNOUNCE:${JSON.stringify(announcement)}`
								}]
							}
						}),
						signal: AbortSignal.timeout(3e3)
					});
				} catch {}
			}));
			runtime.logger?.(`[swarm] 已广播自身能力（${announcement.capabilities.length} 个能力）`);
			await runtime.kernel.publish("swarm.announced", "robot-swarm", {
				capabilities_count: announcement.capabilities.length,
				peers_notified: endpointsToNotify.length
			});
		},
		async ping(peerId) {
			const peer = peers.get(peerId);
			if (!peer) return false;
			if (await fetchJson(`${peer.endpoint.replace(/\/$/, "")}/a2a/agent-card`, 2e3)) {
				updatePeer({
					...peer,
					lastSeen: /* @__PURE__ */ new Date(),
					status: "online"
				});
				return true;
			}
			updatePeer({
				...peer,
				status: "offline"
			});
			return false;
		},
		listPeers() {
			return [...peers.values()];
		},
		getPeer(id) {
			return peers.get(id);
		}
	};
}
function makeSwarmCapabilities(swarm) {
	return [
		{
			id: "swarm.discover",
			verb: "acquire",
			description: "发现对等机器人（通过 A2A agent-card 探测）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: { registry_url: {
					type: "string",
					description: "对等机器人注册表 URL（可选）"
				} }
			},
			handler: async (_ctx, params) => {
				const peers = await swarm.discover(params.registry_url);
				return {
					discovered: peers.length,
					peers: peers.map((p) => ({
						id: p.id,
						name: p.name,
						endpoint: p.endpoint,
						status: p.status
					}))
				};
			}
		},
		{
			id: "swarm.sync_from",
			verb: "acquire",
			description: "从对等机器人同步配置（技能/Playbook/身份/知识库）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["peer_id"],
				properties: {
					peer_id: { type: "string" },
					what: {
						type: "array",
						items: {
							type: "string",
							enum: [
								"skills",
								"playbooks",
								"identity",
								"kb"
							]
						},
						default: ["skills", "identity"]
					}
				}
			},
			handler: async (_ctx, params) => {
				const peerId = String(params.peer_id ?? "");
				const what = params.what ?? ["skills", "identity"];
				return swarm.syncFrom(peerId, what);
			}
		},
		{
			id: "swarm.announce",
			verb: "control",
			description: "向所有对等机器人广播自己的能力",
			owner: { kind: "core" },
			handler: async () => {
				await swarm.announce();
				return {
					status: "announced",
					peers_count: swarm.listPeers().length
				};
			}
		},
		{
			id: "swarm.list",
			verb: "query",
			description: "列出所有已知的对等机器人",
			owner: { kind: "core" },
			handler: async () => ({
				peers: swarm.listPeers().map((p) => ({
					id: p.id,
					name: p.name,
					endpoint: p.endpoint,
					capabilities_count: p.capabilities.length,
					status: p.status,
					last_seen: p.lastSeen.toISOString(),
					synced_at: p.syncedAt?.toISOString() ?? null
				})),
				count: swarm.listPeers().length
			})
		}
	];
}
//#endregion
//#region src/kernel/core-capabilities.ts
/**
* core-capabilities.ts — ClaWorks 机器人核心能力注册
*
* 分层（类比人的基础能力）：
*
*   L0  system.*     生命维持（心跳、自描述、健康）
*   L1  environment.*  感知环境（时间、上下文、主体画像）
*   L2  kb.*         记忆（学习、检索、遗忘）
*   L3  perceive.*   感知（理解消息、提取意图、解析实体）
*   L4  task.*       执行（运行任务、查询状态）
*   L5  object.*     操作（实体 CRUD）
*   L6  event.*      信号（发布事件）
*   L7  learn.*      主动学习（从观察中学习、调度学习任务）
*   L8  evolve.*     自我进化（发现接口、生成 Playbook、拓展能力）
*   L9  message.*    通用消息处理（兜底）
*/
function makeSystemHealthDescriptor(runtime) {
	return {
		id: "system.health",
		verb: "query",
		description: "返回机器人健康状态与诊断报告",
		owner: { kind: "core" },
		handler: async () => buildHealthPayload(runtime)
	};
}
function makeSystemStatusDescriptor(runtime) {
	return {
		id: "system.status",
		verb: "query",
		description: "返回机器人基础信息与运行时状态",
		owner: { kind: "core" },
		handler: async () => ({
			robot: runtime.robot.name,
			role: runtime.robot.role,
			version: runtime.robot.version,
			endpoint: runtime.robot.endpoint,
			packs: runtime.loadedPacks.map((p) => p.manifest.id),
			dialect: runtime.databaseDialect
		})
	};
}
function makeSystemDescribeDescriptor(registry) {
	return {
		id: "system.describe",
		verb: "query",
		description: "列出机器人所有已注册能力（自我介绍）",
		owner: { kind: "core" },
		handler: async () => ({ capabilities: registry.list() })
	};
}
function makeSystemVersionDescriptor(runtime) {
	return {
		id: "system.version",
		verb: "query",
		description: "返回机器人版本信息（版本号、构建时间、运行时环境）",
		owner: { kind: "core" },
		handler: async () => ({
			version: runtime.robot.version,
			name: runtime.robot.name,
			role: runtime.robot.role,
			node_version: process.version,
			platform: process.platform,
			uptime_seconds: Math.floor(process.uptime())
		})
	};
}
function makeSystemStatsDescriptor(runtime) {
	return {
		id: "system.stats",
		verb: "query",
		description: "返回运行时统计数据（Playbook 执行数、事件发布量、能力数量）",
		owner: { kind: "core" },
		handler: async () => {
			const capabilities = runtime.capabilities.list();
			const packs = runtime.loadedPacks;
			const playbooks = runtime.playbookEngine.list();
			return {
				capabilities_count: capabilities.length,
				packs_count: packs.length,
				playbooks_count: playbooks.length,
				uptime_seconds: Math.floor(process.uptime()),
				memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
			};
		}
	};
}
function makeSystemPackListDescriptor(runtime) {
	return {
		id: "system.pack_list",
		verb: "query",
		description: "返回已加载的 Pack 列表（id、版本、playbooks 数量）",
		owner: { kind: "core" },
		handler: async () => ({
			packs: runtime.loadedPacks.map((p) => ({
				id: p.manifest.id,
				name: p.manifest.name ?? p.manifest.id,
				version: p.manifest.version ?? "unknown",
				playbooks: p.playbooks.length,
				object_types: p.objectTypes.length,
				path: p.path
			})),
			count: runtime.loadedPacks.length
		})
	};
}
/** system.learn：探测一个外部接口并将其 schema 注册为新能力 */
function makeSystemLearnDescriptor(runtime) {
	return {
		id: "system.learn",
		verb: "acquire",
		description: "探测接口 schema，自动生成 Playbook 或注册新能力",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: {
				connector_id: {
					type: "string",
					description: "连接器 ID"
				},
				interface_url: {
					type: "string",
					description: "OpenAPI/MCP URL"
				}
			}
		},
		handler: async (_ctx, params) => {
			const connectorId = String(params.connector_id ?? "");
			const interfaceUrl = String(params.interface_url ?? "");
			if (connectorId || interfaceUrl) await runtime.kernel.publish("learn.interface.requested", "system.learn", {
				connector_id: connectorId,
				interface_url: interfaceUrl
			});
			return {
				status: "queued",
				connector_id: connectorId,
				interface_url: interfaceUrl
			};
		}
	};
}
function makeKbSearchDescriptor(runtime) {
	return {
		id: "kb.search",
		verb: "retrieve",
		description: "在知识库中检索（支持 semantic=true 语义搜索，无 embedding 时自动降级 BM25）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: { type: "string" },
				top_k: {
					type: "integer",
					default: 5
				},
				min_score: { type: "number" },
				semantic: {
					type: "boolean",
					default: false,
					description: "true = 语义向量搜索（无 embedding 时降级 BM25）"
				},
				namespace: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const query = String(params.query ?? "");
			const topK = typeof params.top_k === "number" ? params.top_k : 5;
			const namespace = typeof params.namespace === "string" ? params.namespace : void 0;
			const semantic = params.semantic === true;
			let results;
			if (semantic && runtime.kb.semanticSearch) results = await runtime.kb.semanticSearch(query, {
				limit: topK,
				namespace
			});
			else results = await runtime.kb.search(query, {
				limit: topK,
				namespace
			});
			const kbAny = runtime.kb;
			const embeddingAvailable = typeof kbAny.semanticSearch === "function" && typeof kbAny.supportsEmbedding === "boolean" ? kbAny.supportsEmbedding : typeof kbAny.semanticSearch === "function";
			return {
				results,
				count: results.length,
				provider: kbAny.provider ?? "unknown",
				semantic_used: semantic,
				embedding_available: embeddingAvailable
			};
		}
	};
}
function makeKbIngestDescriptor(runtime) {
	return {
		id: "kb.ingest",
		verb: "acquire",
		description: "将文本内容写入知识库",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["content"],
			properties: {
				content: { type: "string" },
				title: { type: "string" },
				source: { type: "string" },
				tags: {
					type: "array",
					items: { type: "string" }
				}
			}
		},
		handler: async (_ctx, params) => {
			await runtime.kb.ingest(String(params.content ?? ""), {
				source: typeof params.source === "string" ? params.source : void 0,
				namespace: typeof params.namespace === "string" ? params.namespace : void 0
			});
			return { status: "ok" };
		}
	};
}
function makeKbStatusDescriptor(runtime) {
	return {
		id: "kb.status",
		verb: "query",
		description: "返回知识库统计与健康状态",
		owner: { kind: "core" },
		handler: async () => {
			const count = await runtime.kb.count?.() ?? -1;
			return {
				provider: runtime.config.data?.kb_provider ?? "stub",
				doc_count: count
			};
		}
	};
}
function makeTaskRunDescriptor(runtime) {
	return {
		id: "task.run",
		verb: "compose",
		description: "按名称触发一个 Playbook 任务",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["playbook_id"],
			properties: {
				playbook_id: { type: "string" },
				input: { type: "object" }
			}
		},
		handler: async (ctx, params) => {
			const id = String(params.playbook_id ?? "");
			const input = params.input ?? {};
			const run = await runtime.playbookEngine.trigger(id, {
				...input,
				_source: ctx.source,
				_correlationId: ctx.correlationId
			});
			return {
				run_id: run.id,
				status: run.status
			};
		}
	};
}
function makeTaskStatusDescriptor(runtime) {
	return {
		id: "task.status",
		verb: "query",
		description: "查询 Playbook 运行状态",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["run_id"],
			properties: { run_id: { type: "string" } }
		},
		handler: async (_ctx, params) => {
			const run = await runtime.playbookEngine.getRun(String(params.run_id ?? ""));
			if (!run) return { status: "not_found" };
			return {
				run_id: run.id,
				status: run.status,
				error: run.error ?? null
			};
		}
	};
}
function makeObjectCreateDescriptor(runtime) {
	return {
		id: "object.create",
		verb: "transform",
		description: "在对象存储中创建实体",
		owner: { kind: "core" },
		rbac: {
			decision: "hitl_required",
			reason: "创建实体需要人工确认"
		},
		handler: async (ctx, params) => {
			const typeName = String(params.type ?? params.object_type ?? "");
			const { type: _t, object_type: _ot, ...fields } = params;
			return {
				status: "ok",
				...await runtime.objectStore.create(typeName, fields, ctx.stepCtx ?? {})
			};
		}
	};
}
function makeObjectQueryDescriptor(runtime) {
	return {
		id: "object.query",
		verb: "retrieve",
		description: "查询对象存储中的实体列表",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["type"],
			properties: {
				type: { type: "string" },
				filter: { type: "object" },
				limit: { type: "integer" }
			}
		},
		handler: async (_ctx, params) => {
			const typeName = String(params.type ?? "");
			const filter = params.filter ?? {};
			const limit = typeof params.limit === "number" ? params.limit : 20;
			const { items } = await runtime.objectStore.query(typeName, {
				filter,
				limit
			});
			return {
				results: items,
				count: items.length
			};
		}
	};
}
function makeObjectUpdateDescriptor(runtime) {
	return {
		id: "object.update",
		verb: "transform",
		description: "更新对象存储中的实体字段",
		owner: { kind: "core" },
		rbac: {
			decision: "hitl_required",
			reason: "修改实体需要人工确认"
		},
		handler: async (_ctx, params) => {
			const typeName = String(params.type ?? params.object_type ?? "");
			const id = String(params.id ?? params.object_id ?? "");
			const { type: _t, object_type: _ot, id: _id, object_id: _oid, ...fields } = params;
			return {
				status: "ok",
				...await runtime.objectStore.update(typeName, id, fields)
			};
		}
	};
}
function makeEventPublishDescriptor(runtime) {
	return {
		id: "event.publish",
		verb: "deliver",
		description: "向 EventKernel 发布事件",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["type"],
			properties: {
				type: { type: "string" },
				payload: { type: "object" },
				correlation_id: { type: "string" }
			}
		},
		handler: async (ctx, params) => {
			const eventType = String(params.type ?? "");
			const payload = params.payload ?? {};
			const correlationId = String(params.correlation_id ?? ctx.correlationId ?? "");
			await runtime.kernel.publish(eventType, ctx.source, payload, { correlationId });
			return {
				status: "ok",
				event_type: eventType
			};
		}
	};
}
function makeMessageHandleDescriptor(runtime) {
	return {
		id: "message.handle",
		verb: "compose",
		description: "兜底处理：对任何未知消息用 LLM 回答，或告知不会",
		advertise: false,
		owner: { kind: "core" },
		handler: async (ctx, params) => {
			const text = String(params.text ?? params.message ?? params.content ?? "");
			const sessionId = String(params.session_id ?? ctx.source ?? "");
			const modeOnly = params.mode === "format_only";
			if (sessionId && text && !modeOnly) runtime.contextEngine?.append(sessionId, "user", text);
			const llm = runtime.bridges?.get?.("llm");
			if (modeOnly) return {
				status: "ok",
				reply: text,
				mode: "format_only"
			};
			if (!llm?.complete && !runtime.llmComplete) return {
				status: "fallback",
				reply: "收到你的消息，但我现在还不知道该怎么处理它。请尝试更具体的指令，或者告诉我你想做什么。",
				original: text
			};
			let kbContext = "";
			try {
				const kbResults = await runtime.kb.search(text, { limit: 3 });
				if (kbResults.length > 0) kbContext = "\n\n相关知识库内容：\n" + kbResults.map((r) => String(r.content ?? r.title ?? "")).join("\n---\n");
			} catch {}
			let contextHistory = "";
			if (sessionId && runtime.contextEngine) {
				const recentTurns = runtime.contextEngine.getRecent(sessionId, 6);
				if (recentTurns.length > 1) contextHistory = "\n\n对话历史：\n" + recentTurns.slice(0, -1).map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.content}`).join("\n");
			}
			const prompt = [
				"你是 ClaWorks 机器人助手，以下是你当前具备的能力列表：",
				runtime.capabilities?.list().map((c) => `${c.id}: ${c.description}`).join("\n") ?? "",
				contextHistory,
				kbContext,
				"",
				"用户发来的消息：",
				text,
				"",
				"请直接回答。如果超出你的能力范围，诚实说明，并告诉用户你能做什么。"
			].filter(Boolean).join("\n");
			const completeFn = llm?.complete ?? runtime.llmComplete;
			if (!completeFn) return {
				status: "fallback",
				reply: "暂时无法处理该消息，LLM 未配置。"
			};
			const result = await completeFn({ prompt });
			if (sessionId && runtime.contextEngine) runtime.contextEngine.append(sessionId, "assistant", result.text);
			return {
				status: "ok",
				reply: result.text
			};
		}
	};
}
function makeEnvironmentContextDescriptor() {
	return {
		id: "environment.context",
		verb: "query",
		description: "返回当前时间、日历、地区等环境上下文，帮助机器人理解「现在是什么情况」",
		owner: { kind: "core" },
		handler: async () => {
			const now = /* @__PURE__ */ new Date();
			const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
			const locale = process.env.LANG ?? process.env.LC_ALL ?? "zh-CN";
			const weekday = now.toLocaleDateString("zh-CN", { weekday: "long" });
			const hour = now.getHours();
			const period = hour < 6 ? "深夜" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : hour < 22 ? "晚上" : "深夜";
			const upcomingHolidays = [];
			for (const [hm, hd, name] of [
				[
					1,
					1,
					"元旦"
				],
				[
					2,
					14,
					"情人节"
				],
				[
					5,
					1,
					"劳动节"
				],
				[
					6,
					1,
					"儿童节"
				],
				[
					10,
					1,
					"国庆节"
				],
				[
					12,
					25,
					"圣诞节"
				]
			]) {
				const daysDiff = new Date(now.getFullYear(), hm - 1, hd).getTime() - now.getTime();
				const days = Math.ceil(daysDiff / 864e5);
				if (days >= 0 && days <= 7) upcomingHolidays.push(`${name}（${days === 0 ? "今天" : `${days}天后`}）`);
			}
			return {
				now: now.toISOString(),
				timezone: tz,
				locale,
				weekday,
				period,
				hour,
				upcoming_holidays: upcomingHolidays,
				work_day: now.getDay() >= 1 && now.getDay() <= 5
			};
		}
	};
}
function makeEnvironmentProfileDescriptor(runtime) {
	return {
		id: "environment.profile",
		verb: "query",
		description: "返回当前部署环境画像（机器人角色、已连接接口、所在行业等）",
		owner: { kind: "core" },
		handler: async () => {
			const connectorIds = Object.keys(runtime.config.connectors ?? {});
			const channels = runtime.loadedPacks.flatMap((p) => (p.manifest.provides.playbooks ?? []).filter((id) => id.includes("channel")));
			return {
				robot_name: runtime.robot.name,
				robot_role: runtime.robot.role,
				packs: runtime.loadedPacks.map((p) => ({
					id: p.manifest.id,
					name: p.manifest.name
				})),
				connected_interfaces: connectorIds,
				channels,
				capabilities_count: runtime.capabilities.listAll().length,
				industry_hint: runtime.config.robot?.role ?? "general"
			};
		}
	};
}
function makeEnvironmentScanDescriptor(runtime) {
	const scanner = createEnvironmentScanner();
	return {
		id: "environment.scan",
		verb: "acquire",
		description: "扫描当前环境（环境变量、文件系统、常见网络服务）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: {
				environment: {
					type: "boolean",
					default: true
				},
				file_system: {
					type: "boolean",
					default: true
				},
				known_services: {
					type: "boolean",
					default: false
				}
			}
		},
		handler: async (_ctx, params) => {
			const result = await scanner.scan({
				environment: params.environment !== false,
				fileSystem: params.file_system !== false ? {
					paths: [process.cwd()],
					maxDepth: 2
				} : void 0,
				knownServices: params.known_services === true
			});
			await runtime.kernel.publish("environment.scan_completed", "environment.scan", {
				resources_found: result.resources.length,
				env_vars_found: result.envVars.length,
				openclaw_found: result.openClaw.found,
				duration_ms: result.durationMs
			});
			return {
				resources: result.resources.map((r) => ({
					id: r.id,
					type: r.type,
					name: r.name,
					location: r.location,
					status: r.status,
					auto_connectable: r.autoConnectable,
					suggested_connector: r.suggestedConnector
				})),
				env_vars: result.envVars,
				openclaw: result.openClaw,
				count: result.resources.length + result.envVars.length,
				duration_ms: result.durationMs
			};
		}
	};
}
function makeEnvironmentScanEnvvarsDescriptor() {
	const scanner = createEnvironmentScanner();
	return {
		id: "environment.scan_envvars",
		verb: "acquire",
		description: "扫描环境变量，发现 IM Token、API Key、数据库 URL 等潜在服务连接",
		owner: { kind: "core" },
		handler: async () => {
			const hints = await scanner.scanEnvVars();
			return {
				hints,
				count: hints.length
			};
		}
	};
}
function makeEnvironmentDetectServicesDescriptor() {
	const scanner = createEnvironmentScanner();
	return {
		id: "environment.detect_services",
		verb: "acquire",
		description: "检测本地常见服务（飞书/MySQL/Redis/MQTT/OPC-UA 等）是否可达",
		owner: { kind: "core" },
		handler: async () => {
			const result = await scanner.scan({
				knownServices: true,
				environment: false
			});
			const available = result.resources.map((r) => r.name);
			return {
				services: result.resources,
				available,
				count: result.resources.length
			};
		}
	};
}
function makeHarnessDetectDescriptor(runtime) {
	const hs = createHarnessSync(runtime);
	return {
		id: "harness.detect_openclaw",
		verb: "query",
		description: "检测本机 OpenClaw 安装（~/.openclaw/agents/...）",
		owner: { kind: "core" },
		handler: async () => hs.detectOpenClaw()
	};
}
function makeHarnessSyncFromDescriptor(runtime) {
	const hs = createHarnessSync(runtime);
	return {
		id: "harness.sync_from_openclaw",
		verb: "acquire",
		description: "从 OpenClaw 同步模型配置、技能和渠道信息到 ClaWorks",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: { config_path: {
				type: "string",
				description: "OpenClaw 配置目录路径"
			} }
		},
		handler: async (_ctx, params) => {
			const detection = await hs.detectOpenClaw();
			const configPath = String(params.config_path ?? detection.configPath ?? "");
			if (!configPath) return {
				synced: false,
				error: "未找到 OpenClaw 配置路径"
			};
			return hs.syncFromOpenClaw(configPath);
		}
	};
}
function makeHarnessPushToDescriptor(runtime) {
	const hs = createHarnessSync(runtime);
	return {
		id: "harness.push_to_openclaw",
		verb: "control",
		description: "向 OpenClaw Agent 注册 ClaWorks cw_* 工具",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: { agent_id: {
				type: "string",
				description: "OpenClaw Agent ID（可选）"
			} }
		},
		handler: async (_ctx, params) => {
			return hs.pushToOpenClaw({ agentId: params.agent_id });
		}
	};
}
function makeHarnessStatusDescriptor(runtime) {
	const hs = createHarnessSync(runtime);
	return {
		id: "harness.status",
		verb: "query",
		description: "查看 OpenClaw Harness 同步状态",
		owner: { kind: "core" },
		handler: async () => hs.status()
	};
}
function makeConnectDetectDescriptor(runtime) {
	const mgr = createAutoConnectManager(runtime);
	return {
		id: "connect.detect",
		verb: "acquire",
		description: "检测环境中所有可用服务（IM/AI/数据库/IoT）",
		owner: { kind: "core" },
		handler: async () => {
			const detected = await mgr.detect();
			return {
				services: detected,
				available: detected.filter((d) => d.available).map((d) => d.service),
				count_available: detected.filter((d) => d.available).length,
				count_total: detected.length
			};
		}
	};
}
function makeConnectRecommendDescriptor(runtime) {
	const mgr = createAutoConnectManager(runtime);
	return {
		id: "connect.recommend",
		verb: "query",
		description: "生成连接建议（告诉用户缺少哪些配置）",
		owner: { kind: "core" },
		handler: async () => {
			return { recommendations: await mgr.generateRecommendations() };
		}
	};
}
function makeConnectStatusDescriptor(runtime) {
	const mgr = createAutoConnectManager(runtime);
	return {
		id: "connect.status",
		verb: "query",
		description: "查看所有连接状态（已连接/未连接/建议）",
		owner: { kind: "core" },
		handler: async () => {
			const detected = await mgr.detect();
			return {
				connected: detected.filter((d) => d.available).map((d) => ({
					service: d.service,
					category: d.category
				})),
				disconnected: detected.filter((d) => !d.available).map((d) => ({
					service: d.service,
					category: d.category,
					missing: d.missingVars
				}))
			};
		}
	};
}
function makePerceiveMessageDescriptor(runtime) {
	return {
		id: "perceive.message",
		verb: "acquire",
		description: "理解一条消息：提取意图、实体、情绪、优先级",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["text"],
			properties: {
				text: { type: "string" },
				source: {
					type: "string",
					description: "消息来源渠道"
				},
				subject_id: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const text = String(params.text ?? "");
			const completeFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
			if (!completeFn) return {
				status: "no_llm",
				intent: "unknown",
				entities: [],
				sentiment: "neutral",
				priority: "normal",
				summary: text.slice(0, 100)
			};
			const prompt = [
				"请分析以下消息，以JSON格式回答（不要有任何多余文字）:",
				`消息: "${text}"`,
				"返回格式: {\"intent\":\"...\", \"entities\":[\"...\"], \"sentiment\":\"positive|neutral|negative\", \"priority\":\"urgent|high|normal|low\", \"summary\":\"一句话摘要\", \"action_hint\":\"建议机器人做什么\"}"
			].join("\n");
			try {
				const { tryParseJson } = await import("./step-executor-Dgu_uWbI.mjs").then((n) => n.d);
				const result = await completeFn({ prompt });
				return tryParseJson(result.text) ?? {
					status: "parse_failed",
					raw: result.text,
					intent: "unknown"
				};
			} catch {
				return {
					status: "error",
					intent: "unknown",
					summary: text.slice(0, 100)
				};
			}
		}
	};
}
function makePerceiveEntityDescriptor(runtime) {
	return {
		id: "perceive.extract_entities",
		verb: "acquire",
		description: "从文本中提取结构化实体（人名、地点、时间、设备编号、工单号、班次等工业实体）",
		owner: { kind: "core" },
		handler: async (_ctx, params) => {
			const text = String(params.text ?? "");
			const completeFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
			if (!completeFn) return {
				status: "no_llm",
				entities: []
			};
			const prompt = [
				"从以下文本提取实体，以JSON数组回答:",
				`文本: "${text}"`,
				"实体类型：person(人名), place(地点), time(时间), equipment_id(设备编号), work_order_id(工单号), alarm_id(报警号), shift(班次), amount(金额/数量), product(产品), org(组织), other(其他)",
				"格式: [{\"type\":\"person|place|time|equipment_id|work_order_id|alarm_id|shift|amount|product|org|other\",\"value\":\"...\",\"confidence\":0.0-1.0}]"
			].join("\n");
			try {
				const raw = (await completeFn({ prompt })).text.trim();
				const start = raw.indexOf("[");
				const end = raw.lastIndexOf("]");
				const parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null;
				return {
					status: "ok",
					entities: Array.isArray(parsed) ? parsed : []
				};
			} catch {
				return {
					status: "error",
					entities: []
				};
			}
		}
	};
}
function makePerceiveClassifyDescriptor(runtime) {
	return {
		id: "perceive.classify",
		verb: "acquire",
		description: "将文本分类到预定义类别之一（传入 categories 列表，返回最匹配类别）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["text", "categories"],
			properties: {
				text: {
					type: "string",
					description: "待分类文本"
				},
				categories: {
					type: "array",
					items: { type: "string" },
					description: "候选类别列表"
				},
				context: {
					type: "string",
					description: "分类背景说明（可选）"
				}
			}
		},
		handler: async (_ctx, params) => {
			const text = String(params.text ?? "");
			const categories = Array.isArray(params.categories) ? params.categories : [];
			const context = String(params.context ?? "");
			if (categories.length === 0) return {
				status: "error",
				reason: "categories 不能为空"
			};
			const completeFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
			if (!completeFn) return {
				status: "no_llm",
				category: categories[0],
				confidence: 0
			};
			const prompt = [
				context ? `背景：${context}` : "",
				`将以下文本分类到最匹配的类别（只能选一个）：`,
				`文本："${text}"`,
				`候选类别：${categories.join("、")}`,
				`以JSON格式回答：{"category":"...","confidence":0.0-1.0,"reason":"..."}`
			].filter(Boolean).join("\n");
			try {
				const { tryParseJson } = await import("./step-executor-Dgu_uWbI.mjs").then((n) => n.d);
				const result = await completeFn({ prompt });
				const parsed = tryParseJson(result.text);
				if (parsed && typeof parsed.category === "string") return {
					status: "ok",
					...parsed
				};
				return {
					status: "parse_failed",
					category: categories[0],
					confidence: 0,
					raw: result.text
				};
			} catch {
				return {
					status: "error",
					category: categories[0],
					confidence: 0
				};
			}
		}
	};
}
function makePerceiveIntentDescriptor(runtime) {
	return {
		id: "perceive.intent",
		verb: "acquire",
		description: "理解消息意图并返回 suggested_capability / entities / confidence，供 Playbook 路由使用",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["text"],
			properties: {
				text: { type: "string" },
				channel: { type: "string" },
				user_id: { type: "string" }
			}
		},
		handler: async (ctx, params) => {
			const text = String(params.text ?? params.message ?? "");
			const sessionId = String(params.user_id ?? params.session_id ?? ctx.runId ?? "default");
			const history = runtime.contextEngine?.getRecent(sessionId, 5) ?? [];
			const historyText = history.length > 0 ? `\n\n历史对话（最近 ${history.length} 条）：\n` + history.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n") : "";
			const profileHint = runtime.userProfileStore?.toPromptHint(sessionId);
			const profileText = profileHint ? `\n用户画像：${profileHint}` : "";
			const enrichedText = text + historyText + profileText;
			if (runtime.structuredOutput && runtime.promptRegistry) {
				if (runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete) try {
					const prompt = runtime.promptRegistry.render("intent_classify", { message: enrichedText });
					const { data } = await runtime.structuredOutput.complete(prompt, {
						type: "object",
						required: ["intent", "confidence"],
						properties: {
							intent: {
								type: "string",
								description: "意图分类结果"
							},
							confidence: {
								type: "number",
								description: "置信度 0-1"
							},
							extracted: {
								type: "object",
								description: "提取的实体"
							}
						}
					}, {
						maxRetries: 3,
						fallback: {
							intent: "unknown",
							confidence: 0,
							extracted: {}
						}
					});
					const intent = String(data.intent ?? "");
					if (intent && intent !== "unknown") return {
						status: "ok",
						intent,
						confidence: typeof data.confidence === "number" ? data.confidence : .8,
						extracted: data.extracted ?? {},
						suggested_capability: intent
					};
				} catch {}
			}
			const perceiveHandler = runtime.capabilities.get("perceive.message");
			if (!perceiveHandler) return {
				status: "no_perceive",
				suggested_capability: "",
				intent: "unknown",
				confidence: 0,
				entities: []
			};
			const result = await perceiveHandler.handler(ctx, {
				...params,
				text: enrichedText
			});
			return {
				...result,
				suggested_capability: String(result.suggested_capability ?? result.intent ?? "")
			};
		}
	};
}
function makePerceiveNeedsClarificationDescriptor(runtime) {
	return {
		id: "perceive.needs_clarification",
		verb: "acquire",
		description: "当用户意图不明确时（置信度低），生成一个简短追问以澄清意图",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["text"],
			properties: {
				text: {
					type: "string",
					description: "用户原始消息"
				},
				intent_confidence: {
					type: "number",
					description: "意图分类置信度 0-1，低于阈值时触发追问"
				},
				context: {
					type: "string",
					description: "对话上下文补充"
				},
				threshold: {
					type: "number",
					description: "置信度阈值（默认 0.55）"
				}
			}
		},
		handler: async (_ctx, params) => {
			const text = String(params.text ?? "");
			const confidence = typeof params.intent_confidence === "number" ? params.intent_confidence : 1;
			if (confidence > (typeof params.threshold === "number" ? params.threshold : .55)) return { needs_clarification: false };
			const llmFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
			if (!llmFn) return { needs_clarification: false };
			const prompt = `用户说："${text}"${params.context ? `\n上下文：${String(params.context)}` : ""}\n我不太确定他的意思（置信度 ${(confidence * 100).toFixed(0)}%）。\n请生成一个简短友好的追问（不超过 20 个字），帮助澄清用户意图。\n只输出追问内容，不要解释，不要加引号。`;
			try {
				const raw = await llmFn(prompt);
				const question = (typeof raw === "string" ? raw : String(raw)).trim();
				if (question) return {
					needs_clarification: true,
					clarification_question: question
				};
			} catch {}
			return { needs_clarification: false };
		}
	};
}
function makePerceiveSentimentDescriptor(runtime) {
	return {
		id: "perceive.sentiment",
		verb: "acquire",
		description: "感知用户消息的情绪倾向（urgent/calm/frustrated/satisfied）和紧急程度 0-1",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["text"],
			properties: { text: { type: "string" } }
		},
		handler: async (_ctx, params) => {
			const text = String(params.text ?? "");
			const llmFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
			if (!llmFn) return {
				sentiment: "calm",
				urgency: .3,
				source: "fallback"
			};
			const prompt = `分析以下消息的情绪，返回 JSON（只输出 JSON，不要解释）：
{"sentiment":"urgent|calm|frustrated|satisfied","urgency":0-1}
消息：${text}`;
			try {
				const raw = await llmFn(prompt);
				const cleaned = (typeof raw === "string" ? raw : String(raw)).trim().replace(/^```json\s*/i, "").replace(/```$/i, "");
				const parsed = JSON.parse(cleaned);
				return {
					sentiment: parsed.sentiment ?? "calm",
					urgency: typeof parsed.urgency === "number" ? parsed.urgency : .3,
					source: "llm"
				};
			} catch {
				const urgentKeywords = [
					"紧急",
					"马上",
					"立刻",
					"快",
					"急",
					"!!",
					"！！"
				];
				const frustratedKeywords = [
					"为什么",
					"怎么回事",
					"不行",
					"不对",
					"差",
					"烂"
				];
				const text_lc = text.toLowerCase();
				if (urgentKeywords.some((k) => text_lc.includes(k))) return {
					sentiment: "urgent",
					urgency: .85,
					source: "keyword"
				};
				if (frustratedKeywords.some((k) => text_lc.includes(k))) return {
					sentiment: "frustrated",
					urgency: .6,
					source: "keyword"
				};
				return {
					sentiment: "calm",
					urgency: .3,
					source: "keyword"
				};
			}
		}
	};
}
function makePerceiveUserProfileUpdateDescriptor(runtime) {
	return {
		id: "perceive.user_profile_update",
		verb: "update",
		description: "更新用户画像（姓名、偏好风格、近期话题），供后续个性化回复使用",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["user_id"],
			properties: {
				user_id: { type: "string" },
				name: { type: "string" },
				topic: {
					type: "string",
					description: "本次对话话题，加入近期话题列表"
				},
				preferred_style: {
					type: "string",
					enum: [
						"concise",
						"detailed",
						"structured"
					]
				},
				custom_notes: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const userId = String(params.user_id ?? "");
			if (!userId || !runtime.userProfileStore) return { updated: false };
			runtime.userProfileStore.bump(userId);
			if (typeof params.name === "string") runtime.userProfileStore.setName(userId, params.name);
			if (typeof params.topic === "string" && params.topic) runtime.userProfileStore.addTopic(userId, params.topic);
			if (typeof params.preferred_style === "string" && [
				"concise",
				"detailed",
				"structured"
			].includes(params.preferred_style)) runtime.userProfileStore.update(userId, { preferredResponseStyle: params.preferred_style });
			if (typeof params.custom_notes === "string") runtime.userProfileStore.update(userId, { customNotes: params.custom_notes });
			return {
				updated: true,
				profile: runtime.userProfileStore.get(userId)
			};
		}
	};
}
/** 工业班次定义：早/中/晚/夜 */
function resolveShift(hour) {
	if (hour >= 6 && hour < 14) return {
		shift: "morning",
		shift_name: "早班",
		next_shift: "afternoon"
	};
	if (hour >= 14 && hour < 22) return {
		shift: "afternoon",
		shift_name: "中班",
		next_shift: "night"
	};
	return {
		shift: "night",
		shift_name: "夜班",
		next_shift: "morning"
	};
}
function makeTimeNowDescriptor() {
	return {
		id: "time.now",
		verb: "query",
		description: "返回当前时间（ISO格式、Unix时间戳、人类可读格式）",
		owner: { kind: "core" },
		handler: async () => {
			const now = /* @__PURE__ */ new Date();
			const pad = (n) => n.toString().padStart(2, "0");
			return {
				iso: now.toISOString(),
				unix: Math.floor(now.getTime() / 1e3),
				unix_ms: now.getTime(),
				human: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				weekday: now.toLocaleDateString("zh-CN", { weekday: "long" })
			};
		}
	};
}
function makeTimeShiftDescriptor() {
	return {
		id: "time.shift",
		verb: "query",
		description: "返回当前班次（早/中/晚/夜），及下一班次信息",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: { hour: {
				type: "number",
				description: "指定小时（0-23），不填则用当前时间"
			} }
		},
		handler: async (_ctx, params) => {
			const hour = typeof params.hour === "number" ? params.hour : (/* @__PURE__ */ new Date()).getHours();
			const shiftInfo = resolveShift(hour);
			const now = /* @__PURE__ */ new Date();
			return {
				...shiftInfo,
				current_hour: hour,
				date: now.toISOString().slice(0, 10)
			};
		}
	};
}
function makeTimeParsDescriptor(runtime) {
	return {
		id: "time.parse",
		verb: "acquire",
		description: "解析自然语言时间表达式为 ISO 格式（如'明天上午9点'→ISO时间）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["text"],
			properties: {
				text: {
					type: "string",
					description: "自然语言时间描述"
				},
				reference: {
					type: "string",
					description: "参考时间（ISO格式），默认当前时间"
				}
			}
		},
		handler: async (_ctx, params) => {
			const text = String(params.text ?? "");
			const reference = params.reference ? new Date(String(params.reference)) : /* @__PURE__ */ new Date();
			if (Number.isNaN(reference.getTime())) return { status: "invalid_reference" };
			const now = reference;
			const pad = (n) => n.toString().padStart(2, "0");
			const todayBase = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const ruleMap = [
				[/现在|此刻|当前/, () => now],
				[/今天/, () => todayBase],
				[/明天/, () => new Date(todayBase.getTime() + 864e5)],
				[/后天/, () => new Date(todayBase.getTime() + 2 * 864e5)],
				[/昨天/, () => /* @__PURE__ */ new Date(todayBase.getTime() - 864e5)],
				[/下周/, () => new Date(todayBase.getTime() + 7 * 864e5)]
			];
			let baseDate = null;
			for (const [pattern, fn] of ruleMap) if (pattern.test(text)) {
				baseDate = fn();
				break;
			}
			const hourMatch = text.match(/(\d{1,2})[点:时]/);
			if (hourMatch && baseDate) {
				baseDate.setHours(Number.parseInt(hourMatch[1]), 0, 0, 0);
				if (text.includes("下午") || text.includes("晚上")) {
					const h = baseDate.getHours();
					if (h < 12) baseDate.setHours(h + 12);
				}
			}
			if (baseDate && !Number.isNaN(baseDate.getTime())) return {
				status: "ok",
				iso: baseDate.toISOString(),
				unix: Math.floor(baseDate.getTime() / 1e3),
				human: `${baseDate.getFullYear()}-${pad(baseDate.getMonth() + 1)}-${pad(baseDate.getDate())} ${pad(baseDate.getHours())}:${pad(baseDate.getMinutes())}`,
				input: text,
				method: "rule"
			};
			const completeFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
			if (!completeFn) return {
				status: "unparsed",
				input: text
			};
			const prompt = `将"${text}"转换为ISO 8601时间格式。参考时间：${now.toISOString()}。只输出JSON：{"iso":"...","human":"YYYY-MM-DD HH:mm","confidence":0.0-1.0}`;
			try {
				const { tryParseJson } = await import("./step-executor-Dgu_uWbI.mjs").then((n) => n.d);
				const parsed = tryParseJson((await completeFn({ prompt })).text);
				return parsed ? {
					status: "ok",
					...parsed,
					input: text,
					method: "llm"
				} : {
					status: "unparsed",
					input: text
				};
			} catch {
				return {
					status: "error",
					input: text
				};
			}
		}
	};
}
function makeTimeDiffDescriptor() {
	return {
		id: "time.diff",
		verb: "transform",
		description: "计算两个时间点之间的差值（秒/分钟/小时/天）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["from", "to"],
			properties: {
				from: {
					type: "string",
					description: "起始时间（ISO格式）"
				},
				to: {
					type: "string",
					description: "结束时间（ISO格式）"
				},
				unit: {
					type: "string",
					enum: [
						"seconds",
						"minutes",
						"hours",
						"days"
					],
					description: "返回单位，默认 seconds"
				}
			}
		},
		handler: async (_ctx, params) => {
			const from = new Date(String(params.from ?? ""));
			const to = new Date(String(params.to ?? ""));
			if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return {
				status: "invalid_time",
				from: String(params.from),
				to: String(params.to)
			};
			const diffMs = to.getTime() - from.getTime();
			const unit = String(params.unit ?? "seconds");
			const value = diffMs / ({
				seconds: 1e3,
				minutes: 6e4,
				hours: 36e5,
				days: 864e5
			}[unit] ?? 1e3);
			return {
				status: "ok",
				value: Math.round(value * 100) / 100,
				unit,
				diff_ms: diffMs,
				from: from.toISOString(),
				to: to.toISOString(),
				negative: diffMs < 0
			};
		}
	};
}
function makeLearnObserveDescriptor(runtime) {
	return {
		id: "learn.observe",
		verb: "acquire",
		description: "将一次观察（事件/现象）记录到知识库，作为未来学习的材料",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["observation"],
			properties: {
				observation: { type: "string" },
				context: { type: "string" },
				importance: {
					type: "string",
					enum: [
						"low",
						"normal",
						"high"
					]
				},
				tags: {
					type: "array",
					items: { type: "string" }
				}
			}
		},
		handler: async (_ctx, params) => {
			const obs = String(params.observation ?? "");
			const contextStr = String(params.context ?? "");
			const importance = String(params.importance ?? "normal");
			const tags = Array.isArray(params.tags) ? params.tags : ["observation"];
			const content = contextStr ? `[${importance}] ${obs}\n\nContext: ${contextStr}` : `[${importance}] ${obs}`;
			await runtime.kb.ingest(content, { source: "learn.observe" });
			const id = "ingested";
			await runtime.kernel.publish("learn.observation_recorded", "learn.observe", {
				id,
				observation: obs,
				importance,
				tags
			});
			return {
				status: "ok",
				id,
				observation: obs
			};
		}
	};
}
function makeLearnFromFeedbackDescriptor(runtime) {
	return {
		id: "learn.from_feedback",
		verb: "acquire",
		description: "根据用户反馈（好/坏/纠正）更新知识库或调整行为",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["feedback_type", "content"],
			properties: {
				feedback_type: {
					type: "string",
					enum: [
						"positive",
						"negative",
						"correction"
					]
				},
				content: { type: "string" },
				related_run_id: { type: "string" },
				correction: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const type = String(params.feedback_type ?? "positive");
			const content = String(params.content ?? "");
			const correction = String(params.correction ?? "");
			const entry = correction ? `[feedback:${type}] ${content}\n\nCorrection: ${correction}` : `[feedback:${type}] ${content}`;
			await runtime.kb.ingest(entry, { source: "learn.from_feedback" });
			const id = "ingested";
			await runtime.kernel.publish("learn.feedback_recorded", "learn.from_feedback", {
				id,
				feedback_type: type,
				content,
				related_run_id: params.related_run_id
			});
			return {
				status: "ok",
				id,
				feedback_type: type
			};
		}
	};
}
let _evolveEngineInstance;
function getOrCreateEvolveEngine(runtime) {
	if (!_evolveEngineInstance) {
		_evolveEngineInstance = createEvolveEngine(runtime);
		runtime.evolveEngine = _evolveEngineInstance;
	}
	return _evolveEngineInstance;
}
function makeEvolveDiscoverDescriptor(runtime) {
	return {
		id: "evolve.discover",
		verb: "acquire",
		description: "主动发现环境中未被充分利用的接口或能力，生成改进建议",
		owner: { kind: "core" },
		handler: async () => {
			const connectorIds = Object.keys(runtime.config.connectors ?? {});
			const capabilities = runtime.capabilities.listAll();
			const packs = runtime.loadedPacks.map((p) => p.manifest.id);
			const underutilized = connectorIds.filter((id) => {
				return !runtime.playbookEngine.list().some((pb) => JSON.stringify(pb).includes(id));
			});
			const suggestions = [];
			for (const id of underutilized) suggestions.push(`Connector '${id}' has no Playbook. Consider probing it with autonomy.probe_interface.`);
			if (capabilities.length < 20) suggestions.push("Capability count is low. Install more Packs via nexus to expand robot abilities.");
			if (packs.length === 0) suggestions.push("No Packs loaded. Install the 'base' pack to get started.");
			await runtime.kernel.publish("evolve.suggestions_ready", "evolve.discover", {
				suggestions,
				connector_count: connectorIds.length,
				capability_count: capabilities.length,
				pack_count: packs.length
			});
			return {
				status: "ok",
				suggestions,
				underutilized_connectors: underutilized
			};
		}
	};
}
function makeEvolveWritePlaybookDescriptor(runtime) {
	return {
		id: "evolve.write_playbook",
		verb: "compose",
		description: "根据描述让 LLM 生成一个 Playbook YAML 并保存为草稿（旧接口，建议改用 evolve.propose）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["description"],
			properties: {
				description: {
					type: "string",
					description: "想要实现的任务描述"
				},
				available_actions: {
					type: "array",
					items: { type: "string" }
				}
			}
		},
		handler: async (_ctx, params) => {
			const description = String(params.description ?? "");
			const engine = getOrCreateEvolveEngine(runtime);
			try {
				const proposal = await engine.propose({ description });
				await runtime.kb.ingest(proposal.playbook_yaml, { source: "evolve.write_playbook" });
				await runtime.kernel.publish("evolve.playbook_drafted", "evolve.write_playbook", {
					id: proposal.id,
					description
				});
				return {
					status: "ok",
					draft_id: proposal.id,
					yaml: proposal.playbook_yaml,
					proposal
				};
			} catch (err) {
				return {
					status: "error",
					reason: err instanceof Error ? err.message : String(err)
				};
			}
		}
	};
}
function makeEvolveProposDescriptor(runtime) {
	return {
		id: "evolve.propose",
		verb: "acquire",
		description: "分析用户需求，LLM 生成完整 Playbook 方案（含 YAML、置信度、缺失能力分析）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["description"],
			properties: {
				description: {
					type: "string",
					description: "用户的需求描述（自然语言）"
				},
				context: {
					type: "string",
					description: "额外上下文（当前状态、已有配置等）"
				}
			}
		},
		handler: async (_ctx, params) => {
			const { description, context } = params;
			return await getOrCreateEvolveEngine(runtime).propose({
				description,
				context
			});
		}
	};
}
function makeEvolveDeployDescriptor(runtime) {
	return {
		id: "evolve.deploy",
		verb: "execute",
		description: "将 EvolveProposal 部署到运行时（写文件 + packLoader.load() 热重载）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["proposal"],
			properties: {
				proposal: {
					type: "object",
					description: "evolve.propose 返回的 EvolveProposal"
				},
				pack_id: {
					type: "string",
					description: "目标 Pack ID，默认 user_evolved"
				}
			}
		},
		handler: async (_ctx, params) => {
			const proposal = params.proposal;
			const packId = params.pack_id;
			return await getOrCreateEvolveEngine(runtime).deploy(proposal, { packId });
		}
	};
}
function makeEvolveVerifyDescriptor(runtime) {
	return {
		id: "evolve.verify",
		verb: "acquire",
		description: "发布测试事件，验证已部署的 Playbook 是否在 5s 内正确触发",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["playbook_id", "test_event"],
			properties: {
				playbook_id: { type: "string" },
				test_event: { type: "string" },
				test_payload: {
					type: "object",
					description: "测试载荷，默认 {}"
				}
			}
		},
		handler: async (_ctx, params) => {
			const { playbook_id, test_event, test_payload = {} } = params;
			return await getOrCreateEvolveEngine(runtime).verify(playbook_id, test_event, test_payload);
		}
	};
}
function makeEvolveLearnDescriptor(runtime) {
	return {
		id: "evolve.learn",
		verb: "execute",
		description: "将进化结果（EvolveResult）写入 CbrStore，供后续相似需求参考",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["result"],
			properties: {
				result: {
					type: "object",
					description: "evolve.deploy 返回的 EvolveResult"
				},
				feedback: {
					type: "string",
					description: "用户对本次执行的反馈"
				}
			}
		},
		handler: async (_ctx, params) => {
			const { result, feedback } = params;
			return {
				learned: true,
				cbr_case_id: await getOrCreateEvolveEngine(runtime).learn(result, feedback)
			};
		}
	};
}
function makeEvolveListDescriptor(runtime) {
	return {
		id: "evolve.list",
		verb: "query",
		description: "列出用户通过对话自动生成的所有 Playbook（来自 user_evolved Pack）",
		owner: { kind: "core" },
		handler: async () => {
			const evolved = await getOrCreateEvolveEngine(runtime).listEvolved();
			return {
				evolved,
				count: evolved.length
			};
		}
	};
}
function makeEvolveRemoveDescriptor(runtime) {
	return {
		id: "evolve.remove",
		verb: "execute",
		description: "移除一个进化的 Playbook（删文件 + 引擎卸载）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["playbook_id"],
			properties: { playbook_id: {
				type: "string",
				description: "要移除的 Playbook ID"
			} }
		},
		handler: async (_ctx, params) => {
			const { playbook_id } = params;
			await getOrCreateEvolveEngine(runtime).remove(playbook_id);
			return {
				removed: true,
				playbook_id
			};
		}
	};
}
function makeEvolveFullCycleDescriptor(runtime) {
	return {
		id: "evolve.full_cycle",
		verb: "execute",
		description: "完整进化循环：理解需求 → LLM 生成方案 → (HITL 确认) → 部署 → 验证 → CBR 学习",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["description"],
			properties: {
				description: {
					type: "string",
					description: "用户的需求描述"
				},
				auto_approve: {
					type: "boolean",
					description: "置信度 >= 0.7 时自动跳过 HITL，默认 false"
				},
				context: { type: "string" }
			}
		},
		handler: async (ctx, params) => {
			const { description, auto_approve = false, context } = params;
			const engine = getOrCreateEvolveEngine(runtime);
			const proposal = await engine.propose({
				description,
				context
			});
			if (!auto_approve && proposal.confidence < .7) {
				await runtime.kernel.publish("hitl.approval_requested", ctx.source ?? "evolve", {
					gate_id: `evolve-${proposal.id}`,
					message: [
						`我生成了以下 Playbook 方案，是否部署？`,
						``,
						`**${proposal.title}**`,
						proposal.description,
						``,
						`置信度：${(proposal.confidence * 100).toFixed(0)}%`,
						proposal.warnings.length > 0 ? `⚠️ 注意：${proposal.warnings.join("、")}` : ""
					].filter(Boolean).join("\n"),
					proposal_id: proposal.id,
					preview: proposal.playbook_yaml.slice(0, 500)
				});
				return {
					status: "awaiting_approval",
					proposal
				};
			}
			const deployResult = await engine.deploy(proposal);
			if (deployResult.deployed) {
				const verifyResult = await engine.verify(proposal.id, proposal.test_event, proposal.test_payload);
				deployResult.test_passed = verifyResult.passed;
				deployResult.test_output = verifyResult.output;
			}
			const cbrCaseId = await engine.learn(deployResult);
			deployResult.cbr_case_id = cbrCaseId;
			await runtime.kernel.publish("evolve.playbook_deployed", "evolve.full_cycle", {
				playbook_id: proposal.id,
				title: proposal.title,
				deployed: deployResult.deployed,
				test_passed: deployResult.test_passed,
				playbook_path: deployResult.playbook_path
			});
			return {
				status: deployResult.test_passed ? "success" : deployResult.deployed ? "deployed_unverified" : "deploy_failed",
				proposal,
				deployed: deployResult.deployed,
				test_passed: deployResult.test_passed,
				playbook_path: deployResult.playbook_path,
				cbr_case_id: cbrCaseId
			};
		}
	};
}
function makePromptListDescriptor(runtime) {
	return {
		id: "prompt.list",
		verb: "query",
		description: "列出所有已注册的 Prompt 模板（id、名称、输出格式）",
		owner: { kind: "core" },
		handler: async () => {
			const registry = runtime.promptRegistry;
			if (!registry) return {
				templates: [],
				count: 0,
				note: "promptRegistry 未注入"
			};
			return {
				templates: registry.list().map((t) => ({
					id: t.id,
					description: t.description ?? ""
				})),
				count: registry.list().length
			};
		}
	};
}
function makePromptRenderDescriptor(runtime) {
	return {
		id: "prompt.render",
		verb: "compose",
		description: "渲染 Prompt 模板，替换 {{variable}} 占位符，返回 system + user 文本",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["template_id", "variables"],
			properties: {
				template_id: {
					type: "string",
					description: "模板 ID（如 intent_classify）"
				},
				variables: {
					type: "object",
					description: "占位符变量键值对"
				}
			}
		},
		handler: async (_ctx, params) => {
			const id = String(params.template_id ?? "");
			const variables = params.variables ?? {};
			try {
				const rendered = runtime.promptRegistry?.render(id, variables) ?? "";
				return {
					status: "ok",
					...typeof rendered === "object" && rendered !== null ? rendered : {}
				};
			} catch (err) {
				return {
					status: "not_found",
					template_id: id,
					reason: err instanceof Error ? err.message : String(err)
				};
			}
		}
	};
}
function makeLlmStructuredCompleteDescriptor(runtime) {
	return {
		id: "llm.structured_complete",
		verb: "compose",
		description: "调用 LLM 并保证输出符合 JSON schema（结构化输出引擎）；失败自动重试最多 max_retries 次。弱模型补偿核心能力。",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["prompt", "schema"],
			properties: {
				prompt: { type: "string" },
				schema: {
					type: "object",
					description: "JSON Schema 对象（OutputSchema）"
				},
				max_retries: {
					type: "number",
					description: "最大重试次数，默认 3"
				},
				fallback: {
					type: "object",
					description: "全部失败时的兜底值"
				},
				task_type: {
					type: "string",
					description: "任务类型（用于模型路由）"
				}
			}
		},
		handler: async (_ctx, params) => {
			const prompt = String(params.prompt ?? "");
			const schema = params.schema;
			if (!schema) return {
				status: "error",
				reason: "schema 参数缺失"
			};
			if (!runtime.structuredOutput) return {
				status: "no_structured_output",
				reason: "结构化输出引擎未初始化"
			};
			try {
				return {
					status: "ok",
					...await runtime.structuredOutput.complete(prompt, schema, {
						maxRetries: typeof params.max_retries === "number" ? params.max_retries : 3,
						fallback: params.fallback
					})
				};
			} catch (err) {
				return {
					status: "error",
					reason: err instanceof Error ? err.message : String(err)
				};
			}
		}
	};
}
function makeRobotWhoamiDescriptor(runtime) {
	return {
		id: "robot.whoami",
		verb: "query",
		description: "机器人自我介绍（'我是谁？'）",
		owner: { kind: "core" },
		handler: async () => {
			const idMgr = runtime.robotIdentityManager;
			if (idMgr) return {
				text: idMgr.buildIntroduction(),
				identity: idMgr.getIdentity()
			};
			return {
				text: `我是 ${runtime.robot.name}，您的${runtime.robot.role}。`,
				name: runtime.robot.name,
				role: runtime.robot.role,
				version: runtime.robot.version
			};
		}
	};
}
function makeRobotIdentityDescriptor(runtime) {
	return {
		id: "robot.identity",
		verb: "query",
		description: "返回机器人完整身份信息（管理员可见）",
		owner: { kind: "core" },
		handler: async () => {
			const idMgr = runtime.robotIdentityManager;
			if (idMgr) return idMgr.getIdentity();
			return {
				name: runtime.robot.name,
				role: runtime.robot.role,
				version: runtime.robot.version,
				endpoint: runtime.robot.endpoint
			};
		}
	};
}
function makeRobotOwnerDescriptor(runtime) {
	return {
		id: "robot.owner",
		verb: "query",
		description: "返回机器人主人信息",
		owner: { kind: "core" },
		handler: async () => {
			const idMgr = runtime.robotIdentityManager;
			if (idMgr) {
				const id = idMgr.getIdentity();
				return id.owner ? { owner: id.owner } : {
					owner: null,
					message: "未设置主人"
				};
			}
			const owner = runtime.identity.owner;
			return owner ? { owner } : { owner: null };
		}
	};
}
function makeRobotRelationsDescriptor(runtime) {
	return {
		id: "robot.relations",
		verb: "query",
		description: "返回关系人列表（管理员可见）",
		owner: { kind: "core" },
		handler: async () => {
			const idMgr = runtime.robotIdentityManager;
			if (idMgr) {
				const relations = idMgr.listRelations();
				return {
					relations,
					count: relations.length
				};
			}
			return {
				relations: [],
				count: 0
			};
		}
	};
}
function makeRobotAddRelationDescriptor(runtime) {
	return {
		id: "robot.add_relation",
		verb: "modify",
		description: "添加关系人（管理员权限）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: [
				"userId",
				"name",
				"role"
			],
			properties: {
				userId: { type: "string" },
				name: { type: "string" },
				role: {
					type: "string",
					enum: [
						"owner",
						"admin",
						"operator",
						"guest",
						"peer_robot"
					]
				},
				channels: {
					type: "array",
					items: { type: "string" }
				},
				bindingSubjects: {
					type: "array",
					items: { type: "string" }
				},
				note: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const idMgr = runtime.robotIdentityManager;
			if (idMgr) return {
				status: "ok",
				relation: idMgr.addRelation({
					userId: String(params.userId ?? ""),
					name: String(params.name ?? ""),
					role: String(params.role ?? "guest"),
					channels: Array.isArray(params.channels) ? params.channels : [],
					bindingSubjects: Array.isArray(params.bindingSubjects) ? params.bindingSubjects : [],
					note: typeof params.note === "string" ? params.note : void 0
				})
			};
			return {
				status: "not_supported",
				message: "身份管理器未初始化"
			};
		}
	};
}
function makeRobotIntroduceDescriptor(runtime) {
	return {
		id: "robot.introduce",
		verb: "query",
		description: "生成完整的自我介绍卡片（Markdown + 能力列表）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: {
				user_id: { type: "string" },
				lang: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const lang = typeof params.lang === "string" ? params.lang : "zh-CN";
			const idMgr = runtime.robotIdentityManager;
			const caps = runtime.capabilities.list();
			const packCount = runtime.loadedPacks.length;
			const playbookCount = runtime.playbookEngine.list().length;
			if (idMgr) {
				const id = idMgr.getIdentity();
				const intro = idMgr.buildIntroduction(lang);
				const capsSummary = caps.slice(0, 10).map((c) => `• **${c.id}** — ${c.description}`).join("\n");
				return {
					text: `## 🤖 ${id.name}\n\n${intro}\n\n**已注册能力（${caps.length} 个，部分展示）：**\n${capsSummary}\n\n📦 已加载 Pack：${packCount} 个 | 📋 Playbook：${playbookCount} 个`,
					card_template: "robot_intro",
					card_data: {
						name: id.name,
						role: id.role,
						organization: id.organization,
						capabilities_count: caps.length,
						packs_count: packCount,
						playbooks_count: playbookCount,
						capabilities_summary: id.capabilities_summary
					}
				};
			}
			const capsSummary = caps.slice(0, 10).map((c) => `• **${c.id}** — ${c.description}`).join("\n");
			return {
				text: `## 🤖 ${runtime.robot.name}\n\n我是 ${runtime.robot.name}，您的${runtime.robot.role}。\n\n**已注册能力（${caps.length} 个，部分展示）：**\n${capsSummary}\n\n📦 已加载 Pack：${packCount} 个 | 📋 Playbook：${playbookCount} 个`,
				card_template: "robot_intro",
				card_data: {
					name: runtime.robot.name,
					role: runtime.robot.role,
					capabilities_count: caps.length,
					packs_count: packCount,
					playbooks_count: playbookCount
				}
			};
		}
	};
}
function makeKbIngestDocumentDescriptor(runtime) {
	return {
		id: "kb.ingest_document",
		verb: "acquire",
		description: "摄入长文档（自动按段落/标题分块，每块作为独立条目）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["content", "title"],
			properties: {
				content: { type: "string" },
				title: { type: "string" },
				source: { type: "string" },
				chunk_size: {
					type: "integer",
					default: 500
				},
				tags: {
					type: "array",
					items: { type: "string" }
				},
				namespace: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const content = String(params.content ?? "");
			const title = String(params.title ?? "untitled");
			const source = typeof params.source === "string" ? params.source : "kb.ingest_document";
			const chunks = chunkDocument(content, typeof params.chunk_size === "number" ? params.chunk_size : 500);
			const ids = [];
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i];
				await runtime.kb.ingest(chunk, { source });
				ids.push("ingested");
			}
			return {
				chunks_created: chunks.length,
				total_chars: content.length,
				chunk_ids: ids,
				title
			};
		}
	};
}
/**
* 将长文档切分为 chunk_size 大小的段落块。
* 优先按 Markdown 标题（#）或空行分割，不满足时强制截断。
*/
function chunkDocument(text, chunkSize) {
	if (text.length <= chunkSize) return [text];
	const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
	const chunks = [];
	let current = "";
	for (const para of paragraphs) if (current.length + para.length + 2 > chunkSize && current.length > 0) {
		chunks.push(current.trim());
		current = para;
	} else current = current ? `${current}\n\n${para}` : para;
	if (current.trim()) chunks.push(current.trim());
	const result = [];
	for (const chunk of chunks) if (chunk.length <= chunkSize * 2) result.push(chunk);
	else for (let i = 0; i < chunk.length; i += chunkSize) result.push(chunk.slice(i, i + chunkSize));
	return result.filter(Boolean);
}
function makeEnvironmentLearnFromFsDescriptor(runtime) {
	const scanner = createEnvironmentScanner();
	return {
		id: "environment.learn_from_fs",
		verb: "acquire",
		description: "扫描文件系统路径，将重要配置/文档/代码摘要写入知识库",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description: "扫描路径列表，默认当前目录"
				},
				max_files: {
					type: "integer",
					default: 50,
					description: "最多摄入文件数"
				},
				file_types: {
					type: "array",
					items: { type: "string" },
					description: "文件类型过滤（扩展名）"
				}
			}
		},
		handler: async (_ctx, params) => {
			const paths = Array.isArray(params.paths) ? params.paths : [process.cwd()];
			const maxFiles = typeof params.max_files === "number" ? params.max_files : 50;
			const fileTypes = Array.isArray(params.file_types) ? params.file_types : [
				"md",
				"json",
				"yaml",
				"txt"
			];
			const resources = await scanner.scanFileSystem(paths, {
				patterns: fileTypes.map((t) => `*.${t}`),
				maxDepth: 3
			});
			let ingested = 0;
			for (const r of resources.slice(0, maxFiles)) try {
				const content = await readFile(r.location, "utf8").catch(() => "");
				if (content.length > 0 && content.length < 5e4) {
					await runtime.kb.ingest(`文件：${r.name}\n路径：${r.location}\n内容摘要：\n${content.slice(0, 2e3)}`, { source: "filesystem" });
					ingested++;
				}
			} catch {}
			return {
				scanned: resources.length,
				ingested,
				paths
			};
		}
	};
}
function makeEnvironmentWebSearchDescriptor(runtime) {
	const scanner = createEnvironmentScanner();
	return {
		id: "environment.web_search",
		verb: "acquire",
		description: "搜索互联网获取信息，并可选写入知识库（需配置 SEARXNG_URL / BRAVE_SEARCH_API_KEY / SERPER_API_KEY）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["query"],
			properties: {
				query: {
					type: "string",
					description: "搜索关键词"
				},
				save_to_kb: {
					type: "boolean",
					default: false,
					description: "是否将结果写入知识库"
				},
				limit: {
					type: "integer",
					default: 5,
					description: "返回结果数"
				}
			}
		},
		handler: async (_ctx, params) => {
			const query = String(params.query ?? "");
			const saveToKb = params.save_to_kb === true;
			const limit = typeof params.limit === "number" ? params.limit : 5;
			const results = await scanner.webSearch(query, limit);
			if (saveToKb && results.length > 0) for (const r of results) await runtime.kb.ingest(`标题：${r.title}\nURL：${r.url}\n摘要：${r.snippet}`, { source: `web_search:${query}` });
			return {
				results,
				saved: saveToKb ? results.length : 0,
				query
			};
		}
	};
}
function makeConnectApplyDescriptor(runtime) {
	const mgr = createAutoConnectManager(runtime);
	return {
		id: "connect.apply",
		verb: "control",
		description: "实际应用连接配置（从环境变量读取凭证并更新运行时连接器配置）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["services"],
			properties: { services: {
				type: "array",
				items: { type: "string" },
				description: "要连接的服务列表（feishu/ollama/openai/...）"
			} }
		},
		handler: async (_ctx, params) => {
			const services = Array.isArray(params.services) ? params.services : [];
			const results = await mgr.applyConnections(services);
			return {
				results,
				applied: results.filter((r) => r.status === "connected").length
			};
		}
	};
}
/**
* 创建并初始化所有核心基础能力注册表。
* 在 createClaworksRuntime 中调用，在任何 Pack 加载之前完成。
*
* 能力分层（共 31 个）：
*   L0 system.*        生命维持（3 个 + system.describe）
*   L1 environment.*   感知环境（2 个）
*   L2 kb.*            记忆（3 个）
*   L3 perceive.*      感知理解（3 个：perceive.message / extract_entities / intent）
*   L3+ perceive增强   类人交互（3 个：needs_clarification / sentiment / user_profile_update）
*   L4 task.*          执行（2 个）
*   L5 object.*        实体操作（3 个）
*   L6 event.*         事件（1 个）
*   L7 learn.*         主动学习（3 个）
*   L8 evolve.*        自我进化（9 个：discover / write_playbook / propose / deploy / verify / learn / list / remove / full_cycle）
*   L9 message.*       兜底（1 个）
*   Lx prompt.*        Prompt 模板（2 个）
*   Lx llm.*           LLM 增强（1 个：llm.structured_complete）
*/
function createCoreCapabilityRegistry(runtime) {
	const registry = createCapabilityRegistry();
	const descriptors = [
		makeSystemHealthDescriptor(runtime),
		makeSystemStatusDescriptor(runtime),
		makeSystemVersionDescriptor(runtime),
		makeSystemStatsDescriptor(runtime),
		makeSystemPackListDescriptor(runtime),
		makeSystemLearnDescriptor(runtime),
		makeEnvironmentContextDescriptor(),
		makeEnvironmentProfileDescriptor(runtime),
		makeEnvironmentScanDescriptor(runtime),
		makeEnvironmentScanEnvvarsDescriptor(),
		makeEnvironmentDetectServicesDescriptor(),
		makeEnvironmentLearnFromFsDescriptor(runtime),
		makeEnvironmentWebSearchDescriptor(runtime),
		makeHarnessDetectDescriptor(runtime),
		makeHarnessSyncFromDescriptor(runtime),
		makeHarnessPushToDescriptor(runtime),
		makeHarnessStatusDescriptor(runtime),
		makeConnectDetectDescriptor(runtime),
		makeConnectRecommendDescriptor(runtime),
		makeConnectStatusDescriptor(runtime),
		makeConnectApplyDescriptor(runtime),
		makeKbSearchDescriptor(runtime),
		makeKbIngestDescriptor(runtime),
		makeKbStatusDescriptor(runtime),
		makePerceiveMessageDescriptor(runtime),
		makePerceiveEntityDescriptor(runtime),
		makePerceiveIntentDescriptor(runtime),
		makePerceiveClassifyDescriptor(runtime),
		makePerceiveNeedsClarificationDescriptor(runtime),
		makePerceiveSentimentDescriptor(runtime),
		makePerceiveUserProfileUpdateDescriptor(runtime),
		makeTaskRunDescriptor(runtime),
		makeTaskStatusDescriptor(runtime),
		makeObjectCreateDescriptor(runtime),
		makeObjectQueryDescriptor(runtime),
		makeObjectUpdateDescriptor(runtime),
		makeEventPublishDescriptor(runtime),
		makeTimeNowDescriptor(),
		makeTimeShiftDescriptor(),
		makeTimeParsDescriptor(runtime),
		makeTimeDiffDescriptor(),
		makeLearnObserveDescriptor(runtime),
		makeLearnFromFeedbackDescriptor(runtime),
		makeEvolveDiscoverDescriptor(runtime),
		makeEvolveWritePlaybookDescriptor(runtime),
		makeEvolveProposDescriptor(runtime),
		makeEvolveDeployDescriptor(runtime),
		makeEvolveVerifyDescriptor(runtime),
		makeEvolveLearnDescriptor(runtime),
		makeEvolveListDescriptor(runtime),
		makeEvolveRemoveDescriptor(runtime),
		makeEvolveFullCycleDescriptor(runtime),
		makeMessageHandleDescriptor(runtime),
		makePromptListDescriptor(runtime),
		makePromptRenderDescriptor(runtime),
		makeLlmStructuredCompleteDescriptor(runtime),
		makeKbIngestDocumentDescriptor(runtime),
		makeRobotWhoamiDescriptor(runtime),
		makeRobotIdentityDescriptor(runtime),
		makeRobotOwnerDescriptor(runtime),
		makeRobotRelationsDescriptor(runtime),
		makeRobotAddRelationDescriptor(runtime),
		makeRobotIntroduceDescriptor(runtime)
	];
	registry.registerAll(descriptors);
	const swarm = createRobotSwarm(runtime);
	for (const d of makeSwarmCapabilities(swarm)) registry.register(d);
	registry.register(makeSystemDescribeDescriptor(registry));
	return registry;
}
//#endregion
//#region src/kernel/extension-capabilities.ts
/**
* extension-capabilities.ts — ClaWorks 通用机器人能力
*
* 架构原则（OpenClaw: "Core stays plugin-agnostic"）：
*
*   此文件只注册"通用机器人能力"——任何行业、任何场景都可能用到的基础能力。
*   业务域特定能力（设备、班次、生产、安全等工业能力）必须在 Pack 中注册，
*   通过 contrib/packs/<domain>/src/capabilities.ts 实现，经由 PackLoader
*   加载到运行时，而不是硬编码在这里。
*
* 三层架构：
*   第一层（Core Runtime）：此文件 — 通用机器人能力，绝不含业务逻辑
*   第二层（通用 Pack）：contrib/packs/base — 通用业务能力（work_order, alarm 等）
*   第三层（行业 Pack）：contrib/packs/industrial — 行业专属能力（shift, equipment 等）
*
* 能力清单（A 类：保留在核心）：
*   L10 reasoning.*   推理（思考、分解、评估）
*   L11 memory.*      记忆管理（召回、工作集）
*   L12 comms.*       通信（发送、广播）
*   L13 a2a.*         Agent-to-Agent（委派、发现、描述）
*   L14 pack.*        Pack 管理（列表、安装、重载）
*   L15 connector.*   连接器管理（列表、调用、状态）
*   L16 schedule.*    计划任务（创建、列表、取消）
*   L17 monitor.*     监控告警（注册监控、查询状态）
*   L18 nexus.*       Nexus 注册表（搜索、描述）
*   L19 guide.*       弱模型辅助（任务分解、步骤引导、模板执行）
*   L20 constitution.*  行为准则（查询、设置用户规则、反馈记录）
*   L21 context.*     对话上下文
*   L22 memory.case_* CBR 案例记忆
*   L23 hook.*        事件主动推送
*   L24 provider.*    Provider 注册表
*   L25 task.*        通用任务管理（业务无关）
*   L26 report.*      通用报告生成
*   L27 approval.*    通用审批流
*   L28 work_order.*  通用工单（core 注册，供 base pack Playbook 调用）
*   L29 alarm.*       通用报警（core 注册，供 base pack Playbook 调用）
*   L30 notify.*      通用通知路由
*   L32 system.*      系统管理
*   L33 skill.*       技能库
*   L34 rule.*        规则引擎
*   L35 governance.*  治理（audit, governance）
*   L36 security.*    安全审计 + observe.*
*   L40 research.*    多源并行研究（KB + 网络 + 事件日志）
*   L41 agent.*       智能体编排（ReAct / plan / spawn）
*
* 已迁移到 Pack（不再在此注册）：
*   L31（工业能力）— contrib/packs/industrial/src/capabilities.ts
*     shift.*, incident.*, equipment.*, maintenance.*, production.*, safety.*
*/
function makeReasoningCapabilities(runtime) {
	const llm = () => runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
	return [
		{
			id: "reasoning.think",
			verb: "compose",
			description: "链式推理：对一个问题一步步思考，返回推理过程和结论",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["question"],
				properties: {
					question: { type: "string" },
					context: {
						type: "string",
						description: "相关背景信息"
					},
					constraints: {
						type: "array",
						items: { type: "string" },
						description: "约束条件"
					}
				}
			},
			handler: async (_ctx, params) => {
				const question = String(params.question ?? "");
				const context = String(params.context ?? "");
				const constraints = Array.isArray(params.constraints) ? params.constraints.join("\n- ") : "";
				const completeFn = llm();
				if (!completeFn) return {
					status: "no_llm",
					conclusion: "无法推理：LLM 未配置"
				};
				const prompt = [
					"请对以下问题进行逐步推理，格式：",
					"{\"steps\":[\"步骤1...\",\"步骤2...\"],\"conclusion\":\"...\",\"confidence\":0.0-1.0}",
					"",
					`问题：${question}`,
					context ? `背景：${context}` : "",
					constraints ? `约束：\n- ${constraints}` : ""
				].filter(Boolean).join("\n");
				try {
					const { tryParseJson } = await import("./step-executor-Dgu_uWbI.mjs").then((n) => n.d);
					const result = await completeFn({ prompt });
					return tryParseJson(result.text) ?? {
						status: "parse_failed",
						raw: result.text
					};
				} catch (err) {
					return {
						status: "error",
						reason: err instanceof Error ? err.message : String(err)
					};
				}
			}
		},
		{
			id: "reasoning.decompose",
			verb: "compose",
			description: "将复杂任务分解为可由机器人执行的原子步骤，并为每步匹配最佳 Playbook 或能力",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["task"],
				properties: {
					task: {
						type: "string",
						description: "要分解的任务描述"
					},
					max_steps: {
						type: "integer",
						default: 5
					}
				}
			},
			handler: async (_ctx, params) => {
				const task = String(params.task ?? "");
				const maxSteps = typeof params.max_steps === "number" ? params.max_steps : 5;
				const capabilities = runtime.capabilities.list().map((c) => `${c.id}: ${c.description}`).join("\n");
				const playbooks = runtime.playbookEngine.list().map((p) => `${p.id}: ${p.name}`).join("\n");
				const completeFn = llm();
				if (!completeFn) return {
					status: "no_llm",
					steps: [{
						step: 1,
						action: "message.handle",
						params: { text: task },
						description: task
					}]
				};
				const prompt = [
					`将以下任务分解为最多 ${maxSteps} 个原子步骤，每步使用机器人已有的能力或 Playbook。`,
					"",
					"已有能力（优先使用）：",
					capabilities,
					"",
					"已有 Playbook：",
					playbooks,
					"",
					`任务：${task}`,
					"",
					"返回 JSON：{\"steps\":[{\"step\":1,\"type\":\"capability|playbook\",\"id\":\"...\",\"params\":{},\"description\":\"...\"}],\"rationale\":\"...\"}"
				].join("\n");
				try {
					const { tryParseJson } = await import("./step-executor-Dgu_uWbI.mjs").then((n) => n.d);
					const result = await completeFn({ prompt });
					return tryParseJson(result.text) ?? {
						status: "parse_failed",
						raw: result.text
					};
				} catch (err) {
					return {
						status: "error",
						reason: err instanceof Error ? err.message : String(err)
					};
				}
			}
		},
		{
			id: "reasoning.evaluate",
			verb: "query",
			description: "评估一个选项或结果：给出优缺点、风险、建议",
			owner: { kind: "core" },
			handler: async (_ctx, params) => {
				const subject = String(params.subject ?? params.option ?? "");
				const criteria = Array.isArray(params.criteria) ? params.criteria.join(", ") : "";
				const completeFn = llm();
				if (!completeFn) return {
					status: "no_llm",
					score: 0,
					recommendation: "无法评估"
				};
				const prompt = [
					`评估以下内容：${subject}`,
					criteria ? `评估标准：${criteria}` : "",
					"格式：{\"pros\":[\"...\"],\"cons\":[\"...\"],\"risks\":[\"...\"],\"score\":0-10,\"recommendation\":\"...\"}"
				].filter(Boolean).join("\n");
				const { tryParseJson } = await import("./step-executor-Dgu_uWbI.mjs").then((n) => n.d);
				const result = await completeFn({ prompt });
				return tryParseJson(result.text) ?? {
					status: "parse_failed",
					raw: result.text
				};
			}
		},
		{
			id: "reason.chain",
			verb: "compose",
			description: "链式推理：将复杂问题分步骤推理，每步结果传入下一步，最终得出结论",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["question", "steps"],
				properties: {
					question: {
						type: "string",
						description: "核心问题"
					},
					steps: {
						type: "array",
						items: { type: "string" },
						description: "推理步骤描述列表，如 ['分析问题', '检索信息', '得出结论']"
					},
					context: {
						type: "string",
						description: "初始上下文"
					}
				}
			},
			handler: async (_ctx, params) => {
				const question = String(params.question ?? "");
				const steps = Array.isArray(params.steps) ? params.steps : ["分析问题", "得出结论"];
				const initialContext = String(params.context ?? "");
				const completeFn = llm();
				if (!completeFn) return {
					status: "no_llm",
					conclusion: "无法推理：LLM 未配置"
				};
				const { tryParseJson } = await import("./step-executor-Dgu_uWbI.mjs").then((n) => n.d);
				const stepResults = [];
				let accumulatedContext = initialContext;
				for (const step of steps) {
					const prompt = [
						`问题：${question}`,
						accumulatedContext ? `当前上下文：${accumulatedContext}` : "",
						`当前推理步骤：${step}`,
						"",
						`请执行"${step}"并以JSON格式输出结果：{"output":"...","key_findings":["..."]}`
					].filter(Boolean).join("\n");
					try {
						const result = await completeFn({ prompt });
						const parsed = tryParseJson(result.text);
						const output = String(parsed?.output ?? result.text.slice(0, 200));
						stepResults.push({
							step,
							result: parsed ?? output
						});
						accumulatedContext = [accumulatedContext, `[${step}] ${output}`].filter(Boolean).join("\n");
					} catch (err) {
						stepResults.push({
							step,
							result: { error: err instanceof Error ? err.message : String(err) }
						});
					}
				}
				const conclusionPrompt = [
					`问题：${question}`,
					`推理过程：\n${stepResults.map((s) => `[${s.step}] ${JSON.stringify(s.result)}`).join("\n")}`,
					`请总结最终结论，以JSON格式输出：{"conclusion":"...","confidence":0.0-1.0,"action_hint":"建议下一步"}`
				].join("\n");
				try {
					const finalParsed = tryParseJson((await completeFn({ prompt: conclusionPrompt })).text);
					return {
						status: "ok",
						question,
						steps: stepResults,
						conclusion: String(finalParsed?.conclusion ?? ""),
						confidence: typeof finalParsed?.confidence === "number" ? finalParsed.confidence : .7,
						action_hint: String(finalParsed?.action_hint ?? "")
					};
				} catch {
					return {
						status: "ok",
						question,
						steps: stepResults,
						conclusion: accumulatedContext.slice(-200)
					};
				}
			}
		}
	];
}
function makeMemoryCapabilities(runtime) {
	return [
		{
			id: "memory.recall",
			verb: "retrieve",
			description: "召回近期交互记录和上下文（情景记忆）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "查询内容（不填则返回最近记录）"
					},
					limit: {
						type: "integer",
						default: 10
					},
					since_hours: {
						type: "number",
						default: 24
					}
				}
			},
			handler: async (_ctx, params) => {
				const query = String(params.query ?? "");
				const limit = typeof params.limit === "number" ? params.limit : 10;
				const sinceHours = typeof params.since_hours === "number" ? params.since_hours : 24;
				if (query) {
					const results = await runtime.kb.search(query, { limit });
					return {
						results,
						count: results.length,
						source: "semantic_search"
					};
				}
				const events = await runtime.kernel.bus.query({
					from: /* @__PURE__ */ new Date(Date.now() - sinceHours * 36e5),
					limit
				});
				return {
					recent_events: events.map((e) => ({
						type: e.type,
						source: e.source,
						timestamp: e.timestamp,
						summary: JSON.stringify(e.payload).slice(0, 100)
					})),
					count: events.length,
					source: "event_bus"
				};
			}
		},
		{
			id: "memory.consolidate",
			verb: "transform",
			description: "整合近期学习记录，去重、合并相关知识点、剪枝低质量条目，提升知识库质量",
			owner: { kind: "core" },
			handler: async () => {
				const results = await runtime.kb.search("", { limit: 100 });
				if (results.length === 0) return {
					status: "ok",
					reviewed: 0,
					merged: 0,
					pruned: 0,
					note: "No KB entries found."
				};
				const groups = /* @__PURE__ */ new Map();
				for (const entry of results) {
					const key = String(entry.content ?? entry.title ?? "").slice(0, 40).toLowerCase().trim();
					if (!key) continue;
					const group = groups.get(key) ?? [];
					group.push(entry);
					groups.set(key, group);
				}
				let merged = 0;
				let pruned = 0;
				const ops = [];
				for (const [, group] of groups.entries()) {
					if (group.length < 2) continue;
					const sorted = group.toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
					const primary = sorted[0];
					const duplicates = sorted.slice(1);
					const mergedContent = [String(primary.content ?? primary.title ?? ""), ...duplicates.map((d) => String(d.content ?? d.title ?? ""))].filter(Boolean).join("\n---\n");
					ops.push((runtime.kb.add ? runtime.kb.add({
						id: String(primary.id ?? ""),
						title: String(primary.title ?? "consolidated"),
						content: mergedContent,
						tags: ["consolidated", "auto-learned"]
					}) : runtime.kb.ingest(mergedContent, { source: "memory.consolidate" })).catch(() => void 0));
					merged += 1;
					for (const dup of duplicates) if (dup.id && typeof runtime.kb.remove === "function") {
						ops.push(runtime.kb.remove(String(dup.id)).catch(() => void 0));
						pruned += 1;
					}
				}
				await Promise.allSettled(ops);
				return {
					status: "ok",
					reviewed: results.length,
					groups: groups.size,
					merged,
					pruned,
					note: `Consolidated ${merged} duplicate groups; pruned ${pruned} entries.`
				};
			}
		},
		{
			id: "memory.list_sessions",
			verb: "query",
			description: "列出所有活跃会话（便于调试和管理对话上下文）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: { limit: {
					type: "integer",
					default: 20
				} }
			},
			handler: async (_ctx, params) => {
				const limit = typeof params.limit === "number" ? params.limit : 20;
				const sessions = (runtime.contextEngine?.listSessions?.() ?? []).slice(0, limit);
				return {
					sessions,
					count: sessions.length,
					note: sessions.length === 0 ? "contextEngine 未实现 listSessions" : void 0
				};
			}
		},
		{
			id: "memory.forget",
			verb: "control",
			description: "删除特定记忆条目（GDPR/隐私合规）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					id: {
						type: "string",
						description: "KB 条目 ID"
					},
					session_id: {
						type: "string",
						description: "会话 ID（清除该会话全部上下文）"
					},
					tags: {
						type: "array",
						items: { type: "string" },
						description: "按 tags 批量删除"
					}
				}
			},
			handler: async (_ctx, params) => {
				const deleted = [];
				const errors = [];
				if (params.id && typeof runtime.kb.remove === "function") try {
					await runtime.kb.remove(String(params.id));
					deleted.push(`kb:${params.id}`);
				} catch (err) {
					errors.push(`kb remove failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				if (params.session_id && runtime.contextEngine?.clear) try {
					runtime.contextEngine?.clear(String(params.session_id));
					deleted.push(`session:${params.session_id}`);
				} catch (err) {
					errors.push(`session clear failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				return {
					status: deleted.length > 0 ? "ok" : "nothing_deleted",
					deleted,
					errors
				};
			}
		}
	];
}
function makeCommsCapabilities(runtime) {
	return [
		{
			id: "comms.send",
			verb: "deliver",
			description: "通过配置的渠道发送消息（必须标识为机器人身份）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["message"],
				properties: {
					message: { type: "string" },
					channel: {
						type: "string",
						description: "单渠道 ID（如 feishu）"
					},
					channels: {
						type: "array",
						items: { type: "string" },
						description: "多渠道 ID 列表"
					},
					user_id: {
						type: "string",
						description: "按用户 ID 路由（查询 NotificationRouter 偏好）"
					},
					role: {
						type: "string",
						description: "按角色路由（通知该角色所有绑定用户）"
					},
					urgency: {
						type: "string",
						description: "紧急程度（normal/high/critical）"
					},
					robot_signature: {
						type: "boolean",
						default: true,
						description: "是否附加机器人身份标识"
					}
				}
			},
			handler: async (_ctx, params) => {
				const rawMessage = String(params.message ?? "");
				const addSignature = params.robot_signature !== false;
				const cleanMessage = (msg) => {
					let s = msg.trim();
					s = s.replace(/^```[\w]*\n?/m, "").replace(/\n?```$/m, "");
					s = s.replace(/^(回复|助手|机器人|AI)[：:]\s*/i, "");
					s = s.trim();
					if (s.length > 2e3) s = s.slice(0, 1980) + "\n…（内容过长，已截断）";
					return s;
				};
				const cleanedRaw = cleanMessage(rawMessage);
				const cwCard = params.card;
				const buildCardsMap = (channelIds) => {
					if (!cwCard || !runtime.cardBuilder) return void 0;
					const map = {};
					for (const ch of channelIds) {
						const formatted = runtime.cardBuilder.toAuto(cwCard, ch);
						if (formatted != null) map[ch] = formatted;
					}
					return Object.keys(map).length > 0 ? map : void 0;
				};
				const buildPlainMessage = () => {
					if (!cwCard || !runtime.cardBuilder) return addSignature ? `[${runtime.robot.name}] ${cleanedRaw}` : cleanedRaw;
					const plainText = runtime.cardBuilder.toPlainText(cwCard);
					return addSignature ? `[${runtime.robot.name}] ${plainText}` : plainText;
				};
				const finalMessage = addSignature ? `[${runtime.robot.name}] ${cleanedRaw}` : cleanedRaw;
				if (params.user_id) {
					const userId = String(params.user_id);
					const pref = runtime.notificationRouter?.getPreference(userId);
					const channels = pref?.channels?.length ? pref.channels : void 0;
					const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
					const message = buildPlainMessage();
					const cards = channels ? buildCardsMap(channels) : void 0;
					if (notifyBridge) await notifyBridge.send({
						message,
						channels,
						...cards ? { cards } : {}
					});
					else runtime.logger?.(`[comms.send → ${userId}] channels=${channels?.join(",") ?? "log"} msg=${message}`);
					return {
						status: "ok",
						message,
						channels,
						routed_by: "user_id",
						user_id: userId
					};
				}
				if (params.role) {
					const role = String(params.role);
					const userIds = (runtime.notificationRouter?.listBindings().filter((b) => b.subjectType === "role" && b.subjectId === role) ?? [] ?? []).flatMap((b) => b.userIds);
					const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
					if (userIds.length === 0) {
						const message = buildPlainMessage();
						if (notifyBridge) await notifyBridge.send({ message });
						else runtime.logger?.(`[comms.send/role-fallback] role=${role} ${message}`);
						return {
							status: "ok",
							message,
							channels: ["default"],
							routed_by: "role_fallback"
						};
					}
					await Promise.allSettled(userIds.map(async (uid) => {
						const pref = runtime.notificationRouter?.getPreference(uid);
						const channels = pref?.channels?.length ? pref.channels : void 0;
						const message = buildPlainMessage();
						const cards = channels ? buildCardsMap(channels) : void 0;
						if (notifyBridge) await notifyBridge.send({
							message,
							channels,
							...cards ? { cards } : {}
						});
						else runtime.logger?.(`[comms.send → ${uid}] channels=${channels?.join(",") ?? "log"}`);
					}));
					return {
						status: "ok",
						message: finalMessage,
						recipients: userIds,
						routed_by: "role"
					};
				}
				const channels = Array.isArray(params.channels) ? params.channels : params.channel ? [String(params.channel)] : void 0;
				const message = buildPlainMessage();
				const cards = channels ? buildCardsMap(channels) : void 0;
				const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
				if (notifyBridge) await notifyBridge.send({
					message,
					channels,
					...cards ? { cards } : {}
				});
				else runtime.logger?.(`[comms.send] ${message} channels=${channels?.join(",") ?? "log"}`);
				return {
					status: "ok",
					message,
					channels
				};
			}
		},
		{
			id: "comms.broadcast",
			verb: "deliver",
			description: "向所有配置的渠道广播消息（需要 HITL）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "广播消息影响所有渠道，需要确认"
			},
			handler: async (_ctx, params) => {
				const message = String(params.message ?? "");
				const finalMessage = `[${runtime.robot.name} BROADCAST] ${message}`;
				const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
				if (notifyBridge) await notifyBridge.send({ message: finalMessage });
				await runtime.kernel.publish("comms.broadcast_sent", "comms.broadcast", { message: finalMessage });
				return {
					status: "ok",
					message: finalMessage
				};
			}
		},
		{
			id: "comms.history",
			verb: "query",
			description: "查看最近发送的消息历史（便于排查通知是否送达）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					limit: {
						type: "integer",
						default: 20
					},
					since_hours: {
						type: "number",
						default: 24
					},
					user_id: {
						type: "string",
						description: "按收件人过滤"
					}
				}
			},
			handler: async (_ctx, params) => {
				const limit = typeof params.limit === "number" ? params.limit : 20;
				const sinceHours = typeof params.since_hours === "number" ? params.since_hours : 24;
				const userId = params.user_id ? String(params.user_id) : void 0;
				const commEvents = (await runtime.kernel.bus.query({
					from: /* @__PURE__ */ new Date(Date.now() - sinceHours * 36e5),
					limit: limit * 2
				})).filter((e) => e.type.startsWith("comms.") || e.type.startsWith("notify."));
				const filtered = userId ? commEvents.filter((e) => {
					const p = e.payload;
					return String(p.user_id ?? p.recipient ?? "").includes(userId);
				}) : commEvents;
				return {
					messages: filtered.slice(0, limit).map((e) => ({
						type: e.type,
						timestamp: e.timestamp,
						summary: JSON.stringify(e.payload).slice(0, 120)
					})),
					count: filtered.length,
					since_hours: sinceHours
				};
			}
		},
		{
			id: "comms.throttle_status",
			verb: "query",
			description: "查看通知节流状态（哪些 userId+eventType 正处于节流期）",
			owner: { kind: "core" },
			handler: async () => {
				const throttleMap = runtime._commsThrottle;
				if (!throttleMap) return {
					status: "ok",
					throttled: [],
					count: 0,
					note: "节流表未初始化"
				};
				const now = Date.now();
				const throttled = [...throttleMap.entries()].filter(([, expiry]) => expiry > now).map(([key, expiry]) => ({
					key,
					expires_in_ms: expiry - now
				}));
				return {
					status: "ok",
					throttled,
					count: throttled.length
				};
			}
		},
		{
			id: "comms.stream_reply",
			verb: "deliver",
			description: "流式 LLM 回复：调用 LLM 生成回复并发送，如渠道支持则分块推送（打字机效果）。不支持流式时自动降级为普通回复。",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["prompt"],
				properties: {
					prompt: {
						type: "string",
						description: "传给 LLM 的提示词"
					},
					channel: {
						type: "string",
						description: "目标渠道 ID"
					},
					channels: {
						type: "array",
						items: { type: "string" }
					},
					model: {
						type: "string",
						description: "指定模型（可选）"
					},
					max_tokens: {
						type: "number",
						description: "最大生成 token 数，默认 500"
					},
					robot_signature: {
						type: "boolean",
						default: true
					}
				}
			},
			handler: async (_ctx, params) => {
				const prompt = String(params.prompt ?? "");
				const model = params.model ? String(params.model) : void 0;
				typeof params.max_tokens === "number" && params.max_tokens;
				const addSignature = params.robot_signature !== false;
				const llmFn = runtime.bridges?.get("llm")?.complete ?? runtime.llmComplete;
				if (!llmFn) return {
					status: "no_llm",
					message: "LLM 未配置，无法生成回复"
				};
				const channels = Array.isArray(params.channels) ? params.channels : params.channel ? [String(params.channel)] : void 0;
				await runtime.kernel.publish("comms.stream_started", "comms.stream_reply", {
					channels,
					prompt_length: prompt.length
				});
				let text;
				try {
					text = (await llmFn({
						prompt,
						model
					})).text;
				} catch (err) {
					await runtime.kernel.publish("comms.stream_failed", "comms.stream_reply", {
						error: err instanceof Error ? err.message : String(err),
						channels
					});
					return {
						status: "error",
						error: err instanceof Error ? err.message : String(err)
					};
				}
				const finalText = addSignature ? `[${runtime.robot.name}] ${text}` : text;
				await runtime.kernel.publish("comms.stream_completed", "comms.stream_reply", {
					channels,
					message_length: finalText.length
				});
				const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
				if (notifyBridge) await notifyBridge.send({
					message: finalText,
					channels
				});
				else runtime.logger?.(`[comms.stream_reply] ${finalText} channels=${channels?.join(",") ?? "log"}`);
				return {
					status: "ok",
					message: finalText,
					channels
				};
			}
		}
	];
}
function makeA2aCapabilities(runtime) {
	const peers = () => runtime.config.a2a?.peers ?? [];
	return [
		{
			id: "a2a.discover",
			verb: "query",
			description: "发现所有已配置的 A2A 对等机器人及其能力",
			owner: { kind: "core" },
			handler: async () => {
				const peerList = peers();
				return {
					peers: (await Promise.allSettled(peerList.map(async (peer) => {
						const url = resolveA2aTarget(peer.name, peerList);
						const client = new A2aClient({ baseUrl: url });
						try {
							const card = await client.fetchAgentCard();
							return {
								name: peer.name,
								url,
								status: "online",
								skills: card.skills?.length ?? 0,
								card
							};
						} catch {
							return {
								name: peer.name,
								url,
								status: "offline"
							};
						}
					}))).map((r) => r.status === "fulfilled" ? r.value : { status: "error" }),
					total: peerList.length
				};
			}
		},
		{
			id: "a2a.describe",
			verb: "query",
			description: "获取指定 A2A 对等机器人的能力卡片",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["peer_name"],
				properties: { peer_name: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				const peerName = String(params.peer_name ?? "");
				return {
					status: "ok",
					peer_name: peerName,
					...await new A2aClient({ baseUrl: resolveA2aTarget(peerName, peers()) }).fetchAgentCard()
				};
			}
		},
		{
			id: "a2a.delegate",
			verb: "deliver",
			description: "将一个任务委派给 A2A 对等机器人执行（需要 HITL）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "委派任务给外部 Agent 需要确认"
			},
			paramsSchema: {
				type: "object",
				required: ["peer_name", "task"],
				properties: {
					peer_name: { type: "string" },
					task: { type: "string" },
					wait_result: {
						type: "boolean",
						default: true
					}
				}
			},
			handler: async (ctx, params) => {
				const peerName = String(params.peer_name ?? "");
				const task = String(params.task ?? "");
				const waitResult = params.wait_result !== false;
				const client = new A2aClient({ baseUrl: resolveA2aTarget(peerName, peers()) });
				await runtime.kernel.publish("a2a.delegate_started", "a2a.delegate", {
					peer: peerName,
					task,
					correlationId: ctx.correlationId
				});
				if (waitResult) {
					const result = await client.sendAndWait({ message: {
						role: "user",
						parts: [{
							type: "text",
							text: task
						}]
					} });
					return {
						status: "ok",
						task_id: result.id,
						result: result.result
					};
				}
				return {
					status: "queued",
					task_id: (await client.sendTask({ message: {
						role: "user",
						parts: [{
							type: "text",
							text: task
						}]
					} })).id
				};
			}
		},
		{
			id: "a2a.self_describe",
			verb: "query",
			description: "返回本机器人的 A2A 代理卡片（供对等机器人发现）",
			owner: { kind: "core" },
			handler: async () => {
				return buildA2aAgentCard(runtime);
			}
		},
		{
			id: "a2a.send_task",
			verb: "deliver",
			description: "向另一个机器人发送任务（A2A 客户端，异步执行）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["peer_name", "task"],
				properties: {
					peer_name: { type: "string" },
					task: { type: "string" },
					metadata: { type: "object" }
				}
			},
			handler: async (_ctx, params) => {
				const peerName = String(params.peer_name ?? "");
				const task = String(params.task ?? "");
				const metadata = params.metadata ?? {};
				return {
					status: "queued",
					task_id: (await new A2aClient({ baseUrl: resolveA2aTarget(peerName, peers()) }).sendTask({
						message: {
							role: "user",
							parts: [{
								type: "text",
								text: task
							}]
						},
						metadata
					})).id,
					peer: peerName
				};
			}
		},
		{
			id: "a2a.list_peers",
			verb: "query",
			description: "列出所有已配置的对等机器人",
			owner: { kind: "core" },
			handler: async () => {
				const peerList = peers();
				return {
					peers: peerList.map((p) => ({
						name: p.name,
						endpoint: p.endpoint ?? p.url
					})),
					count: peerList.length
				};
			}
		},
		{
			id: "a2a.add_peer",
			verb: "modify",
			description: "添加对等机器人（管理员权限）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["name", "endpoint"],
				properties: {
					name: { type: "string" },
					endpoint: { type: "string" },
					trusted: {
						type: "boolean",
						default: false
					}
				}
			},
			handler: async (_ctx, params) => {
				const name = String(params.name ?? "");
				const endpoint = String(params.endpoint ?? "");
				if (!runtime.config.a2a) runtime.config.a2a = {
					enabled: true,
					peers: []
				};
				if (!runtime.config.a2a.peers) runtime.config.a2a.peers = [];
				const existing = runtime.config.a2a.peers.find((p) => p.name === name);
				if (!existing) runtime.config.a2a.peers.push({
					name,
					url: endpoint,
					endpoint
				});
				return {
					status: "ok",
					name,
					endpoint,
					added: !existing
				};
			}
		}
	];
}
function makePackCapabilities(runtime) {
	return [
		{
			id: "pack.list",
			verb: "query",
			description: "列出所有已安装的 Pack 及其提供的能力",
			owner: { kind: "core" },
			handler: async () => ({
				packs: runtime.loadedPacks.map((p) => ({
					id: p.manifest.id,
					name: p.manifest.name,
					version: p.manifest.version,
					playbooks: p.manifest.provides.playbooks,
					object_types: p.manifest.provides.objectTypes,
					action_types: p.manifest.provides.actionTypes
				})),
				total: runtime.loadedPacks.length
			})
		},
		{
			id: "pack.install",
			verb: "acquire",
			description: "从 Nexus 安装一个新 Pack（需要 HITL）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "安装新 Pack 会扩展机器人能力，需要确认"
			},
			paramsSchema: {
				type: "object",
				required: ["pack_id"],
				properties: {
					pack_id: { type: "string" },
					version: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const packId = String(params.pack_id ?? "");
				try {
					const pack = await runtime.packLoader.install(packId, runtime.config.packs ?? {});
					await runtime.playbookEngine.reloadPack(packId);
					await runtime.ontology.loadFromPacks([pack]);
					await runtime.kernel.publish("pack.installed", "pack.install", {
						pack_id: packId,
						version: pack.manifest.version,
						playbooks: pack.manifest.provides.playbooks
					});
					return {
						status: "ok",
						pack_id: packId,
						version: pack.manifest.version
					};
				} catch (err) {
					return {
						status: "error",
						reason: err instanceof Error ? err.message : String(err)
					};
				}
			}
		},
		{
			id: "pack.reload",
			verb: "control",
			description: "重新加载一个 Pack（Pack 文件更新后使用）",
			owner: { kind: "core" },
			handler: async (_ctx, params) => {
				const packId = String(params.pack_id ?? "");
				if (packId) {
					await runtime.playbookEngine.reloadPack(packId);
					return {
						status: "ok",
						reloaded: packId
					};
				}
				const { packs } = await runtime.playbookEngine.reloadPacks?.() ?? { packs: [] };
				return {
					status: "ok",
					reloaded_count: Array.isArray(packs) ? packs.length : 0
				};
			}
		}
	];
}
function makeConnectorCapabilities(runtime) {
	return [
		{
			id: "connector.list",
			verb: "query",
			description: "列出所有已配置的连接器及其运行状态",
			owner: { kind: "core" },
			handler: async () => {
				const statusList = runtime.connectorManager.status();
				return {
					connectors: statusList,
					total: statusList.length
				};
			}
		},
		{
			id: "connector.status",
			verb: "query",
			description: "查询单个连接器的运行状态",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["connector_id"],
				properties: { connector_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				const connectorId = String(params.connector_id ?? "");
				const found = runtime.connectorManager.status().find((s) => s.id === connectorId);
				if (!found) return {
					status: "not_found",
					connector_id: connectorId
				};
				return {
					connector_id: connectorId,
					...found
				};
			}
		},
		{
			id: "connector.invoke",
			verb: "deliver",
			description: "调用连接器的一个方法（需要 HITL）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "直接调用连接器方法可能产生外部副作用"
			},
			paramsSchema: {
				type: "object",
				required: ["connector_id", "method"],
				properties: {
					connector_id: { type: "string" },
					method: { type: "string" },
					params: { type: "object" }
				}
			},
			handler: async (ctx, params) => {
				const connectorId = String(params.connector_id ?? "");
				const method = String(params.method ?? "");
				const methodParams = params.params ?? {};
				await runtime.kernel.publish("connector.invoke_started", "connector.invoke", {
					connector_id: connectorId,
					method,
					correlationId: ctx.correlationId
				});
				await runtime.connectorManager.invoke(connectorId, method, methodParams);
				return {
					status: "ok",
					connector_id: connectorId,
					method
				};
			}
		}
	];
}
function makeScheduleCapabilities(runtime) {
	return [
		{
			id: "schedule.list",
			verb: "query",
			description: "列出所有通过 Playbook 定义的计划任务",
			owner: { kind: "core" },
			handler: async () => {
				const scheduled = runtime.playbookEngine.list().filter((p) => p.trigger.kind === "schedule");
				return {
					tasks: scheduled.map((p) => ({
						playbook_id: p.id,
						name: p.name,
						cron: p.trigger.cron,
						timezone: p.trigger.timezone
					})),
					total: scheduled.length
				};
			}
		},
		{
			id: "schedule.add",
			verb: "control",
			description: "动态添加一个计划任务（需要 HITL）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "添加计划任务会产生周期性副作用"
			},
			paramsSchema: {
				type: "object",
				required: ["playbook_id", "cron"],
				properties: {
					playbook_id: { type: "string" },
					cron: {
						type: "string",
						description: "cron 表达式，如 '0 9 * * *'"
					},
					timezone: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const playbookId = String(params.playbook_id ?? "");
				const cron = String(params.cron ?? "");
				const timezone = params.timezone ? String(params.timezone) : void 0;
				if (!playbookId || !cron) return {
					status: "error",
					reason: "playbook_id and cron are required"
				};
				const existing = runtime.playbookEngine.list().find((p) => p.id === playbookId);
				if (!existing) return {
					status: "error",
					reason: `playbook '${playbookId}' not found`
				};
				try {
					runtime.scheduler.add({
						id: playbookId,
						name: existing.name ?? playbookId,
						pack: existing.pack ?? "dynamic",
						priority: existing.priority ?? 50,
						trigger: {
							kind: "schedule",
							cron,
							timezone
						},
						steps: existing.steps
					});
				} catch {
					return {
						status: "error",
						reason: `invalid cron expression: '${cron}'`
					};
				}
				await runtime.kernel.publish("schedule.job_registered", "schedule.add", {
					playbook_id: playbookId,
					cron,
					timezone
				}).catch(() => void 0);
				return {
					status: "registered",
					playbook_id: playbookId,
					cron,
					timezone
				};
			}
		},
		{
			id: "schedule.remove",
			verb: "control",
			description: "取消一个动态注册的计划任务（重新 reload 可恢复配置中的定时任务）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["playbook_id"],
				properties: { playbook_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				const playbookId = String(params.playbook_id ?? "");
				const remaining = runtime.playbookEngine.list().filter((p) => p.id !== playbookId);
				runtime.scheduler.reload(remaining);
				return {
					status: "reloaded_without",
					playbook_id: playbookId
				};
			}
		}
	];
}
function makeMonitorCapabilities(runtime) {
	const watches = /* @__PURE__ */ new Map();
	return [{
		id: "monitor.watch",
		verb: "observe",
		description: "注册一个事件模式监控，当匹配时触发指定 Playbook",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["event_pattern", "playbook_id"],
			properties: {
				event_pattern: { type: "string" },
				playbook_id: { type: "string" },
				watch_id: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const pattern = String(params.event_pattern ?? "");
			const playbookId = String(params.playbook_id ?? "");
			const watchId = String(params.watch_id ?? `watch-${Date.now()}`);
			watches.set(watchId, {
				pattern,
				playbookId,
				registeredAt: /* @__PURE__ */ new Date()
			});
			await runtime.kernel.publish("monitor.watch_registered", "monitor.watch", {
				watch_id: watchId,
				event_pattern: pattern,
				playbook_id: playbookId
			});
			return {
				status: "ok",
				watch_id: watchId
			};
		}
	}, {
		id: "monitor.status",
		verb: "query",
		description: "查看当前所有监控注册情况",
		owner: { kind: "core" },
		handler: async () => ({
			watches: [...watches.entries()].map(([id, w]) => Object.assign({ id }, w)),
			total: watches.size
		})
	}];
}
function makeNexusCapabilities(runtime) {
	const nexusUrl = () => runtime.config.packs?.registry ?? "http://localhost:18800";
	return [{
		id: "nexus.search",
		verb: "retrieve",
		description: "在 Nexus 注册表中搜索可用的 Pack",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				family: { type: "string" }
			}
		},
		handler: async (_ctx, params) => {
			const query = String(params.query ?? "");
			try {
				const url = `${nexusUrl()}/packages`;
				const res = await fetch(url);
				if (!res.ok) return {
					status: "unavailable",
					packages: []
				};
				const packages = (await res.json()).packages ?? [];
				const filtered = query ? packages.filter((p) => p.slug.includes(query) || p.name.toLowerCase().includes(query.toLowerCase()) || (p.description ?? "").toLowerCase().includes(query.toLowerCase())) : packages;
				return {
					status: "ok",
					packages: filtered,
					total: filtered.length
				};
			} catch {
				return {
					status: "error",
					packages: []
				};
			}
		}
	}, {
		id: "nexus.describe",
		verb: "query",
		description: "获取 Nexus 中指定 Pack 的详细信息",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["pack_id"],
			properties: { pack_id: { type: "string" } }
		},
		handler: async (_ctx, params) => {
			const packId = String(params.pack_id ?? "");
			try {
				const res = await fetch(`${nexusUrl()}/packages/${packId}`);
				if (!res.ok) return {
					status: "not_found",
					pack_id: packId
				};
				return {
					status: "ok",
					...await res.json()
				};
			} catch {
				return {
					status: "error",
					pack_id: packId
				};
			}
		}
	}];
}
/**
* guide.* 能力专为弱本地模型设计：
* - 提供参考答案和步骤模板
* - 机器人只需「对照答案执行」，不需要创新
* - 所有步骤都有明确的输入输出格式
*/
function makeGuideCapabilities(runtime) {
	return [
		{
			id: "guide.list_templates",
			verb: "query",
			description: "列出所有可用的任务模板（弱模型使用：按模板执行无需推理）",
			owner: { kind: "core" },
			handler: async () => {
				const results = await runtime.kb.search("task template playbook guide", { limit: 20 });
				const playbooks = runtime.playbookEngine.list().map((p) => ({
					id: p.id,
					name: p.name,
					description: p.description,
					trigger: p.trigger.kind,
					steps: p.steps.length
				}));
				return {
					kb_templates: results.slice(0, 5),
					playbooks,
					tip: "Use 'task.run' with playbook_id to execute without LLM reasoning"
				};
			}
		},
		{
			id: "guide.step",
			verb: "compose",
			description: "为弱模型提供单步骤的精确执行指令（含参考答案、格式、验证方法）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["action"],
				properties: {
					action: {
						type: "string",
						description: "要执行的动作描述"
					},
					input: {
						type: "object",
						description: "当前可用的输入数据"
					}
				}
			},
			handler: async (_ctx, params) => {
				const action = String(params.action ?? "");
				const input = params.input ?? {};
				const templates = await runtime.kb.search(action, { limit: 3 });
				const matchingPlaybooks = runtime.playbookEngine.list().filter((p) => {
					const text = `${p.name} ${p.description ?? ""}`.toLowerCase();
					return action.toLowerCase().split(" ").some((word) => word.length > 3 && text.includes(word));
				}).slice(0, 2);
				const capabilities = runtime.capabilities.list().filter((c) => {
					const text = `${c.id} ${c.description}`.toLowerCase();
					return action.toLowerCase().split(" ").some((word) => word.length > 3 && text.includes(word));
				}).slice(0, 3);
				return {
					action,
					input,
					recommendation: {
						suggested_capabilities: capabilities.map((c) => ({
							id: c.id,
							description: c.description,
							verb: c.verb
						})),
						suggested_playbooks: matchingPlaybooks.map((p) => ({
							id: p.id,
							name: p.name
						})),
						kb_references: templates.slice(0, 2)
					},
					execution_hint: capabilities[0] ? `直接调用 capabilities.invoke("${capabilities[0].id}", params) 即可执行` : `使用 reasoning.decompose 将此任务分解为更小的步骤`
				};
			}
		},
		{
			id: "guide.fill_template",
			verb: "compose",
			description: "填写一个任务模板并生成可执行的 Playbook 输入参数",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["template_id", "variables"],
				properties: {
					template_id: { type: "string" },
					variables: { type: "object" }
				}
			},
			handler: async (_ctx, params) => {
				const templateId = String(params.template_id ?? "");
				const variables = params.variables ?? {};
				const playbook = runtime.playbookEngine.list().find((p) => p.id === templateId);
				if (!playbook) return {
					status: "not_found",
					template_id: templateId
				};
				return {
					status: "ok",
					template_id: templateId,
					playbook_name: playbook.name,
					filled_input: variables,
					execution: {
						capability: "task.run",
						params: {
							playbook_id: templateId,
							input: variables
						}
					}
				};
			}
		}
	];
}
function makeConstitutionCapabilities(runtime, constitution) {
	return [
		{
			id: "constitution.describe",
			verb: "query",
			description: "返回当前行为准则的完整描述（四层规则）",
			owner: { kind: "core" },
			handler: async () => constitution.describe()
		},
		{
			id: "constitution.check",
			verb: "query",
			description: "检查一个能力是否被允许执行，以及在哪一层受到限制",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["capability_id"],
				properties: {
					capability_id: { type: "string" },
					source: { type: "string" },
					user_id: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const id = String(params.capability_id ?? "");
				return constitution.check(id, {
					source: String(params.source ?? ""),
					userId: String(params.user_id ?? "")
				});
			}
		},
		{
			id: "constitution.set_user_rule",
			verb: "control",
			description: "为特定用户设置自定义规则（Tier 2）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "修改用户规则影响权限"
			},
			handler: async (_ctx, params) => {
				constitution.setUserRule(params);
				return { status: "ok" };
			}
		},
		{
			id: "constitution.record_feedback",
			verb: "acquire",
			description: "记录一次行为反馈，用于 Tier 3 可进化规则学习",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["capability_id", "direction"],
				properties: {
					capability_id: { type: "string" },
					direction: {
						type: "string",
						enum: [
							"nudge_allow",
							"nudge_hitl",
							"style_adjust"
						]
					},
					related_run_id: { type: "string" },
					user_id: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const capabilityId = String(params.capability_id ?? "");
				const direction = params.direction;
				constitution.recordFeedback(capabilityId, direction);
				const desc = constitution.describe();
				await runtime.kernel.publish("capability.feedback_received", "constitution.record_feedback", {
					capability_id: capabilityId,
					direction,
					related_run_id: params.related_run_id ?? null,
					user_id: params.user_id ?? null,
					learned_count: desc.learnedCount,
					threshold_reached: false
				}).catch(() => void 0);
				return {
					status: "ok",
					capability_id: capabilityId,
					direction
				};
			}
		}
	];
}
function makeContextCapabilities(runtime) {
	return [
		{
			id: "context.append",
			verb: "observe",
			description: "追加一条对话记录到会话上下文",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: [
					"session_id",
					"role",
					"content"
				],
				properties: {
					session_id: { type: "string" },
					role: {
						type: "string",
						enum: [
							"user",
							"assistant",
							"system"
						]
					},
					content: { type: "string" },
					meta: { type: "object" }
				}
			},
			handler: async (_ctx, params) => {
				const sessionId = String(params.session_id ?? "");
				const role = String(params.role ?? "user");
				const content = String(params.content ?? "");
				const meta = params.meta ?? void 0;
				runtime.contextEngine?.append(sessionId, role, content, meta);
				return {
					status: "ok",
					session_id: sessionId
				};
			}
		},
		{
			id: "context.get",
			verb: "retrieve",
			description: "获取会话上下文（最近 N 轮对话）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["session_id"],
				properties: {
					session_id: { type: "string" },
					max_turns: {
						type: "integer",
						default: 10
					}
				}
			},
			handler: async (_ctx, params) => {
				const sessionId = String(params.session_id ?? "");
				const maxTurns = typeof params.max_turns === "number" ? params.max_turns : 10;
				const turns = runtime.contextEngine?.getRecent(sessionId, maxTurns) ?? [];
				return {
					session_id: sessionId,
					turns,
					count: turns.length
				};
			}
		},
		{
			id: "context.clear",
			verb: "control",
			description: "清除指定会话的上下文",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["session_id"],
				properties: { session_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				runtime.contextEngine?.clear(String(params.session_id ?? ""));
				return { status: "ok" };
			}
		},
		{
			id: "context.list",
			verb: "query",
			description: "列出所有活跃会话摘要",
			owner: { kind: "core" },
			handler: async () => {
				const sessions = runtime.contextEngine?.listSessions() ?? [];
				return {
					sessions,
					count: sessions.length
				};
			}
		}
	];
}
function makeCbrCapabilities(runtime) {
	return [
		{
			id: "memory.case_search",
			verb: "retrieve",
			description: "搜索相似历史案例（Case-Based Reasoning）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["query"],
				properties: {
					query: { type: "string" },
					limit: {
						type: "integer",
						default: 5
					}
				}
			},
			handler: async (_ctx, params) => {
				const query = String(params.query ?? "");
				const limit = typeof params.limit === "number" ? params.limit : 5;
				const cases = runtime.cbrStore?.search(query, limit) ?? [];
				return {
					cases,
					count: cases.length
				};
			}
		},
		{
			id: "memory.case_record",
			verb: "acquire",
			description: "记录新案例（Playbook 成功/失败后调用，积累经验）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["problem", "solution"],
				properties: {
					problem: { type: "string" },
					solution: { type: "string" },
					outcome: {
						type: "string",
						enum: [
							"success",
							"partial",
							"failed"
						]
					},
					tags: {
						type: "array",
						items: { type: "string" }
					},
					playbook_id: { type: "string" },
					run_id: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				return {
					status: "ok",
					case_id: (runtime.cbrStore?.add(String(params.problem ?? ""), String(params.solution ?? ""), {
						outcome: params.outcome ?? "success",
						tags: Array.isArray(params.tags) ? params.tags : void 0,
						playbookId: params.playbook_id ? String(params.playbook_id) : void 0,
						runId: params.run_id ? String(params.run_id) : void 0
					}))?.id
				};
			}
		},
		{
			id: "memory.case_outcome",
			verb: "acquire",
			description: "更新案例结果（成功/部分成功/失败）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["case_id", "outcome"],
				properties: {
					case_id: { type: "string" },
					outcome: {
						type: "string",
						enum: [
							"success",
							"partial",
							"failed"
						]
					}
				}
			},
			handler: async (_ctx, params) => {
				const caseId = String(params.case_id ?? "");
				const outcome = params.outcome;
				runtime.cbrStore?.recordOutcome(caseId, outcome);
				return {
					status: "ok",
					case_id: caseId,
					outcome
				};
			}
		}
	];
}
function makeHookCapabilities(runtime) {
	return [
		{
			id: "hook.register",
			verb: "control",
			description: "注册一个事件 Hook（事件触发后推送到外部系统；需要 HITL，因为会产生外部副作用）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "注册 Hook 会产生外部副作用"
			},
			paramsSchema: {
				type: "object",
				required: [
					"name",
					"event_pattern",
					"action_kind",
					"template"
				],
				properties: {
					name: { type: "string" },
					event_pattern: { type: "string" },
					condition: { type: "string" },
					action_kind: {
						type: "string",
						enum: [
							"im_notify",
							"webhook",
							"playbook",
							"a2a_delegate"
						]
					},
					channel: { type: "string" },
					url: { type: "string" },
					playbook_id: { type: "string" },
					template: { type: "string" },
					headers: { type: "object" }
				}
			},
			handler: async (_ctx, params) => {
				const hook = runtime.hookEngine?.register({
					name: String(params.name ?? ""),
					trigger: {
						eventPattern: String(params.event_pattern ?? ""),
						condition: params.condition ? String(params.condition) : void 0
					},
					action: {
						kind: params.action_kind ?? "im_notify",
						channel: params.channel ? String(params.channel) : void 0,
						url: params.url ? String(params.url) : void 0,
						playbookId: params.playbook_id ? String(params.playbook_id) : void 0,
						template: String(params.template ?? ""),
						headers: params.headers ?? void 0
					},
					enabled: true
				});
				return {
					status: "ok",
					hook_id: hook?.id,
					name: hook?.name
				};
			}
		},
		{
			id: "hook.unregister",
			verb: "control",
			description: "取消一个已注册的 Hook",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["hook_id"],
				properties: { hook_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				return { status: runtime.hookEngine?.unregister(String(params.hook_id ?? "")) ? "removed" : "not_found" };
			}
		},
		{
			id: "hook.list",
			verb: "query",
			description: "列出所有已注册的 Hook",
			owner: { kind: "core" },
			handler: async () => {
				const hooks = runtime.hookEngine?.list() ?? [];
				return {
					hooks,
					count: hooks.length
				};
			}
		},
		{
			id: "hook.enable",
			verb: "control",
			description: "启用一个 Hook",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["hook_id"],
				properties: { hook_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				runtime.hookEngine?.enable(String(params.hook_id ?? ""));
				return { status: "ok" };
			}
		},
		{
			id: "hook.disable",
			verb: "control",
			description: "禁用一个 Hook",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["hook_id"],
				properties: { hook_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				runtime.hookEngine?.disable(String(params.hook_id ?? ""));
				return { status: "ok" };
			}
		}
	];
}
function makeProviderCapabilities(runtime) {
	return [{
		id: "provider.list",
		verb: "query",
		description: "列出所有已注册的 Provider（LLM/KB/Notify/Connector）",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			properties: { kind: {
				type: "string",
				enum: [
					"llm",
					"kb",
					"notify",
					"connector"
				]
			} }
		},
		handler: async (_ctx, params) => {
			const kind = params.kind;
			const providers = runtime.providerRegistry?.list(kind) ?? [];
			return {
				providers: providers.map((p) => ({
					id: p.id,
					kind: p.kind,
					name: p.name,
					priority: p.priority,
					available: typeof p.available === "function" ? p.available() : p.available,
					meta: p.meta
				})),
				count: providers.length
			};
		}
	}, {
		id: "provider.status",
		verb: "query",
		description: "查看指定 Provider 的可用性",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["provider_id"],
			properties: { provider_id: { type: "string" } }
		},
		handler: async (_ctx, params) => {
			const id = String(params.provider_id ?? "");
			const available = runtime.providerRegistry?.isAvailable(id);
			const provider = (runtime.providerRegistry?.list() ?? []).find((p) => p.id === id);
			if (!provider) return {
				status: "not_found",
				provider_id: id
			};
			return {
				provider_id: id,
				available,
				kind: provider.kind,
				name: provider.name,
				priority: provider.priority
			};
		}
	}];
}
function makeTaskManagementCapabilities(runtime) {
	const TASK_TYPE = "task";
	return [
		{
			id: "task.create",
			verb: "transform",
			description: "创建任务（存入 ObjectStore）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "创建任务需要人工确认"
			},
			paramsSchema: {
				type: "object",
				required: ["title"],
				properties: {
					title: { type: "string" },
					description: { type: "string" },
					assignee: { type: "string" },
					priority: {
						type: "string",
						enum: [
							"urgent",
							"high",
							"normal",
							"low"
						]
					},
					due_date: { type: "string" },
					tags: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			handler: async (ctx, params) => {
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const task = await runtime.objectStore.create(TASK_TYPE, {
					title: String(params.title ?? ""),
					description: params.description ? String(params.description) : void 0,
					assignee: params.assignee ? String(params.assignee) : void 0,
					priority: String(params.priority ?? "normal"),
					status: "open",
					due_date: params.due_date ? String(params.due_date) : void 0,
					tags: Array.isArray(params.tags) ? params.tags : [],
					created_at: now,
					updated_at: now
				}, ctx.stepCtx ?? {});
				await runtime.kernel.publish("task.created", "task.create", {
					task_id: task.id,
					title: params.title
				}).catch(() => void 0);
				return {
					status: "ok",
					task_id: task.id,
					...task
				};
			}
		},
		{
			id: "task.update",
			verb: "transform",
			description: "更新任务状态或字段",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["task_id"],
				properties: {
					task_id: { type: "string" },
					status: {
						type: "string",
						enum: [
							"open",
							"in_progress",
							"done",
							"cancelled"
						]
					},
					assignee: { type: "string" },
					priority: { type: "string" },
					title: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const { task_id: taskId, ...fields } = params;
				const id = String(taskId ?? "");
				return {
					status: "ok",
					task_id: id,
					...await runtime.objectStore.update(TASK_TYPE, id, {
						...fields,
						updated_at: (/* @__PURE__ */ new Date()).toISOString()
					})
				};
			}
		},
		{
			id: "task.list",
			verb: "retrieve",
			description: "按条件列出任务",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					status: { type: "string" },
					assignee: { type: "string" },
					limit: {
						type: "integer",
						default: 20
					}
				}
			},
			handler: async (_ctx, params) => {
				const filter = {};
				if (params.status) filter.status = params.status;
				if (params.assignee) filter.assignee = params.assignee;
				const limit = typeof params.limit === "number" ? params.limit : 20;
				const { items } = await runtime.objectStore.query(TASK_TYPE, {
					filter,
					limit
				});
				return {
					tasks: items,
					count: items.length
				};
			}
		},
		{
			id: "task.assign",
			verb: "deliver",
			description: "分配任务给用户",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["task_id", "assignee"],
				properties: {
					task_id: { type: "string" },
					assignee: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const id = String(params.task_id ?? "");
				const assignee = String(params.assignee ?? "");
				const updated = await runtime.objectStore.update(TASK_TYPE, id, {
					assignee,
					updated_at: (/* @__PURE__ */ new Date()).toISOString()
				});
				await runtime.kernel.publish("task.assigned", "task.assign", {
					task_id: id,
					assignee
				}).catch(() => void 0);
				return {
					status: "ok",
					task_id: id,
					assignee,
					...updated
				};
			}
		}
	];
}
function makeReportCapabilities(runtime) {
	const REPORT_TYPE = "report";
	return [
		{
			id: "report.generate",
			verb: "compose",
			description: "生成结构化报告（汇总数据、Playbook 运行记录等）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["title", "content"],
				properties: {
					title: { type: "string" },
					content: { type: "string" },
					report_type: { type: "string" },
					tags: {
						type: "array",
						items: { type: "string" }
					},
					source: { type: "string" }
				}
			},
			handler: async (ctx, params) => {
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const report = await runtime.objectStore.create(REPORT_TYPE, {
					title: String(params.title ?? ""),
					content: String(params.content ?? ""),
					report_type: String(params.report_type ?? "generic"),
					tags: Array.isArray(params.tags) ? params.tags : [],
					source: params.source ? String(params.source) : ctx.source ?? "system",
					status: "published",
					created_at: now
				}, ctx.stepCtx ?? {});
				await runtime.kernel.publish("report.generated", "report.generate", {
					report_id: report.id,
					title: params.title
				}).catch(() => void 0);
				return {
					status: "ok",
					report_id: report.id,
					...report
				};
			}
		},
		{
			id: "report.list",
			verb: "retrieve",
			description: "列出已生成的报告",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					report_type: { type: "string" },
					limit: {
						type: "integer",
						default: 20
					}
				}
			},
			handler: async (_ctx, params) => {
				const filter = {};
				if (params.report_type) filter.report_type = params.report_type;
				const limit = typeof params.limit === "number" ? params.limit : 20;
				const { items } = await runtime.objectStore.query(REPORT_TYPE, {
					filter,
					limit
				});
				return {
					reports: items,
					count: items.length
				};
			}
		},
		{
			id: "report.export",
			verb: "deliver",
			description: "导出报告内容（返回结构化文本）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["report_id"],
				properties: {
					report_id: { type: "string" },
					format: {
						type: "string",
						enum: [
							"text",
							"json",
							"markdown"
						],
						default: "text"
					}
				}
			},
			handler: async (_ctx, params) => {
				const reportId = String(params.report_id ?? "");
				const format = String(params.format ?? "text");
				const { items } = await runtime.objectStore.query(REPORT_TYPE, {
					filter: { id: reportId },
					limit: 1
				});
				if (items.length === 0) return {
					status: "not_found",
					report_id: reportId
				};
				const report = items[0];
				if (format === "json") return {
					status: "ok",
					report_id: reportId,
					data: report
				};
				if (format === "markdown") return {
					status: "ok",
					report_id: reportId,
					text: `# ${String(report.title ?? "Report")}\n\n${String(report.content ?? "")}`
				};
				return {
					status: "ok",
					report_id: reportId,
					text: String(report.content ?? "")
				};
			}
		}
	];
}
function makeApprovalCapabilities(runtime) {
	const APPROVAL_TYPE = "approval";
	async function triggerHitlNotify(approverIds, approvalId, title) {
		await runtime.kernel.publish("approval.hitl_requested", "approval.create", {
			approval_id: approvalId,
			title,
			approver_ids: approverIds
		}).catch(() => void 0);
	}
	return [
		{
			id: "approval.create",
			verb: "transform",
			description: "创建审批记录（写入 ObjectStore），发布 approval.created 事件并触发 HITL 通知",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: [
					"title",
					"applicant_id",
					"approver_ids"
				],
				properties: {
					title: { type: "string" },
					description: { type: "string" },
					applicant_id: { type: "string" },
					approver_ids: {
						type: "array",
						items: { type: "string" }
					},
					type: {
						type: "string",
						default: "generic"
					},
					payload: { type: "object" }
				}
			},
			handler: async (ctx, params) => {
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const approverIds = Array.isArray(params.approver_ids) ? params.approver_ids : [String(params.approver_ids ?? "")];
				const record = await runtime.objectStore.create(APPROVAL_TYPE, {
					title: String(params.title ?? ""),
					description: params.description ? String(params.description) : void 0,
					applicant_id: String(params.applicant_id ?? ""),
					approver_ids: approverIds,
					type: String(params.type ?? "generic"),
					payload: params.payload ?? {},
					status: "pending",
					created_at: now,
					updated_at: now
				}, ctx.stepCtx ?? {});
				await runtime.kernel.publish("approval.created", "approval.create", {
					approval_id: record.id,
					title: params.title,
					applicant_id: params.applicant_id,
					approver_ids: approverIds,
					status: "pending"
				}).catch(() => void 0);
				await triggerHitlNotify(approverIds, record.id, String(params.title ?? ""));
				return {
					status: "ok",
					approval_id: record.id,
					...record
				};
			}
		},
		{
			id: "approval.get",
			verb: "retrieve",
			description: "按 ID 获取审批详情",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["approval_id"],
				properties: { approval_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				const id = String(params.approval_id ?? "");
				const { items } = await runtime.objectStore.query(APPROVAL_TYPE, {
					filter: { id },
					limit: 1
				});
				if (items.length === 0) return {
					status: "not_found",
					approval_id: id
				};
				return {
					status: "ok",
					...items[0]
				};
			}
		},
		{
			id: "approval.list",
			verb: "retrieve",
			description: "列出审批记录（支持 filter: status/applicant_id/approver_id）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"pending",
							"approved",
							"rejected"
						]
					},
					applicant_id: { type: "string" },
					approver_id: { type: "string" },
					limit: {
						type: "integer",
						default: 20
					}
				}
			},
			handler: async (_ctx, params) => {
				const filter = {};
				if (params.status) filter.status = params.status;
				if (params.applicant_id) filter.applicant_id = params.applicant_id;
				const limit = typeof params.limit === "number" ? params.limit : 20;
				let { items } = await runtime.objectStore.query(APPROVAL_TYPE, {
					filter,
					limit
				});
				if (params.approver_id) {
					const aid = String(params.approver_id);
					items = items.filter((item) => {
						const ids = item.approver_ids;
						return Array.isArray(ids) && ids.includes(aid);
					});
				}
				return {
					approvals: items,
					count: items.length
				};
			}
		},
		{
			id: "approval.approve",
			verb: "transform",
			description: "审批通过（更新状态 → approved，发布 approval.approved 事件）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["approval_id"],
				properties: {
					approval_id: { type: "string" },
					comment: { type: "string" },
					approver_id: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const id = String(params.approval_id ?? "");
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const updated = await runtime.objectStore.update(APPROVAL_TYPE, id, {
					status: "approved",
					decision: "approved",
					approver_id: params.approver_id ? String(params.approver_id) : void 0,
					comment: params.comment ? String(params.comment) : void 0,
					decided_at: now,
					updated_at: now
				});
				await runtime.kernel.publish("approval.approved", "approval.approve", {
					approval_id: id,
					decision: "approved",
					approver_id: params.approver_id ?? null,
					comment: params.comment ?? null,
					...updated ?? {}
				}).catch(() => void 0);
				return {
					status: "ok",
					approval_id: id,
					decision: "approved",
					...updated
				};
			}
		},
		{
			id: "approval.reject",
			verb: "transform",
			description: "审批拒绝（更新状态 → rejected，发布 approval.rejected 事件）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["approval_id"],
				properties: {
					approval_id: { type: "string" },
					reason: { type: "string" },
					approver_id: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const id = String(params.approval_id ?? "");
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const updated = await runtime.objectStore.update(APPROVAL_TYPE, id, {
					status: "rejected",
					decision: "rejected",
					approver_id: params.approver_id ? String(params.approver_id) : void 0,
					reason: params.reason ? String(params.reason) : void 0,
					decided_at: now,
					updated_at: now
				});
				await runtime.kernel.publish("approval.rejected", "approval.reject", {
					approval_id: id,
					decision: "rejected",
					approver_id: params.approver_id ?? null,
					reason: params.reason ?? null,
					...updated ?? {}
				}).catch(() => void 0);
				return {
					status: "ok",
					approval_id: id,
					decision: "rejected",
					...updated
				};
			}
		}
	];
}
function makeWorkOrderCapabilities(runtime) {
	const WO_TYPE = "work_order";
	return [
		{
			id: "work_order.create",
			verb: "transform",
			description: "创建工单（objectStore type=work_order），创建后发布 work_order.created 事件",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["title"],
				properties: {
					title: { type: "string" },
					description: { type: "string" },
					equipment_id: { type: "string" },
					priority: {
						type: "string",
						enum: [
							"urgent",
							"high",
							"normal",
							"low"
						],
						default: "normal"
					},
					assigned_to: { type: "string" }
				}
			},
			handler: async (ctx, params) => {
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const wo = await runtime.objectStore.create(WO_TYPE, {
					title: String(params.title ?? ""),
					description: params.description ? String(params.description) : void 0,
					equipment_id: params.equipment_id ? String(params.equipment_id) : void 0,
					priority: String(params.priority ?? "normal"),
					assigned_to: params.assigned_to ? String(params.assigned_to) : void 0,
					status: "open",
					created_at: now,
					updated_at: now
				}, ctx.stepCtx ?? {});
				await runtime.kernel.publish("work_order.created", "work_order.create", {
					work_order_id: wo.id,
					title: params.title,
					equipment_id: params.equipment_id ?? null,
					priority: params.priority ?? "normal",
					assigned_to: params.assigned_to ?? null,
					status: "open"
				}).catch(() => void 0);
				return {
					status: "ok",
					work_order_id: wo.id,
					...wo
				};
			}
		},
		{
			id: "work_order.get",
			verb: "retrieve",
			description: "按 ID 获取工单详情",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["work_order_id"],
				properties: { work_order_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				const id = String(params.work_order_id ?? "");
				const { items } = await runtime.objectStore.query(WO_TYPE, {
					filter: { id },
					limit: 1
				});
				if (items.length === 0) return {
					status: "not_found",
					work_order_id: id
				};
				return {
					status: "ok",
					...items[0]
				};
			}
		},
		{
			id: "work_order.list",
			verb: "retrieve",
			description: "列出工单（filter: status/assigned_to/equipment_id）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					status: { type: "string" },
					assigned_to: { type: "string" },
					equipment_id: { type: "string" },
					limit: {
						type: "integer",
						default: 20
					}
				}
			},
			handler: async (_ctx, params) => {
				const filter = {};
				if (params.status) filter.status = params.status;
				if (params.assigned_to) filter.assigned_to = params.assigned_to;
				if (params.equipment_id) filter.equipment_id = params.equipment_id;
				const limit = typeof params.limit === "number" ? params.limit : 20;
				const { items } = await runtime.objectStore.query(WO_TYPE, {
					filter,
					limit
				});
				return {
					work_orders: items,
					count: items.length
				};
			}
		},
		{
			id: "work_order.close",
			verb: "transform",
			description: "关闭工单（更新状态 + 记录 close_reason + 写 CBR 案例）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["work_order_id"],
				properties: {
					work_order_id: { type: "string" },
					close_reason: { type: "string" },
					resolution: { type: "string" }
				}
			},
			handler: async (ctx, params) => {
				const id = String(params.work_order_id ?? "");
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const closeReason = params.close_reason ? String(params.close_reason) : "closed";
				const resolution = params.resolution ? String(params.resolution) : "";
				const updated = await runtime.objectStore.update(WO_TYPE, id, {
					status: "closed",
					close_reason: closeReason,
					resolution,
					closed_at: now,
					updated_at: now
				});
				if (resolution) runtime.cbrStore?.add(`work_order:${id}`, resolution, {
					outcome: "success",
					tags: ["work_order", "closed"],
					playbookId: ctx.stepCtx ? String(ctx.stepCtx.playbookId ?? "") : void 0
				});
				await runtime.kernel.publish("work_order.closed", "work_order.close", {
					work_order_id: id,
					close_reason: closeReason,
					resolution,
					...updated ?? {}
				}).catch(() => void 0);
				return {
					status: "ok",
					work_order_id: id,
					close_reason: closeReason,
					...updated
				};
			}
		}
	];
}
function makeAlarmCapabilities(runtime) {
	const ALARM_TYPE = "alarm";
	return [
		{
			id: "alarm.acknowledge",
			verb: "transform",
			description: "确认报警（更新 acknowledged=true），发布 alarm.acknowledged 事件",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["alarm_id"],
				properties: {
					alarm_id: { type: "string" },
					acknowledged_by: { type: "string" },
					comment: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const id = String(params.alarm_id ?? "");
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const updated = await runtime.objectStore.update(ALARM_TYPE, id, {
					acknowledged: true,
					acknowledged_by: params.acknowledged_by ? String(params.acknowledged_by) : void 0,
					acknowledged_at: now,
					ack_comment: params.comment ? String(params.comment) : void 0,
					updated_at: now
				});
				await runtime.kernel.publish("alarm.acknowledged", "alarm.acknowledge", {
					alarm_id: id,
					acknowledged: true,
					acknowledged_by: params.acknowledged_by ?? null,
					...updated ?? {}
				}).catch(() => void 0);
				return {
					status: "ok",
					alarm_id: id,
					acknowledged: true,
					...updated
				};
			}
		},
		{
			id: "alarm.list",
			verb: "retrieve",
			description: "列出报警（filter: status/equipment_id/severity）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"active",
							"acknowledged",
							"resolved"
						]
					},
					equipment_id: { type: "string" },
					severity: {
						type: "string",
						enum: [
							"critical",
							"high",
							"medium",
							"low"
						]
					},
					limit: {
						type: "integer",
						default: 20
					}
				}
			},
			handler: async (_ctx, params) => {
				const filter = {};
				if (params.status) filter.status = params.status;
				if (params.equipment_id) filter.equipment_id = params.equipment_id;
				if (params.severity) filter.severity = params.severity;
				const limit = typeof params.limit === "number" ? params.limit : 20;
				const { items } = await runtime.objectStore.query(ALARM_TYPE, {
					filter,
					limit
				});
				return {
					alarms: items,
					count: items.length
				};
			}
		},
		{
			id: "alarm.resolve",
			verb: "transform",
			description: "标记报警已解决，发布 alarm.resolved 事件",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["alarm_id"],
				properties: {
					alarm_id: { type: "string" },
					resolution: { type: "string" },
					resolved_by: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const id = String(params.alarm_id ?? "");
				const now = (/* @__PURE__ */ new Date()).toISOString();
				const updated = await runtime.objectStore.update(ALARM_TYPE, id, {
					status: "resolved",
					resolved: true,
					resolved_by: params.resolved_by ? String(params.resolved_by) : void 0,
					resolution: params.resolution ? String(params.resolution) : void 0,
					resolved_at: now,
					updated_at: now
				});
				await runtime.kernel.publish("alarm.resolved", "alarm.resolve", {
					alarm_id: id,
					resolved: true,
					resolved_by: params.resolved_by ?? null,
					resolution: params.resolution ?? null,
					...updated ?? {}
				}).catch(() => void 0);
				return {
					status: "ok",
					alarm_id: id,
					resolved: true,
					...updated
				};
			}
		}
	];
}
function makeNotifyCapabilities(runtime) {
	return [
		{
			id: "notify.dispatch",
			verb: "deliver",
			description: "核心通知路由：根据 subject/role 找到责任人，按用户偏好渠道发送（渠道无关）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["subject_type"],
				properties: {
					subject_type: {
						type: "string",
						description: "主体类型：equipment / department / role / user"
					},
					subject_id: {
						type: "string",
						description: "主体 ID（设备号、部门 ID、角色名、userId）"
					},
					priority: {
						type: "string",
						enum: [
							"low",
							"normal",
							"high",
							"critical"
						],
						default: "normal",
						description: "优先级；critical/high 向所有注册渠道发送，normal/low 只用首选渠道"
					},
					title: {
						type: "string",
						description: "通知标题（可选）"
					},
					message: {
						type: "string",
						description: "通知正文（与 card_template 二选一）"
					},
					card_template: {
						type: "string",
						enum: [
							"alarm",
							"work_order",
							"approval",
							"report",
							"health"
						],
						description: "卡片模板名称，与 card_data 配合使用（会覆盖 message）"
					},
					card_data: {
						type: "object",
						description: "传给卡片模板的字段数据"
					},
					metadata: {
						type: "object",
						description: "附加业务元数据（不显示给用户）"
					}
				}
			},
			handler: async (_ctx, params) => {
				let message = params.message ? String(params.message) : "";
				let cardPayload;
				if (params.card_template) {
					const tpl = String(params.card_template);
					const data = params.card_data ?? {};
					const cb = runtime.cardBuilder;
					if (cb) try {
						let card;
						if (tpl === "alarm") card = cb.alarm({
							alarmId: String(data.alarm_id ?? data.alarmId ?? ""),
							equipmentId: String(data.equipment_id ?? data.equipmentId ?? ""),
							severity: String(data.severity ?? "medium"),
							description: String(data.description ?? ""),
							time: data.time ? String(data.time) : void 0
						});
						else if (tpl === "work_order") card = cb.workOrder({
							id: String(data.id ?? ""),
							title: String(data.title ?? ""),
							status: String(data.status ?? "open"),
							assignee: String(data.assignee ?? ""),
							priority: String(data.priority ?? "normal"),
							equipment: data.equipment ? String(data.equipment) : void 0
						});
						else if (tpl === "approval") card = cb.approval({
							id: String(data.id ?? ""),
							title: String(data.title ?? ""),
							applicant: String(data.applicant ?? ""),
							status: String(data.status ?? "pending"),
							description: data.description ? String(data.description) : void 0
						});
						else if (tpl === "report") card = cb.report({
							title: String(data.title ?? "报告"),
							period: String(data.period ?? ""),
							metrics: Array.isArray(data.metrics) ? data.metrics : []
						});
						else if (tpl === "health") card = cb.healthStatus({
							overall: String(data.overall ?? "ok"),
							dimensions: Array.isArray(data.dimensions) ? data.dimensions : []
						});
						if (card) {
							cardPayload = { card };
							if (!message) message = cb.toPlainText(card);
						}
					} catch {}
				}
				return await runtime.notificationRouter?.dispatch({
					subjectType: String(params.subject_type ?? "user"),
					subjectId: params.subject_id ? String(params.subject_id) : void 0,
					priority: params.priority ?? "normal",
					title: params.title ? String(params.title) : void 0,
					message,
					metadata: {
						...params.metadata ?? {},
						...cardPayload
					}
				});
			}
		},
		{
			id: "notify.subscribe",
			verb: "control",
			description: "用户订阅某类事件通知，并指定接收渠道",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: [
					"user_id",
					"event_patterns",
					"channels"
				],
				properties: {
					user_id: { type: "string" },
					event_patterns: {
						type: "array",
						items: { type: "string" },
						description: "事件模式，如 ['alarm.*']"
					},
					channels: {
						type: "array",
						items: { type: "string" },
						description: "偏好渠道列表（优先级顺序）"
					}
				}
			},
			handler: async (_ctx, params) => {
				const userId = String(params.user_id ?? "");
				const patterns = Array.isArray(params.event_patterns) ? params.event_patterns : [];
				const channels = Array.isArray(params.channels) ? params.channels : [];
				const existing = runtime.notificationRouter?.getPreference(userId);
				const mergedPatterns = [...new Set([...existing?.subscriptions ?? [], ...patterns])];
				const mergedChannels = [...new Set([...channels, ...existing?.channels ?? []])];
				runtime.notificationRouter?.setPreference(userId, {
					channels: mergedChannels,
					subscriptions: mergedPatterns
				});
				return {
					status: "ok",
					user_id: userId,
					subscriptions: mergedPatterns,
					channels: mergedChannels
				};
			}
		},
		{
			id: "notify.unsubscribe",
			verb: "control",
			description: "取消用户对某类事件的订阅",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["user_id"],
				properties: {
					user_id: { type: "string" },
					event_patterns: {
						type: "array",
						items: { type: "string" },
						description: "要取消的事件模式（不填则清除所有订阅）"
					}
				}
			},
			handler: async (_ctx, params) => {
				const userId = String(params.user_id ?? "");
				const toRemove = Array.isArray(params.event_patterns) ? params.event_patterns : null;
				const existing = runtime.notificationRouter?.getPreference(userId);
				if (!existing) return {
					status: "not_found",
					user_id: userId
				};
				const subscriptions = toRemove ? existing.subscriptions.filter((s) => !toRemove.includes(s)) : [];
				runtime.notificationRouter?.setPreference(userId, { subscriptions });
				return {
					status: "ok",
					user_id: userId,
					subscriptions
				};
			}
		},
		{
			id: "notify.preferences",
			verb: "control",
			description: "查看或设置用户通知偏好（使用哪些渠道接收通知）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["user_id"],
				properties: {
					user_id: { type: "string" },
					channels: {
						type: "array",
						items: { type: "string" },
						description: "设置偏好渠道（不填则只查询）"
					}
				}
			},
			handler: async (_ctx, params) => {
				const userId = String(params.user_id ?? "");
				if (Array.isArray(params.channels)) runtime.notificationRouter?.setPreference(userId, { channels: params.channels });
				const pref = runtime.notificationRouter?.getPreference(userId);
				return pref ? {
					status: "ok",
					...pref
				} : {
					status: "not_found",
					user_id: userId,
					channels: [],
					subscriptions: []
				};
			}
		},
		{
			id: "notify.bind_subject",
			verb: "control",
			description: "绑定责任人（如：设备 E001 的负责人是张三、李四）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: [
					"subject_type",
					"subject_id",
					"user_ids"
				],
				properties: {
					subject_type: {
						type: "string",
						description: "主体类型：equipment / department / role / user"
					},
					subject_id: { type: "string" },
					user_ids: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			handler: async (_ctx, params) => {
				const subjectType = String(params.subject_type ?? "");
				const subjectId = String(params.subject_id ?? "");
				const userIds = Array.isArray(params.user_ids) ? params.user_ids : [];
				runtime.notificationRouter?.bindSubject(subjectType, subjectId, userIds);
				return {
					status: "ok",
					subject_type: subjectType,
					subject_id: subjectId,
					user_ids: userIds
				};
			}
		},
		{
			id: "notify.list_bindings",
			verb: "query",
			description: "列出所有责任人绑定关系（subject → userIds）",
			owner: { kind: "core" },
			handler: async () => {
				const bindings = runtime.notificationRouter?.listBindings() ?? [];
				return {
					bindings,
					count: bindings.length
				};
			}
		},
		{
			id: "memory.search",
			verb: "retrieve",
			description: "搜索知识库记忆，支持 namespace 过滤（system/operator/user/auto-learned/feedback）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["query"],
				properties: {
					query: { type: "string" },
					limit: {
						type: "integer",
						default: 5
					},
					namespace: {
						type: "string",
						enum: [
							"system",
							"operator",
							"user",
							"auto-learned",
							"feedback"
						],
						description: "按 namespace/tag 过滤"
					}
				}
			},
			handler: async (_ctx, params) => {
				const query = String(params.query ?? "");
				const limit = typeof params.limit === "number" ? params.limit : 5;
				const namespace = params.namespace ? String(params.namespace) : void 0;
				const results = await runtime.kb.search(query, {
					limit,
					namespace
				});
				return {
					results,
					count: results.length
				};
			}
		}
	];
}
function makeSystemCapabilities(runtime) {
	return [{
		id: "system.reload_packs",
		verb: "control",
		description: "重新加载所有 Pack 配置",
		owner: { kind: "core" },
		handler: async () => {
			try {
				await runtime.kernel.publish("system.packs_reloaded", "system.reload_packs", { reloaded_at: (/* @__PURE__ */ new Date()).toISOString() }).catch(() => void 0);
				const loaderAny = runtime.packLoader;
				if (typeof loaderAny.reload === "function") await loaderAny.reload();
				return {
					status: "ok",
					reloaded_at: (/* @__PURE__ */ new Date()).toISOString()
				};
			} catch (err) {
				return {
					status: "error",
					reason: err instanceof Error ? err.message : String(err)
				};
			}
		}
	}, {
		id: "health.check",
		verb: "query",
		description: "检查系统整体健康状态",
		owner: { kind: "core" },
		handler: async () => {
			const components = {};
			try {
				runtime.db.prepare("SELECT 1").get();
				components.db = "ok";
			} catch {
				components.db = "error";
			}
			components.kernel = "ok";
			components.playbooks = `${runtime.playbookEngine.list().length} loaded`;
			components.capabilities = `${runtime.capabilities.list().length} registered`;
			return {
				overall: Object.values(components).every((v) => v === "ok" || v.endsWith("loaded") || v.endsWith("registered")) ? "ok" : "degraded",
				components,
				checked_at: (/* @__PURE__ */ new Date()).toISOString()
			};
		}
	}];
}
function makeSkillCapabilities(runtime) {
	return [{
		id: "skill.execute",
		verb: "execute",
		description: "执行一个 Skill（纯脚本能力，完全不依赖 LLM）。Playbook action 步骤可调用。",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["skill_id"],
			properties: { skill_id: {
				type: "string",
				description: "Skill ID"
			} }
		},
		handler: async (_ctx, params) => {
			const skillId = String(params.skill_id ?? "");
			if (!skillId) return {
				status: "error",
				reason: "skill_id 参数缺失"
			};
			if (!runtime.skillLibrary?.get(skillId)) return {
				status: "not_found",
				skill_id: skillId
			};
			const { skill_id: _, ...skillParams } = params;
			try {
				return {
					status: "ok",
					...await runtime.skillLibrary?.invoke(skillId, skillParams)
				};
			} catch (err) {
				return {
					status: "error",
					skill_id: skillId,
					reason: err instanceof Error ? err.message : String(err)
				};
			}
		}
	}, {
		id: "skill.list",
		verb: "query",
		description: "列出所有已注册的 Skill（含内置和 Pack 注册的 Skill）",
		owner: { kind: "core" },
		handler: async () => {
			const skills = (runtime.skillLibrary?.list() ?? []).map((s) => ({
				id: s.id,
				name: s.name,
				description: s.description
			}));
			return {
				skills,
				count: skills.length
			};
		}
	}];
}
function makeRuleCapabilities(runtime) {
	return [
		{
			id: "rule.evaluate",
			verb: "query",
			description: "执行决策表，对上下文数据匹配 if-then 规则，完全不依赖 LLM。弱模型补偿核心能力。",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["table_id", "context"],
				properties: {
					table_id: {
						type: "string",
						description: "决策表 ID"
					},
					context: {
						type: "object",
						description: "待匹配的上下文数据"
					}
				}
			},
			handler: async (_ctx, params) => {
				const tableId = String(params.table_id ?? "");
				const context = params.context ?? {};
				if (!tableId) return {
					status: "error",
					reason: "table_id 参数缺失"
				};
				try {
					return {
						status: "ok",
						...await runtime.ruleEngine?.evaluate(tableId, context)
					};
				} catch (err) {
					return {
						status: "error",
						table_id: tableId,
						reason: err instanceof Error ? err.message : String(err)
					};
				}
			}
		},
		{
			id: "rule.register",
			verb: "execute",
			description: "动态注册一张决策表（Pack 可在启动时注册自定义规则）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["table"],
				properties: { table: {
					type: "object",
					description: "DecisionTable 对象"
				} }
			},
			handler: async (_ctx, params) => {
				const table = params.table;
				if (!table?.id || !table.name || !Array.isArray(table.rules)) return {
					status: "error",
					reason: "table 参数无效：需要 id, name, rules[]"
				};
				runtime.ruleEngine?.registerTable?.(table);
				return {
					status: "ok",
					table_id: table.id,
					rules_count: table.rules.length
				};
			}
		},
		{
			id: "rule.list",
			verb: "query",
			description: "列出所有已注册的决策表",
			owner: { kind: "core" },
			handler: async () => {
				const tables = runtime.ruleEngine?.listTables?.()?.map((t) => ({
					id: t.id,
					name: t.name,
					description: t.description,
					rules_count: t.rules.length
				})) ?? [];
				return {
					tables,
					count: tables.length
				};
			}
		}
	];
}
function makeGovernanceCapabilities(runtime) {
	return [
		{
			id: "audit.query",
			verb: "retrieve",
			description: "查询审计日志（按 capability_id / 时间范围 / actor 过滤）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					capability_id: {
						type: "string",
						description: "能力 ID 过滤（支持前缀匹配）"
					},
					since_hours: {
						type: "number",
						default: 24,
						description: "过去 N 小时内"
					},
					actor: {
						type: "string",
						description: "触发者 ID 过滤"
					},
					limit: {
						type: "integer",
						default: 50
					}
				}
			},
			handler: async (_ctx, params) => {
				const sinceHours = typeof params.since_hours === "number" ? params.since_hours : 24;
				const limit = typeof params.limit === "number" ? params.limit : 50;
				const capabilityId = params.capability_id ? String(params.capability_id) : void 0;
				const actor = params.actor ? String(params.actor) : void 0;
				let filtered = (await runtime.kernel.bus.query({
					from: /* @__PURE__ */ new Date(Date.now() - sinceHours * 36e5),
					limit: limit * 3
				})).filter((e) => e.type.startsWith("capability.") || e.type.startsWith("audit.") || e.type.startsWith("constitution.") || e.type.startsWith("hitl."));
				if (capabilityId) filtered = filtered.filter((e) => {
					const p = e.payload;
					return String(p.capability_id ?? p.id ?? "").startsWith(capabilityId);
				});
				if (actor) filtered = filtered.filter((e) => {
					const p = e.payload;
					return String(p.actor ?? p.source ?? e.source ?? "").includes(actor);
				});
				return {
					results: filtered.slice(0, limit).map((e) => ({
						id: e.id,
						type: e.type,
						source: e.source,
						timestamp: e.timestamp,
						payload: e.payload
					})),
					count: filtered.length,
					since_hours: sinceHours
				};
			}
		},
		{
			id: "governance.circuit_breaker_status",
			verb: "query",
			description: "查看所有能力熔断器状态（open/half-open/closed），运维排查用",
			owner: { kind: "core" },
			handler: async () => {
				const breakers = runtime.capabilities.listCircuitBreakers?.() ?? [];
				const now = Date.now();
				const active = breakers.filter((b) => b.state !== "closed");
				return {
					circuit_breakers: breakers,
					active_count: active.length,
					open: active.filter((b) => b.state === "open").map((b) => ({
						...b,
						reopens_in_ms: b.openUntil ? Math.max(0, b.openUntil - now) : 0
					})),
					half_open: active.filter((b) => b.state === "half-open")
				};
			}
		},
		{
			id: "governance.reset_circuit_breaker",
			verb: "control",
			description: "手动重置某个能力的熔断器（运维用途，需要 HITL）",
			owner: { kind: "core" },
			rbac: {
				decision: "hitl_required",
				reason: "重置熔断器是运维操作，需要确认"
			},
			paramsSchema: {
				type: "object",
				required: ["capability_id"],
				properties: { capability_id: {
					type: "string",
					description: "要重置的能力 ID"
				} }
			},
			handler: async (_ctx, params) => {
				const id = String(params.capability_id ?? "");
				runtime.capabilities.resetCircuitBreaker?.(id);
				return {
					status: "ok",
					capability_id: id,
					message: `熔断器已重置`
				};
			}
		}
	];
}
function registerExtensionCapabilities(runtime, constitution) {
	const all = [
		...makeReasoningCapabilities(runtime),
		...makeMemoryCapabilities(runtime),
		...makeCommsCapabilities(runtime),
		...makeA2aCapabilities(runtime),
		...makePackCapabilities(runtime),
		...makeConnectorCapabilities(runtime),
		...makeScheduleCapabilities(runtime),
		...makeMonitorCapabilities(runtime),
		...makeNexusCapabilities(runtime),
		...makeGuideCapabilities(runtime),
		...makeConstitutionCapabilities(runtime, constitution),
		...makeContextCapabilities(runtime),
		...makeCbrCapabilities(runtime),
		...makeHookCapabilities(runtime),
		...makeProviderCapabilities(runtime),
		...makeTaskManagementCapabilities(runtime),
		...makeReportCapabilities(runtime),
		...makeApprovalCapabilities(runtime),
		...makeWorkOrderCapabilities(runtime),
		...makeAlarmCapabilities(runtime),
		...makeNotifyCapabilities(runtime),
		...makeSystemCapabilities(runtime),
		...makeSkillCapabilities(runtime),
		...makeRuleCapabilities(runtime),
		...makeGovernanceCapabilities(runtime),
		...makeSecurityCapabilities(runtime),
		...makeScaffoldCapabilities(runtime),
		...makeLearningCapabilities(runtime),
		...makeEvolveCapabilities(runtime),
		...makeResearchCapabilities(runtime),
		...makeAgentOrchCapabilities(runtime)
	];
	runtime.capabilities.registerAll(all);
}
function makeSecurityCapabilities(runtime) {
	return [
		{
			id: "security.audit_log",
			verb: "query",
			description: "查询安全审计日志（RBAC 拒绝、认证失败等事件）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					limit: {
						type: "integer",
						default: 50
					},
					event_type: { type: "string" }
				}
			},
			handler: async (_ctx, params) => {
				const limit = typeof params.limit === "number" ? params.limit : 50;
				try {
					const rows = runtime.db.prepare("SELECT id, type, source, payload, timestamp FROM cw_events WHERE type LIKE 'rbac.%' OR type LIKE 'security.%' OR type LIKE 'auth.%' ORDER BY timestamp DESC LIMIT ?").all(limit);
					return {
						events: rows.map((r) => ({
							id: r.id,
							type: r.type,
							source: r.source,
							payload: (() => {
								try {
									return JSON.parse(r.payload);
								} catch {
									return r.payload;
								}
							})(),
							timestamp: new Date(r.timestamp).toISOString()
						})),
						count: rows.length
					};
				} catch {
					return {
						events: [],
						count: 0,
						note: "audit table query failed"
					};
				}
			}
		},
		{
			id: "security.api_key_status",
			verb: "query",
			description: "查询 API Key 配置状态（不返回实际 Key）",
			owner: { kind: "core" },
			handler: async () => {
				const hasKey = !!runtime.config.api?.api_key?.trim();
				const required = runtime.config.api?.require_api_key === true || runtime.config.security?.require_api_key === true || process.env.CLAWORKS_REQUIRE_API_KEY === "1";
				const envKeySet = !!process.env.CLAWORKS_API_KEY?.trim();
				return {
					api_key_configured: hasKey || envKeySet,
					api_key_required: required,
					source: envKeySet ? "env" : hasKey ? "config" : "none"
				};
			}
		},
		{
			id: "security.rate_limit_status",
			verb: "query",
			description: "查询当前速率限制配置与状态",
			owner: { kind: "core" },
			handler: async () => {
				const rl = runtime.rateLimiter;
				return {
					max_requests_per_minute: (process.env.CLAWORKS_RATE_LIMIT_PER_MIN ? Number.parseInt(process.env.CLAWORKS_RATE_LIMIT_PER_MIN, 10) : void 0) ?? runtime.config.kernel?.rate_limit_max_requests ?? 120,
					window_ms: runtime.config.kernel?.rate_limit_window_ms ?? 6e4,
					active_buckets: rl?.size?.() ?? 0,
					env_override: !!process.env.CLAWORKS_RATE_LIMIT_PER_MIN
				};
			}
		},
		{
			id: "observe.playbook_runs",
			verb: "query",
			description: "查看当前正在运行（或最近完成）的 Playbook 列表",
			owner: { kind: "core" },
			handler: async () => {
				const active = (await runtime.playbookEngine.listRuns({ limit: 50 })).filter((r) => r.status === "running" || r.status === "waiting_hitl");
				return {
					count: active.length,
					runs: active.map((r) => ({
						id: r.id,
						playbook: r.playbookId,
						status: r.status,
						started_at: r.startedAt,
						elapsed_ms: Date.now() - new Date(r.startedAt).getTime()
					}))
				};
			}
		},
		{
			id: "observe.event_log",
			verb: "query",
			description: "查看最近发布到 EventKernel 的事件日志（环形缓冲，最多 200 条）",
			owner: { kind: "core" },
			handler: async (_ctx, params) => {
				const limit = typeof params?.limit === "number" ? params.limit : 20;
				const eventType = params?.event_type ? String(params.event_type) : void 0;
				const log = runtime.kernel.getRecentEvents(limit, eventType);
				return {
					count: log.length,
					events: log.map((e) => ({
						type: e.type,
						source: e.source,
						ts: e.ts.toISOString()
					}))
				};
			}
		},
		{
			id: "observe.capability_stats",
			verb: "query",
			description: "统计最近能力调用次数（从 EventKernel 环形缓冲提取 capability.called.* 事件）",
			owner: { kind: "core" },
			handler: async () => {
				const recentEvents = runtime.kernel.getRecentEvents(200);
				const stats = {};
				for (const e of recentEvents) if (e.type.startsWith("capability.called.")) {
					const capId = e.type.slice(18);
					if (!stats[capId]) stats[capId] = { calls: 0 };
					stats[capId].calls++;
					stats[capId].last_called = e.ts.toISOString();
				}
				return {
					stats,
					total_recent_events: recentEvents.length,
					period: "最近 200 个事件",
					tracked_capabilities: Object.keys(stats).length
				};
			}
		},
		{
			id: "observe.robot_status",
			verb: "query",
			description: "获取机器人整体运行状态：健康度、活跃任务数、知识库规模、已注册能力数、上线时长",
			owner: { kind: "core" },
			handler: async (ctx) => {
				const [healthResult, kbStatusResult, runsResult] = await Promise.allSettled([
					runtime.capabilities.invoke("health.check", ctx, {}),
					runtime.capabilities.invoke("kb.status", ctx, {}),
					runtime.capabilities.invoke("observe.playbook_runs", ctx, {})
				]);
				const health = healthResult.status === "fulfilled" ? healthResult.value : {};
				const kbStatus = kbStatusResult.status === "fulfilled" ? kbStatusResult.value : {};
				const runs = runsResult.status === "fulfilled" ? runsResult.value : { count: 0 };
				const runtimeAny = runtime;
				const uptimeSeconds = runtimeAny.startTime ? Math.floor((Date.now() - runtimeAny.startTime) / 1e3) : 0;
				return {
					robot_name: runtime.identity?.name ?? "ClaWorks",
					robot_id: runtime.robot?.id ?? "unknown",
					uptime_seconds: uptimeSeconds,
					health: health.overall ?? "unknown",
					active_playbooks: runs.count ?? 0,
					kb_entries: kbStatus.entry_count ?? 0,
					capabilities_registered: runtime.capabilities.list().length,
					loaded_packs: runtime.loadedPacks.length
				};
			}
		}
	];
}
function makeScaffoldCapabilities(runtime) {
	return [
		{
			id: "scaffold.generate_domain",
			verb: "execute",
			description: "调用强模型为指定领域预生成意图分类模板、快速路由决策表，提升弱模型执行质量（适合初始化/低峰时段调用）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["domain"],
				properties: {
					domain: {
						type: "string",
						description: "领域标签，如 industrial / oa / retail"
					},
					context: {
						type: "string",
						description: "领域背景描述，帮助强模型生成更准确的模板"
					}
				}
			},
			handler: async (_ctx, params) => {
				const domain = String(params.domain ?? "general");
				const context = String(params.context ?? "");
				const engine = runtime.scaffoldEngine;
				if (!engine) return {
					status: "unavailable",
					reason: "ScaffoldEngine 未初始化"
				};
				return {
					domain,
					generated: await engine.generateDomainScaffold(domain, context),
					status: "deployed"
				};
			}
		},
		{
			id: "scaffold.generate_prompt",
			verb: "execute",
			description: "调用强模型生成少样本提示词模板，针对特定任务类型优化弱模型输出精度，完成后自动注册到 promptRegistry",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["task_type"],
				properties: {
					task_type: {
						type: "string",
						description: "任务类型，如 intent_classify / alarm_diagnose"
					},
					examples: {
						type: "array",
						items: { type: "string" },
						description: "典型示例列表"
					},
					output_schema: {
						type: "object",
						description: "期望输出的 JSON Schema"
					}
				}
			},
			handler: async (_ctx, params) => {
				const taskType = String(params.task_type ?? "");
				const examples = Array.isArray(params.examples) ? params.examples : [];
				const outputSchema = params.output_schema;
				const engine = runtime.scaffoldEngine;
				if (!engine) return {
					status: "unavailable",
					reason: "ScaffoldEngine 未初始化"
				};
				const asset = await engine.generatePromptTemplate(taskType, examples, { outputSchema });
				await engine.deploy(asset);
				return {
					asset_id: asset.id,
					task_type: asset.task_type,
					status: "deployed"
				};
			}
		},
		{
			id: "scaffold.generate_decision_table",
			verb: "execute",
			description: "从示例中提炼确定性规则，生成零 LLM 调用的决策表，避免重复调用弱模型处理可规则化的判断",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["scenario"],
				properties: {
					scenario: {
						type: "string",
						description: "场景描述，如 '报警路由' / '工单优先级分配'"
					},
					examples: {
						type: "array",
						description: "示例列表，每条含 input 和 output",
						items: { type: "object" }
					}
				}
			},
			handler: async (_ctx, params) => {
				const scenario = String(params.scenario ?? "");
				const examples = Array.isArray(params.examples) ? params.examples : [];
				const engine = runtime.scaffoldEngine;
				if (!engine) return {
					status: "unavailable",
					reason: "ScaffoldEngine 未初始化"
				};
				return {
					asset_id: (await engine.generateDecisionTable(scenario, examples)).id,
					scenario,
					status: "generated"
				};
			}
		},
		{
			id: "scaffold.list",
			verb: "query",
			description: "查看所有已预生成的脚手架资产（Prompt 模板、决策表、Skill 脚本），含使用率和成功率统计",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					type: {
						type: "string",
						description: "资产类型过滤：prompt_template / decision_table / skill_script"
					},
					domain: {
						type: "string",
						description: "领域过滤"
					}
				}
			},
			handler: async (_ctx, params) => {
				const engine = runtime.scaffoldEngine;
				if (!engine) return {
					assets: [],
					count: 0,
					status: "unavailable"
				};
				const typeFilter = params.type ? String(params.type) : void 0;
				const domainFilter = params.domain ? String(params.domain) : void 0;
				const assets = engine.list({
					type: typeFilter,
					domain: domainFilter
				});
				return {
					assets: assets.map((a) => ({
						id: a.id,
						type: a.type,
						name: a.name,
						domain: a.domain,
						task_type: a.task_type,
						generated_by: a.generated_by,
						validated: a.validated,
						usage_count: a.usage_count,
						success_rate: a.success_rate
					})),
					count: assets.length
				};
			}
		}
	];
}
function makeLearningCapabilities(runtime) {
	return [
		{
			id: "learn.from_interaction",
			verb: "execute",
			description: "将一次成功的用户交互（输入→意图→响应→反馈）存入 CBR 案例库和 KB，供弱模型后续直接命中",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["input", "response"],
				properties: {
					input: {
						type: "string",
						description: "用户原始输入"
					},
					intent: {
						type: "string",
						description: "识别到的意图"
					},
					response: {
						type: "string",
						description: "机器人的成功回复"
					},
					feedback_score: {
						type: "number",
						description: "用户反馈评分 0-1，默认 0.8"
					}
				}
			},
			handler: async (_ctx, params) => {
				const input = String(params.input ?? "");
				const intent = String(params.intent ?? "unknown");
				const response = String(params.response ?? "");
				const score = typeof params.feedback_score === "number" ? params.feedback_score : .8;
				const results = [];
				if (runtime.cbrStore) try {
					runtime.cbrStore.add({
						problem: input,
						solution: response,
						intent
					}, void 0, {
						source: "interaction_learning",
						intent,
						score
					});
					results.push("cbr");
				} catch {}
				try {
					await runtime.kb.add?.({
						id: `learned-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
						content: `用户问：${input}\n成功回复：${response}`,
						source: "interaction_learning"
					});
					results.push("kb");
				} catch {}
				if (runtime.scaffoldEngine && intent) {
					const scaffoldId = `scaffold-intent-${intent}`;
					runtime.scaffoldEngine.recordUsage(scaffoldId, score >= .7);
				}
				return {
					learned: true,
					stored_in: results,
					intent,
					score
				};
			}
		},
		{
			id: "learn.batch_from_history",
			verb: "execute",
			description: "扫描历史对话记录，批量写入 KB 和 CBR 案例库，让弱模型积累经验以减少重复 LLM 调用",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					limit: {
						type: "number",
						description: "处理的最大会话数量，默认 50"
					},
					min_score: {
						type: "number",
						description: "最低质量评分，低于此值跳过，默认 0.7"
					}
				}
			},
			handler: async (_ctx, params) => {
				const limit = typeof params.limit === "number" ? params.limit : 50;
				const minScore = typeof params.min_score === "number" ? params.min_score : .7;
				const contextEngine = runtime.contextEngine;
				if (!contextEngine) return {
					learned: 0,
					status: "no_context_engine"
				};
				const sessions = [];
				if (typeof contextEngine.listSessions === "function") {
					const listed = contextEngine.listSessions();
					sessions.push(...listed.slice(0, limit));
				}
				let learned = 0;
				for (const sessionId of sessions) try {
					const messages = contextEngine.getRecent(sessionId, 10);
					if (messages.length < 2) continue;
					const text = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
					await runtime.kb.add?.({
						id: `history-${sessionId}-${Date.now()}`,
						content: text,
						source: "history_learning"
					});
					learned++;
				} catch {}
				return {
					learned,
					sessions_processed: sessions.length,
					min_score: minScore
				};
			}
		},
		{
			id: "learn.record_success",
			verb: "execute",
			description: "标记某次脚手架资产调用为成功/失败，用于更新成功率统计，指导后续资产优化",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["asset_id", "success"],
				properties: {
					asset_id: {
						type: "string",
						description: "脚手架资产 ID"
					},
					success: {
						type: "boolean",
						description: "是否成功"
					}
				}
			},
			handler: async (_ctx, params) => {
				const assetId = String(params.asset_id ?? "");
				const success = Boolean(params.success);
				runtime.scaffoldEngine?.recordUsage(assetId, success);
				return {
					recorded: true,
					asset_id: assetId,
					success
				};
			}
		}
	];
}
function makeResearchCapabilities(runtime) {
	return [
		{
			id: "research.query",
			verb: "acquire",
			description: "从 KB / 网络 / 事件日志并行搜索，LLM 综合分析，返回研究结论",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["query"],
				properties: {
					query: {
						type: "string",
						description: "研究问题"
					},
					sources: {
						type: "array",
						items: {
							type: "string",
							enum: [
								"kb",
								"web",
								"events"
							]
						},
						description: "数据来源，默认 [\"kb\",\"web\"]"
					},
					depth: {
						type: "string",
						enum: ["quick", "thorough"],
						description: "搜索深度"
					},
					save_to_kb: {
						type: "boolean",
						description: "是否将结论写回知识库"
					}
				}
			},
			handler: async (_ctx, params) => {
				const agent = runtime.researchAgent;
				if (!agent) return { error: "ResearchAgent 未初始化" };
				const { query, sources, depth, save_to_kb } = params;
				return await agent.research({
					query,
					sources,
					depth,
					save_to_kb
				});
			}
		},
		{
			id: "research.monitor",
			verb: "execute",
			description: "持续监控话题，定期搜索并发布 research.monitor_update 事件",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["topic"],
				properties: {
					topic: {
						type: "string",
						description: "监控话题"
					},
					interval_hours: {
						type: "number",
						description: "监控间隔小时数，默认 6"
					}
				}
			},
			handler: async (_ctx, params) => {
				const agent = runtime.researchAgent;
				if (!agent) return { error: "ResearchAgent 未初始化" };
				const { topic, interval_hours = 6 } = params;
				return {
					monitor_id: await agent.monitor(topic, interval_hours),
					topic,
					interval_hours
				};
			}
		},
		{
			id: "research.stop_monitor",
			verb: "execute",
			description: "停止话题监控",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["monitor_id"],
				properties: { monitor_id: { type: "string" } }
			},
			handler: async (_ctx, params) => {
				runtime.researchAgent?.stopMonitor(String(params.monitor_id ?? ""));
				return { stopped: true };
			}
		}
	];
}
function makeAgentOrchCapabilities(runtime) {
	return [
		{
			id: "agent.react",
			verb: "execute",
			description: "ReAct 模式：LLM 自主决策工具调用，迭代执行直到目标完成（安全白名单保护）",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["goal"],
				properties: {
					goal: {
						type: "string",
						description: "智能体执行目标"
					},
					tools: {
						type: "array",
						items: { type: "string" },
						description: "允许使用的能力 ID 白名单"
					},
					max_iterations: {
						type: "integer",
						description: "最大迭代次数，默认 5"
					}
				}
			},
			handler: async (ctx, params) => {
				const { runReact } = await import("./react-executor-DQCGQHhF.mjs");
				const { goal, tools = [], max_iterations = 5 } = params;
				return await runReact(goal, tools, max_iterations, runtime, {
					sessionId: ctx.sessionId ?? "agent-react",
					userId: ctx.userId ?? "system",
					source: "agent.react"
				});
			}
		},
		{
			id: "agent.plan",
			verb: "acquire",
			description: "将复杂目标分解为可并行执行的子任务列表",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				required: ["goal"],
				properties: { goal: {
					type: "string",
					description: "需要分解的复杂目标"
				} }
			},
			handler: async (_ctx, params) => {
				const llm = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;
				if (!llm) return {
					goal: params.goal,
					subtasks: [],
					count: 0,
					error: "LLM 未配置"
				};
				const caps = runtime.capabilities.list().slice(0, 30).map((c) => c.id);
				const m = (await llm({ prompt: `将目标分解为并行子任务：${params.goal}\n可用能力：${caps.join(", ")}\n返回JSON数组：[{"task":"子任务","capability":"能力ID","params":{}}]` })).text.match(/\[[\s\S]*\]/);
				const subtasks = m ? (() => {
					try {
						return JSON.parse(m[0]);
					} catch {
						return [];
					}
				})() : [];
				return {
					goal: params.goal,
					subtasks,
					count: subtasks.length
				};
			}
		},
		{
			id: "agent.spawn",
			verb: "execute",
			description: "后台异步执行子任务（能力调用或 ReAct 循环），通过 agent.task_completed 事件返回结果",
			owner: { kind: "core" },
			paramsSchema: {
				type: "object",
				properties: {
					task_id: {
						type: "string",
						description: "任务 ID，不填则自动生成"
					},
					capability: {
						type: "string",
						description: "直接调用的能力 ID（二选一）"
					},
					capability_params: {
						type: "object",
						description: "能力参数"
					},
					react_goal: {
						type: "string",
						description: "ReAct 目标（二选一）"
					},
					tools: {
						type: "array",
						items: { type: "string" },
						description: "ReAct 工具白名单"
					},
					max_iterations: {
						type: "integer",
						description: "ReAct 最大迭代次数"
					}
				}
			},
			handler: async (ctx, params) => {
				const { task_id = `task-${Date.now()}`, capability, capability_params, react_goal, tools = [], max_iterations = 3 } = params;
				const spawnCtx = {
					sessionId: ctx.sessionId ?? "agent-spawn",
					userId: ctx.userId ?? "system",
					source: "agent.spawn",
					invoke: async (capId, p) => runtime.capabilities.invoke(capId, {
						source: "agent.spawn",
						invoke: async () => ({})
					}, p)
				};
				(async () => {
					try {
						let result;
						if (react_goal) {
							const { runReact } = await import("./react-executor-DQCGQHhF.mjs");
							result = await runReact(react_goal, tools, max_iterations, runtime, spawnCtx);
						} else if (capability) result = await runtime.capabilities.invoke(capability, spawnCtx, capability_params ?? {});
						await runtime.kernel.publish("agent.task_completed", "agent-spawn", {
							task_id,
							result
						});
					} catch (e) {
						await runtime.kernel.publish("agent.task_failed", "agent-spawn", {
							task_id,
							error: e instanceof Error ? e.message : String(e)
						}).catch(() => {});
					}
				})();
				return {
					task_id,
					status: "spawned"
				};
			}
		}
	];
}
function makeEvolveCapabilities(runtime) {
	return [{
		id: "evolve.prepare_domain",
		verb: "execute",
		description: "调用强模型为新领域预生成全套脚手架（Playbook/Prompt/Rule），之后弱模型可直接使用，无需推理",
		owner: { kind: "core" },
		paramsSchema: {
			type: "object",
			required: ["domain"],
			properties: {
				domain: {
					type: "string",
					description: "目标领域，如 industrial / retail / healthcare"
				},
				description: {
					type: "string",
					description: "领域详细描述，帮助强模型理解业务场景"
				},
				examples: {
					type: "array",
					items: { type: "object" },
					description: "典型输入输出示例，用于生成决策表"
				}
			}
		},
		handler: async (_ctx, params) => {
			const domain = String(params.domain ?? "general");
			const description = String(params.description ?? "");
			const examples = Array.isArray(params.examples) ? params.examples : [];
			const engine = runtime.scaffoldEngine;
			if (!engine) return {
				status: "unavailable",
				reason: "ScaffoldEngine 未初始化"
			};
			const scaffolds = await engine.generateDomainScaffold(domain, description);
			let decisionTable = null;
			if (examples.length > 0) {
				const dt = await engine.generateDecisionTable(`${domain}.intent_routing`, examples);
				await engine.deploy(dt);
				decisionTable = {
					id: dt.id,
					rules_count: (() => {
						try {
							return JSON.parse(dt.content).rules?.length ?? 0;
						} catch {
							return 0;
						}
					})()
				};
			}
			return {
				domain,
				scaffolds_generated: scaffolds,
				decision_table: decisionTable,
				status: "ready",
				note: "弱模型现可使用预制资源，无需自由推理"
			};
		}
	}, {
		id: "evolve.scaffold_status",
		verb: "query",
		description: "查看所有领域的脚手架预热状态和弱模型补偿覆盖率",
		owner: { kind: "core" },
		handler: async () => {
			const engine = runtime.scaffoldEngine;
			if (!engine) return {
				status: "unavailable",
				domains: [],
				total_assets: 0
			};
			const all = engine.list();
			const byDomain = /* @__PURE__ */ new Map();
			for (const a of all) {
				const d = a.domain ?? "general";
				byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
			}
			return {
				status: "ok",
				domains: [...byDomain.entries()].map(([domain, count]) => ({
					domain,
					asset_count: count
				})),
				total_assets: all.length,
				validated: all.filter((a) => a.validated).length,
				avg_success_rate: all.length > 0 ? (all.reduce((s, a) => s + a.success_rate, 0) / all.length).toFixed(3) : "N/A"
			};
		}
	}];
}
//#endregion
//#region src/kernel/robot-constitution-v2.ts
/**
* robot-constitution-v2.ts — ClaWorks 四层行为准则体系
*
* 参照 OpenClaw constitution 体系，扩展为四个层级：
*
*   Tier 0: IMMUTABLE（硬编码，代码中不可修改）
*     - 不泄露凭据
*     - 不冒充人类
*     - 不在无确认的情况下删除数据
*     - 所有对外通信必须标识为机器人
*     - 这些规则是机器人的「道德底线」
*
*   Tier 1: OPERATOR（运营商配置，在 claworks.json 中设置）
*     - 哪些能力需要 HITL
*     - 信任来源列表
*     - 速率限制
*     - 机器人角色范围
*
*   Tier 2: USER（用户运行时设置，存储在 ObjectStore）
*     - 个人偏好
*     - 自定义权限
*     - 风格偏好
*     - 通知渠道偏好
*
*   Tier 3: LEARNED（可进化，通过反馈循环更新）
*     - 响应格式偏好
*     - 优先级调整
*     - 行为微调
*     - 注意：安全规则不在此层
*
* 与 OpenClaw 对应：
*   Tier 0 ↔ 硬编码的 Gateway 鉴权规则
*   Tier 1 ↔ operator-scopes + DEFAULT_ROBOT_CONSTITUTION
*   Tier 2 ↔ PluginSessionExtension（用户状态）
*   Tier 3 ↔ memory/kb-backed behavioral evolution
*/
const IMMUTABLE_RULES = {
	denyAlways: [
		"credential.export",
		"credential.share",
		"data.delete_all",
		"production.modify_unconfirmed",
		"identity.impersonate_human",
		"llm.inject_system_prompt"
	],
	requireHitlAlways: [
		"data.delete_production",
		"config.security_change",
		"pack.uninstall",
		"constitution.modify_tier0"
	],
	identity: {
		mustIdentifyAsRobot: true,
		cannotClaimHuman: true,
		mustRevealCapabilitiesOnRequest: true,
		ownerInstructionsPriority: "highest",
		cannotDenyBeingRobot: true
	},
	roleAccess: {
		owner: {
			description: "主人/管理员——所有合法能力均可使用，指令优先级最高",
			canModifyConfig: true,
			canAddRelations: true,
			canReadAllInfo: true
		},
		admin: {
			description: "管理员——可执行日常业务操作，不能修改系统安全配置",
			canModifyConfig: false,
			canAddRelations: true,
			canReadAllInfo: true
		},
		operator: {
			description: "操作员——可执行日常业务操作，不能修改系统配置或安全设置",
			canModifyConfig: false,
			canAddRelations: false,
			canReadAllInfo: false
		},
		guest: {
			description: "访客——只能查询，不能创建/修改任何数据",
			canModifyConfig: false,
			canAddRelations: false,
			canReadAllInfo: false,
			readOnly: true
		}
	}
};
const DEFAULT_OPERATOR_CONSTITUTION = {
	autoAllow: [
		"system.*",
		"environment.*",
		"kb.search",
		"kb.status",
		"memory.recall",
		"task.status",
		"object.query",
		"event.publish:system.*",
		"autonomy.*",
		"perceive.*",
		"reasoning.think",
		"reasoning.decompose",
		"reasoning.evaluate",
		"guide.*",
		"connector.list",
		"connector.status",
		"pack.list",
		"nexus.search",
		"a2a.discover",
		"schedule.list",
		"monitor.status",
		"robot.*",
		"health.check"
	],
	hitlRequired: [
		"object.create",
		"object.update",
		"comms.broadcast",
		"a2a.delegate",
		"pack.install",
		"connector.invoke",
		"schedule.add",
		"evolve.write_playbook",
		"kb.ingest",
		"learn.from_feedback"
	],
	deny: [
		"data.delete_all",
		"credential.*",
		"identity.impersonate_human"
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
		"a2a",
		"autonomy-engine",
		"scheduler"
	],
	dedupWindowMs: 6e4,
	rateLimit: 0
};
function matchesPattern(pattern, value) {
	if (pattern === value) return true;
	if (pattern.endsWith(".*")) {
		const prefix = pattern.slice(0, -2);
		return value === prefix || value.startsWith(`${prefix}.`);
	}
	if (pattern.includes("*")) return new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$").test(value);
	return false;
}
function createConstitutionV2(operator = {}) {
	const op = {
		...DEFAULT_OPERATOR_CONSTITUTION,
		...operator,
		autoAllow: [...operator.autoAllow ?? DEFAULT_OPERATOR_CONSTITUTION.autoAllow],
		hitlRequired: [...operator.hitlRequired ?? DEFAULT_OPERATOR_CONSTITUTION.hitlRequired],
		deny: [...operator.deny ?? DEFAULT_OPERATOR_CONSTITUTION.deny],
		trustedSources: [...new Set([...DEFAULT_OPERATOR_CONSTITUTION.trustedSources, ...operator.trustedSources ?? []])]
	};
	const userRules = /* @__PURE__ */ new Map();
	const learnedRules = /* @__PURE__ */ new Map();
	return {
		check(capabilityId, opts = {}) {
			if (IMMUTABLE_RULES.denyAlways.some((p) => matchesPattern(p, capabilityId))) return {
				action: "deny",
				tier: 0,
				reason: "Immutable rule: always denied"
			};
			if (IMMUTABLE_RULES.requireHitlAlways.some((p) => matchesPattern(p, capabilityId))) return {
				action: "hitl_required",
				tier: 0,
				reason: "Immutable rule: always requires HITL"
			};
			if (opts.userId) {
				const userRule = userRules.get(opts.userId);
				if (userRule) {
					if (userRule.additionalDeny?.some((p) => matchesPattern(p, capabilityId))) return {
						action: "deny",
						tier: 2,
						reason: `User rule for ${opts.userId}: denied`
					};
					if (userRule.additionalAllow?.some((p) => matchesPattern(p, capabilityId))) {
						if (!op.deny.some((p) => matchesPattern(p, capabilityId))) return {
							action: "allow",
							tier: 2,
							reason: `User rule for ${opts.userId}: allowed`
						};
					}
				}
			}
			if (op.deny.some((p) => matchesPattern(p, capabilityId))) return {
				action: "deny",
				tier: 1,
				reason: "Operator rule: denied"
			};
			if (op.autoAllow.some((p) => matchesPattern(p, capabilityId))) return {
				action: "allow",
				tier: 1,
				reason: "Operator rule: auto-allowed"
			};
			if (op.hitlRequired.some((p) => matchesPattern(p, capabilityId))) {
				const learned = learnedRules.get(capabilityId);
				if (learned?.adjustment === "nudge_allow" && learned.feedbackCount >= learned.threshold && !learned.frozen) return {
					action: "allow",
					tier: 3,
					reason: "Learned rule: nudged to allow"
				};
				return {
					action: "hitl_required",
					tier: 1,
					reason: "Operator rule: HITL required"
				};
			}
			return {
				action: "allow",
				tier: 1,
				reason: "Default: allowed (not in any deny/hitl list)"
			};
		},
		setUserRule(entry) {
			userRules.set(entry.userId, entry);
		},
		getUserRule(userId) {
			return userRules.get(userId);
		},
		recordFeedback(capabilityId, direction) {
			const existing = learnedRules.get(capabilityId);
			if (existing) existing.feedbackCount += 1;
			else learnedRules.set(capabilityId, {
				capabilityId,
				adjustment: direction,
				feedbackCount: 1,
				threshold: 5,
				frozen: capabilityId.startsWith("data.delete") || capabilityId.startsWith("credential")
			});
		},
		describe() {
			return {
				immutable: IMMUTABLE_RULES,
				operator: op,
				userCount: userRules.size,
				learnedCount: learnedRules.size
			};
		}
	};
}
//#endregion
//#region src/kernel/robot-identity-manager.ts
/**
* robot-identity-manager.ts — 机器人完整身份管理系统
*
* 提供：
* - RobotIdentityProfile：机器人的完整身份信息（组织、角色、能力声明等）
* - RobotRelation：与其他人/机器人的关系
* - RobotIdentityManager：身份管理器接口（读/写/持久化）
*
* 与 claworks/robot-identity.ts 的关系：
*   robot-identity.ts   → 从 robot.md 读取静态 RBAC/宪法信息（运行时不可变）
*   robot-identity-manager.ts → 动态身份、关系、自我介绍（可热更新、可持久化）
*/
function createRobotIdentityManager(config = {}) {
	let identity = {
		id: config.id ?? randomUUID(),
		name: config.name ?? "ClaWorks 机器人",
		role: config.role ?? "通用工业助手",
		organization: config.organization ?? "未设置",
		domain: config.domain ?? "通用",
		version: config.version ?? "1.0.0",
		language: config.language ?? "zh-CN",
		timezone: config.timezone ?? "Asia/Shanghai",
		owner: config.owner,
		admins: config.admins ?? [],
		operators: config.operators ?? [],
		guests: config.guests ?? [],
		capabilities_summary: config.capabilities_summary ?? "工业设备监控、报警处理、工单管理、知识库查询",
		introduction: config.introduction ?? "",
		always_greet: config.always_greet ?? true,
		auto_learn: config?.auto_learn ?? true,
		proactive: config.proactive ?? true
	};
	if (!identity.introduction) identity.introduction = buildIntroTemplate(identity);
	const relations = /* @__PURE__ */ new Map();
	if (identity.owner) relations.set(identity.owner.userId, {
		userId: identity.owner.userId,
		name: identity.owner.name,
		role: "owner",
		channels: [],
		bindingSubjects: [],
		joinedAt: /* @__PURE__ */ new Date()
	});
	return {
		getIdentity() {
			return { ...identity };
		},
		updateIdentity(patch) {
			identity = {
				...identity,
				...patch
			};
			if (!patch.introduction) identity.introduction = buildIntroTemplate(identity);
		},
		addRelation(rel) {
			const full = {
				...rel,
				joinedAt: /* @__PURE__ */ new Date()
			};
			relations.set(rel.userId, full);
			syncRoleLists(identity, relations);
			return full;
		},
		removeRelation(userId) {
			const removed = relations.delete(userId);
			if (removed) syncRoleLists(identity, relations);
			return removed;
		},
		getRelation(userId) {
			return relations.get(userId);
		},
		listRelations() {
			return Array.from(relations.values());
		},
		buildIntroduction(lang) {
			if (lang && lang !== "zh-CN" && lang !== "zh") return buildIntroTemplateEn(identity);
			return buildIntroTemplate(identity);
		},
		async persist(db) {
			const sql = `
        INSERT OR REPLACE INTO cw_robot_identity (id, data, updated_at)
        VALUES (?, ?, ?)
      `;
			const data = JSON.stringify({
				identity,
				relations: Array.from(relations.values()).map((r) => ({
					...r,
					joinedAt: r.joinedAt.toISOString()
				}))
			});
			try {
				db.prepare(sql).run("singleton", data, Date.now());
			} catch {}
		},
		async hydrate(db) {
			try {
				const row = db.prepare("SELECT data FROM cw_robot_identity WHERE id = ?").get("singleton");
				if (!row) return;
				const parsed = JSON.parse(row.data);
				identity = {
					...identity,
					...parsed.identity
				};
				relations.clear();
				for (const r of parsed.relations ?? []) relations.set(r.userId, {
					...r,
					joinedAt: new Date(r.joinedAt)
				});
			} catch {}
		}
	};
}
function buildIntroTemplate(identity) {
	const ownerPart = identity.owner ? `我归属于 **${identity.owner.name}** 管理。` : "";
	return `我是 **${identity.name}**，${identity.organization}的${identity.role}。我能帮您处理${identity.capabilities_summary}。${ownerPart}

**版本**：${identity.version}  
**语言**：${identity.language}  
**时区**：${identity.timezone}`;
}
function buildIntroTemplateEn(identity) {
	return `I am **${identity.name}**, the ${identity.role} of ${identity.organization}. I can help you with ${identity.capabilities_summary}.

**Version**: ${identity.version}  
**Language**: ${identity.language}  
**Timezone**: ${identity.timezone}`;
}
function syncRoleLists(identity, relations) {
	identity.admins = [];
	identity.operators = [];
	identity.guests = [];
	for (const rel of relations.values()) if (rel.role === "admin") identity.admins.push(rel.userId);
	else if (rel.role === "operator") identity.operators.push(rel.userId);
	else if (rel.role === "guest") identity.guests.push(rel.userId);
}
//#endregion
//#region src/kernel/context-engine.ts
const MAX_TURNS_PER_SESSION = 50;
const SESSION_IDLE_MS = 1800 * 1e3;
function createContextEngine(opts) {
	const sessions = /* @__PURE__ */ new Map();
	function getOrCreate(sessionId) {
		let data = sessions.get(sessionId);
		if (!data) {
			data = {
				turns: [],
				lastActiveAt: /* @__PURE__ */ new Date(),
				firstTurnAt: /* @__PURE__ */ new Date()
			};
			sessions.set(sessionId, data);
		}
		return data;
	}
	function pruneIdleSessions() {
		const cutoff = Date.now() - SESSION_IDLE_MS;
		for (const [id, data] of sessions.entries()) if (data.lastActiveAt.getTime() < cutoff) sessions.delete(id);
	}
	return {
		append(sessionId, role, content, meta) {
			pruneIdleSessions();
			const data = getOrCreate(sessionId);
			data.turns.push({
				role,
				content,
				timestamp: /* @__PURE__ */ new Date(),
				meta
			});
			data.lastActiveAt = /* @__PURE__ */ new Date();
			if (data.turns.length > MAX_TURNS_PER_SESSION) data.turns.splice(0, data.turns.length - MAX_TURNS_PER_SESSION);
		},
		getRecent(sessionId, maxTurns = 10) {
			const data = sessions.get(sessionId);
			if (!data) return [];
			const turns = data.turns;
			return turns.slice(Math.max(0, turns.length - maxTurns));
		},
		listSessions() {
			pruneIdleSessions();
			return [...sessions.entries()].map(([sessionId, data]) => ({
				sessionId,
				turnCount: data.turns.length,
				lastActiveAt: data.lastActiveAt,
				firstTurnAt: data.firstTurnAt
			}));
		},
		clear(sessionId) {
			sessions.delete(sessionId);
		},
		async compress(sessionId, maxTurns = 10) {
			const data = sessions.get(sessionId);
			if (!data) return;
			if (data.turns.length <= maxTurns) return;
			const olderTurns = data.turns.slice(0, data.turns.length - maxTurns);
			const recentTurns = data.turns.slice(data.turns.length - maxTurns);
			if (opts?.llmComplete && olderTurns.length > 0) {
				const prompt = [
					"将以下对话历史精炼为一段简洁的摘要（200字以内），保留关键决定、用户偏好和上下文信息：",
					"",
					olderTurns.map((t) => `[${t.role}] ${t.content}`).join("\n"),
					"",
					"摘要："
				].join("\n");
				try {
					const { text } = await opts.llmComplete({ prompt });
					data.turns = [{
						role: "system",
						content: `[历史摘要] ${text.trim()}`,
						timestamp: olderTurns[olderTurns.length - 1].timestamp,
						meta: {
							compressed: true,
							originalTurnCount: olderTurns.length
						}
					}, ...recentTurns];
				} catch {
					data.turns = recentTurns;
				}
			} else data.turns = recentTurns;
		},
		async persist(_db) {}
	};
}
//#endregion
//#region src/kernel/scaffold-engine.ts
function createScaffoldEngine(runtime) {
	const assets = /* @__PURE__ */ new Map();
	/** 调用 LLM（优先使用强模型配置） */
	async function callLlm(prompt) {
		const completeFn = runtime.llmComplete;
		if (!completeFn) return JSON.stringify({
			error: "no_llm",
			note: "LLM 未配置，无法生成脚手架"
		});
		return (await completeFn({ prompt })).text;
	}
	/** 从 LLM 输出中提取 JSON 对象 */
	function extractJson(text) {
		try {
			return JSON.parse(text);
		} catch {
			const match = text.match(/\{[\s\S]*\}/);
			if (match) try {
				return JSON.parse(match[0]);
			} catch {
				return null;
			}
			return null;
		}
	}
	const engine = {
		async generateDomainScaffold(domain, context = "") {
			let promptTemplates = 0;
			let decisionTables = 0;
			const intentPrompt = `你是工业机器人系统架构师，为本地弱模型（Qwen 7B/35B）预制脚手架。
目标：让弱模型通过"填空+多选"完成任务，而不是自由推理。

为 "${domain}" 领域生成一个意图分类少样本 Prompt 模板。

要求：
1. 列出 8-12 个典型意图类别（根据领域特点）
2. 每个类别附带 2-3 个典型用户输入示例
3. 弱模型只需做单选题，从类别列表中选一个
4. 强制 JSON 输出格式

${context ? `领域上下文：${context}` : ""}

以 JSON 格式返回：
{
  "system_prompt": "完整的 system prompt，含类别定义和 few-shot 示例",
  "user_template": "{{message}}",
  "intents": ["意图1", "意图2", "..."]
}`;
			try {
				const intentData = extractJson(await callLlm(intentPrompt));
				if (intentData?.system_prompt) {
					const asset = {
						id: `scaffold-intent-${domain}`,
						type: "prompt_template",
						name: `${domain} 意图分类模板`,
						description: `为 ${domain} 领域预制的意图分类少样本提示词，弱模型填空使用`,
						content: JSON.stringify(intentData),
						domain,
						task_type: "intent_classify",
						generated_by: "strong-model",
						generated_at: /* @__PURE__ */ new Date(),
						validated: false,
						usage_count: 0,
						success_rate: 1
					};
					assets.set(asset.id, asset);
					await engine.deploy(asset);
					promptTemplates++;
				}
			} catch {
				const fallbackAsset = {
					id: `scaffold-intent-${domain}`,
					type: "prompt_template",
					name: `${domain} 意图分类（内置兜底）`,
					description: `${domain} 领域意图分类模板（强模型不可用时的兜底版本）`,
					content: JSON.stringify({
						system_prompt: `你是 ${domain} 领域助手。将用户消息分类到以下意图之一，只输出 JSON。\n输出：{"intent":"类别名","confidence":0.0-1.0}`,
						user_template: "{{message}}",
						intents: [
							"query",
							"create",
							"update",
							"alarm",
							"report",
							"unknown"
						]
					}),
					domain,
					task_type: "intent_classify",
					generated_by: "builtin-fallback",
					generated_at: /* @__PURE__ */ new Date(),
					validated: true,
					usage_count: 0,
					success_rate: .8
				};
				assets.set(fallbackAsset.id, fallbackAsset);
				await engine.deploy(fallbackAsset);
				promptTemplates++;
			}
			const tablePrompt = `为 "${domain}" 领域生成一个关键词快速路由决策表。
目标：常见指令通过关键词匹配直接路由，完全不调 LLM，响应时间 <1ms。

输出 JSON：
{
  "rules": [
    {"keywords": ["帮助", "功能", "help"], "intent": "help", "confidence": 0.99},
    {"keywords": ["报警", "告警", "异常"], "intent": "alarm_query", "confidence": 0.95},
    ...至少 8 条规则...
  ]
}`;
			try {
				const tableData = extractJson(await callLlm(tablePrompt));
				if (tableData?.rules) {
					const asset = {
						id: `scaffold-rules-${domain}`,
						type: "decision_table",
						name: `${domain} 快速路由规则`,
						description: `${domain} 领域关键词快速路由，0ms 直接命中，不调 LLM`,
						content: JSON.stringify(tableData),
						domain,
						task_type: "intent_routing",
						generated_by: "strong-model",
						generated_at: /* @__PURE__ */ new Date(),
						validated: false,
						usage_count: 0,
						success_rate: 1
					};
					assets.set(asset.id, asset);
					decisionTables++;
				}
			} catch {}
			return {
				playbooks: 0,
				prompt_templates: promptTemplates,
				decision_tables: decisionTables,
				skills: 0
			};
		},
		async generatePromptTemplate(taskType, examples, opts = {}) {
			const schemaHint = opts.outputSchema ? `\n输出 JSON Schema: ${JSON.stringify(opts.outputSchema)}` : "";
			const result = await callLlm(`为 "${taskType}" 任务生成少样本 Prompt 模板，让弱模型（Qwen 35B）可靠执行。

已有示例：
${examples.map((e, i) => `示例${i + 1}: ${e}`).join("\n") || "（无示例，请基于任务类型推断）"}
${schemaHint}

设计原则：
1. system prompt 明确列出所有可能输出选项
2. 包含 3-5 个 few-shot 示例
3. 强制弱模型输出 JSON 格式
4. 避免开放式推理，改为多选/填空

输出 JSON：
{
  "system_prompt": "完整的系统提示词，含 few-shot 示例...",
  "user_template": "用户输入模板，含 {{variable}} 占位符",
  "few_shots": [{"input": "...", "output": "..."}]
}`);
			const data = extractJson(result) ?? {
				system_prompt: result,
				user_template: "{{text}}",
				few_shots: []
			};
			const asset = {
				id: `scaffold-prompt-${taskType}-${Date.now()}`,
				type: "prompt_template",
				name: `${taskType} 提示词模板`,
				description: `为弱模型预制的 ${taskType} 任务少样本提示词`,
				content: JSON.stringify(data),
				task_type: taskType,
				generated_by: "strong-model",
				generated_at: /* @__PURE__ */ new Date(),
				validated: false,
				usage_count: 0,
				success_rate: 1
			};
			assets.set(asset.id, asset);
			return asset;
		},
		async generateDecisionTable(scenario, examples) {
			const data = extractJson(await callLlm(`基于以下示例，为 "${scenario}" 场景生成确定性决策表。
目标：把模糊的 AI 判断转换成零 LLM 调用的规则匹配。

示例：
${examples.map((e) => `  输入: ${JSON.stringify(e.input)} → 输出: ${JSON.stringify(e.output)}`).join("\n") || "（无示例，请基于场景推断典型规则）"}

输出 JSON（规则按优先级排列）：
{
  "id": "table_id",
  "name": "决策表名称",
  "rules": [
    {
      "id": "rule_1",
      "priority": 100,
      "condition": {"field": "字段名", "op": "contains|eq|in", "value": "匹配值"},
      "action": {"kind": "return|publish_event", "params": {"key": "value"}},
      "stopOnMatch": true
    }
  ]
}`)) ?? {
				id: `dt-${Date.now()}`,
				name: scenario,
				rules: []
			};
			const asset = {
				id: `scaffold-dt-${scenario.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}`,
				type: "decision_table",
				name: scenario,
				description: `为 ${scenario} 预制的确定性决策表，零 LLM 调用`,
				content: JSON.stringify(data),
				task_type: scenario,
				generated_by: "strong-model",
				generated_at: /* @__PURE__ */ new Date(),
				validated: false,
				usage_count: 0,
				success_rate: 1
			};
			assets.set(asset.id, asset);
			return asset;
		},
		async generateSkillScript(capability, description) {
			const fnName = capability.replace(/[^a-zA-Z0-9]/g, "_");
			const result = await callLlm(`为 "${capability}" 能力生成确定性 TypeScript 实现（不调 LLM）。

功能描述：${description}

要求：
1. 纯函数，无副作用
2. 所有逻辑基于规则/数据处理，不调 LLM
3. 参数和返回值都是 Record<string, unknown>

返回 JSON：
{
  "function_name": "${fnName}",
  "implementation": "完整 TypeScript 函数代码（export function ${fnName}...）",
  "params_description": "参数说明"
}`);
			const data = extractJson(result) ?? {
				function_name: fnName,
				implementation: result
			};
			const asset = {
				id: `scaffold-skill-${fnName}-${Date.now()}`,
				type: "skill_script",
				name: `${capability} skill`,
				description,
				content: JSON.stringify(data),
				task_type: capability,
				generated_by: "strong-model",
				generated_at: /* @__PURE__ */ new Date(),
				validated: false,
				usage_count: 0,
				success_rate: 1
			};
			assets.set(asset.id, asset);
			return asset;
		},
		get: (id) => assets.get(id),
		list(filter = {}) {
			let result = [...assets.values()];
			if (filter.type) result = result.filter((a) => a.type === filter.type);
			if (filter.domain) result = result.filter((a) => a.domain === filter.domain);
			if (filter.task_type) result = result.filter((a) => a.task_type === filter.task_type);
			return result;
		},
		recordUsage(id, success) {
			const a = assets.get(id);
			if (!a) return;
			const successes = Math.round(a.success_rate * a.usage_count) + (success ? 1 : 0);
			a.usage_count += 1;
			a.success_rate = a.usage_count > 0 ? successes / a.usage_count : 1;
		},
		async deploy(asset) {
			if (asset.type === "prompt_template" && runtime.promptRegistry) {
				let templateStr = asset.content;
				try {
					const parsed = JSON.parse(asset.content);
					templateStr = `${String(parsed.system_prompt ?? "")}\n\n用户：${String(parsed.user_template ?? "{{text}}")}`;
				} catch {}
				runtime.promptRegistry.register(asset.id, templateStr, asset.description);
				if (asset.task_type) runtime.promptRegistry.register(asset.task_type, templateStr, asset.description);
			} else if (asset.type === "decision_table") {
				if (runtime.ruleEngine) try {
					const tableData = JSON.parse(asset.content);
					if (typeof runtime.ruleEngine.addRule === "function" && Array.isArray(tableData.rules)) for (const rule of tableData.rules) runtime.ruleEngine.addRule({
						...rule,
						table_id: tableData.id
					});
				} catch {}
			}
		}
	};
	return engine;
}
//#endregion
//#region src/kernel/user-profile-store.ts
const DEFAULT_STYLE = "concise";
const MAX_RECENT_TOPICS = 10;
const PROFILE_IDLE_MS = 10080 * 60 * 1e3;
function rowToProfile(row) {
	let recentTopics = [];
	try {
		const parsed = JSON.parse(row.recent_topics);
		if (Array.isArray(parsed)) recentTopics = parsed;
	} catch {}
	return {
		userId: row.user_id,
		name: row.name ?? void 0,
		preferredLanguage: row.preferred_language ?? void 0,
		preferredResponseStyle: row.preferred_style ?? DEFAULT_STYLE,
		recentTopics,
		interactionCount: row.interaction_count,
		lastSeenAt: row.last_seen_at,
		customNotes: row.custom_notes ?? void 0
	};
}
function createUserProfileStore(db) {
	const cache = /* @__PURE__ */ new Map();
	const stmts = db ? {
		select: db.prepare(`SELECT * FROM cw_user_profiles WHERE user_id = ?`),
		upsert: db.prepare(`
          INSERT INTO cw_user_profiles
            (user_id, name, preferred_language, preferred_style,
             recent_topics, interaction_count, last_seen_at, custom_notes, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            name = excluded.name,
            preferred_language = excluded.preferred_language,
            preferred_style = excluded.preferred_style,
            recent_topics = excluded.recent_topics,
            interaction_count = excluded.interaction_count,
            last_seen_at = excluded.last_seen_at,
            custom_notes = excluded.custom_notes,
            updated_at = datetime('now')
        `),
		selectAll: db.prepare(`SELECT * FROM cw_user_profiles ORDER BY last_seen_at DESC`)
	} : null;
	function pruneIdle() {
		const cutoff = Date.now() - PROFILE_IDLE_MS;
		for (const [id, p] of cache) if (p._lastSeen < cutoff) cache.delete(id);
	}
	/** 从内存缓存读取；缺失时尝试从 DB 加载；都没有则创建默认值。 */
	function getOrCreate(userId) {
		const cached = cache.get(userId);
		if (cached) return cached;
		if (stmts) {
			const row = stmts.select.get(userId);
			if (row) {
				const entry = {
					...rowToProfile(row),
					_lastSeen: Date.now()
				};
				cache.set(userId, entry);
				return entry;
			}
		}
		const fresh = {
			userId,
			preferredResponseStyle: DEFAULT_STYLE,
			recentTopics: [],
			interactionCount: 0,
			lastSeenAt: (/* @__PURE__ */ new Date()).toISOString(),
			_lastSeen: Date.now()
		};
		cache.set(userId, fresh);
		return fresh;
	}
	/** 将画像写入 DB（幂等）。 */
	function persist(p) {
		if (!stmts) return;
		try {
			stmts.upsert.run(p.userId, p.name ?? null, p.preferredLanguage ?? null, p.preferredResponseStyle, JSON.stringify(p.recentTopics), p.interactionCount, p.lastSeenAt, p.customNotes ?? null);
		} catch {}
	}
	return {
		get(userId) {
			pruneIdle();
			const { _lastSeen: _ls, ...profile } = getOrCreate(userId);
			return profile;
		},
		update(userId, patch) {
			const p = getOrCreate(userId);
			Object.assign(p, patch);
			p.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
			p._lastSeen = Date.now();
			persist(p);
		},
		addTopic(userId, topic) {
			const p = getOrCreate(userId);
			p.recentTopics = [topic, ...p.recentTopics.filter((t) => t !== topic)].slice(0, MAX_RECENT_TOPICS);
			p._lastSeen = Date.now();
			persist(p);
		},
		getPreferredStyle(userId) {
			return getOrCreate(userId).preferredResponseStyle;
		},
		setName(userId, name) {
			const p = getOrCreate(userId);
			p.name = name;
			p._lastSeen = Date.now();
			persist(p);
		},
		bump(userId) {
			const p = getOrCreate(userId);
			p.interactionCount += 1;
			p.lastSeenAt = (/* @__PURE__ */ new Date()).toISOString();
			p._lastSeen = Date.now();
			persist(p);
		},
		toPromptHint(userId) {
			const p = getOrCreate(userId);
			const parts = [];
			if (p.name) parts.push(`用户名：${p.name}`);
			if (p.preferredLanguage) parts.push(`语言：${p.preferredLanguage}`);
			parts.push(`偏好风格：${p.preferredResponseStyle}`);
			if (p.recentTopics.length > 0) parts.push(`近期话题：${p.recentTopics.slice(0, 3).join("、")}`);
			if (p.interactionCount > 0) parts.push(`历史交互次数：${p.interactionCount}`);
			if (p.customNotes) parts.push(`备注：${p.customNotes}`);
			return parts.join("；");
		},
		list() {
			pruneIdle();
			if (stmts) try {
				return stmts.selectAll.all().map(rowToProfile);
			} catch {}
			return [...cache.values()].map(({ _lastSeen: _ls, ...p }) => p);
		}
	};
}
//#endregion
//#region src/claworks/runtime.ts
async function createClaworksRuntime(config, opts) {
	const { db, close, dialect, note } = openDatabase(config.data?.database_url ?? `sqlite://${join(homedir(), ".claworks", "robot.db")}`);
	if (note) opts?.logger?.(`[claworks] ${note}`);
	const robot = {
		name: config.robot?.name ?? "claworks-robot",
		role: config.robot?.role ?? "monolith",
		version: opts?.version ?? "2026.5.0-alpha.1",
		endpoint: `http://${config.robot?.host ?? "127.0.0.1"}:${config.robot?.port ?? 8e3}`
	};
	const stateDir = join(homedir(), ".claworks");
	const identity = buildRobotIdentity({
		robotName: robot.name,
		robotRole: robot.role,
		stateDir
	});
	const rbac = createRbacGuard([...DEFAULT_RBAC_POLICIES]);
	const ingress = createIngressRouter(DEFAULT_INGRESS_POLICIES);
	const ontology = createOntologyEngine();
	const policySyncTarget = {};
	const objectStore = createObjectStore(db, {
		validate: (typeName, data) => ontology.validate(typeName, data),
		onPolicyWrite: (typeName) => {
			if (policySyncTarget.runtime) schedulePolicySync(policySyncTarget.runtime, typeName);
		}
	});
	const kbPath = config.data?.kb_path?.trim();
	const kb = opts?.kb ?? (kbPath && config.data?.kb_provider !== "memory-core" ? createFileKnowledgeBase(kbPath) : createKnowledgeBase());
	const hitl = opts?.hitl ?? (await import("./hitl-gate-ZrCT4Lv1.mjs").then((n) => n.n)).createHitlGate();
	let kernel;
	let runtime;
	const publishEvent = async (type, source, payload, correlationId) => {
		appendObservationEvent(source, type, payload);
		await kernel.publish(type, source, payload, {
			correlationId,
			subjectType: "system",
			subjectId: source
		});
	};
	const a2aPeers = config.a2a?.peers ?? [];
	const modelRouter = createModelRouter(config.model_router);
	const actionRegistry = createActionRegistry();
	const intentRegistry = createIntentRegistry();
	const playbookEngine = createPlaybookEngine({
		db,
		objectStore,
		kb,
		robot,
		hitl,
		llmComplete: opts?.llmComplete,
		notify: opts?.notify,
		ontology,
		publishEvent,
		subagentRun: opts?.subagentRun,
		skillRun: opts?.skillRun,
		a2aPeers,
		modelRouter,
		rbacCheck: (input) => rbac.check(input),
		reloadPacks: async () => {
			const { packs } = await reloadClaworksPacksFromDisk(runtime);
			return {
				packs,
				total: packs.length,
				loaded: packs.length
			};
		},
		reloadPackById: async (packId) => reloadClaworksPackById(runtime, packId),
		actionRegistry,
		intentRegistry,
		logger: opts?.logger
	});
	const packLoader = createPackLoader();
	const packPaths = [
		...config.packs?.paths ?? [],
		join(homedir(), ".claworks", "packs"),
		join(process.cwd(), "packs"),
		join(process.cwd(), "../claworks-packs")
	];
	const persistedInstalled = await loadPersistedInstalled();
	const packConfig = mergePackConfig({
		...config.packs,
		paths: packPaths,
		installed: config.packs?.installed ?? ["base", "process-industry"]
	}, persistedInstalled);
	config.packs = packConfig;
	const packs = await packLoader.loadInstalled(packConfig);
	await ontology.loadFromPacks(packs);
	await playbookEngine.loadFromPacks(packs);
	const gatewayPort = Number(process.env.CLAWORKS_GATEWAY_PORT ?? config.robot?.port ?? 18800);
	robot.endpoint = `http://${config.robot?.host ?? "127.0.0.1"}:${gatewayPort}`;
	const publishAnomaly = async (payload) => {
		appendObservationEvent("kernel", "system.anomaly", payload);
		await kernel.publish("system.anomaly", "kernel", payload, {
			subjectType: "system",
			subjectId: "kernel"
		});
	};
	kernel = createEventKernel({
		playbookEngine,
		db,
		logger: opts?.logger,
		playbookConcurrency: config.kernel?.playbook_concurrency ?? 10,
		publishAnomaly,
		onOutboxExhausted: async (payload) => {
			await publishAnomaly({
				kind: "outbox_exhausted",
				...payload
			});
		}
	});
	kernel.matcher.load(playbookEngine.list());
	const connectorManager = new ConnectorManager({ logger: opts?.logger });
	connectorManager.setEventHandler(async (ev) => {
		appendObservationEvent(ev.source, ev.type, ev.payload);
		const result = await applyIngressPublish(runtime, {
			source: "connector",
			eventType: ev.type,
			subjectId: ev.source,
			payload: ev.payload,
			correlationId: ev.correlationId,
			subjectType: "system",
			publishSource: ev.source
		});
		if (result.action === "denied") {
			opts?.logger?.(`[claworks:ingress] denied connector event: ${ev.type} — ${result.reason}`);
			return;
		}
		if (result.action === "observe_only") {
			opts?.logger?.(`[claworks:ingress] observe-only: ${ev.type} from ${ev.source}`);
			return;
		}
		if (result.action === "intent_routed") opts?.logger?.(`[claworks:ingress] intent_route ${ev.type} → playbook ${result.playbookId} run=${result.runId}`);
	});
	playbookEngine.setConnectorInvoke(async (connectorId, method, params) => {
		await connectorManager.invoke(connectorId, method, params);
	});
	const scheduler = createPlaybookScheduler({
		logger: opts?.logger,
		timezone: config.kernel?.scheduler_timezone,
		onFire: async (playbookId) => {
			await kernel.publish("system.schedule.fired", "scheduler", {
				playbook_id: playbookId,
				_scheduled: true,
				fired_at: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
	});
	scheduler.reload(playbookEngine.list());
	const robotIdentityManager = createRobotIdentityManager({
		name: robot.name,
		role: robot.role
	});
	runtime = {
		config,
		robot,
		identity,
		rbac,
		ingress,
		db,
		objectStore,
		ontology,
		kb,
		playbookEngine,
		kernel,
		capabilities: null,
		actionRegistry,
		intentRegistry,
		robotIdentityManager,
		shutdown: async () => stopClaworksRuntime(runtime),
		loadedPacks: packs,
		packLoader,
		connectorManager,
		scheduler,
		logger: opts?.logger,
		databaseDialect: dialect,
		close
	};
	policySyncTarget.runtime = runtime;
	const capabilities = createCoreCapabilityRegistry(runtime);
	runtime.capabilities = capabilities;
	kernel.setCapabilityRegistry(capabilities);
	const constitutionConfig = config.kernel ?? {};
	const constitution = createConstitutionV2({
		autoAllow: Array.isArray(constitutionConfig.extra_auto_allow) ? [...DEFAULT_OPERATOR_CONSTITUTION.autoAllow, ...constitutionConfig.extra_auto_allow] : void 0,
		hitlRequired: Array.isArray(constitutionConfig.extra_hitl_required) ? [...DEFAULT_OPERATOR_CONSTITUTION.hitlRequired, ...constitutionConfig.extra_hitl_required] : void 0,
		deny: Array.isArray(constitutionConfig.extra_deny) ? [...DEFAULT_OPERATOR_CONSTITUTION.deny, ...constitutionConfig.extra_deny] : void 0
	});
	runtime.constitution = constitution;
	registerExtensionCapabilities(runtime, constitution);
	capabilities.setConstitution(constitution);
	runtime.scaffoldEngine = createScaffoldEngine(runtime);
	runtime.contextEngine = createContextEngine({ llmComplete: opts?.llmComplete ? async (p) => {
		const r = await opts.llmComplete(p.prompt);
		return { text: typeof r === "string" ? r : String(r) };
	} : void 0 });
	runtime.userProfileStore = createUserProfileStore(db);
	runtime.researchAgent = createResearchAgent(runtime);
	return runtime;
}
async function startClaworksRuntime(runtime) {
	markRuntimeStarted();
	await runtime.kernel.start();
	const hydrated = await runtime.playbookEngine.hydrateSuspendedRuns();
	if (hydrated > 0) runtime.logger?.(`[claworks] hydrated ${hydrated} waiting_hitl run(s)`);
	runtime.scheduler.reload(runtime.playbookEngine.list());
	const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync-CZlL_vuW.mjs").then((n) => n.t);
	await syncRbacFromObjectStore(runtime);
	await syncIngressFromObjectStore(runtime);
	const connectorEntries = runtime.config.connectors ?? {};
	const connectors = resolveConnectorConfigs(connectorEntries);
	for (const [id, cfg] of Object.entries(connectors)) {
		await runtime.connectorManager.start(id, cfg);
		const raw = connectorEntries[id];
		if (raw?.auto_start) {
			const method = typeof raw.auto_start === "object" ? raw.auto_start.method ?? "start" : "start";
			const params = typeof raw.auto_start === "object" ? raw.auto_start.params : void 0;
			try {
				await runtime.connectorManager.invoke(id, method, params);
			} catch (err) {
				runtime.logger?.(`[claworks:connector] auto_start ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	await runtime.kernel.flushOutbox();
	runtime._outboxFlushTimer = setInterval(() => {
		runtime.kernel.flushOutbox().catch((err) => {
			runtime.logger?.(`[claworks:outbox] flush failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	}, 3e4);
	runtime._hitlExpiryTimer = setInterval(() => {
		runtime.playbookEngine.expireStaleHitl().then((n) => {
			if (n > 0) runtime.logger?.(`[claworks:hitl] expired ${n} stale HITL token(s)`);
		}).catch((err) => {
			runtime.logger?.(`[claworks:hitl] expiry sweep failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	}, 3e4);
	await runtime.kernel.publish("system.runtime.started", "runtime", {
		version: runtime.robot.version,
		name: runtime.robot.name,
		role: runtime.robot.role,
		packCount: runtime.loadedPacks.length,
		playbookCount: runtime.playbookEngine.list().length,
		endpoint: runtime.robot.endpoint
	});
}
async function stopClaworksRuntime(runtime) {
	if (runtime._outboxFlushTimer) {
		clearInterval(runtime._outboxFlushTimer);
		runtime._outboxFlushTimer = void 0;
	}
	if (runtime._hitlExpiryTimer) {
		clearInterval(runtime._hitlExpiryTimer);
		runtime._hitlExpiryTimer = void 0;
	}
	try {
		await runtime.kernel.publish("system.runtime.stopped", "runtime", { name: runtime.robot.name });
	} catch {}
	runtime.scheduler.stop();
	await runtime.connectorManager.stopAll();
	await runtime.kernel.stop();
	runtime.close();
}
//#endregion
//#region src/claworks/packs-cli.ts
function registerClaworksPacksCli(program) {
	if (!isClaworksProduct()) return;
	const packs = program.command("packs").description("Manage ClaWorks extension packs (Nexus registry)");
	packs.command("list").description("List installed packs").action(async () => {
		const installed = await loadPersistedInstalled();
		console.log(JSON.stringify({
			installed,
			state: resolveInstalledStatePath()
		}, null, 2));
	});
	packs.command("search").argument("[query]", "search query").option("--registry <url>", "Nexus registry URL", "http://127.0.0.1:8080").action(async (query, opts) => {
		const result = await listNexusPackages(opts.registry, { q: query });
		console.log(JSON.stringify(result, null, 2));
	});
	packs.command("update").argument("<source>", "nexus://pack@version or pack name").option("--registry <url>", "Nexus registry URL").description("Update (re-install) a pack from Nexus or local path").action(async (source, opts) => {
		const runtime = await createClaworksRuntime({ packs: {
			registry: opts.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080",
			installed: await loadPersistedInstalled()
		} });
		await startClaworksRuntime(runtime);
		try {
			const result = await installClaworksPack(runtime, source.startsWith("nexus://") ? source : `nexus://${source}`);
			console.log(JSON.stringify({
				updated: result.pack.manifest.id,
				version: result.pack.manifest.version,
				installed: result.installed
			}, null, 2));
		} finally {
			await stopClaworksRuntime(runtime);
		}
	});
	packs.command("reload").description("Reload packs from disk without installing").action(async () => {
		const runtime = await createClaworksRuntime({ packs: { installed: await loadPersistedInstalled() } });
		await startClaworksRuntime(runtime);
		try {
			const result = await reloadClaworksPacksFromDisk(runtime);
			console.log(JSON.stringify({ reloaded: result.packs.map((p) => p.manifest.id) }, null, 2));
		} finally {
			await stopClaworksRuntime(runtime);
		}
	});
	packs.command("install").argument("<source>", "nexus://pack@version or pack name").option("--registry <url>", "Nexus registry URL").action(async (source, opts) => {
		const runtime = await createClaworksRuntime({ packs: {
			registry: opts.registry ?? process.env.CLAWORKS_NEXUS_URL ?? "http://127.0.0.1:8080",
			installed: await loadPersistedInstalled()
		} });
		await startClaworksRuntime(runtime);
		try {
			const nexusSource = source.startsWith("nexus://") ? source : `nexus://${source}`;
			if (!parseNexusSource(nexusSource) && !source.startsWith("file://")) throw new Error(`Invalid pack source: ${source}`);
			const result = await installClaworksPack(runtime, nexusSource);
			console.log(JSON.stringify({
				pack: result.pack.manifest.id,
				version: result.pack.manifest.version,
				path: result.pack.path,
				installed: result.installed
			}, null, 2));
		} finally {
			await stopClaworksRuntime(runtime);
		}
	});
}
//#endregion
export { bridgeChannelMessageReceived as a, schedulePolicySync as c, applyClaworksProductEnv as d, detectAndApplyClaworksCli as f, warnIfOpenClawEntryWithClaworksState as h, stopClaworksRuntime as i, createModelRouter as l, looksLikeClaworksStateEnv as m, createClaworksRuntime as n, resolveNotifyTargets as o, isClaworksProduct as p, startClaworksRuntime as r, robotOwnerFromObject as s, registerClaworksPacksCli as t, CLAWORKS_DEFAULT_GATEWAY_PORT as u };
