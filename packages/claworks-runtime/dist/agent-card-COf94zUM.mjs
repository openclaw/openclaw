import { f as __exportAll } from "./ontology-engine-DYitirop.mjs";
import { c as runtimeUptimeSeconds } from "./client-sSruxTff.mjs";
import { r as installPackFromNexus } from "./pack-loader-ttcUSOdi.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
//#region src/claworks/ingress-publish.ts
async function applyIngressPublish(runtime, params) {
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
	if ((runtime.config.data?.database_url ?? "").startsWith("postgres")) checks.push({
		id: "database_postgres",
		status: "warn",
		message: "postgresql:// configured: run `pnpm claworks:migrate` for schema; runtime ObjectStore uses SQLite cache until PG adapter is enabled"
	});
	checks.push({
		id: "robot",
		status: "ok",
		message: `${runtime.robot.name} (${runtime.robot.role}) @ ${runtime.robot.endpoint}`
	});
	return checks;
}
//#endregion
//#region src/claworks/health.ts
var health_exports = /* @__PURE__ */ __exportAll({
	buildHealthPayload: () => buildHealthPayload,
	resolveHealthStatus: () => resolveHealthStatus
});
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
		uptime_s: runtimeUptimeSeconds(),
		planes: {
			kernel: status === "unavailable" ? "error" : "ok",
			data: checks.find((c) => c.id === "database")?.status === "error" ? "error" : "ok",
			orch: checks.find((c) => c.id === "playbooks")?.status === "error" ? "error" : "ok"
		},
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
var im_bridge_exports = /* @__PURE__ */ __exportAll({ bridgeImMessage: () => bridgeImMessage });
async function bridgeImMessage(runtime, input) {
	const source = "im";
	const eventType = "im.message.received";
	const subjectId = `${input.channel}:${input.userId}`;
	const decision = runtime.ingress.decide(source, eventType, subjectId);
	const rbacAction = decision.action === "intent_route" ? "playbook.trigger" : "event.publish";
	const rbacResource = decision.action === "intent_route" ? `playbook:${decision.hint ?? "classify_im_to_business_event"}` : eventType;
	const rbacResult = runtime.rbac.check({
		action: rbacAction,
		resource: rbacResource,
		subjectType: "channel_user",
		subjectId,
		context: { channel: input.channel }
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
	const result = await applyIngressPublish(runtime, {
		source,
		eventType,
		subjectId,
		payload: {
			_im_channel: input.channel,
			_im_message_id: input.messageId,
			_im_user_id: input.userId,
			_im_group_id: input.groupId,
			_im_message: input.text,
			_ingress_decision: decision.action,
			...input.extra
		},
		publishSource: "im-bridge",
		idempotencyKey: `im:${input.channel}:${input.messageId}`,
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
//#region src/claworks/pack-runtime.ts
var pack_runtime_exports = /* @__PURE__ */ __exportAll({
	installClaworksPack: () => installClaworksPack,
	loadPersistedInstalled: () => loadPersistedInstalled,
	mergePackConfig: () => mergePackConfig,
	persistInstalled: () => persistInstalled,
	reloadClaworksPackById: () => reloadClaworksPackById,
	reloadClaworksPacks: () => reloadClaworksPacks,
	reloadClaworksPacksFromDisk: () => reloadClaworksPacksFromDisk,
	resolveInstalledStatePath: () => resolveInstalledStatePath,
	resolvePacksInstallRoot: () => resolvePacksInstallRoot,
	searchNexusPackages: () => searchNexusPackages,
	uninstallClaworksPack: () => uninstallClaworksPack,
	updateClaworksPack: () => updateClaworksPack
});
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
	runtime.actionRegistry.clear();
	runtime.intentRegistry.clear();
	for (const pack of packs) if (pack.factory) try {
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
		if (contribution.onLoad) await contribution.onLoad(runtime);
	} catch (err) {
		runtime.logger?.(`[claworks:packs] factory error in pack '${pack.manifest.id}': ${err instanceof Error ? err.message : String(err)}`);
	}
	const { syncRbacFromObjectStore, syncIngressFromObjectStore } = await import("./rbac-sync-CZlL_vuW.mjs").then((n) => n.t);
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
			args: [presetPath(root, "mqtt", "mqtt-bridge.mjs")],
			env: { CLAWORKS_MQTT_SIMULATE: "1" }
		};
		case "opcua": return {
			command: process.env.CLAWORKS_PYTHON ?? "python3",
			args: [presetPath(root, "opcua", "opcua-bridge.py")],
			env: { CLAWORKS_OPCUA_SIMULATE: "1" }
		};
		case "modbus": return {
			command: process.env.CLAWORKS_PYTHON ?? "python3",
			args: [presetPath(root, "modbus", "modbus-bridge.py")],
			env: { CLAWORKS_MODBUS_SIMULATE: "1" }
		};
		default: return null;
	}
}
function resolveConnectorConfigs(connectors, claworksRoot = resolveClaworksRoot()) {
	const resolved = {};
	for (const [id, raw] of Object.entries(connectors ?? {})) {
		const preset = raw.preset ? getConnectorPreset(raw.preset, claworksRoot) : null;
		if (raw.preset && !preset) throw new Error(`Unknown connector preset: ${raw.preset}`);
		const { preset: _presetKey, ...rest } = raw;
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
		if (!resolved[id].command) throw new Error(`Connector ${id} missing command`);
	}
	return resolved;
}
//#endregion
//#region src/interfaces/a2a/agent-card.ts
function buildA2aAgentCard(runtime, baseUrl) {
	const url = baseUrl ?? runtime.robot.endpoint;
	return {
		name: runtime.robot.name,
		description: "ClaWorks industrial robot",
		url,
		version: runtime.robot.version,
		capabilities: {
			streaming: false,
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
export { health_exports as C, applyIngressPublish as E, buildHealthPayload as S, runClaworksDoctor as T, bridgeImMessage as _, loadPersistedInstalled as a, resolveA2aPeer as b, persistInstalled as c, reloadClaworksPacksFromDisk as d, resolveInstalledStatePath as f, updateClaworksPack as g, uninstallClaworksPack as h, installClaworksPack as i, reloadClaworksPackById as l, searchNexusPackages as m, resolveConnectorConfigs as n, mergePackConfig as o, resolvePacksInstallRoot as p, ConnectorManager as r, pack_runtime_exports as s, buildA2aAgentCard as t, reloadClaworksPacks as u, im_bridge_exports as v, resolveHealthStatus as w, resolveA2aPeerId as x, checkA2aPeerRbac as y };
