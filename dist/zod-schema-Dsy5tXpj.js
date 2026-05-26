import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { At as boolean, Bt as discriminatedUnion, Et as array, Nn as record, Qn as url, Rn as string, Si as NEVER, Tn as object, Xn as union, Zn as unknown, dn as literal, un as lazy, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as ZodIssueCode } from "./compat-bCpUj7Jq.js";
import { t as InstallRecordShape } from "./zod-schema.installs-D7BhBdmh.js";
import { C as SecretInputSchema, E as SecretsConfigSchema, F as VisibleRepliesSchema, P as TypingModeSchema, _ as NativeCommandsSettingSchema, c as GroupChatSchema, d as HumanDelaySchema, g as ModelsConfigSchema, i as ContextVisibilityModeSchema, j as TtsConfigSchema, k as TranscribeAudioSchema, l as GroupPolicySchema, n as BlockStreamingCoalesceSchema, p as InboundDebounceSchema, r as CliBackendSchema, t as BlockStreamingChunkSchema, u as HexColorSchema, y as QueueSchema, z as createAllowDenyChannelRulesSchema } from "./zod-schema.core-D7Y_eqdd.js";
import { t as sensitive } from "./zod-schema.sensitive-3GVmnUbm.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import { a as AgentRuntimePolicySchema, c as HeartbeatSchema, d as ToolsSchema, f as AgentModelSchema, i as AgentRunRetriesConfigSchema, l as MemorySearchSchema, n as AgentEmbeddedHarnessSchema, o as AgentSandboxSchema, p as AgentToolModelSchema, r as AgentEntrySchema, s as ElevatedAllowFromSchema, t as AgentContextLimitsSchema } from "./zod-schema.agent-runtime-Bq5CXVVg.js";
import { n as ChannelHeartbeatVisibilitySchema, r as ApprovalsSchema } from "./zod-schema.channels-BJfpHgPH.js";
import path from "node:path";
//#region src/cli/parse-bytes.ts
const UNIT_MULTIPLIERS = {
	b: 1,
	kb: 1024,
	k: 1024,
	mb: 1024 ** 2,
	m: 1024 ** 2,
	gb: 1024 ** 3,
	g: 1024 ** 3,
	tb: 1024 ** 4,
	t: 1024 ** 4
};
function invalidByteSize(raw, reason) {
	const value = raw.trim() ? `"${raw}"` : "empty value";
	const prefix = reason ? `Invalid byte size (${reason}): ${value}.` : `Invalid byte size: ${value}.`;
	return /* @__PURE__ */ new Error(`${prefix} Use values like 512kb, 10mb, 1gb, or 500.`);
}
function parseByteSize(raw, opts) {
	const trimmed = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw) ?? "");
	if (!trimmed) throw invalidByteSize(raw, "empty");
	const m = /^(\d+(?:\.\d+)?)([a-z]+)?$/.exec(trimmed);
	if (!m) throw invalidByteSize(raw);
	const value = Number(m[1]);
	if (!Number.isFinite(value) || value < 0) throw invalidByteSize(raw);
	const unit = normalizeLowercaseStringOrEmpty(m[2] ?? opts?.defaultUnit ?? "b");
	const multiplier = UNIT_MULTIPLIERS[unit];
	if (!multiplier) throw invalidByteSize(raw, `unknown unit "${unit}"`);
	const bytes = Math.round(value * multiplier);
	if (!Number.isFinite(bytes)) throw invalidByteSize(raw);
	return bytes;
}
//#endregion
//#region src/config/control-ui-css.ts
const CSS_WIDTH_KEYWORDS = new Set([
	"none",
	"min-content",
	"max-content"
]);
const CSS_WIDTH_FUNCTIONS = new Set([
	"calc",
	"clamp",
	"fit-content",
	"max",
	"min"
]);
const CSS_WIDTH_UNITS = new Set([
	"ch",
	"em",
	"rem",
	"vh",
	"vmax",
	"vmin",
	"vw",
	"px"
]);
const CSS_WIDTH_ALLOWED_CHARS = /^[0-9A-Za-z.%+\-*/(),\s]+$/;
const CSS_WIDTH_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9-]*/g;
const CSS_WIDTH_SIMPLE_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax|%)$/i;
const CSS_WIDTH_MAX_LENGTH = 96;
function hasBalancedParentheses(value) {
	let depth = 0;
	for (const char of value) if (char === "(") depth++;
	else if (char === ")") {
		depth--;
		if (depth < 0) return false;
	}
	return depth === 0;
}
function hasAllowedIdentifiers(value) {
	for (const match of value.matchAll(CSS_WIDTH_IDENTIFIER_RE)) {
		const identifier = match[0].toLowerCase();
		if (!CSS_WIDTH_FUNCTIONS.has(identifier) && !CSS_WIDTH_KEYWORDS.has(identifier) && !CSS_WIDTH_UNITS.has(identifier)) return false;
	}
	return true;
}
function normalizeControlUiChatMessageMaxWidth(value) {
	return value.trim().replace(/\s+/g, " ");
}
function isValidControlUiChatMessageMaxWidth(value) {
	const normalized = normalizeControlUiChatMessageMaxWidth(value);
	if (normalized.length === 0 || normalized.length > CSS_WIDTH_MAX_LENGTH) return false;
	if (CSS_WIDTH_KEYWORDS.has(normalized.toLowerCase())) return true;
	if (CSS_WIDTH_SIMPLE_RE.test(normalized)) return true;
	if (!CSS_WIDTH_ALLOWED_CHARS.test(normalized)) return false;
	if (!hasBalancedParentheses(normalized) || !hasAllowedIdentifiers(normalized)) return false;
	return /^(?:calc|clamp|fit-content|max|min)\(.+\)$/i.test(normalized);
}
//#endregion
//#region src/config/byte-size.ts
/**
* Parse an optional byte-size value from config.
* Accepts non-negative numbers or strings like "2mb".
*/
function parseNonNegativeByteSize(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		const int = Math.floor(value);
		return int >= 0 ? int : null;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		try {
			const bytes = parseByteSize(trimmed, { defaultUnit: "b" });
			return bytes >= 0 ? bytes : null;
		} catch {
			return null;
		}
	}
	return null;
}
function isValidNonNegativeByteSizeString(value) {
	return parseNonNegativeByteSize(value) !== null;
}
//#endregion
//#region src/config/zod-schema.agent-defaults.ts
const SilentReplyPolicySchema = union([literal("allow"), literal("disallow")]);
const NonNegativeByteSizeSchema = union([number().int().nonnegative(), string().refine(isValidNonNegativeByteSizeString, "Expected byte size string like 2mb")]);
const OptionalBootstrapFileNameSchema = _enum([
	"SOUL.md",
	"USER.md",
	"HEARTBEAT.md",
	"IDENTITY.md"
]);
const SilentReplyPolicyConfigSchema = object({
	group: SilentReplyPolicySchema.optional(),
	internal: SilentReplyPolicySchema.optional()
}).strict();
const AgentDefaultsSchema = object({
	/** Global default provider params applied to all models before per-model and per-agent overrides. */
	params: record(string(), unknown()).optional(),
	agentRuntime: AgentRuntimePolicySchema,
	embeddedHarness: AgentEmbeddedHarnessSchema,
	model: AgentModelSchema.optional(),
	imageModel: AgentToolModelSchema.optional(),
	imageGenerationModel: AgentToolModelSchema.optional(),
	videoGenerationModel: AgentToolModelSchema.optional(),
	musicGenerationModel: AgentToolModelSchema.optional(),
	mediaGenerationAutoProviderFallback: boolean().optional(),
	pdfModel: AgentToolModelSchema.optional(),
	pdfMaxBytesMb: number().positive().optional(),
	pdfMaxPages: number().int().positive().optional(),
	models: record(string(), object({
		alias: string().optional(),
		/** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
		params: record(string(), unknown()).optional(),
		agentRuntime: AgentRuntimePolicySchema,
		/** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
		streaming: boolean().optional()
	}).strict()).optional(),
	workspace: string().optional(),
	skills: array(string()).optional(),
	silentReply: SilentReplyPolicyConfigSchema.optional(),
	repoRoot: string().optional(),
	systemPromptOverride: string().optional(),
	promptOverlays: object({ gpt5: object({ personality: union([
		literal("friendly"),
		literal("on"),
		literal("off")
	]).optional() }).strict().optional() }).strict().optional(),
	skipBootstrap: boolean().optional(),
	skipOptionalBootstrapFiles: array(OptionalBootstrapFileNameSchema).optional(),
	contextInjection: union([
		literal("always"),
		literal("continuation-skip"),
		literal("never")
	]).optional(),
	bootstrapMaxChars: number().int().positive().optional(),
	bootstrapTotalMaxChars: number().int().positive().optional(),
	experimental: object({ localModelLean: boolean().optional() }).strict().optional(),
	bootstrapPromptTruncationWarning: union([
		literal("off"),
		literal("once"),
		literal("always")
	]).optional(),
	userTimezone: string().optional(),
	startupContext: object({
		enabled: boolean().optional(),
		applyOn: array(union([literal("new"), literal("reset")])).optional(),
		dailyMemoryDays: number().int().min(1).max(14).optional(),
		maxFileBytes: number().int().min(1).max(64 * 1024).optional(),
		maxFileChars: number().int().min(1).max(1e4).optional(),
		maxTotalChars: number().int().min(1).max(5e4).optional()
	}).strict().optional(),
	contextLimits: AgentContextLimitsSchema,
	timeFormat: union([
		literal("auto"),
		literal("12"),
		literal("24")
	]).optional(),
	envelopeTimezone: string().optional(),
	envelopeTimestamp: union([literal("on"), literal("off")]).optional(),
	envelopeElapsed: union([literal("on"), literal("off")]).optional(),
	contextTokens: number().int().positive().optional(),
	cliBackends: record(string(), CliBackendSchema).optional(),
	memorySearch: MemorySearchSchema,
	contextPruning: object({
		mode: union([literal("off"), literal("cache-ttl")]).optional(),
		ttl: string().optional(),
		keepLastAssistants: number().int().nonnegative().optional(),
		softTrimRatio: number().min(0).max(1).optional(),
		hardClearRatio: number().min(0).max(1).optional(),
		minPrunableToolChars: number().int().nonnegative().optional(),
		tools: object({
			allow: array(string()).optional(),
			deny: array(string()).optional()
		}).strict().optional(),
		softTrim: object({
			maxChars: number().int().nonnegative().optional(),
			headChars: number().int().nonnegative().optional(),
			tailChars: number().int().nonnegative().optional()
		}).strict().optional(),
		hardClear: object({
			enabled: boolean().optional(),
			placeholder: string().optional()
		}).strict().optional()
	}).strict().optional(),
	compaction: object({
		mode: union([literal("default"), literal("safeguard")]).optional(),
		provider: string().optional(),
		reserveTokens: number().int().nonnegative().optional(),
		keepRecentTokens: number().int().positive().optional(),
		reserveTokensFloor: number().int().nonnegative().optional(),
		maxHistoryShare: number().min(.1).max(.9).optional(),
		customInstructions: string().optional(),
		identifierPolicy: union([
			literal("strict"),
			literal("off"),
			literal("custom")
		]).optional(),
		identifierInstructions: string().optional(),
		recentTurnsPreserve: number().int().min(0).max(12).optional(),
		qualityGuard: object({
			enabled: boolean().optional(),
			maxRetries: number().int().nonnegative().optional()
		}).strict().optional(),
		midTurnPrecheck: object({ enabled: boolean().optional() }).strict().optional(),
		postIndexSync: _enum([
			"off",
			"async",
			"await"
		]).optional(),
		postCompactionSections: array(string()).optional(),
		model: string().optional(),
		timeoutSeconds: number().int().positive().optional(),
		memoryFlush: object({
			enabled: boolean().optional(),
			model: string().optional(),
			softThresholdTokens: number().int().nonnegative().optional(),
			forceFlushTranscriptBytes: NonNegativeByteSizeSchema.optional(),
			prompt: string().optional(),
			systemPrompt: string().optional()
		}).strict().optional(),
		truncateAfterCompaction: boolean().optional(),
		maxActiveTranscriptBytes: NonNegativeByteSizeSchema.optional(),
		notifyUser: boolean().optional()
	}).strict().optional(),
	runRetries: AgentRunRetriesConfigSchema.optional(),
	embeddedPi: object({
		projectSettingsPolicy: union([
			literal("trusted"),
			literal("sanitize"),
			literal("ignore")
		]).optional(),
		executionContract: union([literal("default"), literal("strict-agentic")]).optional()
	}).strict().optional(),
	thinkingDefault: union([
		literal("off"),
		literal("minimal"),
		literal("low"),
		literal("medium"),
		literal("high"),
		literal("xhigh"),
		literal("adaptive"),
		literal("max")
	]).optional(),
	verboseDefault: union([
		literal("off"),
		literal("on"),
		literal("full")
	]).optional(),
	toolProgressDetail: union([literal("explain"), literal("raw")]).optional(),
	reasoningDefault: union([
		literal("off"),
		literal("on"),
		literal("stream")
	]).optional(),
	elevatedDefault: union([
		literal("off"),
		literal("on"),
		literal("ask"),
		literal("full")
	]).optional(),
	blockStreamingDefault: union([literal("off"), literal("on")]).optional(),
	blockStreamingBreak: union([literal("text_end"), literal("message_end")]).optional(),
	blockStreamingChunk: BlockStreamingChunkSchema.optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	humanDelay: HumanDelaySchema.optional(),
	timeoutSeconds: number().int().positive().optional(),
	mediaMaxMb: number().positive().optional(),
	imageMaxDimensionPx: number().int().positive().optional(),
	typingIntervalSeconds: number().int().positive().optional(),
	typingMode: TypingModeSchema.optional(),
	heartbeat: HeartbeatSchema,
	maxConcurrent: number().int().positive().optional(),
	subagents: object({
		delegationMode: _enum(["suggest", "prefer"]).optional(),
		allowAgents: array(string()).optional(),
		maxConcurrent: number().int().positive().optional(),
		maxSpawnDepth: number().int().min(1).max(5).optional().describe("Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents."),
		maxChildrenPerAgent: number().int().min(1).max(20).optional().describe("Maximum number of active children a single agent session can spawn (default: 5)."),
		archiveAfterMinutes: number().int().min(0).optional(),
		model: AgentModelSchema.optional(),
		thinking: string().optional(),
		runTimeoutSeconds: number().int().min(0).optional(),
		announceTimeoutMs: number().int().positive().optional(),
		requireAgentId: boolean().optional()
	}).strict().optional(),
	sandbox: AgentSandboxSchema
}).strict().optional();
//#endregion
//#region src/config/zod-schema.agents.ts
const AgentsSchema = object({
	defaults: lazy(() => AgentDefaultsSchema).optional(),
	list: array(AgentEntrySchema).optional()
}).strict().optional();
const BindingMatchSchema = object({
	channel: string(),
	accountId: string().optional(),
	peer: object({
		kind: union([
			literal("direct"),
			literal("group"),
			literal("channel"),
			literal("dm")
		]),
		id: string()
	}).strict().optional(),
	guildId: string().optional(),
	teamId: string().optional(),
	roles: array(string()).optional()
}).strict();
const BindingSessionSchema = object({ dmScope: union([
	literal("main"),
	literal("per-peer"),
	literal("per-channel-peer"),
	literal("per-account-channel-peer")
]).optional() }).strict();
const BindingsSchema = array(union([object({
	type: literal("route").optional(),
	agentId: string(),
	comment: string().optional(),
	match: BindingMatchSchema,
	session: BindingSessionSchema.optional()
}).strict(), object({
	type: literal("acp"),
	agentId: string(),
	comment: string().optional(),
	match: BindingMatchSchema,
	acp: object({
		mode: _enum(["persistent", "oneshot"]).optional(),
		label: string().optional(),
		cwd: string().optional(),
		backend: string().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	if (!(normalizeOptionalString(value.match.peer?.id) ?? "")) {
		ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["match", "peer"],
			message: "ACP bindings require match.peer.id to target a concrete conversation."
		});
		return;
	}
})])).optional();
const BroadcastSchema = object({ strategy: _enum(["parallel", "sequential"]).optional() }).catchall(array(string())).optional();
const AudioSchema = object({ transcription: TranscribeAudioSchema }).strict().optional();
//#endregion
//#region src/config/zod-schema.channels-config.ts
const ChannelModelByChannelSchema = record(string(), record(string(), string())).optional();
const ChannelBotLoopProtectionSchema = object({
	enabled: boolean().optional(),
	maxEventsPerWindow: number().int().positive().optional(),
	windowSeconds: number().int().positive().optional(),
	cooldownSeconds: number().int().positive().optional()
}).strict();
function addLegacyChannelAcpBindingIssues(value, ctx, path = []) {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((entry, index) => addLegacyChannelAcpBindingIssues(entry, ctx, [...path, index]));
		return;
	}
	const record = value;
	const bindings = record.bindings;
	if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
		const acp = bindings.acp;
		if (acp && typeof acp === "object") ctx.addIssue({
			code: ZodIssueCode.custom,
			path: [
				...path,
				"bindings",
				"acp"
			],
			message: "Legacy channel-local ACP bindings were removed; use top-level bindings[] entries."
		});
	}
	for (const [key, entry] of Object.entries(record)) addLegacyChannelAcpBindingIssues(entry, ctx, [...path, key]);
}
const ChannelsSchema = object({
	defaults: object({
		groupPolicy: GroupPolicySchema.optional(),
		contextVisibility: ContextVisibilityModeSchema.optional(),
		heartbeat: ChannelHeartbeatVisibilitySchema,
		botLoopProtection: ChannelBotLoopProtectionSchema.optional()
	}).strict().optional(),
	modelByChannel: ChannelModelByChannelSchema
}).passthrough().superRefine((value, ctx) => {
	addLegacyChannelAcpBindingIssues(value, ctx);
}).optional();
//#endregion
//#region src/config/zod-schema.hooks.ts
function isSafeRelativeModulePath(raw) {
	const value = raw.trim();
	if (!value) return false;
	if (path.isAbsolute(value)) return false;
	if (value.startsWith("~")) return false;
	if (value.includes(":")) return false;
	if (value.split(/[\\/]+/g).some((part) => part === "..")) return false;
	return true;
}
const SafeRelativeModulePathSchema = string().refine(isSafeRelativeModulePath, "module must be a safe relative path (no absolute paths)");
const HookMappingSchema = object({
	id: string().optional(),
	match: object({
		path: string().optional(),
		source: string().optional()
	}).optional(),
	action: union([literal("wake"), literal("agent")]).optional(),
	wakeMode: union([literal("now"), literal("next-heartbeat")]).optional(),
	name: string().optional(),
	agentId: string().optional(),
	sessionKey: string().optional().register(sensitive),
	messageTemplate: string().optional(),
	textTemplate: string().optional(),
	deliver: boolean().optional(),
	allowUnsafeExternalContent: boolean().optional(),
	channel: string().trim().min(1).optional(),
	to: string().optional(),
	model: string().optional(),
	thinking: string().optional(),
	timeoutSeconds: number().int().positive().optional(),
	transform: object({
		module: SafeRelativeModulePathSchema,
		export: string().optional()
	}).strict().optional()
}).strict().optional();
const InternalHookHandlerSchema = object({
	event: string(),
	module: SafeRelativeModulePathSchema,
	export: string().optional()
}).strict();
const HookConfigSchema = object({
	enabled: boolean().optional(),
	env: record(string(), string()).optional()
}).passthrough();
const HookInstallRecordSchema = object({
	...InstallRecordShape,
	hooks: array(string()).optional()
}).strict();
const InternalHooksSchema = object({
	enabled: boolean().optional(),
	handlers: array(InternalHookHandlerSchema).optional(),
	entries: record(string(), HookConfigSchema).optional(),
	load: object({ extraDirs: array(string()).optional() }).strict().optional(),
	installs: record(string(), HookInstallRecordSchema).optional()
}).strict().optional();
const HooksGmailSchema = object({
	account: string().optional(),
	label: string().optional(),
	topic: string().optional(),
	subscription: string().optional(),
	pushToken: string().optional().register(sensitive),
	hookUrl: string().optional(),
	includeBody: boolean().optional(),
	maxBytes: number().int().positive().optional(),
	renewEveryMinutes: number().int().positive().optional(),
	allowUnsafeExternalContent: boolean().optional(),
	serve: object({
		bind: string().optional(),
		port: number().int().positive().optional(),
		path: string().optional()
	}).strict().optional(),
	tailscale: object({
		mode: union([
			literal("off"),
			literal("serve"),
			literal("funnel")
		]).optional(),
		path: string().optional(),
		target: string().optional()
	}).strict().optional(),
	model: string().optional(),
	thinking: union([
		literal("off"),
		literal("minimal"),
		literal("low"),
		literal("medium"),
		literal("high")
	]).optional()
}).strict().optional();
//#endregion
//#region src/config/zod-schema.proxy.ts
function isHttpOrHttpsProxyUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
const ProxyLoopbackModeSchema = _enum([
	"gateway-only",
	"proxy",
	"block"
]);
const ProxyTlsConfigSchema = object({ caFile: string().min(1).optional() }).strict().optional();
const ProxyConfigSchema = object({
	enabled: boolean().optional(),
	proxyUrl: url().refine(isHttpOrHttpsProxyUrl, { message: "proxyUrl must use http:// or https://" }).register(sensitive).optional(),
	tls: ProxyTlsConfigSchema,
	loopbackMode: ProxyLoopbackModeSchema.optional()
}).strict().optional();
//#endregion
//#region src/config/zod-schema.session.ts
const SessionResetConfigSchema = object({
	mode: union([literal("daily"), literal("idle")]).optional(),
	atHour: number().int().min(0).max(23).optional(),
	idleMinutes: number().int().positive().optional()
}).strict();
const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();
const SessionSchema = object({
	scope: union([literal("per-sender"), literal("global")]).optional(),
	dmScope: union([
		literal("main"),
		literal("per-peer"),
		literal("per-channel-peer"),
		literal("per-account-channel-peer")
	]).optional(),
	identityLinks: record(string(), array(string())).optional(),
	resetTriggers: array(string()).optional(),
	idleMinutes: number().int().positive().optional(),
	reset: SessionResetConfigSchema.optional(),
	resetByType: object({
		direct: SessionResetConfigSchema.optional(),
		/** @deprecated Use `direct` instead. Kept for backward compatibility. */
		dm: SessionResetConfigSchema.optional(),
		group: SessionResetConfigSchema.optional(),
		thread: SessionResetConfigSchema.optional()
	}).strict().optional(),
	resetByChannel: record(string(), SessionResetConfigSchema).optional(),
	store: string().optional(),
	typingIntervalSeconds: number().int().positive().optional(),
	typingMode: TypingModeSchema.optional(),
	mainKey: string().optional(),
	sendPolicy: SessionSendPolicySchema.optional(),
	writeLock: object({
		acquireTimeoutMs: number().int().positive().optional(),
		staleMs: number().int().positive().optional(),
		maxHoldMs: number().int().positive().optional()
	}).strict().optional(),
	agentToAgent: object({ maxPingPongTurns: number().int().min(0).max(20).optional() }).strict().optional(),
	threadBindings: object({
		enabled: boolean().optional(),
		idleHours: number().nonnegative().optional(),
		maxAgeHours: number().nonnegative().optional(),
		spawnSessions: boolean().optional(),
		defaultSpawnContext: _enum(["isolated", "fork"]).optional()
	}).strict().optional(),
	maintenance: object({
		mode: _enum(["enforce", "warn"]).optional(),
		pruneAfter: union([string(), number()]).optional(),
		/** @deprecated Use pruneAfter instead. */
		pruneDays: number().int().positive().optional(),
		maxEntries: number().int().positive().optional(),
		rotateBytes: union([string(), number()]).optional(),
		resetArchiveRetention: union([
			string(),
			number(),
			literal(false)
		]).optional(),
		maxDiskBytes: union([string(), number()]).optional(),
		highWaterBytes: union([string(), number()]).optional()
	}).strict().superRefine((val, ctx) => {
		if (val.pruneAfter !== void 0) try {
			parseDurationMs(normalizeStringifiedOptionalString(val.pruneAfter) ?? "", { defaultUnit: "d" });
		} catch {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["pruneAfter"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.resetArchiveRetention !== void 0 && val.resetArchiveRetention !== false) try {
			parseDurationMs(normalizeStringifiedOptionalString(val.resetArchiveRetention) ?? "", { defaultUnit: "d" });
		} catch {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["resetArchiveRetention"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.maxDiskBytes !== void 0) try {
			parseByteSize(normalizeStringifiedOptionalString(val.maxDiskBytes) ?? "", { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["maxDiskBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
		if (val.highWaterBytes !== void 0) try {
			parseByteSize(normalizeStringifiedOptionalString(val.highWaterBytes) ?? "", { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["highWaterBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
	}).optional()
}).strict().optional();
const MessagesSchema = object({
	messagePrefix: string().optional(),
	visibleReplies: VisibleRepliesSchema.optional(),
	responsePrefix: string().optional(),
	groupChat: GroupChatSchema,
	queue: QueueSchema,
	inbound: InboundDebounceSchema,
	ackReaction: string().optional(),
	ackReactionScope: _enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"off",
		"none"
	]).optional(),
	removeAckAfterReply: boolean().optional(),
	statusReactions: object({
		enabled: boolean().optional(),
		emojis: object({
			thinking: string().optional(),
			tool: string().optional(),
			coding: string().optional(),
			web: string().optional(),
			deploy: string().optional(),
			build: string().optional(),
			concierge: string().optional(),
			done: string().optional(),
			error: string().optional(),
			stallSoft: string().optional(),
			stallHard: string().optional(),
			compacting: string().optional()
		}).strict().optional(),
		timing: object({
			debounceMs: number().int().min(0).optional(),
			stallSoftMs: number().int().min(0).optional(),
			stallHardMs: number().int().min(0).optional(),
			doneHoldMs: number().int().min(0).optional(),
			errorHoldMs: number().int().min(0).optional()
		}).strict().optional()
	}).strict().optional(),
	suppressToolErrors: boolean().optional(),
	tts: TtsConfigSchema
}).strict().optional();
const CommandsSchema = object({
	native: NativeCommandsSettingSchema.optional().default("auto"),
	nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
	text: boolean().optional(),
	bash: boolean().optional(),
	bashForegroundMs: number().int().min(0).max(3e4).optional(),
	config: boolean().optional(),
	mcp: boolean().optional(),
	plugins: boolean().optional(),
	debug: boolean().optional(),
	restart: boolean().optional().default(true),
	useAccessGroups: boolean().optional(),
	ownerAllowFrom: array(union([string(), number()])).optional(),
	ownerDisplay: _enum(["raw", "hash"]).optional().default("raw"),
	ownerDisplaySecret: string().optional().register(sensitive),
	allowFrom: ElevatedAllowFromSchema.optional()
}).strict().optional().default(() => ({
	native: "auto",
	nativeSkills: "auto",
	restart: true,
	ownerDisplay: "raw"
}));
//#endregion
//#region src/config/zod-schema.ts
const BrowserSnapshotDefaultsSchema = object({ mode: literal("efficient").optional() }).strict().optional();
const NodeHostSchema = object({ browserProxy: object({
	enabled: boolean().optional(),
	allowProfiles: array(string()).optional()
}).strict().optional() }).strict().optional();
const GatewayRemoteConfigSchema = object({
	enabled: boolean().optional(),
	url: string().optional(),
	transport: union([literal("ssh"), literal("direct")]).optional(),
	remotePort: number().int().min(1).max(65535).optional(),
	token: SecretInputSchema.optional().register(sensitive),
	password: SecretInputSchema.optional().register(sensitive),
	tlsFingerprint: string().optional(),
	sshTarget: string().optional(),
	sshIdentity: string().optional()
}).strict().optional();
const LegacyCanvasHostSchema = object({
	enabled: boolean().optional(),
	root: string().optional(),
	port: number().int().positive().optional(),
	liveReload: boolean().optional()
}).strict().optional();
const SecuritySchema = object({ audit: object({ suppressions: array(object({
	checkId: string().min(1),
	titleIncludes: string().min(1).optional(),
	detailIncludes: string().min(1).optional(),
	reason: string().min(1).optional()
}).strict()).optional() }).strict().optional() }).strict().optional();
const AccessGroupsSchema = record(string().min(1), discriminatedUnion("type", [object({
	type: literal("discord.channelAudience"),
	guildId: string().min(1),
	channelId: string().min(1),
	membership: literal("canViewChannel").optional()
}).strict(), object({
	type: literal("message.senders"),
	members: record(string().min(1), array(string().min(1)))
}).strict()])).optional();
const MemoryQmdPathSchema = object({
	path: string(),
	name: string().optional(),
	pattern: string().optional()
}).strict();
const MemoryQmdSessionSchema = object({
	enabled: boolean().optional(),
	exportDir: string().optional(),
	retentionDays: number().int().nonnegative().optional()
}).strict();
const MemoryQmdUpdateSchema = object({
	interval: string().optional(),
	debounceMs: number().int().nonnegative().optional(),
	onBoot: boolean().optional(),
	startup: _enum([
		"off",
		"idle",
		"immediate"
	]).optional(),
	startupDelayMs: number().int().nonnegative().optional(),
	waitForBootSync: boolean().optional(),
	embedInterval: string().optional(),
	commandTimeoutMs: number().int().nonnegative().optional(),
	updateTimeoutMs: number().int().nonnegative().optional(),
	embedTimeoutMs: number().int().nonnegative().optional()
}).strict();
const MemoryQmdLimitsSchema = object({
	maxResults: number().int().positive().optional(),
	maxSnippetChars: number().int().positive().optional(),
	maxInjectedChars: number().int().positive().optional(),
	timeoutMs: number().int().nonnegative().optional()
}).strict();
const MemoryQmdMcporterSchema = object({
	enabled: boolean().optional(),
	serverName: string().optional(),
	startDaemon: boolean().optional()
}).strict();
const LoggingLevelSchema = union([
	literal("silent"),
	literal("fatal"),
	literal("error"),
	literal("warn"),
	literal("info"),
	literal("debug"),
	literal("trace")
]);
const MemoryQmdSchema = object({
	command: string().optional(),
	mcporter: MemoryQmdMcporterSchema.optional(),
	searchMode: union([
		literal("query"),
		literal("search"),
		literal("vsearch")
	]).optional(),
	searchTool: string().trim().min(1).optional(),
	includeDefaultMemory: boolean().optional(),
	paths: array(MemoryQmdPathSchema).optional(),
	sessions: MemoryQmdSessionSchema.optional(),
	update: MemoryQmdUpdateSchema.optional(),
	limits: MemoryQmdLimitsSchema.optional(),
	scope: SessionSendPolicySchema.optional()
}).strict();
const MemorySchema = object({
	backend: union([literal("builtin"), literal("qmd")]).optional(),
	citations: union([
		literal("auto"),
		literal("on"),
		literal("off")
	]).optional(),
	qmd: MemoryQmdSchema.optional()
}).strict().optional();
const HttpUrlSchema = string().url().refine((value) => {
	const protocol = new URL(value).protocol;
	return protocol === "http:" || protocol === "https:";
}, "Expected http:// or https:// URL");
const ResponsesEndpointUrlFetchShape = {
	allowUrl: boolean().optional(),
	urlAllowlist: array(string()).optional(),
	allowedMimes: array(string()).optional(),
	maxBytes: number().int().positive().optional(),
	maxRedirects: number().int().nonnegative().optional(),
	timeoutMs: number().int().positive().optional()
};
const SkillEntrySchema = object({
	enabled: boolean().optional(),
	apiKey: SecretInputSchema.optional().register(sensitive),
	env: record(string(), string()).optional(),
	config: record(string(), unknown()).optional()
}).strict();
const PluginEntrySchema = object({
	enabled: boolean().optional(),
	hooks: object({
		allowPromptInjection: boolean().optional(),
		allowConversationAccess: boolean().optional(),
		timeoutMs: number().int().positive().max(6e5).optional(),
		timeouts: record(string(), number().int().positive().max(6e5)).optional()
	}).strict().optional(),
	subagent: object({
		allowModelOverride: boolean().optional(),
		allowedModels: array(string()).optional()
	}).strict().optional(),
	llm: object({
		allowModelOverride: boolean().optional(),
		allowedModels: array(string()).optional(),
		allowAgentIdOverride: boolean().optional()
	}).strict().optional(),
	config: record(string(), unknown()).optional()
}).strict();
const TalkProviderEntrySchema = object({ apiKey: SecretInputSchema.optional().register(sensitive) }).catchall(unknown());
const TalkRealtimeSchema = object({
	provider: string().optional(),
	providers: record(string(), TalkProviderEntrySchema).optional(),
	model: string().optional(),
	voice: string().optional(),
	instructions: string().optional(),
	mode: _enum([
		"realtime",
		"stt-tts",
		"transcription"
	]).optional(),
	transport: _enum([
		"webrtc",
		"provider-websocket",
		"gateway-relay",
		"managed-room"
	]).optional(),
	brain: _enum([
		"agent-consult",
		"direct-tools",
		"none"
	]).optional(),
	consultRouting: _enum(["provider-direct", "force-agent-consult"]).optional()
}).strict().superRefine((realtime, ctx) => {
	const provider = normalizeLowercaseStringOrEmpty(realtime.provider ?? "");
	const providers = realtime.providers ? Object.keys(realtime.providers) : [];
	if (provider && providers.length > 0 && !(provider in realtime.providers)) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["provider"],
		message: `talk.realtime.provider must match a key in talk.realtime.providers (missing "${provider}")`
	});
	if (!provider && providers.length > 1) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["provider"],
		message: "talk.realtime.provider is required when talk.realtime.providers defines multiple providers"
	});
});
const TalkSchema = object({
	provider: string().optional(),
	providers: record(string(), TalkProviderEntrySchema).optional(),
	realtime: TalkRealtimeSchema.optional(),
	consultThinkingLevel: _enum([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"adaptive",
		"max"
	]).optional(),
	consultFastMode: boolean().optional(),
	speechLocale: string().optional(),
	interruptOnSpeech: boolean().optional(),
	silenceTimeoutMs: number().int().positive().optional()
}).strict().superRefine((talk, ctx) => {
	const provider = normalizeLowercaseStringOrEmpty(talk.provider ?? "");
	const providers = talk.providers ? Object.keys(talk.providers) : [];
	if (provider && providers.length > 0 && !(provider in talk.providers)) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["provider"],
		message: `talk.provider must match a key in talk.providers (missing "${provider}")`
	});
	if (!provider && providers.length > 1) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["provider"],
		message: "talk.provider is required when talk.providers defines multiple providers"
	});
});
const McpServerSchema = object({
	command: string().optional(),
	args: array(string()).optional(),
	env: record(string(), union([
		string(),
		number(),
		boolean()
	])).optional(),
	cwd: string().optional(),
	workingDirectory: string().optional(),
	url: HttpUrlSchema.optional(),
	transport: union([literal("sse"), literal("streamable-http")]).optional(),
	headers: record(string(), union([
		string().register(sensitive),
		number(),
		boolean()
	]).register(sensitive)).optional(),
	codex: object({
		agents: array(string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i)).min(1).optional(),
		defaultToolsApprovalMode: _enum([
			"auto",
			"prompt",
			"approve"
		]).optional(),
		default_tools_approval_mode: _enum([
			"auto",
			"prompt",
			"approve"
		]).optional()
	}).strict().optional()
}).catchall(unknown());
const McpConfigSchema = object({
	servers: record(string(), McpServerSchema).optional(),
	sessionIdleTtlMs: number().finite().min(0).optional()
}).strict().optional();
const CrestodianSchema = object({ rescue: object({
	enabled: union([literal("auto"), boolean()]).optional(),
	ownerDmOnly: boolean().optional(),
	pendingTtlMinutes: number().int().positive().optional()
}).strict().optional() }).strict().optional();
const CommitmentsSchema = object({
	enabled: boolean().optional(),
	maxPerDay: number().int().positive().optional()
}).strict().optional();
const OpenClawSchema = object({
	$schema: string().optional(),
	meta: object({
		lastTouchedVersion: string().optional(),
		lastTouchedAt: union([string(), number().transform((n, ctx) => {
			const d = new Date(n);
			if (Number.isNaN(d.getTime())) {
				ctx.addIssue({
					code: ZodIssueCode.custom,
					message: "Invalid timestamp"
				});
				return NEVER;
			}
			return d.toISOString();
		})]).optional()
	}).strict().optional(),
	env: object({
		shellEnv: object({
			enabled: boolean().optional(),
			timeoutMs: number().int().nonnegative().optional()
		}).strict().optional(),
		vars: record(string(), string()).optional()
	}).catchall(string()).optional(),
	wizard: object({
		lastRunAt: string().optional(),
		lastRunVersion: string().optional(),
		lastRunCommit: string().optional(),
		lastRunCommand: string().optional(),
		lastRunMode: union([literal("local"), literal("remote")]).optional()
	}).strict().optional(),
	diagnostics: object({
		enabled: boolean().optional(),
		flags: array(string()).optional(),
		stuckSessionWarnMs: number().int().positive().optional(),
		stuckSessionAbortMs: number().int().positive().optional(),
		memoryPressureSnapshot: boolean().optional(),
		otel: object({
			enabled: boolean().optional(),
			endpoint: string().optional(),
			tracesEndpoint: string().optional(),
			metricsEndpoint: string().optional(),
			logsEndpoint: string().optional(),
			protocol: union([literal("http/protobuf"), literal("grpc")]).optional(),
			headers: record(string(), string()).optional(),
			serviceName: string().optional(),
			traces: boolean().optional(),
			metrics: boolean().optional(),
			logs: boolean().optional(),
			sampleRate: number().min(0).max(1).optional(),
			flushIntervalMs: number().int().nonnegative().optional(),
			captureContent: union([boolean(), object({
				enabled: boolean().optional(),
				inputMessages: boolean().optional(),
				outputMessages: boolean().optional(),
				toolInputs: boolean().optional(),
				toolOutputs: boolean().optional(),
				systemPrompt: boolean().optional()
			}).strict()]).optional()
		}).strict().optional(),
		cacheTrace: object({
			enabled: boolean().optional(),
			filePath: string().optional(),
			includeMessages: boolean().optional(),
			includePrompt: boolean().optional(),
			includeSystem: boolean().optional()
		}).strict().optional()
	}).strict().optional(),
	logging: object({
		level: LoggingLevelSchema.optional(),
		file: string().optional(),
		maxFileBytes: number().int().positive().optional(),
		consoleLevel: LoggingLevelSchema.optional(),
		consoleStyle: union([
			literal("pretty"),
			literal("compact"),
			literal("json")
		]).optional(),
		redactSensitive: union([literal("off"), literal("tools")]).optional(),
		redactPatterns: array(string()).optional()
	}).strict().optional(),
	cli: object({ banner: object({ taglineMode: union([
		literal("random"),
		literal("default"),
		literal("off")
	]).optional() }).strict().optional() }).strict().optional(),
	crestodian: CrestodianSchema,
	update: object({
		channel: union([
			literal("stable"),
			literal("beta"),
			literal("dev")
		]).optional(),
		checkOnStart: boolean().optional(),
		auto: object({
			enabled: boolean().optional(),
			stableDelayHours: number().nonnegative().max(168).optional(),
			stableJitterHours: number().nonnegative().max(168).optional(),
			betaCheckIntervalHours: number().positive().max(24).optional()
		}).strict().optional()
	}).strict().optional(),
	browser: object({
		enabled: boolean().optional(),
		evaluateEnabled: boolean().optional(),
		cdpUrl: string().optional(),
		remoteCdpTimeoutMs: number().int().nonnegative().optional(),
		remoteCdpHandshakeTimeoutMs: number().int().nonnegative().optional(),
		localLaunchTimeoutMs: number().int().positive().max(12e4).optional(),
		localCdpReadyTimeoutMs: number().int().positive().max(12e4).optional(),
		actionTimeoutMs: number().int().positive().optional(),
		color: string().optional(),
		executablePath: string().optional(),
		headless: boolean().optional(),
		noSandbox: boolean().optional(),
		attachOnly: boolean().optional(),
		cdpPortRangeStart: number().int().min(1).max(65535).optional(),
		defaultProfile: string().optional(),
		snapshotDefaults: BrowserSnapshotDefaultsSchema,
		ssrfPolicy: object({
			dangerouslyAllowPrivateNetwork: boolean().optional(),
			allowedHostnames: array(string()).optional(),
			hostnameAllowlist: array(string()).optional()
		}).strict().optional(),
		profiles: record(string().regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"), object({
			cdpPort: number().int().min(1).max(65535).optional(),
			cdpUrl: string().optional(),
			userDataDir: string().optional(),
			mcpCommand: string().optional(),
			mcpArgs: array(string()).optional(),
			driver: union([
				literal("openclaw"),
				literal("clawd"),
				literal("existing-session")
			]).optional(),
			headless: boolean().optional(),
			executablePath: string().optional(),
			attachOnly: boolean().optional(),
			color: HexColorSchema
		}).strict().refine((value) => value.driver === "existing-session" || value.cdpPort || value.cdpUrl, { message: "Profile must set cdpPort or cdpUrl" }).refine((value) => value.driver === "existing-session" || !value.userDataDir, { message: "Profile userDataDir is only supported with driver=\"existing-session\"" })).optional(),
		extraArgs: array(string()).optional(),
		tabCleanup: object({
			enabled: boolean().optional(),
			idleMinutes: number().int().nonnegative().optional(),
			maxTabsPerSession: number().int().nonnegative().optional(),
			sweepMinutes: number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	ui: object({
		seamColor: HexColorSchema.optional(),
		assistant: object({
			name: string().max(50).optional(),
			avatar: string().max(2e6).optional()
		}).strict().optional()
	}).strict().optional(),
	secrets: SecretsConfigSchema,
	auth: object({
		profiles: record(string(), object({
			provider: string(),
			mode: union([
				literal("api_key"),
				literal("aws-sdk"),
				literal("oauth"),
				literal("token")
			]),
			email: string().optional(),
			displayName: string().optional()
		}).strict()).optional(),
		order: record(string(), array(string())).optional(),
		cooldowns: object({
			billingBackoffHours: number().positive().optional(),
			billingBackoffHoursByProvider: record(string(), number().positive()).optional(),
			billingMaxHours: number().positive().optional(),
			authPermanentBackoffMinutes: number().positive().optional(),
			authPermanentMaxMinutes: number().positive().optional(),
			failureWindowHours: number().positive().optional(),
			overloadedProfileRotations: number().int().nonnegative().optional(),
			overloadedBackoffMs: number().int().nonnegative().optional(),
			rateLimitedProfileRotations: number().int().nonnegative().optional()
		}).strict().optional()
	}).strict().optional(),
	accessGroups: AccessGroupsSchema,
	acp: object({
		enabled: boolean().optional(),
		dispatch: object({ enabled: boolean().optional() }).strict().optional(),
		backend: string().optional(),
		fallbacks: array(string()).optional(),
		defaultAgent: string().optional(),
		allowedAgents: array(string()).optional(),
		maxConcurrentSessions: number().int().positive().optional(),
		stream: object({
			coalesceIdleMs: number().int().nonnegative().optional(),
			maxChunkChars: number().int().positive().optional(),
			repeatSuppression: boolean().optional(),
			deliveryMode: union([literal("live"), literal("final_only")]).optional(),
			hiddenBoundarySeparator: union([
				literal("none"),
				literal("space"),
				literal("newline"),
				literal("paragraph")
			]).optional(),
			maxOutputChars: number().int().positive().optional(),
			maxSessionUpdateChars: number().int().positive().optional(),
			tagVisibility: record(string(), boolean()).optional()
		}).strict().optional(),
		runtime: object({
			ttlMinutes: number().int().positive().optional(),
			installCommand: string().optional()
		}).strict().optional()
	}).strict().optional(),
	models: ModelsConfigSchema,
	nodeHost: NodeHostSchema,
	agents: AgentsSchema,
	tools: ToolsSchema,
	security: SecuritySchema,
	bindings: BindingsSchema,
	broadcast: BroadcastSchema,
	audio: AudioSchema,
	media: object({
		preserveFilenames: boolean().optional(),
		ttlHours: number().int().min(1).max(168).optional()
	}).strict().optional(),
	messages: MessagesSchema,
	commands: CommandsSchema,
	approvals: ApprovalsSchema,
	session: SessionSchema,
	cron: object({
		enabled: boolean().optional(),
		store: string().optional(),
		maxConcurrentRuns: number().int().positive().optional(),
		retry: object({
			maxAttempts: number().int().min(0).max(10).optional(),
			backoffMs: array(number().int().nonnegative()).min(1).max(10).optional(),
			retryOn: array(_enum([
				"rate_limit",
				"overloaded",
				"network",
				"timeout",
				"server_error"
			])).min(1).optional()
		}).strict().optional(),
		webhook: HttpUrlSchema.optional(),
		webhookToken: SecretInputSchema.optional().register(sensitive),
		sessionRetention: union([string(), literal(false)]).optional(),
		runLog: object({
			maxBytes: union([string(), number()]).optional(),
			keepLines: number().int().positive().optional()
		}).strict().optional(),
		failureAlert: object({
			enabled: boolean().optional(),
			after: number().int().min(1).optional(),
			cooldownMs: number().int().min(0).optional(),
			includeSkipped: boolean().optional(),
			mode: _enum(["announce", "webhook"]).optional(),
			accountId: string().optional()
		}).strict().optional(),
		failureDestination: object({
			channel: string().optional(),
			to: string().optional(),
			accountId: string().optional(),
			mode: _enum(["announce", "webhook"]).optional()
		}).strict().optional()
	}).strict().superRefine((val, ctx) => {
		if (val.sessionRetention !== void 0 && val.sessionRetention !== false) try {
			parseDurationMs(normalizeStringifiedOptionalString(val.sessionRetention) ?? "", { defaultUnit: "h" });
		} catch {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["sessionRetention"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.runLog?.maxBytes !== void 0) try {
			parseByteSize(normalizeStringifiedOptionalString(val.runLog.maxBytes) ?? "", { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["runLog", "maxBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
	}).optional(),
	commitments: CommitmentsSchema,
	hooks: object({
		enabled: boolean().optional(),
		path: string().optional(),
		token: string().optional().register(sensitive),
		defaultSessionKey: string().optional(),
		allowRequestSessionKey: boolean().optional(),
		allowedSessionKeyPrefixes: array(string()).optional(),
		allowedAgentIds: array(string()).optional(),
		maxBodyBytes: number().int().positive().optional(),
		presets: array(string()).optional(),
		transformsDir: string().optional(),
		mappings: array(HookMappingSchema).optional(),
		gmail: HooksGmailSchema,
		internal: InternalHooksSchema
	}).strict().optional(),
	web: object({
		enabled: boolean().optional(),
		heartbeatSeconds: number().int().positive().optional(),
		reconnect: object({
			initialMs: number().positive().optional(),
			maxMs: number().positive().optional(),
			factor: number().positive().optional(),
			jitter: number().min(0).max(1).optional(),
			maxAttempts: number().int().min(0).optional()
		}).strict().optional(),
		whatsapp: object({
			keepAliveIntervalMs: number().int().positive().optional(),
			connectTimeoutMs: number().int().positive().optional(),
			defaultQueryTimeoutMs: number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	channels: ChannelsSchema,
	discovery: object({
		wideArea: object({
			enabled: boolean().optional(),
			domain: string().optional()
		}).strict().optional(),
		mdns: object({ mode: _enum([
			"off",
			"minimal",
			"full"
		]).optional() }).strict().optional()
	}).strict().optional(),
	talk: TalkSchema.optional(),
	gateway: object({
		port: number().int().positive().optional(),
		mode: union([literal("local"), literal("remote")]).optional(),
		bind: union([
			literal("auto"),
			literal("lan"),
			literal("loopback"),
			literal("custom"),
			literal("tailnet")
		]).optional(),
		customBindHost: string().optional(),
		controlUi: object({
			enabled: boolean().optional(),
			basePath: string().optional(),
			root: string().optional(),
			embedSandbox: union([
				literal("strict"),
				literal("scripts"),
				literal("trusted")
			]).optional(),
			allowExternalEmbedUrls: boolean().optional(),
			chatMessageMaxWidth: string().transform((value) => normalizeControlUiChatMessageMaxWidth(value)).refine((value) => isValidControlUiChatMessageMaxWidth(value), { message: "Expected a CSS width value such as 960px, 82%, min(1280px, 82%), or calc(100% - 2rem)" }).optional(),
			allowedOrigins: array(string()).optional(),
			dangerouslyAllowHostHeaderOriginFallback: boolean().optional(),
			allowInsecureAuth: boolean().optional(),
			dangerouslyDisableDeviceAuth: boolean().optional()
		}).strict().optional(),
		auth: object({
			mode: union([
				literal("none"),
				literal("token"),
				literal("password"),
				literal("trusted-proxy")
			]).optional(),
			token: SecretInputSchema.optional().register(sensitive),
			password: SecretInputSchema.optional().register(sensitive),
			allowTailscale: boolean().optional(),
			rateLimit: object({
				maxAttempts: number().optional(),
				windowMs: number().optional(),
				lockoutMs: number().optional(),
				exemptLoopback: boolean().optional()
			}).strict().optional(),
			trustedProxy: object({
				userHeader: string().min(1, "userHeader is required for trusted-proxy mode"),
				requiredHeaders: array(string()).optional(),
				allowUsers: array(string()).optional(),
				allowLoopback: boolean().optional()
			}).strict().optional()
		}).strict().optional(),
		trustedProxies: array(string()).optional(),
		allowRealIpFallback: boolean().optional(),
		tools: object({
			deny: array(string()).optional(),
			allow: array(string()).optional()
		}).strict().optional(),
		webchat: object({ chatHistoryMaxChars: number().int().positive().max(5e5).optional() }).strict().optional(),
		handshakeTimeoutMs: number().int().min(1).optional(),
		channelHealthCheckMinutes: number().int().min(0).optional(),
		channelStaleEventThresholdMinutes: number().int().min(1).optional(),
		channelMaxRestartsPerHour: number().int().min(1).optional(),
		tailscale: object({
			mode: union([
				literal("off"),
				literal("serve"),
				literal("funnel")
			]).optional(),
			resetOnExit: boolean().optional(),
			preserveFunnel: boolean().optional()
		}).strict().optional(),
		remote: GatewayRemoteConfigSchema,
		reload: object({
			mode: union([
				literal("off"),
				literal("restart"),
				literal("hot"),
				literal("hybrid")
			]).optional(),
			debounceMs: number().int().min(0).optional(),
			deferralTimeoutMs: number().int().min(0).optional()
		}).strict().optional(),
		tls: object({
			enabled: boolean().optional(),
			autoGenerate: boolean().optional(),
			certPath: string().optional(),
			keyPath: string().optional(),
			caPath: string().optional()
		}).optional(),
		http: object({
			endpoints: object({
				chatCompletions: object({
					enabled: boolean().optional(),
					maxBodyBytes: number().int().positive().optional(),
					maxImageParts: number().int().nonnegative().optional(),
					maxTotalImageBytes: number().int().positive().optional(),
					images: object({ ...ResponsesEndpointUrlFetchShape }).strict().optional()
				}).strict().optional(),
				responses: object({
					enabled: boolean().optional(),
					maxBodyBytes: number().int().positive().optional(),
					maxUrlParts: number().int().nonnegative().optional(),
					files: object({
						...ResponsesEndpointUrlFetchShape,
						maxChars: number().int().positive().optional(),
						pdf: object({
							maxPages: number().int().positive().optional(),
							maxPixels: number().int().positive().optional(),
							minTextChars: number().int().nonnegative().optional()
						}).strict().optional()
					}).strict().optional(),
					images: object({ ...ResponsesEndpointUrlFetchShape }).strict().optional()
				}).strict().optional()
			}).strict().optional(),
			securityHeaders: object({ strictTransportSecurity: union([string(), literal(false)]).optional() }).strict().optional()
		}).strict().optional(),
		push: object({ apns: object({ relay: object({
			baseUrl: string().optional(),
			timeoutMs: number().int().positive().optional()
		}).strict().optional() }).strict().optional() }).strict().optional(),
		nodes: object({
			browser: object({
				mode: union([
					literal("auto"),
					literal("manual"),
					literal("off")
				]).optional(),
				node: string().optional()
			}).strict().optional(),
			pairing: object({ autoApproveCidrs: array(string()).optional() }).strict().optional(),
			allowCommands: array(string()).optional(),
			denyCommands: array(string()).optional()
		}).strict().optional()
	}).strict().superRefine((gateway, ctx) => {
		const effectiveHealthCheckMinutes = gateway.channelHealthCheckMinutes ?? 5;
		if (gateway.channelStaleEventThresholdMinutes != null && effectiveHealthCheckMinutes !== 0 && gateway.channelStaleEventThresholdMinutes < effectiveHealthCheckMinutes) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["channelStaleEventThresholdMinutes"],
			message: "channelStaleEventThresholdMinutes should be >= channelHealthCheckMinutes to avoid delayed stale detection"
		});
	}).optional(),
	memory: MemorySchema,
	mcp: McpConfigSchema,
	skills: object({
		allowBundled: array(string()).optional(),
		load: object({
			extraDirs: array(string()).optional(),
			allowSymlinkTargets: array(string()).optional(),
			watch: boolean().optional(),
			watchDebounceMs: number().int().min(0).optional()
		}).strict().optional(),
		install: object({
			preferBrew: boolean().optional(),
			nodeManager: union([
				literal("npm"),
				literal("pnpm"),
				literal("yarn"),
				literal("bun")
			]).optional(),
			allowUploadedArchives: boolean().optional()
		}).strict().optional(),
		limits: object({
			maxCandidatesPerRoot: number().int().min(1).optional(),
			maxSkillsLoadedPerSource: number().int().min(1).optional(),
			maxSkillsInPrompt: number().int().min(0).optional(),
			maxSkillsPromptChars: number().int().min(0).optional(),
			maxSkillFileBytes: number().int().min(0).optional()
		}).strict().optional(),
		entries: record(string(), SkillEntrySchema).optional()
	}).strict().optional(),
	plugins: object({
		enabled: boolean().optional(),
		allow: array(string()).optional(),
		deny: array(string()).optional(),
		load: object({ paths: array(string()).optional() }).strict().optional(),
		slots: object({
			memory: string().optional(),
			contextEngine: string().optional()
		}).strict().optional(),
		entries: record(string(), PluginEntrySchema).optional(),
		bundledDiscovery: _enum(["compat", "allowlist"]).optional()
	}).strict().optional(),
	canvasHost: LegacyCanvasHostSchema,
	surfaces: record(string(), object({ silentReply: SilentReplyPolicyConfigSchema.optional() }).strict()).optional(),
	proxy: ProxyConfigSchema
}).strict().superRefine((cfg, ctx) => {
	const agents = cfg.agents?.list ?? [];
	if (agents.length === 0) return;
	const agentIds = new Set(agents.map((agent) => agent.id));
	const broadcast = cfg.broadcast;
	if (!broadcast) return;
	for (const [peerId, ids] of Object.entries(broadcast)) {
		if (peerId === "strategy") continue;
		if (!Array.isArray(ids)) continue;
		for (let idx = 0; idx < ids.length; idx += 1) {
			const agentId = ids[idx];
			if (!agentIds.has(agentId)) ctx.addIssue({
				code: ZodIssueCode.custom,
				path: [
					"broadcast",
					peerId,
					idx
				],
				message: `Unknown agent id "${agentId}" (not in agents.list).`
			});
		}
	}
});
//#endregion
export { parseNonNegativeByteSize as n, parseByteSize as r, OpenClawSchema as t };
