import { a as createKnowledgeBase, c as openDatabase$1, d as migrateClaworksSchema, i as mesProductionDispatch, l as convertPlaceholders, n as createObjectStore, o as createFileKnowledgeBase, r as publishWorkOrderCreated, s as openDatabase, t as createOntologyEngine, u as isPostgresDatabaseUrl } from "./ontology-engine-DYitirop.mjs";
import { a as listObservationEvents, c as runtimeUptimeSeconds, i as listDecisionLog, n as appendDecisionLog, o as markRuntimeStarted, r as appendObservationEvent, s as prometheusMetricsText, t as A2aClient } from "./client-sSruxTff.mjs";
import { a as bridgeChannelMessageReceived, c as schedulePolicySync, d as applyClaworksProductEnv, f as detectAndApplyClaworksCli, h as warnIfOpenClawEntryWithClaworksState, i as stopClaworksRuntime, l as createModelRouter, m as looksLikeClaworksStateEnv, n as createClaworksRuntime, o as resolveNotifyTargets, p as isClaworksProduct, r as startClaworksRuntime, s as robotOwnerFromObject, t as registerClaworksPacksCli, u as CLAWORKS_DEFAULT_GATEWAY_PORT } from "./claworks-DxcM1gHV.mjs";
import { a as evaluatePlaybookCondition, f as listA2aPeerNames, i as interpolate, n as StepFailedError, p as resolveA2aTarget, r as executePlaybookStep, t as HitlSuspendedError, u as executeFunction } from "./step-executor-Dgu_uWbI.mjs";
import { a as buildRobotIdentity, c as extractRulesFromMd, i as DEFAULT_RBAC_POLICIES, l as loadRobotMd, n as syncIngressFromObjectStore, o as createRbacGuard, r as syncRbacFromObjectStore, s as extractOwnerFromMd } from "./rbac-sync-CZlL_vuW.mjs";
import { E as applyIngressPublish, S as buildHealthPayload, T as runClaworksDoctor, _ as bridgeImMessage, a as loadPersistedInstalled, b as resolveA2aPeer, c as persistInstalled, d as reloadClaworksPacksFromDisk, f as resolveInstalledStatePath, g as updateClaworksPack, h as uninstallClaworksPack, i as installClaworksPack, l as reloadClaworksPackById, m as searchNexusPackages, n as resolveConnectorConfigs, o as mergePackConfig, p as resolvePacksInstallRoot, r as ConnectorManager, t as buildA2aAgentCard, u as reloadClaworksPacks, w as resolveHealthStatus, x as resolveA2aPeerId, y as checkA2aPeerRbac } from "./agent-card-COf94zUM.mjs";
import { n as createIngressRouter, t as DEFAULT_INGRESS_POLICIES } from "./ingress-CqjhZRWq.mjs";
import { t as bridgeWebhookPayload } from "./webhook-bridge-CAdM-3RL.mjs";
import { _ as readPackManifest, a as parseNexusSource, d as scanNexusCatalog, f as createPackLoader, g as parsePlaybookYaml, h as parseObjectTypeYaml, i as listNexusPackages, o as extractPackBuffer, p as resolvePackDir, r as installPackFromNexus } from "./pack-loader-ttcUSOdi.mjs";
import { t as createPlaybookEngine } from "./playbook-engine-Cux1LZFy.mjs";
import "./planes/data/index.mjs";
import { t as createHitlGate } from "./hitl-gate-ZrCT4Lv1.mjs";
import "./planes/orch/index.mjs";
import { a as createA2aHttpHandler, c as createClaworksRestHandler, d as parsePath, f as readJsonBody, g as resolveAuthContext, h as checkRbac, i as callClaworksMcpTool, l as badRequest, m as checkClaworksApiAuth, n as createMcpHttpHandler, o as A2aTaskStore, p as sendJson, r as CLAWORKS_MCP_TOOLS, s as serveClaworksStudio, t as createNexusServer, u as notFound } from "./interfaces-BM3zcavL.mjs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/kernel/system-prompt-builder.ts
const PROMPT_PRIORITY = {
	SOUL: 10,
	MEMORY: 20,
	USER: 30,
	CONTEXT: 40,
	CAPABILITIES: 50,
	SAFETY: 60,
	OPERATOR: 70,
	DYNAMIC: 80
};
var SystemPromptBuilder = class SystemPromptBuilder {
	constructor() {
		this._sections = /* @__PURE__ */ new Map();
	}
	/**
	* 添加或覆盖一个具名段。
	* id 唯一；同 id 再次调用会覆盖旧段。
	*/
	addSection(id, content, opts) {
		this._sections.set(id, {
			id,
			heading: opts?.heading,
			content: content.trim(),
			priority: opts?.priority ?? 100
		});
		return this;
	}
	removeSection(id) {
		this._sections.delete(id);
		return this;
	}
	hasSection(id) {
		return this._sections.has(id);
	}
	/**
	* Soul 段：机器人的核心身份与价值观。
	* 参照 OpenClaw context_files 中的 soul.md 文件角色。
	* 最稳定的段，缓存友好，每次请求不应改变。
	*/
	withSoul(robotName, mission, extra) {
		const lines = [
			`You are ${robotName}. ${mission}`,
			"You are helpful, precise, and proactive.",
			"Always identify yourself as a robot; never claim to be human.",
			...extra ?? []
		];
		return this.addSection("soul", lines.join("\n"), {
			heading: "Identity",
			priority: PROMPT_PRIORITY.SOUL
		});
	}
	/**
	* Memory 段：从向量搜索 / KB 检索到的相关记忆片段注入。
	* 参照 OpenClaw 的 `buildMemoryPromptSection`。
	*/
	withMemory(memories) {
		if (memories.length === 0) {
			this.removeSection("memory");
			return this;
		}
		const content = memories.map((m) => `- ${m}`).join("\n");
		return this.addSection("memory", content, {
			heading: "Relevant Memory",
			priority: PROMPT_PRIORITY.MEMORY
		});
	}
	/**
	* User Profile 段：当前用户画像注入。
	* 来源：`UserProfileStore.toPromptHint(userId)`。
	*/
	withUserProfile(profile) {
		const lines = [];
		if (profile.name) lines.push(`User: ${profile.name}`);
		if (profile.language) lines.push(`Language: ${profile.language}`);
		if (profile.style) lines.push(`Preferred response style: ${profile.style}`);
		if (profile.topics?.length) lines.push(`Recent topics: ${profile.topics.slice(0, 5).join(", ")}`);
		if (profile.interactionCount != null && profile.interactionCount > 0) lines.push(`Prior interactions: ${profile.interactionCount}`);
		if (profile.notes) lines.push(`Notes: ${profile.notes}`);
		if (lines.length === 0) {
			this.removeSection("user");
			return this;
		}
		return this.addSection("user", lines.join("\n"), {
			heading: "Current User",
			priority: PROMPT_PRIORITY.USER
		});
	}
	/**
	* Context 段：注入近期对话摘要（不是完整 history，用于 system prompt 感知连续性）。
	* 参照 OpenClaw 的 `extraSystemPrompt`（Group Chat Context）。
	*/
	withContext(summary) {
		const trimmed = summary.trim();
		if (!trimmed) {
			this.removeSection("context");
			return this;
		}
		return this.addSection("context", trimmed, {
			heading: "Recent Conversation Context",
			priority: PROMPT_PRIORITY.CONTEXT
		});
	}
	/**
	* Capabilities 段：列出当前运行时可用的能力 ID。
	* 参照 OpenClaw 的 Tooling 段。
	* caps 超过 30 个时仅取前 30，避免 prompt 过长。
	*/
	withCapabilities(caps, extra) {
		const shown = caps.slice(0, 30);
		const lines = [`Available capabilities (${caps.length} total): ${shown.join(", ")}${caps.length > 30 ? "…" : ""}`, ...extra ?? []];
		return this.addSection("capabilities", lines.join("\n"), {
			heading: "Available Actions",
			priority: PROMPT_PRIORITY.CAPABILITIES
		});
	}
	/**
	* Safety 段：不可违背的安全规则。
	* 参照 OpenClaw 的 `safetySection`。
	*/
	withSafetyRules(extra) {
		const lines = [
			"No independent goals beyond the user's request.",
			"Safety over completion. When in conflict: pause and ask.",
			"Never credential export, bulk data deletion, or identity impersonation.",
			"All outbound communication must identify you as a robot.",
			...extra ?? []
		];
		return this.addSection("safety", lines.join("\n"), {
			heading: "Safety",
			priority: PROMPT_PRIORITY.SAFETY
		});
	}
	/**
	* Operator 段：运营商/管理员补充指令（来自 operator constitution Tier 1）。
	*/
	withOperatorGuidance(guidance) {
		const trimmed = guidance.trim();
		if (!trimmed) {
			this.removeSection("operator");
			return this;
		}
		return this.addSection("operator", trimmed, {
			heading: "Operator Policy",
			priority: PROMPT_PRIORITY.OPERATOR
		});
	}
	/**
	* Dynamic 段：每次请求都可能变化的实时信息（当前时间、实时状态等）。
	* 参照 OpenClaw 的动态 context files（heartbeat.md 等）。
	* 放在 prompt 末尾，避免破坏稳定缓存前缀。
	*/
	withDynamic(content) {
		const trimmed = content.trim();
		if (!trimmed) {
			this.removeSection("dynamic");
			return this;
		}
		return this.addSection("dynamic", trimmed, {
			heading: "Current State",
			priority: PROMPT_PRIORITY.DYNAMIC
		});
	}
	/**
	* 按优先级升序（小值在前）拼接所有段，返回完整 system prompt 字符串。
	* 每段格式：`## {heading}\n{content}\n`（有 heading 时）；无 heading 直接输出 content。
	*/
	build() {
		const sorted = [...this._sections.values()].sort((a, b) => a.priority - b.priority);
		const parts = [];
		for (const section of sorted) {
			if (!section.content) continue;
			if (section.heading) parts.push(`## ${section.heading}\n${section.content}`);
			else parts.push(section.content);
		}
		return parts.join("\n\n");
	}
	/**
	* 导出当前所有段的快照（调试 / 测试用）。
	*/
	sections() {
		return [...this._sections.values()].sort((a, b) => a.priority - b.priority);
	}
	/**
	* 克隆当前 builder（用于在同一基础上派生不同用户的 prompt）。
	*/
	clone() {
		const next = new SystemPromptBuilder();
		for (const [id, section] of this._sections) next._sections.set(id, { ...section });
		return next;
	}
};
/**
* 快速创建一个预设了 Soul + Safety 的基础 builder，
* 供各能力处理器（perceive.intent 等）在此基础上追加动态段。
*/
function createBasePromptBuilder(opts) {
	return new SystemPromptBuilder().withSoul(opts.robotName, opts.mission, opts.soulExtra).withSafetyRules(opts.safetyExtra);
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
	"process-industry",
	"enterprise-general",
	"enterprise-commercial"
];
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
/** True when sibling claworks-packs, contrib/packs, or ~/.claworks/packs has at least one pack. */
function hasPackSourcesAvailable(opts) {
	if (discoverPackSourceDir(opts?.cwd)) return true;
	if (discoverContribPackSourceDir(opts?.cwd)) return true;
	const packsRoot = join(opts?.stateDir?.trim() || join(homedir(), ".claworks"), "packs");
	if (!existsSync(packsRoot)) return false;
	for (const name of readdirSync(packsRoot)) if (existsSync(join(packsRoot, name, "claworks.pack.json"))) return true;
	return false;
}
/** In-repo packs (e.g. personal-enterprise) under contrib/packs/. */
function discoverContribPackSourceDir(cwd = process.cwd()) {
	const candidates = [join(cwd, "contrib", "packs"), join(fileURLToPath(new URL("../../../..", import.meta.url)), "contrib", "packs")];
	for (const dir of candidates) if (existsSync(dir)) return resolve(dir);
	return null;
}
function resolvePackSourcePath(packId, primaryDir, contribDir) {
	if (primaryDir) {
		const primary = join(primaryDir, packId);
		if (existsSync(primary)) return primary;
	}
	if (contribDir) {
		const contrib = join(contribDir, packId);
		if (existsSync(contrib)) return contrib;
	}
	return null;
}
function seedPacksToStateDir(opts) {
	const destRoot = join(opts?.stateDir?.trim() || join(homedir(), ".claworks"), "packs");
	const primaryDir = opts?.sourceDir?.trim() || discoverPackSourceDir();
	const contribDir = discoverContribPackSourceDir();
	const packIds = opts?.packIds ?? DEFAULT_CLAWORKS_PACK_IDS;
	const linked = [];
	const missing = [];
	const warnings = [];
	mkdirSync(destRoot, { recursive: true });
	if (!primaryDir && !contribDir) {
		warnings.push("No claworks-packs source found — clone sibling repo or set CLAWORKS_PACKS_DIR to a directory containing base/, process-industry/, etc.");
		return {
			linked,
			missing: [...packIds],
			warnings
		};
	}
	for (const packId of packIds) {
		const src = resolvePackSourcePath(packId, primaryDir, contribDir);
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
	const contribPackDir = discoverContribPackSourceDir();
	const paths = new Set([
		...packs.paths ?? [],
		statePacks,
		sourceDir,
		contribPackDir
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
	if (process.env.CLAWORKS_VECTOR_KB === "1" || process.env.CLAWORKS_PRODUCT_PROFILE?.trim() === "personal_work" || (plugins?.allow ?? []).includes("memory-core") || (plugins?.allow ?? []).includes("memory-lancedb")) {
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
export { A2aClient, A2aTaskStore, CLAWORKS_DEFAULT_GATEWAY_PORT, CLAWORKS_MCP_TOOLS, ConnectorManager, DEFAULT_INGRESS_POLICIES, DEFAULT_RBAC_POLICIES, HitlSuspendedError, PROMPT_PRIORITY, StepFailedError, SystemPromptBuilder, appendDecisionLog, appendObservationEvent, applyClaworksProductEnv, applyIngressPublish, badRequest, bridgeChannelMessageReceived, bridgeImMessage, bridgeWebhookPayload, buildA2aAgentCard, buildHealthPayload, buildRobotIdentity, callClaworksMcpTool, checkA2aPeerRbac, checkClaworksApiAuth, checkRbac, convertPlaceholders, createA2aHttpHandler, createBasePromptBuilder, createClaworksRestHandler, createClaworksRuntime, createFileKnowledgeBase, createHitlGate, createIngressRouter, createKnowledgeBase, createMcpHttpHandler, createModelRouter, createNexusServer, createObjectStore, createOntologyEngine, createPackLoader, createPlaybookEngine, createRbacGuard, detectAndApplyClaworksCli, discoverPackSourceDir, evaluatePlaybookCondition, executeFunction, executePlaybookStep, extractOwnerFromMd, extractPackBuffer, extractRulesFromMd, hasPackSourcesAvailable, installClaworksPack, installPackFromNexus, interpolate, isClaworksProduct, isClaworksRobotConfigPresent, isPostgresDatabaseUrl, listA2aPeerNames, listDecisionLog, listNexusPackages, listObservationEvents, loadPersistedInstalled, loadRobotMd, looksLikeClaworksStateEnv, markRuntimeStarted, mergePackConfig, mesProductionDispatch, migrateClaworksSchema, notFound, openDatabase, openDatabase$1 as openSqliteDatabase, parseNexusSource, parseObjectTypeYaml, parsePath, parsePlaybookYaml, persistInstalled, prometheusMetricsText, publishWorkOrderCreated, readJsonBody, readPackManifest, registerClaworksPacksCli, reloadClaworksPackById, reloadClaworksPacks, reloadClaworksPacksFromDisk, repairClaworksJsonConfig, resolveA2aPeer, resolveA2aPeerId, resolveA2aTarget, resolveAuthContext, resolveConnectorConfigs, resolveHealthStatus, resolveInstalledStatePath, resolveNotifyTargets, resolvePackDir, resolvePacksInstallRoot, robotOwnerFromObject, runClaworksDoctor, runtimeUptimeSeconds, scanNexusCatalog, schedulePolicySync, searchNexusPackages, sendJson, serveClaworksStudio, startClaworksRuntime, stopClaworksRuntime, syncIngressFromObjectStore, syncRbacFromObjectStore, uninstallClaworksPack, updateClaworksPack, warnIfOpenClawEntryWithClaworksState };
