import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as isBlockedObjectKey } from "./prototype-keys-gIgii6VQ.js";
import { An as preprocess, At as boolean, Et as array, Nn as record, Rn as string, Tn as object, Xn as union, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { n as ZodIssueCode } from "./compat-bCpUj7Jq.js";
import { C as SecretInputSchema, D as ToolsLinksSchema, O as ToolsMediaSchema, c as GroupChatSchema, d as HumanDelaySchema, f as IdentitySchema, j as TtsConfigSchema } from "./zod-schema.core-D7Y_eqdd.js";
import { t as sensitive } from "./zod-schema.sensitive-3GVmnUbm.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import { a as isSandboxHostPathAbsolute, c as splitSandboxBindSpec, t as getBlockedNetworkModeReason } from "./network-mode-BsO8g-R7.js";
//#region src/config/zod-schema.agent-model.ts
const AgentModelSchema = union([string(), object({
	primary: string().optional(),
	fallbacks: array(string()).optional()
}).strict()]);
const AgentToolModelSchema = union([string(), object({
	primary: string().optional(),
	fallbacks: array(string()).optional(),
	timeoutMs: number().int().positive().optional()
}).strict()]);
//#endregion
//#region src/config/zod-schema.agent-runtime.ts
function validateSandboxBindEntries(binds, ctx) {
	if (!binds) return;
	for (let i = 0; i < binds.length; i += 1) {
		const bind = normalizeOptionalString(binds[i]) ?? "";
		if (!bind) {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["binds", i],
				message: "Sandbox security: bind mount entry must be a non-empty string."
			});
			continue;
		}
		const parsed = splitSandboxBindSpec(bind);
		const source = (parsed ? parsed.host : bind).trim();
		if (!isSandboxHostPathAbsolute(source)) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["binds", i],
			message: `Sandbox security: bind mount "${bind}" uses a non-absolute source path "${source}". Only absolute POSIX or Windows drive-letter paths are supported for sandbox binds.`
		});
	}
}
const AgentRunRetriesConfigSchema = object({
	base: number().int().positive().optional(),
	perProfile: number().int().nonnegative().optional(),
	min: number().int().positive().optional(),
	max: number().int().positive().optional()
}).strict().refine((data) => {
	if (data.min !== void 0 && data.max !== void 0) return data.max >= data.min;
	return true;
}, {
	message: "max must be greater than or equal to min",
	path: ["max"]
});
const HeartbeatSchema = object({
	every: string().optional(),
	activeHours: object({
		start: string().optional(),
		end: string().optional(),
		timezone: string().optional()
	}).strict().optional(),
	model: string().optional(),
	session: string().optional(),
	includeReasoning: boolean().optional(),
	target: string().optional(),
	directPolicy: union([literal("allow"), literal("block")]).optional(),
	to: string().optional(),
	accountId: string().optional(),
	prompt: string().optional(),
	includeSystemPromptSection: boolean().optional(),
	ackMaxChars: number().int().nonnegative().optional(),
	suppressToolErrorWarnings: boolean().optional(),
	timeoutSeconds: number().int().positive().optional(),
	lightContext: boolean().optional(),
	isolatedSession: boolean().optional(),
	skipWhenBusy: boolean().optional()
}).strict().superRefine((val, ctx) => {
	if (!val.every) return;
	try {
		parseDurationMs(val.every, { defaultUnit: "m" });
	} catch {
		ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["every"],
			message: "invalid duration (use ms, s, m, h)"
		});
	}
	const active = val.activeHours;
	if (!active) return;
	const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
	const validateTime = (raw, opts, path) => {
		if (!raw) return;
		if (!timePattern.test(raw)) {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["activeHours", path],
				message: "invalid time (use \"HH:MM\" 24h format)"
			});
			return;
		}
		const [hourStr, minuteStr] = raw.split(":");
		const hour = Number(hourStr);
		const minute = Number(minuteStr);
		if (hour === 24 && minute !== 0) {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: ["activeHours", path],
				message: "invalid time (24:00 is the only allowed 24:xx value)"
			});
			return;
		}
		if (hour === 24 && !opts.allow24) ctx.addIssue({
			code: ZodIssueCode.custom,
			path: ["activeHours", path],
			message: "invalid time (start cannot be 24:00)"
		});
	};
	validateTime(active.start, { allow24: false }, "start");
	validateTime(active.end, { allow24: true }, "end");
}).optional();
const SandboxDockerSchema = object({
	image: string().optional(),
	containerPrefix: string().optional(),
	workdir: string().optional(),
	readOnlyRoot: boolean().optional(),
	tmpfs: array(string()).optional(),
	network: string().optional(),
	user: string().optional(),
	capDrop: array(string()).optional(),
	env: record(string(), string()).optional(),
	setupCommand: union([string(), array(string())]).transform((value) => Array.isArray(value) ? value.join("\n") : value).optional(),
	pidsLimit: number().int().positive().optional(),
	memory: union([string(), number()]).optional(),
	memorySwap: union([string(), number()]).optional(),
	cpus: number().positive().optional(),
	gpus: string().min(1).optional(),
	ulimits: record(string(), union([
		string(),
		number(),
		object({
			soft: number().int().nonnegative().optional(),
			hard: number().int().nonnegative().optional()
		}).strict()
	])).optional(),
	seccompProfile: string().optional(),
	apparmorProfile: string().optional(),
	dns: array(string()).optional(),
	extraHosts: array(string()).optional(),
	binds: array(string()).optional(),
	dangerouslyAllowReservedContainerTargets: boolean().optional(),
	dangerouslyAllowExternalBindSources: boolean().optional(),
	dangerouslyAllowContainerNamespaceJoin: boolean().optional()
}).strict().superRefine((data, ctx) => {
	validateSandboxBindEntries(data.binds, ctx);
	const blockedNetworkReason = getBlockedNetworkModeReason({
		network: data.network,
		allowContainerNamespaceJoin: data.dangerouslyAllowContainerNamespaceJoin === true
	});
	if (blockedNetworkReason === "host") ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: network mode \"host\" is blocked. Use \"bridge\" or \"none\" instead."
	});
	if (blockedNetworkReason === "container_namespace_join") ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: network mode \"container:*\" is blocked by default. Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime."
	});
	if (normalizeLowercaseStringOrEmpty(data.seccompProfile ?? "") === "unconfined") ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["seccompProfile"],
		message: "Sandbox security: seccomp profile \"unconfined\" is blocked. Use a custom seccomp profile file or omit this setting."
	});
	if (normalizeLowercaseStringOrEmpty(data.apparmorProfile ?? "") === "unconfined") ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["apparmorProfile"],
		message: "Sandbox security: apparmor profile \"unconfined\" is blocked. Use a named AppArmor profile or omit this setting."
	});
}).optional();
const SandboxBrowserSchema = object({
	enabled: boolean().optional(),
	image: string().optional(),
	containerPrefix: string().optional(),
	network: string().optional(),
	cdpPort: number().int().positive().optional(),
	cdpSourceRange: string().optional(),
	vncPort: number().int().positive().optional(),
	noVncPort: number().int().positive().optional(),
	headless: boolean().optional(),
	enableNoVnc: boolean().optional(),
	allowHostControl: boolean().optional(),
	autoStart: boolean().optional(),
	autoStartTimeoutMs: number().int().positive().optional(),
	binds: array(string()).optional()
}).superRefine((data, ctx) => {
	validateSandboxBindEntries(data.binds, ctx);
	if (normalizeLowercaseStringOrEmpty(data.network ?? "") === "host") ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: browser network mode \"host\" is blocked. Use \"bridge\" or a custom bridge network instead."
	});
}).strict().optional();
const SandboxPruneSchema = object({
	idleHours: number().int().nonnegative().optional(),
	maxAgeDays: number().int().nonnegative().optional()
}).strict().optional();
const AgentContextLimitsSchema = object({
	memoryGetMaxChars: number().int().min(1).max(25e4).optional(),
	memoryGetDefaultLines: number().int().min(1).max(5e3).optional(),
	toolResultMaxChars: number().int().min(1).max(25e4).optional(),
	postCompactionMaxChars: number().int().min(1).max(5e4).optional()
}).strict().optional();
const AgentSkillsLimitsSchema = object({ maxSkillsPromptChars: number().int().min(0).optional() }).strict().optional();
const ToolPolicySchema = object({
	allow: array(string()).optional(),
	alsoAllow: array(string()).optional(),
	deny: array(string()).optional()
}).strict().superRefine((value, ctx) => {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: ZodIssueCode.custom,
		message: "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
	});
}).optional();
const ToolPolicyBySenderSchema = record(string(), ToolPolicySchema).optional();
const TrimmedOptionalConfigStringSchema = string().transform((value) => {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}).optional();
const CodexAllowedDomainsSchema = array(string()).transform((values) => {
	const deduped = [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
	return deduped.length > 0 ? deduped : void 0;
}).optional();
const CodexUserLocationSchema = object({
	country: TrimmedOptionalConfigStringSchema,
	region: TrimmedOptionalConfigStringSchema,
	city: TrimmedOptionalConfigStringSchema,
	timezone: TrimmedOptionalConfigStringSchema
}).strict().transform((value) => {
	return value.country || value.region || value.city || value.timezone ? value : void 0;
}).optional();
const LEGACY_WEB_SEARCH_PROVIDER_CONFIG_KEYS = new Set([
	"brave",
	"duckduckgo",
	"exa",
	"firecrawl",
	"gemini",
	"grok",
	"kimi",
	"minimax",
	"ollama",
	"perplexity",
	"searxng",
	"tavily"
]);
function isPlainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
const BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD = "__openclawBlockedWebSearchKeys";
const ToolsWebSchema = object({
	search: preprocess((value) => {
		if (!isPlainRecord(value)) return value;
		const blockedKeys = Object.getOwnPropertyNames(value).filter((key) => isBlockedObjectKey(key));
		if (blockedKeys.length === 0) return value;
		return {
			...value,
			[BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD]: blockedKeys
		};
	}, object({
		enabled: boolean().optional(),
		provider: string().optional(),
		maxResults: number().int().positive().optional(),
		timeoutSeconds: number().int().positive().optional(),
		cacheTtlMinutes: number().nonnegative().optional(),
		apiKey: SecretInputSchema.optional().register(sensitive),
		openaiCodex: object({
			enabled: boolean().optional(),
			mode: union([literal("cached"), literal("live")]).optional(),
			allowedDomains: CodexAllowedDomainsSchema,
			contextSize: union([
				literal("low"),
				literal("medium"),
				literal("high")
			]).optional(),
			userLocation: CodexUserLocationSchema
		}).strict().optional()
	}).catchall(unknown()).superRefine((value, ctx) => {
		const blockedKeys = value[BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD];
		if (Array.isArray(blockedKeys)) for (const key of blockedKeys) {
			if (typeof key !== "string") continue;
			ctx.addIssue({
				code: ZodIssueCode.custom,
				path: [key],
				message: "tools.web.search must not contain blocked object keys"
			});
		}
		for (const [key, entry] of Object.entries(value)) {
			if (key === BLOCKED_WEB_SEARCH_KEYS_ISSUE_FIELD || isBlockedObjectKey(key)) continue;
			if (LEGACY_WEB_SEARCH_PROVIDER_CONFIG_KEYS.has(key) && isPlainRecord(entry)) ctx.addIssue({
				code: ZodIssueCode.custom,
				path: [key],
				message: "legacy web_search provider config must use plugins.entries.<plugin>.config.webSearch"
			});
		}
	})).optional(),
	fetch: object({
		enabled: boolean().optional(),
		provider: string().optional(),
		maxChars: number().int().positive().optional(),
		maxCharsCap: number().int().positive().optional(),
		maxResponseBytes: number().int().positive().optional(),
		timeoutSeconds: number().int().positive().optional(),
		cacheTtlMinutes: number().nonnegative().optional(),
		maxRedirects: number().int().nonnegative().optional(),
		userAgent: string().optional(),
		readability: boolean().optional(),
		useTrustedEnvProxy: boolean().optional(),
		ssrfPolicy: object({
			allowRfc2544BenchmarkRange: boolean().optional(),
			allowIpv6UniqueLocalRange: boolean().optional()
		}).strict().optional(),
		firecrawl: object({
			enabled: boolean().optional(),
			apiKey: SecretInputSchema.optional().register(sensitive),
			baseUrl: string().optional(),
			onlyMainContent: boolean().optional(),
			maxAgeMs: number().int().nonnegative().optional(),
			timeoutSeconds: number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	x_search: object({
		enabled: boolean().optional(),
		model: string().optional(),
		inlineCitations: boolean().optional(),
		maxTurns: number().int().optional(),
		timeoutSeconds: number().int().positive().optional(),
		cacheTtlMinutes: number().nonnegative().optional()
	}).strict().optional()
}).strict().optional();
const ToolProfileSchema = union([
	literal("minimal"),
	literal("coding"),
	literal("messaging"),
	literal("full")
]).optional();
function addAllowAlsoAllowConflictIssue(value, ctx, message) {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) ctx.addIssue({
		code: ZodIssueCode.custom,
		message
	});
}
const ToolPolicyWithProfileSchema = object({
	allow: array(string()).optional(),
	alsoAllow: array(string()).optional(),
	deny: array(string()).optional(),
	profile: ToolProfileSchema
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
});
const ElevatedAllowFromSchema = record(string(), array(union([string(), number()]))).optional();
const ToolExecApplyPatchSchema = object({
	enabled: boolean().optional(),
	workspaceOnly: boolean().optional(),
	allowModels: array(string()).optional()
}).strict().optional();
const ToolExecSafeBinProfileSchema = object({
	minPositional: number().int().nonnegative().optional(),
	maxPositional: number().int().nonnegative().optional(),
	allowedValueFlags: array(string()).optional(),
	deniedFlags: array(string()).optional()
}).strict();
const ToolExecBaseShape = {
	host: _enum([
		"auto",
		"sandbox",
		"gateway",
		"node"
	]).optional(),
	security: _enum([
		"deny",
		"allowlist",
		"full"
	]).optional(),
	ask: _enum([
		"off",
		"on-miss",
		"always"
	]).optional(),
	node: string().optional(),
	pathPrepend: array(string()).optional(),
	safeBins: array(string()).optional(),
	strictInlineEval: boolean().optional(),
	commandHighlighting: boolean().optional(),
	safeBinTrustedDirs: array(string()).optional(),
	safeBinProfiles: record(string(), ToolExecSafeBinProfileSchema).optional(),
	backgroundMs: number().int().positive().optional(),
	timeoutSec: number().int().positive().optional(),
	cleanupMs: number().int().positive().optional(),
	notifyOnExit: boolean().optional(),
	notifyOnExitEmptySuccess: boolean().optional(),
	applyPatch: ToolExecApplyPatchSchema
};
const AgentToolExecSchema = object({
	...ToolExecBaseShape,
	approvalRunningNoticeMs: number().int().nonnegative().optional()
}).strict().optional();
const ToolExecSchema = object(ToolExecBaseShape).strict().optional();
const ToolFsSchema = object({ workspaceOnly: boolean().optional() }).strict().optional();
const ToolLoopDetectionDetectorSchema = object({
	genericRepeat: boolean().optional(),
	knownPollNoProgress: boolean().optional(),
	pingPong: boolean().optional()
}).strict().optional();
const ToolLoopPostCompactionGuardSchema = object({ windowSize: number().int().positive().optional() }).strict().optional();
const ToolLoopDetectionSchema = object({
	enabled: boolean().optional(),
	historySize: number().int().positive().optional(),
	warningThreshold: number().int().positive().optional(),
	unknownToolThreshold: number().int().positive().optional(),
	criticalThreshold: number().int().positive().optional(),
	globalCircuitBreakerThreshold: number().int().positive().optional(),
	detectors: ToolLoopDetectionDetectorSchema,
	postCompactionGuard: ToolLoopPostCompactionGuardSchema
}).strict().superRefine((value, ctx) => {
	if (value.warningThreshold !== void 0 && value.criticalThreshold !== void 0 && value.warningThreshold >= value.criticalThreshold) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["criticalThreshold"],
		message: "tools.loopDetection.warningThreshold must be lower than criticalThreshold."
	});
	if (value.criticalThreshold !== void 0 && value.globalCircuitBreakerThreshold !== void 0 && value.criticalThreshold >= value.globalCircuitBreakerThreshold) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["globalCircuitBreakerThreshold"],
		message: "tools.loopDetection.criticalThreshold must be lower than globalCircuitBreakerThreshold."
	});
}).optional();
const ToolSearchSchema = union([boolean(), object({
	enabled: boolean().optional(),
	mode: _enum(["code", "tools"]).optional(),
	codeTimeoutMs: number().int().positive().optional(),
	searchDefaultLimit: number().int().positive().optional(),
	maxSearchLimit: number().int().positive().optional()
}).strict()]).optional();
const CodeModeSchema = union([boolean(), object({
	enabled: boolean().optional(),
	runtime: literal("quickjs-wasi").optional(),
	mode: literal("only").optional(),
	languages: array(_enum(["javascript", "typescript"])).optional(),
	timeoutMs: number().int().positive().optional(),
	memoryLimitBytes: number().int().positive().optional(),
	maxOutputBytes: number().int().positive().optional(),
	maxSnapshotBytes: number().int().positive().optional(),
	maxPendingToolCalls: number().int().positive().optional(),
	snapshotTtlSeconds: number().int().positive().optional(),
	searchDefaultLimit: number().int().positive().optional(),
	maxSearchLimit: number().int().positive().optional()
}).strict()]).optional();
const SandboxSshSchema = object({
	target: string().min(1).optional(),
	command: string().min(1).optional(),
	workspaceRoot: string().min(1).optional(),
	strictHostKeyChecking: boolean().optional(),
	updateHostKeys: boolean().optional(),
	identityFile: string().min(1).optional(),
	certificateFile: string().min(1).optional(),
	knownHostsFile: string().min(1).optional(),
	identityData: SecretInputSchema.optional().register(sensitive),
	certificateData: SecretInputSchema.optional().register(sensitive),
	knownHostsData: SecretInputSchema.optional().register(sensitive)
}).strict().optional();
const AgentSandboxSchema = object({
	mode: union([
		literal("off"),
		literal("non-main"),
		literal("all")
	]).optional(),
	backend: string().min(1).optional(),
	workspaceAccess: union([
		literal("none"),
		literal("ro"),
		literal("rw")
	]).optional(),
	sessionToolsVisibility: union([literal("spawned"), literal("all")]).optional(),
	scope: union([
		literal("session"),
		literal("agent"),
		literal("shared")
	]).optional(),
	workspaceRoot: string().optional(),
	docker: SandboxDockerSchema,
	ssh: SandboxSshSchema,
	browser: SandboxBrowserSchema,
	prune: SandboxPruneSchema
}).strict().superRefine((data, ctx) => {
	if (getBlockedNetworkModeReason({
		network: data.browser?.network,
		allowContainerNamespaceJoin: data.docker?.dangerouslyAllowContainerNamespaceJoin === true
	}) === "container_namespace_join") ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["browser", "network"],
		message: "Sandbox security: browser network mode \"container:*\" is blocked by default. Set sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime."
	});
}).optional();
const CommonToolPolicyFields = {
	profile: ToolProfileSchema,
	allow: array(string()).optional(),
	alsoAllow: array(string()).optional(),
	deny: array(string()).optional(),
	byProvider: record(string(), ToolPolicyWithProfileSchema).optional(),
	toolsBySender: ToolPolicyBySenderSchema
};
const MessageToolConfigSchema = object({
	allowCrossContextSend: boolean().optional(),
	crossContext: object({
		allowWithinProvider: boolean().optional(),
		allowAcrossProviders: boolean().optional(),
		marker: object({
			enabled: boolean().optional(),
			prefix: string().optional(),
			suffix: string().optional()
		}).strict().optional()
	}).strict().optional(),
	actions: object({ allow: array(string()).optional() }).strict().optional(),
	broadcast: object({ enabled: boolean().optional() }).strict().optional()
}).strict().optional();
const AgentToolsSchema = object({
	...CommonToolPolicyFields,
	codeMode: CodeModeSchema,
	elevated: object({
		enabled: boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: AgentToolExecSchema,
	fs: ToolFsSchema,
	loopDetection: ToolLoopDetectionSchema,
	message: MessageToolConfigSchema,
	sandbox: object({ tools: ToolPolicySchema }).strict().optional()
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
}).optional();
const MemorySearchSchema = object({
	enabled: boolean().optional(),
	sources: array(union([literal("memory"), literal("sessions")])).optional(),
	extraPaths: array(string()).optional(),
	qmd: object({ extraCollections: array(object({
		path: string(),
		name: string().optional(),
		pattern: string().optional()
	}).strict()).optional() }).strict().optional(),
	multimodal: object({
		enabled: boolean().optional(),
		modalities: array(union([
			literal("image"),
			literal("audio"),
			literal("all")
		])).optional(),
		maxFileBytes: number().int().positive().optional()
	}).strict().optional(),
	experimental: object({ sessionMemory: boolean().optional() }).strict().optional(),
	provider: string().optional(),
	remote: object({
		baseUrl: string().optional(),
		apiKey: SecretInputSchema.optional().register(sensitive),
		headers: record(string(), string()).optional(),
		nonBatchConcurrency: number().int().positive().optional(),
		batch: object({
			enabled: boolean().optional(),
			wait: boolean().optional(),
			concurrency: number().int().positive().optional(),
			pollIntervalMs: number().int().nonnegative().optional(),
			timeoutMinutes: number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	fallback: string().optional(),
	model: string().optional(),
	inputType: string().min(1).optional(),
	queryInputType: string().min(1).optional(),
	documentInputType: string().min(1).optional(),
	outputDimensionality: number().int().positive().optional(),
	local: object({
		modelPath: string().optional(),
		modelCacheDir: string().optional(),
		contextSize: union([number().int().positive(), literal("auto")]).optional()
	}).strict().optional(),
	store: object({
		driver: literal("sqlite").optional(),
		path: string().optional(),
		fts: object({ tokenizer: union([literal("unicode61"), literal("trigram")]).optional() }).strict().optional(),
		vector: object({
			enabled: boolean().optional(),
			extensionPath: string().optional()
		}).strict().optional()
	}).strict().optional(),
	chunking: object({
		tokens: number().int().positive().optional(),
		overlap: number().int().nonnegative().optional()
	}).strict().optional(),
	sync: object({
		onSessionStart: boolean().optional(),
		onSearch: boolean().optional(),
		watch: boolean().optional(),
		watchDebounceMs: number().int().nonnegative().optional(),
		intervalMinutes: number().int().nonnegative().optional(),
		embeddingBatchTimeoutSeconds: number().int().positive().optional(),
		sessions: object({
			deltaBytes: number().int().nonnegative().optional(),
			deltaMessages: number().int().nonnegative().optional(),
			postCompactionForce: boolean().optional()
		}).strict().optional()
	}).strict().optional(),
	query: object({
		maxResults: number().int().positive().optional(),
		minScore: number().min(0).max(1).optional(),
		hybrid: object({
			enabled: boolean().optional(),
			vectorWeight: number().min(0).max(1).optional(),
			textWeight: number().min(0).max(1).optional(),
			candidateMultiplier: number().int().positive().optional(),
			mmr: object({
				enabled: boolean().optional(),
				lambda: number().min(0).max(1).optional()
			}).strict().optional(),
			temporalDecay: object({
				enabled: boolean().optional(),
				halfLifeDays: number().int().positive().optional()
			}).strict().optional()
		}).strict().optional()
	}).strict().optional(),
	cache: object({
		enabled: boolean().optional(),
		maxEntries: number().int().positive().optional()
	}).strict().optional()
}).strict().optional();
const AgentRuntimeAcpSchema = object({
	agent: string().optional(),
	backend: string().optional(),
	mode: _enum(["persistent", "oneshot"]).optional(),
	cwd: string().optional()
}).strict().optional();
const AgentRuntimeSchema = union([object({ type: literal("embedded") }).strict(), object({
	type: literal("acp"),
	acp: AgentRuntimeAcpSchema
}).strict()]).optional();
const AgentEmbeddedHarnessSchema = object({ runtime: string().optional() }).strict().optional();
const AgentRuntimePolicySchema = object({ id: string().optional() }).strict().optional();
const AgentEntrySchema = object({
	id: string(),
	default: boolean().optional(),
	name: string().optional(),
	description: string().optional(),
	workspace: string().optional(),
	agentDir: string().optional(),
	systemPromptOverride: string().optional(),
	agentRuntime: AgentRuntimePolicySchema,
	embeddedHarness: AgentEmbeddedHarnessSchema,
	model: AgentModelSchema.optional(),
	models: record(string(), object({
		alias: string().optional(),
		params: record(string(), unknown()).optional(),
		agentRuntime: AgentRuntimePolicySchema,
		streaming: boolean().optional()
	}).strict()).optional(),
	thinkingDefault: _enum([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"adaptive",
		"max"
	]).optional(),
	verboseDefault: _enum([
		"off",
		"on",
		"full"
	]).optional(),
	toolProgressDetail: _enum(["explain", "raw"]).optional(),
	reasoningDefault: _enum([
		"on",
		"off",
		"stream"
	]).optional(),
	fastModeDefault: boolean().optional(),
	contextInjection: union([
		literal("always"),
		literal("continuation-skip"),
		literal("never")
	]).optional(),
	bootstrapMaxChars: number().int().positive().optional(),
	bootstrapTotalMaxChars: number().int().positive().optional(),
	experimental: object({ localModelLean: boolean().optional() }).strict().optional(),
	skills: array(string()).optional(),
	memorySearch: MemorySearchSchema,
	humanDelay: HumanDelaySchema.optional(),
	tts: TtsConfigSchema,
	skillsLimits: AgentSkillsLimitsSchema,
	contextLimits: AgentContextLimitsSchema,
	contextTokens: number().int().positive().optional(),
	heartbeat: HeartbeatSchema,
	identity: IdentitySchema,
	groupChat: GroupChatSchema,
	subagents: object({
		delegationMode: _enum(["suggest", "prefer"]).optional(),
		allowAgents: array(string()).optional(),
		model: AgentModelSchema.optional(),
		thinking: string().optional(),
		requireAgentId: boolean().optional()
	}).strict().optional(),
	runRetries: AgentRunRetriesConfigSchema.optional(),
	embeddedPi: object({ executionContract: union([literal("default"), literal("strict-agentic")]).optional() }).strict().optional(),
	sandbox: AgentSandboxSchema,
	params: record(string(), unknown()).optional(),
	tools: AgentToolsSchema,
	runtime: AgentRuntimeSchema
}).strict();
const ToolsSchema = object({
	...CommonToolPolicyFields,
	web: ToolsWebSchema,
	media: ToolsMediaSchema,
	links: ToolsLinksSchema,
	sessions: object({ visibility: _enum([
		"self",
		"tree",
		"agent",
		"all"
	]).optional() }).strict().optional(),
	loopDetection: ToolLoopDetectionSchema,
	toolSearch: ToolSearchSchema,
	codeMode: CodeModeSchema,
	message: MessageToolConfigSchema,
	agentToAgent: object({
		enabled: boolean().optional(),
		allow: array(string()).optional()
	}).strict().optional(),
	elevated: object({
		enabled: boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: ToolExecSchema,
	fs: ToolFsSchema,
	subagents: object({ tools: ToolPolicySchema }).strict().optional(),
	sandbox: object({ tools: ToolPolicySchema }).strict().optional(),
	sessions_spawn: object({ attachments: object({
		enabled: boolean().optional(),
		maxTotalBytes: number().optional(),
		maxFiles: number().optional(),
		maxFileBytes: number().optional(),
		retainOnSessionKeep: boolean().optional()
	}).strict().optional() }).strict().optional(),
	experimental: object({ planTool: boolean().optional() }).strict().optional()
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
}).optional();
//#endregion
export { AgentRuntimePolicySchema as a, HeartbeatSchema as c, ToolsSchema as d, AgentModelSchema as f, AgentRunRetriesConfigSchema as i, MemorySearchSchema as l, AgentEmbeddedHarnessSchema as n, AgentSandboxSchema as o, AgentToolModelSchema as p, AgentEntrySchema as r, ElevatedAllowFromSchema as s, AgentContextLimitsSchema as t, ToolPolicySchema as u };
