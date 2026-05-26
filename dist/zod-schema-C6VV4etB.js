import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as InstallRecordShape } from "./zod-schema.installs-DTTZnerp.js";
import { t as parseDurationMs } from "./parse-duration-961Oqdwr.js";
import { a as AgentSandboxSchema, c as MemorySearchSchema, d as AgentModelSchema, i as AgentRuntimePolicySchema, n as AgentEmbeddedHarnessSchema, o as ElevatedAllowFromSchema, r as AgentEntrySchema, s as HeartbeatSchema, t as AgentContextLimitsSchema, u as ToolsSchema } from "./zod-schema.agent-runtime-CkLkDy5d.js";
import { C as SecretInputSchema, E as SecretsConfigSchema, F as VisibleRepliesSchema, P as TypingModeSchema, R as createAllowDenyChannelRulesSchema, _ as NativeCommandsSettingSchema, c as GroupChatSchema, d as HumanDelaySchema, g as ModelsConfigSchema, i as ContextVisibilityModeSchema, j as TtsConfigSchema, k as TranscribeAudioSchema, l as GroupPolicySchema, n as BlockStreamingCoalesceSchema, p as InboundDebounceSchema, r as CliBackendSchema, t as BlockStreamingChunkSchema, u as HexColorSchema, y as QueueSchema } from "./zod-schema.core-CrlgnnCI.js";
import { t as sensitive } from "./zod-schema.sensitive-DZxjbqai.js";
import { l as ChannelHeartbeatVisibilitySchema } from "./zod-schema.providers-whatsapp-BElo3xB4.js";
import path from "node:path";
import { z } from "zod";
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
const SilentReplyPolicySchema = z.union([z.literal("allow"), z.literal("disallow")]);
const NonNegativeByteSizeSchema = z.union([z.number().int().nonnegative(), z.string().refine(isValidNonNegativeByteSizeString, "Expected byte size string like 2mb")]);
const OptionalBootstrapFileNameSchema = z.enum([
	"SOUL.md",
	"USER.md",
	"HEARTBEAT.md",
	"IDENTITY.md"
]);
const SilentReplyPolicyConfigSchema = z.object({
	direct: SilentReplyPolicySchema.optional(),
	group: SilentReplyPolicySchema.optional(),
	internal: SilentReplyPolicySchema.optional()
}).strict();
const SilentReplyRewriteConfigSchema = z.object({
	direct: z.boolean().optional(),
	group: z.boolean().optional(),
	internal: z.boolean().optional()
}).strict();
const AgentDefaultsSchema = z.object({
	/** Global default provider params applied to all models before per-model and per-agent overrides. */
	params: z.record(z.string(), z.unknown()).optional(),
	agentRuntime: AgentRuntimePolicySchema,
	embeddedHarness: AgentEmbeddedHarnessSchema,
	model: AgentModelSchema.optional(),
	imageModel: AgentModelSchema.optional(),
	imageGenerationModel: AgentModelSchema.optional(),
	videoGenerationModel: AgentModelSchema.optional(),
	musicGenerationModel: AgentModelSchema.optional(),
	mediaGenerationAutoProviderFallback: z.boolean().optional(),
	pdfModel: AgentModelSchema.optional(),
	pdfMaxBytesMb: z.number().positive().optional(),
	pdfMaxPages: z.number().int().positive().optional(),
	models: z.record(z.string(), z.object({
		alias: z.string().optional(),
		/** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
		params: z.record(z.string(), z.unknown()).optional(),
		agentRuntime: AgentRuntimePolicySchema,
		/** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
		streaming: z.boolean().optional()
	}).strict()).optional(),
	workspace: z.string().optional(),
	skills: z.array(z.string()).optional(),
	silentReply: SilentReplyPolicyConfigSchema.optional(),
	silentReplyRewrite: SilentReplyRewriteConfigSchema.optional(),
	repoRoot: z.string().optional(),
	systemPromptOverride: z.string().optional(),
	promptOverlays: z.object({ gpt5: z.object({ personality: z.union([
		z.literal("friendly"),
		z.literal("on"),
		z.literal("off")
	]).optional() }).strict().optional() }).strict().optional(),
	skipBootstrap: z.boolean().optional(),
	skipOptionalBootstrapFiles: z.array(OptionalBootstrapFileNameSchema).optional(),
	contextInjection: z.union([
		z.literal("always"),
		z.literal("continuation-skip"),
		z.literal("never")
	]).optional(),
	bootstrapMaxChars: z.number().int().positive().optional(),
	bootstrapTotalMaxChars: z.number().int().positive().optional(),
	experimental: z.object({ localModelLean: z.boolean().optional() }).strict().optional(),
	bootstrapPromptTruncationWarning: z.union([
		z.literal("off"),
		z.literal("once"),
		z.literal("always")
	]).optional(),
	userTimezone: z.string().optional(),
	startupContext: z.object({
		enabled: z.boolean().optional(),
		applyOn: z.array(z.union([z.literal("new"), z.literal("reset")])).optional(),
		dailyMemoryDays: z.number().int().min(1).max(14).optional(),
		maxFileBytes: z.number().int().min(1).max(64 * 1024).optional(),
		maxFileChars: z.number().int().min(1).max(1e4).optional(),
		maxTotalChars: z.number().int().min(1).max(5e4).optional()
	}).strict().optional(),
	contextLimits: AgentContextLimitsSchema,
	timeFormat: z.union([
		z.literal("auto"),
		z.literal("12"),
		z.literal("24")
	]).optional(),
	envelopeTimezone: z.string().optional(),
	envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
	envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
	contextTokens: z.number().int().positive().optional(),
	cliBackends: z.record(z.string(), CliBackendSchema).optional(),
	memorySearch: MemorySearchSchema,
	contextPruning: z.object({
		mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
		ttl: z.string().optional(),
		keepLastAssistants: z.number().int().nonnegative().optional(),
		softTrimRatio: z.number().min(0).max(1).optional(),
		hardClearRatio: z.number().min(0).max(1).optional(),
		minPrunableToolChars: z.number().int().nonnegative().optional(),
		tools: z.object({
			allow: z.array(z.string()).optional(),
			deny: z.array(z.string()).optional()
		}).strict().optional(),
		softTrim: z.object({
			maxChars: z.number().int().nonnegative().optional(),
			headChars: z.number().int().nonnegative().optional(),
			tailChars: z.number().int().nonnegative().optional()
		}).strict().optional(),
		hardClear: z.object({
			enabled: z.boolean().optional(),
			placeholder: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	compaction: z.object({
		mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
		provider: z.string().optional(),
		reserveTokens: z.number().int().nonnegative().optional(),
		keepRecentTokens: z.number().int().positive().optional(),
		reserveTokensFloor: z.number().int().nonnegative().optional(),
		maxHistoryShare: z.number().min(.1).max(.9).optional(),
		customInstructions: z.string().optional(),
		identifierPolicy: z.union([
			z.literal("strict"),
			z.literal("off"),
			z.literal("custom")
		]).optional(),
		identifierInstructions: z.string().optional(),
		recentTurnsPreserve: z.number().int().min(0).max(12).optional(),
		qualityGuard: z.object({
			enabled: z.boolean().optional(),
			maxRetries: z.number().int().nonnegative().optional()
		}).strict().optional(),
		midTurnPrecheck: z.object({ enabled: z.boolean().optional() }).strict().optional(),
		postIndexSync: z.enum([
			"off",
			"async",
			"await"
		]).optional(),
		postCompactionSections: z.array(z.string()).optional(),
		model: z.string().optional(),
		timeoutSeconds: z.number().int().positive().optional(),
		memoryFlush: z.object({
			enabled: z.boolean().optional(),
			model: z.string().optional(),
			softThresholdTokens: z.number().int().nonnegative().optional(),
			forceFlushTranscriptBytes: NonNegativeByteSizeSchema.optional(),
			prompt: z.string().optional(),
			systemPrompt: z.string().optional()
		}).strict().optional(),
		truncateAfterCompaction: z.boolean().optional(),
		maxActiveTranscriptBytes: NonNegativeByteSizeSchema.optional(),
		notifyUser: z.boolean().optional()
	}).strict().optional(),
	embeddedPi: z.object({
		projectSettingsPolicy: z.union([
			z.literal("trusted"),
			z.literal("sanitize"),
			z.literal("ignore")
		]).optional(),
		executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional()
	}).strict().optional(),
	thinkingDefault: z.union([
		z.literal("off"),
		z.literal("minimal"),
		z.literal("low"),
		z.literal("medium"),
		z.literal("high"),
		z.literal("xhigh"),
		z.literal("adaptive"),
		z.literal("max")
	]).optional(),
	verboseDefault: z.union([
		z.literal("off"),
		z.literal("on"),
		z.literal("full")
	]).optional(),
	toolProgressDetail: z.union([z.literal("explain"), z.literal("raw")]).optional(),
	reasoningDefault: z.union([
		z.literal("off"),
		z.literal("on"),
		z.literal("stream")
	]).optional(),
	elevatedDefault: z.union([
		z.literal("off"),
		z.literal("on"),
		z.literal("ask"),
		z.literal("full")
	]).optional(),
	blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
	blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
	blockStreamingChunk: BlockStreamingChunkSchema.optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	humanDelay: HumanDelaySchema.optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	mediaMaxMb: z.number().positive().optional(),
	imageMaxDimensionPx: z.number().int().positive().optional(),
	typingIntervalSeconds: z.number().int().positive().optional(),
	typingMode: TypingModeSchema.optional(),
	heartbeat: HeartbeatSchema,
	maxConcurrent: z.number().int().positive().optional(),
	subagents: z.object({
		delegationMode: z.enum(["suggest", "prefer"]).optional(),
		allowAgents: z.array(z.string()).optional(),
		maxConcurrent: z.number().int().positive().optional(),
		maxSpawnDepth: z.number().int().min(1).max(5).optional().describe("Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents."),
		maxChildrenPerAgent: z.number().int().min(1).max(20).optional().describe("Maximum number of active children a single agent session can spawn (default: 5)."),
		archiveAfterMinutes: z.number().int().min(0).optional(),
		model: AgentModelSchema.optional(),
		thinking: z.string().optional(),
		runTimeoutSeconds: z.number().int().min(0).optional(),
		announceTimeoutMs: z.number().int().positive().optional(),
		requireAgentId: z.boolean().optional()
	}).strict().optional(),
	sandbox: AgentSandboxSchema
}).strict().optional();
//#endregion
//#region src/config/zod-schema.agents.ts
const AgentsSchema = z.object({
	defaults: z.lazy(() => AgentDefaultsSchema).optional(),
	list: z.array(AgentEntrySchema).optional()
}).strict().optional();
const BindingMatchSchema = z.object({
	channel: z.string(),
	accountId: z.string().optional(),
	peer: z.object({
		kind: z.union([
			z.literal("direct"),
			z.literal("group"),
			z.literal("channel"),
			z.literal("dm")
		]),
		id: z.string()
	}).strict().optional(),
	guildId: z.string().optional(),
	teamId: z.string().optional(),
	roles: z.array(z.string()).optional()
}).strict();
const BindingSessionSchema = z.object({ dmScope: z.union([
	z.literal("main"),
	z.literal("per-peer"),
	z.literal("per-channel-peer"),
	z.literal("per-account-channel-peer")
]).optional() }).strict();
const RouteBindingSchema = z.object({
	type: z.literal("route").optional(),
	agentId: z.string(),
	comment: z.string().optional(),
	match: BindingMatchSchema,
	session: BindingSessionSchema.optional()
}).strict();
const AcpBindingSchema = z.object({
	type: z.literal("acp"),
	agentId: z.string(),
	comment: z.string().optional(),
	match: BindingMatchSchema,
	acp: z.object({
		mode: z.enum(["persistent", "oneshot"]).optional(),
		label: z.string().optional(),
		cwd: z.string().optional(),
		backend: z.string().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	if (!(normalizeOptionalString(value.match.peer?.id) ?? "")) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["match", "peer"],
			message: "ACP bindings require match.peer.id to target a concrete conversation."
		});
		return;
	}
});
const BindingsSchema = z.array(z.union([RouteBindingSchema, AcpBindingSchema])).optional();
const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);
const BroadcastSchema = z.object({ strategy: BroadcastStrategySchema.optional() }).catchall(z.array(z.string())).optional();
const AudioSchema = z.object({ transcription: TranscribeAudioSchema }).strict().optional();
//#endregion
//#region src/config/zod-schema.approvals.ts
const ExecApprovalForwardTargetSchema = z.object({
	channel: z.string().min(1),
	to: z.string().min(1),
	accountId: z.string().optional(),
	threadId: z.union([z.string(), z.number()]).optional()
}).strict();
const ExecApprovalForwardingSchema = z.object({
	enabled: z.boolean().optional(),
	mode: z.union([
		z.literal("session"),
		z.literal("targets"),
		z.literal("both")
	]).optional(),
	agentFilter: z.array(z.string()).optional(),
	sessionFilter: z.array(z.string()).optional(),
	targets: z.array(ExecApprovalForwardTargetSchema).optional()
}).strict().optional();
const ApprovalsSchema = z.object({
	exec: ExecApprovalForwardingSchema,
	plugin: ExecApprovalForwardingSchema
}).strict().optional();
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
const SafeRelativeModulePathSchema = z.string().refine(isSafeRelativeModulePath, "module must be a safe relative path (no absolute paths)");
const HookMappingSchema = z.object({
	id: z.string().optional(),
	match: z.object({
		path: z.string().optional(),
		source: z.string().optional()
	}).optional(),
	action: z.union([z.literal("wake"), z.literal("agent")]).optional(),
	wakeMode: z.union([z.literal("now"), z.literal("next-heartbeat")]).optional(),
	name: z.string().optional(),
	agentId: z.string().optional(),
	sessionKey: z.string().optional().register(sensitive),
	messageTemplate: z.string().optional(),
	textTemplate: z.string().optional(),
	deliver: z.boolean().optional(),
	allowUnsafeExternalContent: z.boolean().optional(),
	channel: z.string().trim().min(1).optional(),
	to: z.string().optional(),
	model: z.string().optional(),
	thinking: z.string().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	transform: z.object({
		module: SafeRelativeModulePathSchema,
		export: z.string().optional()
	}).strict().optional()
}).strict().optional();
const InternalHookHandlerSchema = z.object({
	event: z.string(),
	module: SafeRelativeModulePathSchema,
	export: z.string().optional()
}).strict();
const HookConfigSchema = z.object({
	enabled: z.boolean().optional(),
	env: z.record(z.string(), z.string()).optional()
}).passthrough();
const HookInstallRecordSchema = z.object({
	...InstallRecordShape,
	hooks: z.array(z.string()).optional()
}).strict();
const InternalHooksSchema = z.object({
	enabled: z.boolean().optional(),
	handlers: z.array(InternalHookHandlerSchema).optional(),
	entries: z.record(z.string(), HookConfigSchema).optional(),
	load: z.object({ extraDirs: z.array(z.string()).optional() }).strict().optional(),
	installs: z.record(z.string(), HookInstallRecordSchema).optional()
}).strict().optional();
const HooksGmailSchema = z.object({
	account: z.string().optional(),
	label: z.string().optional(),
	topic: z.string().optional(),
	subscription: z.string().optional(),
	pushToken: z.string().optional().register(sensitive),
	hookUrl: z.string().optional(),
	includeBody: z.boolean().optional(),
	maxBytes: z.number().int().positive().optional(),
	renewEveryMinutes: z.number().int().positive().optional(),
	allowUnsafeExternalContent: z.boolean().optional(),
	serve: z.object({
		bind: z.string().optional(),
		port: z.number().int().positive().optional(),
		path: z.string().optional()
	}).strict().optional(),
	tailscale: z.object({
		mode: z.union([
			z.literal("off"),
			z.literal("serve"),
			z.literal("funnel")
		]).optional(),
		path: z.string().optional(),
		target: z.string().optional()
	}).strict().optional(),
	model: z.string().optional(),
	thinking: z.union([
		z.literal("off"),
		z.literal("minimal"),
		z.literal("low"),
		z.literal("medium"),
		z.literal("high")
	]).optional()
}).strict().optional();
//#endregion
//#region src/config/zod-schema.providers.ts
const ChannelModelByChannelSchema = z.record(z.string(), z.record(z.string(), z.string())).optional();
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
			code: z.ZodIssueCode.custom,
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
const ChannelsSchema = z.object({
	defaults: z.object({
		groupPolicy: GroupPolicySchema.optional(),
		contextVisibility: ContextVisibilityModeSchema.optional(),
		heartbeat: ChannelHeartbeatVisibilitySchema
	}).strict().optional(),
	modelByChannel: ChannelModelByChannelSchema
}).passthrough().superRefine((value, ctx) => {
	addLegacyChannelAcpBindingIssues(value, ctx);
}).optional();
//#endregion
//#region src/config/zod-schema.proxy.ts
function isHttpProxyUrl(value) {
	try {
		return new URL(value).protocol === "http:";
	} catch {
		return false;
	}
}
const ProxyLoopbackModeSchema = z.enum([
	"gateway-only",
	"proxy",
	"block"
]);
const ProxyConfigSchema = z.object({
	enabled: z.boolean().optional(),
	proxyUrl: z.url().refine(isHttpProxyUrl, { message: "proxyUrl must use http://" }).register(sensitive).optional(),
	loopbackMode: ProxyLoopbackModeSchema.optional()
}).strict().optional();
//#endregion
//#region src/config/zod-schema.session.ts
const SessionResetConfigSchema = z.object({
	mode: z.union([z.literal("daily"), z.literal("idle")]).optional(),
	atHour: z.number().int().min(0).max(23).optional(),
	idleMinutes: z.number().int().positive().optional()
}).strict();
const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();
const SessionSchema = z.object({
	scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
	dmScope: z.union([
		z.literal("main"),
		z.literal("per-peer"),
		z.literal("per-channel-peer"),
		z.literal("per-account-channel-peer")
	]).optional(),
	identityLinks: z.record(z.string(), z.array(z.string())).optional(),
	resetTriggers: z.array(z.string()).optional(),
	idleMinutes: z.number().int().positive().optional(),
	reset: SessionResetConfigSchema.optional(),
	resetByType: z.object({
		direct: SessionResetConfigSchema.optional(),
		/** @deprecated Use `direct` instead. Kept for backward compatibility. */
		dm: SessionResetConfigSchema.optional(),
		group: SessionResetConfigSchema.optional(),
		thread: SessionResetConfigSchema.optional()
	}).strict().optional(),
	resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
	store: z.string().optional(),
	typingIntervalSeconds: z.number().int().positive().optional(),
	typingMode: TypingModeSchema.optional(),
	mainKey: z.string().optional(),
	sendPolicy: SessionSendPolicySchema.optional(),
	writeLock: z.object({ acquireTimeoutMs: z.number().int().positive().optional() }).strict().optional(),
	agentToAgent: z.object({ maxPingPongTurns: z.number().int().min(0).max(20).optional() }).strict().optional(),
	threadBindings: z.object({
		enabled: z.boolean().optional(),
		idleHours: z.number().nonnegative().optional(),
		maxAgeHours: z.number().nonnegative().optional(),
		spawnSessions: z.boolean().optional(),
		defaultSpawnContext: z.enum(["isolated", "fork"]).optional()
	}).strict().optional(),
	maintenance: z.object({
		mode: z.enum(["enforce", "warn"]).optional(),
		pruneAfter: z.union([z.string(), z.number()]).optional(),
		/** @deprecated Use pruneAfter instead. */
		pruneDays: z.number().int().positive().optional(),
		maxEntries: z.number().int().positive().optional(),
		rotateBytes: z.union([z.string(), z.number()]).optional(),
		resetArchiveRetention: z.union([
			z.string(),
			z.number(),
			z.literal(false)
		]).optional(),
		maxDiskBytes: z.union([z.string(), z.number()]).optional(),
		highWaterBytes: z.union([z.string(), z.number()]).optional()
	}).strict().superRefine((val, ctx) => {
		if (val.pruneAfter !== void 0) try {
			parseDurationMs(normalizeStringifiedOptionalString(val.pruneAfter) ?? "", { defaultUnit: "d" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["pruneAfter"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.resetArchiveRetention !== void 0 && val.resetArchiveRetention !== false) try {
			parseDurationMs(normalizeStringifiedOptionalString(val.resetArchiveRetention) ?? "", { defaultUnit: "d" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["resetArchiveRetention"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.maxDiskBytes !== void 0) try {
			parseByteSize(normalizeStringifiedOptionalString(val.maxDiskBytes) ?? "", { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["maxDiskBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
		if (val.highWaterBytes !== void 0) try {
			parseByteSize(normalizeStringifiedOptionalString(val.highWaterBytes) ?? "", { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["highWaterBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
	}).optional()
}).strict().optional();
const MessagesSchema = z.object({
	messagePrefix: z.string().optional(),
	visibleReplies: VisibleRepliesSchema.optional(),
	responsePrefix: z.string().optional(),
	groupChat: GroupChatSchema,
	queue: QueueSchema,
	inbound: InboundDebounceSchema,
	ackReaction: z.string().optional(),
	ackReactionScope: z.enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"off",
		"none"
	]).optional(),
	removeAckAfterReply: z.boolean().optional(),
	statusReactions: z.object({
		enabled: z.boolean().optional(),
		emojis: z.object({
			thinking: z.string().optional(),
			tool: z.string().optional(),
			coding: z.string().optional(),
			web: z.string().optional(),
			done: z.string().optional(),
			error: z.string().optional(),
			stallSoft: z.string().optional(),
			stallHard: z.string().optional(),
			compacting: z.string().optional()
		}).strict().optional(),
		timing: z.object({
			debounceMs: z.number().int().min(0).optional(),
			stallSoftMs: z.number().int().min(0).optional(),
			stallHardMs: z.number().int().min(0).optional(),
			doneHoldMs: z.number().int().min(0).optional(),
			errorHoldMs: z.number().int().min(0).optional()
		}).strict().optional()
	}).strict().optional(),
	suppressToolErrors: z.boolean().optional(),
	tts: TtsConfigSchema
}).strict().optional();
const CommandsSchema = z.object({
	native: NativeCommandsSettingSchema.optional().default("auto"),
	nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
	text: z.boolean().optional(),
	bash: z.boolean().optional(),
	bashForegroundMs: z.number().int().min(0).max(3e4).optional(),
	config: z.boolean().optional(),
	mcp: z.boolean().optional(),
	plugins: z.boolean().optional(),
	debug: z.boolean().optional(),
	restart: z.boolean().optional().default(true),
	useAccessGroups: z.boolean().optional(),
	ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	ownerDisplay: z.enum(["raw", "hash"]).optional().default("raw"),
	ownerDisplaySecret: z.string().optional().register(sensitive),
	allowFrom: ElevatedAllowFromSchema.optional()
}).strict().optional().default(() => ({
	native: "auto",
	nativeSkills: "auto",
	restart: true,
	ownerDisplay: "raw"
}));
//#endregion
//#region src/config/zod-schema.ts
const BrowserSnapshotDefaultsSchema = z.object({ mode: z.literal("efficient").optional() }).strict().optional();
const NodeHostSchema = z.object({ browserProxy: z.object({
	enabled: z.boolean().optional(),
	allowProfiles: z.array(z.string()).optional()
}).strict().optional() }).strict().optional();
const LegacyCanvasHostSchema = z.object({
	enabled: z.boolean().optional(),
	root: z.string().optional(),
	port: z.number().int().positive().optional(),
	liveReload: z.boolean().optional()
}).strict().optional();
const AccessGroupsSchema = z.record(z.string().min(1), z.discriminatedUnion("type", [z.object({
	type: z.literal("discord.channelAudience"),
	guildId: z.string().min(1),
	channelId: z.string().min(1),
	membership: z.literal("canViewChannel").optional()
}).strict(), z.object({
	type: z.literal("message.senders"),
	members: z.record(z.string().min(1), z.array(z.string().min(1)))
}).strict()])).optional();
const MemoryQmdPathSchema = z.object({
	path: z.string(),
	name: z.string().optional(),
	pattern: z.string().optional()
}).strict();
const MemoryQmdSessionSchema = z.object({
	enabled: z.boolean().optional(),
	exportDir: z.string().optional(),
	retentionDays: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdUpdateSchema = z.object({
	interval: z.string().optional(),
	debounceMs: z.number().int().nonnegative().optional(),
	onBoot: z.boolean().optional(),
	startup: z.enum([
		"off",
		"idle",
		"immediate"
	]).optional(),
	startupDelayMs: z.number().int().nonnegative().optional(),
	waitForBootSync: z.boolean().optional(),
	embedInterval: z.string().optional(),
	commandTimeoutMs: z.number().int().nonnegative().optional(),
	updateTimeoutMs: z.number().int().nonnegative().optional(),
	embedTimeoutMs: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdLimitsSchema = z.object({
	maxResults: z.number().int().positive().optional(),
	maxSnippetChars: z.number().int().positive().optional(),
	maxInjectedChars: z.number().int().positive().optional(),
	timeoutMs: z.number().int().nonnegative().optional()
}).strict();
const MemoryQmdMcporterSchema = z.object({
	enabled: z.boolean().optional(),
	serverName: z.string().optional(),
	startDaemon: z.boolean().optional()
}).strict();
const LoggingLevelSchema = z.union([
	z.literal("silent"),
	z.literal("fatal"),
	z.literal("error"),
	z.literal("warn"),
	z.literal("info"),
	z.literal("debug"),
	z.literal("trace")
]);
const MemoryQmdSchema = z.object({
	command: z.string().optional(),
	mcporter: MemoryQmdMcporterSchema.optional(),
	searchMode: z.union([
		z.literal("query"),
		z.literal("search"),
		z.literal("vsearch")
	]).optional(),
	searchTool: z.string().trim().min(1).optional(),
	includeDefaultMemory: z.boolean().optional(),
	paths: z.array(MemoryQmdPathSchema).optional(),
	sessions: MemoryQmdSessionSchema.optional(),
	update: MemoryQmdUpdateSchema.optional(),
	limits: MemoryQmdLimitsSchema.optional(),
	scope: SessionSendPolicySchema.optional()
}).strict();
const MemorySchema = z.object({
	backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
	citations: z.union([
		z.literal("auto"),
		z.literal("on"),
		z.literal("off")
	]).optional(),
	qmd: MemoryQmdSchema.optional()
}).strict().optional();
const HttpUrlSchema = z.string().url().refine((value) => {
	const protocol = new URL(value).protocol;
	return protocol === "http:" || protocol === "https:";
}, "Expected http:// or https:// URL");
const ResponsesEndpointUrlFetchShape = {
	allowUrl: z.boolean().optional(),
	urlAllowlist: z.array(z.string()).optional(),
	allowedMimes: z.array(z.string()).optional(),
	maxBytes: z.number().int().positive().optional(),
	maxRedirects: z.number().int().nonnegative().optional(),
	timeoutMs: z.number().int().positive().optional()
};
const SkillEntrySchema = z.object({
	enabled: z.boolean().optional(),
	apiKey: SecretInputSchema.optional().register(sensitive),
	env: z.record(z.string(), z.string()).optional(),
	config: z.record(z.string(), z.unknown()).optional()
}).strict();
const PluginEntrySchema = z.object({
	enabled: z.boolean().optional(),
	hooks: z.object({
		allowPromptInjection: z.boolean().optional(),
		allowConversationAccess: z.boolean().optional(),
		timeoutMs: z.number().int().positive().max(6e5).optional(),
		timeouts: z.record(z.string(), z.number().int().positive().max(6e5)).optional()
	}).strict().optional(),
	subagent: z.object({
		allowModelOverride: z.boolean().optional(),
		allowedModels: z.array(z.string()).optional()
	}).strict().optional(),
	llm: z.object({
		allowModelOverride: z.boolean().optional(),
		allowedModels: z.array(z.string()).optional(),
		allowAgentIdOverride: z.boolean().optional()
	}).strict().optional(),
	config: z.record(z.string(), z.unknown()).optional()
}).strict();
const TalkProviderEntrySchema = z.object({ apiKey: SecretInputSchema.optional().register(sensitive) }).catchall(z.unknown());
const TalkRealtimeSchema = z.object({
	provider: z.string().optional(),
	providers: z.record(z.string(), TalkProviderEntrySchema).optional(),
	model: z.string().optional(),
	voice: z.string().optional(),
	instructions: z.string().optional(),
	mode: z.enum([
		"realtime",
		"stt-tts",
		"transcription"
	]).optional(),
	transport: z.enum([
		"webrtc",
		"provider-websocket",
		"gateway-relay",
		"managed-room"
	]).optional(),
	brain: z.enum([
		"agent-consult",
		"direct-tools",
		"none"
	]).optional()
}).strict().superRefine((realtime, ctx) => {
	const provider = normalizeLowercaseStringOrEmpty(realtime.provider ?? "");
	const providers = realtime.providers ? Object.keys(realtime.providers) : [];
	if (provider && providers.length > 0 && !(provider in realtime.providers)) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["provider"],
		message: `talk.realtime.provider must match a key in talk.realtime.providers (missing "${provider}")`
	});
	if (!provider && providers.length > 1) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["provider"],
		message: "talk.realtime.provider is required when talk.realtime.providers defines multiple providers"
	});
});
const TalkSchema = z.object({
	provider: z.string().optional(),
	providers: z.record(z.string(), TalkProviderEntrySchema).optional(),
	realtime: TalkRealtimeSchema.optional(),
	consultThinkingLevel: z.enum([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"adaptive",
		"max"
	]).optional(),
	consultFastMode: z.boolean().optional(),
	speechLocale: z.string().optional(),
	interruptOnSpeech: z.boolean().optional(),
	silenceTimeoutMs: z.number().int().positive().optional()
}).strict().superRefine((talk, ctx) => {
	const provider = normalizeLowercaseStringOrEmpty(talk.provider ?? "");
	const providers = talk.providers ? Object.keys(talk.providers) : [];
	if (provider && providers.length > 0 && !(provider in talk.providers)) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["provider"],
		message: `talk.provider must match a key in talk.providers (missing "${provider}")`
	});
	if (!provider && providers.length > 1) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["provider"],
		message: "talk.provider is required when talk.providers defines multiple providers"
	});
});
const McpServerSchema = z.object({
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.union([
		z.string(),
		z.number(),
		z.boolean()
	])).optional(),
	cwd: z.string().optional(),
	workingDirectory: z.string().optional(),
	url: HttpUrlSchema.optional(),
	transport: z.union([z.literal("sse"), z.literal("streamable-http")]).optional(),
	headers: z.record(z.string(), z.union([
		z.string().register(sensitive),
		z.number(),
		z.boolean()
	]).register(sensitive)).optional()
}).catchall(z.unknown());
const McpConfigSchema = z.object({
	servers: z.record(z.string(), McpServerSchema).optional(),
	sessionIdleTtlMs: z.number().finite().min(0).optional()
}).strict().optional();
const CrestodianSchema = z.object({ rescue: z.object({
	enabled: z.union([z.literal("auto"), z.boolean()]).optional(),
	ownerDmOnly: z.boolean().optional(),
	pendingTtlMinutes: z.number().int().positive().optional()
}).strict().optional() }).strict().optional();
const CommitmentsSchema = z.object({
	enabled: z.boolean().optional(),
	maxPerDay: z.number().int().positive().optional()
}).strict().optional();
const OpenClawSchema = z.object({
	$schema: z.string().optional(),
	meta: z.object({
		lastTouchedVersion: z.string().optional(),
		lastTouchedAt: z.union([z.string(), z.number().transform((n, ctx) => {
			const d = new Date(n);
			if (Number.isNaN(d.getTime())) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Invalid timestamp"
				});
				return z.NEVER;
			}
			return d.toISOString();
		})]).optional()
	}).strict().optional(),
	env: z.object({
		shellEnv: z.object({
			enabled: z.boolean().optional(),
			timeoutMs: z.number().int().nonnegative().optional()
		}).strict().optional(),
		vars: z.record(z.string(), z.string()).optional()
	}).catchall(z.string()).optional(),
	wizard: z.object({
		lastRunAt: z.string().optional(),
		lastRunVersion: z.string().optional(),
		lastRunCommit: z.string().optional(),
		lastRunCommand: z.string().optional(),
		lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional()
	}).strict().optional(),
	diagnostics: z.object({
		enabled: z.boolean().optional(),
		flags: z.array(z.string()).optional(),
		stuckSessionWarnMs: z.number().int().positive().optional(),
		stuckSessionAbortMs: z.number().int().positive().optional(),
		otel: z.object({
			enabled: z.boolean().optional(),
			endpoint: z.string().optional(),
			tracesEndpoint: z.string().optional(),
			metricsEndpoint: z.string().optional(),
			logsEndpoint: z.string().optional(),
			protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
			headers: z.record(z.string(), z.string()).optional(),
			serviceName: z.string().optional(),
			traces: z.boolean().optional(),
			metrics: z.boolean().optional(),
			logs: z.boolean().optional(),
			sampleRate: z.number().min(0).max(1).optional(),
			flushIntervalMs: z.number().int().nonnegative().optional(),
			captureContent: z.union([z.boolean(), z.object({
				enabled: z.boolean().optional(),
				inputMessages: z.boolean().optional(),
				outputMessages: z.boolean().optional(),
				toolInputs: z.boolean().optional(),
				toolOutputs: z.boolean().optional(),
				systemPrompt: z.boolean().optional()
			}).strict()]).optional()
		}).strict().optional(),
		cacheTrace: z.object({
			enabled: z.boolean().optional(),
			filePath: z.string().optional(),
			includeMessages: z.boolean().optional(),
			includePrompt: z.boolean().optional(),
			includeSystem: z.boolean().optional()
		}).strict().optional()
	}).strict().optional(),
	logging: z.object({
		level: LoggingLevelSchema.optional(),
		file: z.string().optional(),
		maxFileBytes: z.number().int().positive().optional(),
		consoleLevel: LoggingLevelSchema.optional(),
		consoleStyle: z.union([
			z.literal("pretty"),
			z.literal("compact"),
			z.literal("json")
		]).optional(),
		redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
		redactPatterns: z.array(z.string()).optional()
	}).strict().optional(),
	cli: z.object({ banner: z.object({ taglineMode: z.union([
		z.literal("random"),
		z.literal("default"),
		z.literal("off")
	]).optional() }).strict().optional() }).strict().optional(),
	crestodian: CrestodianSchema,
	update: z.object({
		channel: z.union([
			z.literal("stable"),
			z.literal("beta"),
			z.literal("dev")
		]).optional(),
		checkOnStart: z.boolean().optional(),
		auto: z.object({
			enabled: z.boolean().optional(),
			stableDelayHours: z.number().nonnegative().max(168).optional(),
			stableJitterHours: z.number().nonnegative().max(168).optional(),
			betaCheckIntervalHours: z.number().positive().max(24).optional()
		}).strict().optional()
	}).strict().optional(),
	browser: z.object({
		enabled: z.boolean().optional(),
		evaluateEnabled: z.boolean().optional(),
		cdpUrl: z.string().optional(),
		remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
		remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
		localLaunchTimeoutMs: z.number().int().positive().max(12e4).optional(),
		localCdpReadyTimeoutMs: z.number().int().positive().max(12e4).optional(),
		actionTimeoutMs: z.number().int().positive().optional(),
		color: z.string().optional(),
		executablePath: z.string().optional(),
		headless: z.boolean().optional(),
		noSandbox: z.boolean().optional(),
		attachOnly: z.boolean().optional(),
		cdpPortRangeStart: z.number().int().min(1).max(65535).optional(),
		defaultProfile: z.string().optional(),
		snapshotDefaults: BrowserSnapshotDefaultsSchema,
		ssrfPolicy: z.object({
			dangerouslyAllowPrivateNetwork: z.boolean().optional(),
			allowedHostnames: z.array(z.string()).optional(),
			hostnameAllowlist: z.array(z.string()).optional()
		}).strict().optional(),
		profiles: z.record(z.string().regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"), z.object({
			cdpPort: z.number().int().min(1).max(65535).optional(),
			cdpUrl: z.string().optional(),
			userDataDir: z.string().optional(),
			mcpCommand: z.string().optional(),
			mcpArgs: z.array(z.string()).optional(),
			driver: z.union([
				z.literal("openclaw"),
				z.literal("clawd"),
				z.literal("existing-session")
			]).optional(),
			headless: z.boolean().optional(),
			executablePath: z.string().optional(),
			attachOnly: z.boolean().optional(),
			color: HexColorSchema
		}).strict().refine((value) => value.driver === "existing-session" || value.cdpPort || value.cdpUrl, { message: "Profile must set cdpPort or cdpUrl" }).refine((value) => value.driver === "existing-session" || !value.userDataDir, { message: "Profile userDataDir is only supported with driver=\"existing-session\"" })).optional(),
		extraArgs: z.array(z.string()).optional(),
		tabCleanup: z.object({
			enabled: z.boolean().optional(),
			idleMinutes: z.number().int().nonnegative().optional(),
			maxTabsPerSession: z.number().int().nonnegative().optional(),
			sweepMinutes: z.number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	ui: z.object({
		seamColor: HexColorSchema.optional(),
		assistant: z.object({
			name: z.string().max(50).optional(),
			avatar: z.string().max(2e6).optional()
		}).strict().optional()
	}).strict().optional(),
	secrets: SecretsConfigSchema,
	auth: z.object({
		profiles: z.record(z.string(), z.object({
			provider: z.string(),
			mode: z.union([
				z.literal("api_key"),
				z.literal("aws-sdk"),
				z.literal("oauth"),
				z.literal("token")
			]),
			email: z.string().optional(),
			displayName: z.string().optional()
		}).strict()).optional(),
		order: z.record(z.string(), z.array(z.string())).optional(),
		cooldowns: z.object({
			billingBackoffHours: z.number().positive().optional(),
			billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
			billingMaxHours: z.number().positive().optional(),
			authPermanentBackoffMinutes: z.number().positive().optional(),
			authPermanentMaxMinutes: z.number().positive().optional(),
			failureWindowHours: z.number().positive().optional(),
			overloadedProfileRotations: z.number().int().nonnegative().optional(),
			overloadedBackoffMs: z.number().int().nonnegative().optional(),
			rateLimitedProfileRotations: z.number().int().nonnegative().optional()
		}).strict().optional()
	}).strict().optional(),
	accessGroups: AccessGroupsSchema,
	acp: z.object({
		enabled: z.boolean().optional(),
		dispatch: z.object({ enabled: z.boolean().optional() }).strict().optional(),
		backend: z.string().optional(),
		defaultAgent: z.string().optional(),
		allowedAgents: z.array(z.string()).optional(),
		maxConcurrentSessions: z.number().int().positive().optional(),
		stream: z.object({
			coalesceIdleMs: z.number().int().nonnegative().optional(),
			maxChunkChars: z.number().int().positive().optional(),
			repeatSuppression: z.boolean().optional(),
			deliveryMode: z.union([z.literal("live"), z.literal("final_only")]).optional(),
			hiddenBoundarySeparator: z.union([
				z.literal("none"),
				z.literal("space"),
				z.literal("newline"),
				z.literal("paragraph")
			]).optional(),
			maxOutputChars: z.number().int().positive().optional(),
			maxSessionUpdateChars: z.number().int().positive().optional(),
			tagVisibility: z.record(z.string(), z.boolean()).optional()
		}).strict().optional(),
		runtime: z.object({
			ttlMinutes: z.number().int().positive().optional(),
			installCommand: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	models: ModelsConfigSchema,
	nodeHost: NodeHostSchema,
	agents: AgentsSchema,
	tools: ToolsSchema,
	bindings: BindingsSchema,
	broadcast: BroadcastSchema,
	audio: AudioSchema,
	media: z.object({
		preserveFilenames: z.boolean().optional(),
		ttlHours: z.number().int().min(1).max(168).optional()
	}).strict().optional(),
	messages: MessagesSchema,
	commands: CommandsSchema,
	approvals: ApprovalsSchema,
	session: SessionSchema,
	cron: z.object({
		enabled: z.boolean().optional(),
		store: z.string().optional(),
		maxConcurrentRuns: z.number().int().positive().optional(),
		retry: z.object({
			maxAttempts: z.number().int().min(0).max(10).optional(),
			backoffMs: z.array(z.number().int().nonnegative()).min(1).max(10).optional(),
			retryOn: z.array(z.enum([
				"rate_limit",
				"overloaded",
				"network",
				"timeout",
				"server_error"
			])).min(1).optional()
		}).strict().optional(),
		webhook: HttpUrlSchema.optional(),
		webhookToken: SecretInputSchema.optional().register(sensitive),
		sessionRetention: z.union([z.string(), z.literal(false)]).optional(),
		runLog: z.object({
			maxBytes: z.union([z.string(), z.number()]).optional(),
			keepLines: z.number().int().positive().optional()
		}).strict().optional(),
		failureAlert: z.object({
			enabled: z.boolean().optional(),
			after: z.number().int().min(1).optional(),
			cooldownMs: z.number().int().min(0).optional(),
			includeSkipped: z.boolean().optional(),
			mode: z.enum(["announce", "webhook"]).optional(),
			accountId: z.string().optional()
		}).strict().optional(),
		failureDestination: z.object({
			channel: z.string().optional(),
			to: z.string().optional(),
			accountId: z.string().optional(),
			mode: z.enum(["announce", "webhook"]).optional()
		}).strict().optional()
	}).strict().superRefine((val, ctx) => {
		if (val.sessionRetention !== void 0 && val.sessionRetention !== false) try {
			parseDurationMs(normalizeStringifiedOptionalString(val.sessionRetention) ?? "", { defaultUnit: "h" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["sessionRetention"],
				message: "invalid duration (use ms, s, m, h, d)"
			});
		}
		if (val.runLog?.maxBytes !== void 0) try {
			parseByteSize(normalizeStringifiedOptionalString(val.runLog.maxBytes) ?? "", { defaultUnit: "b" });
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["runLog", "maxBytes"],
				message: "invalid size (use b, kb, mb, gb, tb)"
			});
		}
	}).optional(),
	commitments: CommitmentsSchema,
	hooks: z.object({
		enabled: z.boolean().optional(),
		path: z.string().optional(),
		token: z.string().optional().register(sensitive),
		defaultSessionKey: z.string().optional(),
		allowRequestSessionKey: z.boolean().optional(),
		allowedSessionKeyPrefixes: z.array(z.string()).optional(),
		allowedAgentIds: z.array(z.string()).optional(),
		maxBodyBytes: z.number().int().positive().optional(),
		presets: z.array(z.string()).optional(),
		transformsDir: z.string().optional(),
		mappings: z.array(HookMappingSchema).optional(),
		gmail: HooksGmailSchema,
		internal: InternalHooksSchema
	}).strict().optional(),
	web: z.object({
		enabled: z.boolean().optional(),
		heartbeatSeconds: z.number().int().positive().optional(),
		reconnect: z.object({
			initialMs: z.number().positive().optional(),
			maxMs: z.number().positive().optional(),
			factor: z.number().positive().optional(),
			jitter: z.number().min(0).max(1).optional(),
			maxAttempts: z.number().int().min(0).optional()
		}).strict().optional(),
		whatsapp: z.object({
			keepAliveIntervalMs: z.number().int().positive().optional(),
			connectTimeoutMs: z.number().int().positive().optional(),
			defaultQueryTimeoutMs: z.number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	channels: ChannelsSchema,
	discovery: z.object({
		wideArea: z.object({
			enabled: z.boolean().optional(),
			domain: z.string().optional()
		}).strict().optional(),
		mdns: z.object({ mode: z.enum([
			"off",
			"minimal",
			"full"
		]).optional() }).strict().optional()
	}).strict().optional(),
	talk: TalkSchema.optional(),
	gateway: z.object({
		port: z.number().int().positive().optional(),
		mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
		bind: z.union([
			z.literal("auto"),
			z.literal("lan"),
			z.literal("loopback"),
			z.literal("custom"),
			z.literal("tailnet")
		]).optional(),
		customBindHost: z.string().optional(),
		controlUi: z.object({
			enabled: z.boolean().optional(),
			basePath: z.string().optional(),
			root: z.string().optional(),
			embedSandbox: z.union([
				z.literal("strict"),
				z.literal("scripts"),
				z.literal("trusted")
			]).optional(),
			allowExternalEmbedUrls: z.boolean().optional(),
			chatMessageMaxWidth: z.string().transform((value) => normalizeControlUiChatMessageMaxWidth(value)).refine((value) => isValidControlUiChatMessageMaxWidth(value), { message: "Expected a CSS width value such as 960px, 82%, min(1280px, 82%), or calc(100% - 2rem)" }).optional(),
			allowedOrigins: z.array(z.string()).optional(),
			dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
			allowInsecureAuth: z.boolean().optional(),
			dangerouslyDisableDeviceAuth: z.boolean().optional()
		}).strict().optional(),
		auth: z.object({
			mode: z.union([
				z.literal("none"),
				z.literal("token"),
				z.literal("password"),
				z.literal("trusted-proxy")
			]).optional(),
			token: SecretInputSchema.optional().register(sensitive),
			password: SecretInputSchema.optional().register(sensitive),
			allowTailscale: z.boolean().optional(),
			rateLimit: z.object({
				maxAttempts: z.number().optional(),
				windowMs: z.number().optional(),
				lockoutMs: z.number().optional(),
				exemptLoopback: z.boolean().optional()
			}).strict().optional(),
			trustedProxy: z.object({
				userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
				requiredHeaders: z.array(z.string()).optional(),
				allowUsers: z.array(z.string()).optional(),
				allowLoopback: z.boolean().optional()
			}).strict().optional()
		}).strict().optional(),
		trustedProxies: z.array(z.string()).optional(),
		allowRealIpFallback: z.boolean().optional(),
		tools: z.object({
			deny: z.array(z.string()).optional(),
			allow: z.array(z.string()).optional()
		}).strict().optional(),
		webchat: z.object({ chatHistoryMaxChars: z.number().int().positive().max(5e5).optional() }).strict().optional(),
		handshakeTimeoutMs: z.number().int().min(1).optional(),
		channelHealthCheckMinutes: z.number().int().min(0).optional(),
		channelStaleEventThresholdMinutes: z.number().int().min(1).optional(),
		channelMaxRestartsPerHour: z.number().int().min(1).optional(),
		tailscale: z.object({
			mode: z.union([
				z.literal("off"),
				z.literal("serve"),
				z.literal("funnel")
			]).optional(),
			resetOnExit: z.boolean().optional(),
			preserveFunnel: z.boolean().optional()
		}).strict().optional(),
		remote: z.object({
			url: z.string().optional(),
			transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
			token: SecretInputSchema.optional().register(sensitive),
			password: SecretInputSchema.optional().register(sensitive),
			tlsFingerprint: z.string().optional(),
			sshTarget: z.string().optional(),
			sshIdentity: z.string().optional()
		}).strict().optional(),
		reload: z.object({
			mode: z.union([
				z.literal("off"),
				z.literal("restart"),
				z.literal("hot"),
				z.literal("hybrid")
			]).optional(),
			debounceMs: z.number().int().min(0).optional(),
			deferralTimeoutMs: z.number().int().min(0).optional()
		}).strict().optional(),
		tls: z.object({
			enabled: z.boolean().optional(),
			autoGenerate: z.boolean().optional(),
			certPath: z.string().optional(),
			keyPath: z.string().optional(),
			caPath: z.string().optional()
		}).optional(),
		http: z.object({
			endpoints: z.object({
				chatCompletions: z.object({
					enabled: z.boolean().optional(),
					maxBodyBytes: z.number().int().positive().optional(),
					maxImageParts: z.number().int().nonnegative().optional(),
					maxTotalImageBytes: z.number().int().positive().optional(),
					images: z.object({ ...ResponsesEndpointUrlFetchShape }).strict().optional()
				}).strict().optional(),
				responses: z.object({
					enabled: z.boolean().optional(),
					maxBodyBytes: z.number().int().positive().optional(),
					maxUrlParts: z.number().int().nonnegative().optional(),
					files: z.object({
						...ResponsesEndpointUrlFetchShape,
						maxChars: z.number().int().positive().optional(),
						pdf: z.object({
							maxPages: z.number().int().positive().optional(),
							maxPixels: z.number().int().positive().optional(),
							minTextChars: z.number().int().nonnegative().optional()
						}).strict().optional()
					}).strict().optional(),
					images: z.object({ ...ResponsesEndpointUrlFetchShape }).strict().optional()
				}).strict().optional()
			}).strict().optional(),
			securityHeaders: z.object({ strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional() }).strict().optional()
		}).strict().optional(),
		push: z.object({ apns: z.object({ relay: z.object({
			baseUrl: z.string().optional(),
			timeoutMs: z.number().int().positive().optional()
		}).strict().optional() }).strict().optional() }).strict().optional(),
		nodes: z.object({
			browser: z.object({
				mode: z.union([
					z.literal("auto"),
					z.literal("manual"),
					z.literal("off")
				]).optional(),
				node: z.string().optional()
			}).strict().optional(),
			pairing: z.object({ autoApproveCidrs: z.array(z.string()).optional() }).strict().optional(),
			allowCommands: z.array(z.string()).optional(),
			denyCommands: z.array(z.string()).optional()
		}).strict().optional()
	}).strict().superRefine((gateway, ctx) => {
		const effectiveHealthCheckMinutes = gateway.channelHealthCheckMinutes ?? 5;
		if (gateway.channelStaleEventThresholdMinutes != null && effectiveHealthCheckMinutes !== 0 && gateway.channelStaleEventThresholdMinutes < effectiveHealthCheckMinutes) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["channelStaleEventThresholdMinutes"],
			message: "channelStaleEventThresholdMinutes should be >= channelHealthCheckMinutes to avoid delayed stale detection"
		});
	}).optional(),
	memory: MemorySchema,
	mcp: McpConfigSchema,
	skills: z.object({
		allowBundled: z.array(z.string()).optional(),
		load: z.object({
			extraDirs: z.array(z.string()).optional(),
			allowSymlinkTargets: z.array(z.string()).optional(),
			watch: z.boolean().optional(),
			watchDebounceMs: z.number().int().min(0).optional()
		}).strict().optional(),
		install: z.object({
			preferBrew: z.boolean().optional(),
			nodeManager: z.union([
				z.literal("npm"),
				z.literal("pnpm"),
				z.literal("yarn"),
				z.literal("bun")
			]).optional(),
			allowUploadedArchives: z.boolean().optional()
		}).strict().optional(),
		limits: z.object({
			maxCandidatesPerRoot: z.number().int().min(1).optional(),
			maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
			maxSkillsInPrompt: z.number().int().min(0).optional(),
			maxSkillsPromptChars: z.number().int().min(0).optional(),
			maxSkillFileBytes: z.number().int().min(0).optional()
		}).strict().optional(),
		entries: z.record(z.string(), SkillEntrySchema).optional()
	}).strict().optional(),
	plugins: z.object({
		enabled: z.boolean().optional(),
		allow: z.array(z.string()).optional(),
		deny: z.array(z.string()).optional(),
		load: z.object({ paths: z.array(z.string()).optional() }).strict().optional(),
		slots: z.object({
			memory: z.string().optional(),
			contextEngine: z.string().optional()
		}).strict().optional(),
		entries: z.record(z.string(), PluginEntrySchema).optional(),
		bundledDiscovery: z.enum(["compat", "allowlist"]).optional()
	}).strict().optional(),
	canvasHost: LegacyCanvasHostSchema,
	surfaces: z.record(z.string(), z.object({
		silentReply: SilentReplyPolicyConfigSchema.optional(),
		silentReplyRewrite: SilentReplyRewriteConfigSchema.optional()
	}).strict()).optional(),
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
				code: z.ZodIssueCode.custom,
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
