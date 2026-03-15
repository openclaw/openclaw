import { g as normalizeAccountId } from "./session-key-CbP51u9x.js";
import { Gt as hasConfiguredSecretInput } from "./runtime-DRRlb-lt.js";
import { F as SecretRefSchema, J as sensitive, K as requireAllowlistAllowFrom, L as ToolsLinksSchema, M as ReplyToModeSchema, N as RetryConfigSchema, P as SecretInputSchema, R as ToolsMediaSchema, S as IdentitySchema, T as MarkdownConfigSchema, V as TtsConfigSchema, _ as ExecutableTokenSchema, b as HexColorSchema, f as BlockStreamingChunkSchema, g as DmPolicySchema, h as DmConfigSchema, k as ProviderCommandsSchema, p as BlockStreamingCoalesceSchema, q as requireOpenAllowFrom, v as GroupChatSchema, w as MSTeamsReplyStyleSchema, x as HumanDelaySchema, y as GroupPolicySchema } from "./config-helpers-C9J9Kf27.js";
import path from "node:path";
import { z } from "zod";
//#region src/plugin-sdk/status-helpers.ts
/** Create the baseline runtime snapshot shape used by channel/account status stores. */
function createDefaultChannelRuntimeState(accountId, extra) {
	return {
		accountId,
		running: false,
		lastStartAt: null,
		lastStopAt: null,
		lastError: null,
		...extra
	};
}
/** Normalize a channel-level status summary so missing lifecycle fields become explicit nulls. */
function buildBaseChannelStatusSummary(snapshot) {
	return {
		configured: snapshot.configured ?? false,
		running: snapshot.running ?? false,
		lastStartAt: snapshot.lastStartAt ?? null,
		lastStopAt: snapshot.lastStopAt ?? null,
		lastError: snapshot.lastError ?? null
	};
}
/** Extend the base summary with probe fields while preserving stable null defaults. */
function buildProbeChannelStatusSummary(snapshot, extra) {
	return {
		...buildBaseChannelStatusSummary(snapshot),
		...extra,
		probe: snapshot.probe,
		lastProbeAt: snapshot.lastProbeAt ?? null
	};
}
/** Build the standard per-account status payload from config metadata plus runtime state. */
function buildBaseAccountStatusSnapshot(params) {
	const { account, runtime, probe } = params;
	return {
		accountId: account.accountId,
		name: account.name,
		enabled: account.enabled,
		configured: account.configured,
		...buildRuntimeAccountStatusSnapshot({
			runtime,
			probe
		}),
		lastInboundAt: runtime?.lastInboundAt ?? null,
		lastOutboundAt: runtime?.lastOutboundAt ?? null
	};
}
/** Convenience wrapper when the caller already has flattened account fields instead of an account object. */
function buildComputedAccountStatusSnapshot(params) {
	const { accountId, name, enabled, configured, runtime, probe } = params;
	return buildBaseAccountStatusSnapshot({
		account: {
			accountId,
			name,
			enabled,
			configured
		},
		runtime,
		probe
	});
}
/** Normalize runtime-only account state into the shared status snapshot fields. */
function buildRuntimeAccountStatusSnapshot(params) {
	const { runtime, probe } = params;
	return {
		running: runtime?.running ?? false,
		lastStartAt: runtime?.lastStartAt ?? null,
		lastStopAt: runtime?.lastStopAt ?? null,
		lastError: runtime?.lastError ?? null,
		probe
	};
}
/** Build token-based channel status summaries with optional mode reporting. */
function buildTokenChannelStatusSummary(snapshot, opts) {
	const base = {
		...buildBaseChannelStatusSummary(snapshot),
		tokenSource: snapshot.tokenSource ?? "none",
		probe: snapshot.probe,
		lastProbeAt: snapshot.lastProbeAt ?? null
	};
	if (opts?.includeMode === false) {return base;}
	return {
		...base,
		mode: snapshot.mode ?? null
	};
}
/** Convert account runtime errors into the generic channel status issue format. */
function collectStatusIssuesFromLastError(channel, accounts) {
	return accounts.flatMap((account) => {
		const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
		if (!lastError) {return [];}
		return [{
			channel,
			accountId: account.accountId,
			kind: "runtime",
			message: `Channel error: ${lastError}`
		}];
	});
}
//#endregion
//#region src/config/discord-preview-streaming.ts
function normalizeStreamingMode(value) {
	if (typeof value !== "string") {return null;}
	return value.trim().toLowerCase() || null;
}
function parseStreamingMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "off" || normalized === "partial" || normalized === "block" || normalized === "progress") {return normalized;}
	return null;
}
function parseDiscordPreviewStreamMode(value) {
	const parsed = parseStreamingMode(value);
	if (!parsed) {return null;}
	return parsed === "progress" ? "partial" : parsed;
}
function parseSlackLegacyDraftStreamMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "replace" || normalized === "status_final" || normalized === "append") {return normalized;}
	return null;
}
function mapSlackLegacyDraftStreamModeToStreaming(mode) {
	if (mode === "append") {return "block";}
	if (mode === "status_final") {return "progress";}
	return "partial";
}
function mapStreamingModeToSlackLegacyDraftStreamMode(mode) {
	if (mode === "block") {return "append";}
	if (mode === "progress") {return "status_final";}
	return "replace";
}
function resolveTelegramPreviewStreamMode(params = {}) {
	const parsedStreaming = parseStreamingMode(params.streaming);
	if (parsedStreaming) {
		if (parsedStreaming === "progress") {return "partial";}
		return parsedStreaming;
	}
	const legacy = parseDiscordPreviewStreamMode(params.streamMode);
	if (legacy) {return legacy;}
	if (typeof params.streaming === "boolean") {return params.streaming ? "partial" : "off";}
	return "partial";
}
function resolveDiscordPreviewStreamMode(params = {}) {
	const parsedStreaming = parseDiscordPreviewStreamMode(params.streaming);
	if (parsedStreaming) {return parsedStreaming;}
	const legacy = parseDiscordPreviewStreamMode(params.streamMode);
	if (legacy) {return legacy;}
	if (typeof params.streaming === "boolean") {return params.streaming ? "partial" : "off";}
	return "off";
}
function resolveSlackStreamingMode(params = {}) {
	const parsedStreaming = parseStreamingMode(params.streaming);
	if (parsedStreaming) {return parsedStreaming;}
	const legacyStreamMode = parseSlackLegacyDraftStreamMode(params.streamMode);
	if (legacyStreamMode) {return mapSlackLegacyDraftStreamModeToStreaming(legacyStreamMode);}
	if (typeof params.streaming === "boolean") {return params.streaming ? "partial" : "off";}
	return "partial";
}
function resolveSlackNativeStreaming(params = {}) {
	if (typeof params.nativeStreaming === "boolean") {return params.nativeStreaming;}
	if (typeof params.streaming === "boolean") {return params.streaming;}
	return true;
}
function formatSlackStreamModeMigrationMessage(pathPrefix, resolvedStreaming) {
	return `Moved ${pathPrefix}.streamMode → ${pathPrefix}.streaming (${resolvedStreaming}).`;
}
function formatSlackStreamingBooleanMigrationMessage(pathPrefix, resolvedNativeStreaming) {
	return `Moved ${pathPrefix}.streaming (boolean) → ${pathPrefix}.nativeStreaming (${resolvedNativeStreaming}).`;
}
//#endregion
//#region src/cli/parse-duration.ts
const DURATION_MULTIPLIERS = {
	ms: 1,
	s: 1e3,
	m: 6e4,
	h: 36e5,
	d: 864e5
};
function parseDurationMs(raw, opts) {
	const trimmed = String(raw ?? "").trim().toLowerCase();
	if (!trimmed) {throw new Error("invalid duration (empty)");}
	const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
	if (single) {
		const value = Number(single[1]);
		if (!Number.isFinite(value) || value < 0) {throw new Error(`invalid duration: ${raw}`);}
		const unit = single[2] ?? opts?.defaultUnit ?? "ms";
		const ms = Math.round(value * DURATION_MULTIPLIERS[unit]);
		if (!Number.isFinite(ms)) {throw new Error(`invalid duration: ${raw}`);}
		return ms;
	}
	let totalMs = 0;
	let consumed = 0;
	for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
		const [full, valueRaw, unitRaw] = match;
		const index = match.index ?? -1;
		if (!full || !valueRaw || !unitRaw || index < 0) {throw new Error(`invalid duration: ${raw}`);}
		if (index !== consumed) {throw new Error(`invalid duration: ${raw}`);}
		const value = Number(valueRaw);
		if (!Number.isFinite(value) || value < 0) {throw new Error(`invalid duration: ${raw}`);}
		const multiplier = DURATION_MULTIPLIERS[unitRaw];
		if (!multiplier) {throw new Error(`invalid duration: ${raw}`);}
		totalMs += value * multiplier;
		consumed += full.length;
	}
	if (consumed !== trimmed.length || consumed === 0) {throw new Error(`invalid duration: ${raw}`);}
	const ms = Math.round(totalMs);
	if (!Number.isFinite(ms)) {throw new Error(`invalid duration: ${raw}`);}
	return ms;
}
//#endregion
//#region src/agents/sandbox/network-mode.ts
function normalizeNetworkMode(network) {
	return network?.trim().toLowerCase() || void 0;
}
function getBlockedNetworkModeReason(params) {
	const normalized = normalizeNetworkMode(params.network);
	if (!normalized) {return null;}
	if (normalized === "host") {return "host";}
	if (normalized.startsWith("container:") && params.allowContainerNamespaceJoin !== true) {return "container_namespace_join";}
	return null;
}
//#endregion
//#region src/config/zod-schema.agent-model.ts
const AgentModelSchema = z.union([z.string(), z.object({
	primary: z.string().optional(),
	fallbacks: z.array(z.string()).optional()
}).strict()]);
//#endregion
//#region src/config/zod-schema.agent-runtime.ts
const HeartbeatSchema = z.object({
	every: z.string().optional(),
	activeHours: z.object({
		start: z.string().optional(),
		end: z.string().optional(),
		timezone: z.string().optional()
	}).strict().optional(),
	model: z.string().optional(),
	session: z.string().optional(),
	includeReasoning: z.boolean().optional(),
	target: z.string().optional(),
	directPolicy: z.union([z.literal("allow"), z.literal("block")]).optional(),
	to: z.string().optional(),
	accountId: z.string().optional(),
	prompt: z.string().optional(),
	ackMaxChars: z.number().int().nonnegative().optional(),
	suppressToolErrorWarnings: z.boolean().optional(),
	lightContext: z.boolean().optional(),
	isolatedSession: z.boolean().optional()
}).strict().superRefine((val, ctx) => {
	if (!val.every) {return;}
	try {
		parseDurationMs(val.every, { defaultUnit: "m" });
	} catch {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["every"],
			message: "invalid duration (use ms, s, m, h)"
		});
	}
	const active = val.activeHours;
	if (!active) {return;}
	const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
	const validateTime = (raw, opts, path) => {
		if (!raw) {return;}
		if (!timePattern.test(raw)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
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
				code: z.ZodIssueCode.custom,
				path: ["activeHours", path],
				message: "invalid time (24:00 is the only allowed 24:xx value)"
			});
			return;
		}
		if (hour === 24 && !opts.allow24) {ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["activeHours", path],
			message: "invalid time (start cannot be 24:00)"
		});}
	};
	validateTime(active.start, { allow24: false }, "start");
	validateTime(active.end, { allow24: true }, "end");
}).optional();
const SandboxDockerSchema = z.object({
	image: z.string().optional(),
	containerPrefix: z.string().optional(),
	workdir: z.string().optional(),
	readOnlyRoot: z.boolean().optional(),
	tmpfs: z.array(z.string()).optional(),
	network: z.string().optional(),
	user: z.string().optional(),
	capDrop: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	setupCommand: z.union([z.string(), z.array(z.string())]).transform((value) => Array.isArray(value) ? value.join("\n") : value).optional(),
	pidsLimit: z.number().int().positive().optional(),
	memory: z.union([z.string(), z.number()]).optional(),
	memorySwap: z.union([z.string(), z.number()]).optional(),
	cpus: z.number().positive().optional(),
	ulimits: z.record(z.string(), z.union([
		z.string(),
		z.number(),
		z.object({
			soft: z.number().int().nonnegative().optional(),
			hard: z.number().int().nonnegative().optional()
		}).strict()
	])).optional(),
	seccompProfile: z.string().optional(),
	apparmorProfile: z.string().optional(),
	dns: z.array(z.string()).optional(),
	extraHosts: z.array(z.string()).optional(),
	binds: z.array(z.string()).optional(),
	dangerouslyAllowReservedContainerTargets: z.boolean().optional(),
	dangerouslyAllowExternalBindSources: z.boolean().optional(),
	dangerouslyAllowContainerNamespaceJoin: z.boolean().optional()
}).strict().superRefine((data, ctx) => {
	if (data.binds) {for (let i = 0; i < data.binds.length; i += 1) {
		const bind = data.binds[i]?.trim() ?? "";
		if (!bind) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["binds", i],
				message: "Sandbox security: bind mount entry must be a non-empty string."
			});
			continue;
		}
		const firstColon = bind.indexOf(":");
		const source = (firstColon <= 0 ? bind : bind.slice(0, firstColon)).trim();
		if (!source.startsWith("/")) ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["binds", i],
			message: `Sandbox security: bind mount "${bind}" uses a non-absolute source path "${source}". Only absolute POSIX paths are supported for sandbox binds.`
		});
	}}
	const blockedNetworkReason = getBlockedNetworkModeReason({
		network: data.network,
		allowContainerNamespaceJoin: data.dangerouslyAllowContainerNamespaceJoin === true
	});
	if (blockedNetworkReason === "host") {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: network mode \"host\" is blocked. Use \"bridge\" or \"none\" instead."
	});}
	if (blockedNetworkReason === "container_namespace_join") {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: network mode \"container:*\" is blocked by default. Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime."
	});}
	if (data.seccompProfile?.trim().toLowerCase() === "unconfined") {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["seccompProfile"],
		message: "Sandbox security: seccomp profile \"unconfined\" is blocked. Use a custom seccomp profile file or omit this setting."
	});}
	if (data.apparmorProfile?.trim().toLowerCase() === "unconfined") {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["apparmorProfile"],
		message: "Sandbox security: apparmor profile \"unconfined\" is blocked. Use a named AppArmor profile or omit this setting."
	});}
}).optional();
const SandboxBrowserSchema = z.object({
	enabled: z.boolean().optional(),
	image: z.string().optional(),
	containerPrefix: z.string().optional(),
	network: z.string().optional(),
	cdpPort: z.number().int().positive().optional(),
	cdpSourceRange: z.string().optional(),
	vncPort: z.number().int().positive().optional(),
	noVncPort: z.number().int().positive().optional(),
	headless: z.boolean().optional(),
	enableNoVnc: z.boolean().optional(),
	allowHostControl: z.boolean().optional(),
	autoStart: z.boolean().optional(),
	autoStartTimeoutMs: z.number().int().positive().optional(),
	binds: z.array(z.string()).optional()
}).superRefine((data, ctx) => {
	if (data.network?.trim().toLowerCase() === "host") {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["network"],
		message: "Sandbox security: browser network mode \"host\" is blocked. Use \"bridge\" or a custom bridge network instead."
	});}
}).strict().optional();
const SandboxPruneSchema = z.object({
	idleHours: z.number().int().nonnegative().optional(),
	maxAgeDays: z.number().int().nonnegative().optional()
}).strict().optional();
const ToolPolicySchema = z.object({
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional()
}).strict().superRefine((value, ctx) => {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)"
	});}
}).optional();
const ToolsWebSearchSchema = z.object({
	enabled: z.boolean().optional(),
	provider: z.union([
		z.literal("brave"),
		z.literal("firecrawl"),
		z.literal("perplexity"),
		z.literal("grok"),
		z.literal("gemini"),
		z.literal("kimi")
	]).optional(),
	apiKey: SecretInputSchema.optional().register(sensitive),
	maxResults: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	cacheTtlMinutes: z.number().nonnegative().optional(),
	perplexity: z.object({
		apiKey: SecretInputSchema.optional().register(sensitive),
		baseUrl: z.string().optional(),
		model: z.string().optional()
	}).strict().optional(),
	grok: z.object({
		apiKey: SecretInputSchema.optional().register(sensitive),
		model: z.string().optional(),
		inlineCitations: z.boolean().optional()
	}).strict().optional(),
	gemini: z.object({
		apiKey: SecretInputSchema.optional().register(sensitive),
		model: z.string().optional()
	}).strict().optional(),
	firecrawl: z.object({
		apiKey: SecretInputSchema.optional().register(sensitive),
		baseUrl: z.string().optional()
	}).strict().optional(),
	kimi: z.object({
		apiKey: SecretInputSchema.optional().register(sensitive),
		baseUrl: z.string().optional(),
		model: z.string().optional()
	}).strict().optional(),
	brave: z.object({ mode: z.union([z.literal("web"), z.literal("llm-context")]).optional() }).strict().optional()
}).strict().optional();
const ToolsWebFetchSchema = z.object({
	enabled: z.boolean().optional(),
	maxChars: z.number().int().positive().optional(),
	maxCharsCap: z.number().int().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	cacheTtlMinutes: z.number().nonnegative().optional(),
	maxRedirects: z.number().int().nonnegative().optional(),
	userAgent: z.string().optional(),
	readability: z.boolean().optional(),
	firecrawl: z.object({
		enabled: z.boolean().optional(),
		apiKey: SecretInputSchema.optional().register(sensitive),
		baseUrl: z.string().optional(),
		onlyMainContent: z.boolean().optional(),
		maxAgeMs: z.number().int().nonnegative().optional(),
		timeoutSeconds: z.number().int().positive().optional()
	}).strict().optional()
}).strict().optional();
const ToolsWebSchema = z.object({
	search: ToolsWebSearchSchema,
	fetch: ToolsWebFetchSchema
}).strict().optional();
const ToolProfileSchema = z.union([
	z.literal("minimal"),
	z.literal("coding"),
	z.literal("messaging"),
	z.literal("full")
]).optional();
function addAllowAlsoAllowConflictIssue(value, ctx, message) {
	if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message
	});}
}
const ToolPolicyWithProfileSchema = z.object({
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	profile: ToolProfileSchema
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
});
const ElevatedAllowFromSchema = z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional();
const ToolExecApplyPatchSchema = z.object({
	enabled: z.boolean().optional(),
	workspaceOnly: z.boolean().optional(),
	allowModels: z.array(z.string()).optional()
}).strict().optional();
const ToolExecSafeBinProfileSchema = z.object({
	minPositional: z.number().int().nonnegative().optional(),
	maxPositional: z.number().int().nonnegative().optional(),
	allowedValueFlags: z.array(z.string()).optional(),
	deniedFlags: z.array(z.string()).optional()
}).strict();
const ToolExecBaseShape = {
	host: z.enum([
		"sandbox",
		"gateway",
		"node"
	]).optional(),
	security: z.enum([
		"deny",
		"allowlist",
		"full"
	]).optional(),
	ask: z.enum([
		"off",
		"on-miss",
		"always"
	]).optional(),
	node: z.string().optional(),
	pathPrepend: z.array(z.string()).optional(),
	safeBins: z.array(z.string()).optional(),
	safeBinTrustedDirs: z.array(z.string()).optional(),
	safeBinProfiles: z.record(z.string(), ToolExecSafeBinProfileSchema).optional(),
	backgroundMs: z.number().int().positive().optional(),
	timeoutSec: z.number().int().positive().optional(),
	cleanupMs: z.number().int().positive().optional(),
	notifyOnExit: z.boolean().optional(),
	notifyOnExitEmptySuccess: z.boolean().optional(),
	applyPatch: ToolExecApplyPatchSchema
};
const AgentToolExecSchema = z.object({
	...ToolExecBaseShape,
	approvalRunningNoticeMs: z.number().int().nonnegative().optional()
}).strict().optional();
const ToolExecSchema = z.object(ToolExecBaseShape).strict().optional();
const ToolFsSchema = z.object({ workspaceOnly: z.boolean().optional() }).strict().optional();
const ToolLoopDetectionDetectorSchema = z.object({
	genericRepeat: z.boolean().optional(),
	knownPollNoProgress: z.boolean().optional(),
	pingPong: z.boolean().optional()
}).strict().optional();
const ToolLoopDetectionSchema = z.object({
	enabled: z.boolean().optional(),
	historySize: z.number().int().positive().optional(),
	warningThreshold: z.number().int().positive().optional(),
	criticalThreshold: z.number().int().positive().optional(),
	globalCircuitBreakerThreshold: z.number().int().positive().optional(),
	detectors: ToolLoopDetectionDetectorSchema
}).strict().superRefine((value, ctx) => {
	if (value.warningThreshold !== void 0 && value.criticalThreshold !== void 0 && value.warningThreshold >= value.criticalThreshold) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["criticalThreshold"],
		message: "tools.loopDetection.warningThreshold must be lower than criticalThreshold."
	});}
	if (value.criticalThreshold !== void 0 && value.globalCircuitBreakerThreshold !== void 0 && value.criticalThreshold >= value.globalCircuitBreakerThreshold) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["globalCircuitBreakerThreshold"],
		message: "tools.loopDetection.criticalThreshold must be lower than globalCircuitBreakerThreshold."
	});}
}).optional();
const SandboxSshSchema = z.object({
	target: z.string().min(1).optional(),
	command: z.string().min(1).optional(),
	workspaceRoot: z.string().min(1).optional(),
	strictHostKeyChecking: z.boolean().optional(),
	updateHostKeys: z.boolean().optional(),
	identityFile: z.string().min(1).optional(),
	certificateFile: z.string().min(1).optional(),
	knownHostsFile: z.string().min(1).optional(),
	identityData: SecretInputSchema.optional().register(sensitive),
	certificateData: SecretInputSchema.optional().register(sensitive),
	knownHostsData: SecretInputSchema.optional().register(sensitive)
}).strict().optional();
const AgentSandboxSchema = z.object({
	mode: z.union([
		z.literal("off"),
		z.literal("non-main"),
		z.literal("all")
	]).optional(),
	backend: z.string().min(1).optional(),
	workspaceAccess: z.union([
		z.literal("none"),
		z.literal("ro"),
		z.literal("rw")
	]).optional(),
	sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
	scope: z.union([
		z.literal("session"),
		z.literal("agent"),
		z.literal("shared")
	]).optional(),
	perSession: z.boolean().optional(),
	workspaceRoot: z.string().optional(),
	docker: SandboxDockerSchema,
	ssh: SandboxSshSchema,
	browser: SandboxBrowserSchema,
	prune: SandboxPruneSchema
}).strict().superRefine((data, ctx) => {
	if (getBlockedNetworkModeReason({
		network: data.browser?.network,
		allowContainerNamespaceJoin: data.docker?.dangerouslyAllowContainerNamespaceJoin === true
	}) === "container_namespace_join") {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["browser", "network"],
		message: "Sandbox security: browser network mode \"container:*\" is blocked by default. Set sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime."
	});}
}).optional();
const CommonToolPolicyFields = {
	profile: ToolProfileSchema,
	allow: z.array(z.string()).optional(),
	alsoAllow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional()
};
const AgentToolsSchema = z.object({
	...CommonToolPolicyFields,
	elevated: z.object({
		enabled: z.boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: AgentToolExecSchema,
	fs: ToolFsSchema,
	loopDetection: ToolLoopDetectionSchema,
	sandbox: z.object({ tools: ToolPolicySchema }).strict().optional()
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
}).optional();
const MemorySearchSchema = z.object({
	enabled: z.boolean().optional(),
	sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
	extraPaths: z.array(z.string()).optional(),
	multimodal: z.object({
		enabled: z.boolean().optional(),
		modalities: z.array(z.union([
			z.literal("image"),
			z.literal("audio"),
			z.literal("all")
		])).optional(),
		maxFileBytes: z.number().int().positive().optional()
	}).strict().optional(),
	experimental: z.object({ sessionMemory: z.boolean().optional() }).strict().optional(),
	provider: z.union([
		z.literal("openai"),
		z.literal("local"),
		z.literal("gemini"),
		z.literal("voyage"),
		z.literal("mistral"),
		z.literal("ollama")
	]).optional(),
	remote: z.object({
		baseUrl: z.string().optional(),
		apiKey: SecretInputSchema.optional().register(sensitive),
		headers: z.record(z.string(), z.string()).optional(),
		batch: z.object({
			enabled: z.boolean().optional(),
			wait: z.boolean().optional(),
			concurrency: z.number().int().positive().optional(),
			pollIntervalMs: z.number().int().nonnegative().optional(),
			timeoutMinutes: z.number().int().positive().optional()
		}).strict().optional()
	}).strict().optional(),
	fallback: z.union([
		z.literal("openai"),
		z.literal("gemini"),
		z.literal("local"),
		z.literal("voyage"),
		z.literal("mistral"),
		z.literal("ollama"),
		z.literal("none")
	]).optional(),
	model: z.string().optional(),
	outputDimensionality: z.number().int().positive().optional(),
	local: z.object({
		modelPath: z.string().optional(),
		modelCacheDir: z.string().optional()
	}).strict().optional(),
	store: z.object({
		driver: z.literal("sqlite").optional(),
		path: z.string().optional(),
		vector: z.object({
			enabled: z.boolean().optional(),
			extensionPath: z.string().optional()
		}).strict().optional()
	}).strict().optional(),
	chunking: z.object({
		tokens: z.number().int().positive().optional(),
		overlap: z.number().int().nonnegative().optional()
	}).strict().optional(),
	sync: z.object({
		onSessionStart: z.boolean().optional(),
		onSearch: z.boolean().optional(),
		watch: z.boolean().optional(),
		watchDebounceMs: z.number().int().nonnegative().optional(),
		intervalMinutes: z.number().int().nonnegative().optional(),
		sessions: z.object({
			deltaBytes: z.number().int().nonnegative().optional(),
			deltaMessages: z.number().int().nonnegative().optional(),
			postCompactionForce: z.boolean().optional()
		}).strict().optional()
	}).strict().optional(),
	query: z.object({
		maxResults: z.number().int().positive().optional(),
		minScore: z.number().min(0).max(1).optional(),
		hybrid: z.object({
			enabled: z.boolean().optional(),
			vectorWeight: z.number().min(0).max(1).optional(),
			textWeight: z.number().min(0).max(1).optional(),
			candidateMultiplier: z.number().int().positive().optional(),
			mmr: z.object({
				enabled: z.boolean().optional(),
				lambda: z.number().min(0).max(1).optional()
			}).strict().optional(),
			temporalDecay: z.object({
				enabled: z.boolean().optional(),
				halfLifeDays: z.number().int().positive().optional()
			}).strict().optional()
		}).strict().optional()
	}).strict().optional(),
	cache: z.object({
		enabled: z.boolean().optional(),
		maxEntries: z.number().int().positive().optional()
	}).strict().optional()
}).strict().optional();
const AgentRuntimeAcpSchema = z.object({
	agent: z.string().optional(),
	backend: z.string().optional(),
	mode: z.enum(["persistent", "oneshot"]).optional(),
	cwd: z.string().optional()
}).strict().optional();
const AgentRuntimeSchema = z.union([z.object({ type: z.literal("embedded") }).strict(), z.object({
	type: z.literal("acp"),
	acp: AgentRuntimeAcpSchema
}).strict()]).optional();
const AgentEntrySchema = z.object({
	id: z.string(),
	default: z.boolean().optional(),
	name: z.string().optional(),
	workspace: z.string().optional(),
	agentDir: z.string().optional(),
	model: AgentModelSchema.optional(),
	skills: z.array(z.string()).optional(),
	memorySearch: MemorySearchSchema,
	humanDelay: HumanDelaySchema.optional(),
	heartbeat: HeartbeatSchema,
	identity: IdentitySchema,
	groupChat: GroupChatSchema,
	subagents: z.object({
		allowAgents: z.array(z.string()).optional(),
		model: z.union([z.string(), z.object({
			primary: z.string().optional(),
			fallbacks: z.array(z.string()).optional()
		}).strict()]).optional(),
		thinking: z.string().optional()
	}).strict().optional(),
	sandbox: AgentSandboxSchema,
	params: z.record(z.string(), z.unknown()).optional(),
	tools: AgentToolsSchema,
	runtime: AgentRuntimeSchema
}).strict();
const ToolsSchema = z.object({
	...CommonToolPolicyFields,
	web: ToolsWebSchema,
	media: ToolsMediaSchema,
	links: ToolsLinksSchema,
	sessions: z.object({ visibility: z.enum([
		"self",
		"tree",
		"agent",
		"all"
	]).optional() }).strict().optional(),
	loopDetection: ToolLoopDetectionSchema,
	message: z.object({
		allowCrossContextSend: z.boolean().optional(),
		crossContext: z.object({
			allowWithinProvider: z.boolean().optional(),
			allowAcrossProviders: z.boolean().optional(),
			marker: z.object({
				enabled: z.boolean().optional(),
				prefix: z.string().optional(),
				suffix: z.string().optional()
			}).strict().optional()
		}).strict().optional(),
		broadcast: z.object({ enabled: z.boolean().optional() }).strict().optional()
	}).strict().optional(),
	agentToAgent: z.object({
		enabled: z.boolean().optional(),
		allow: z.array(z.string()).optional()
	}).strict().optional(),
	elevated: z.object({
		enabled: z.boolean().optional(),
		allowFrom: ElevatedAllowFromSchema
	}).strict().optional(),
	exec: ToolExecSchema,
	fs: ToolFsSchema,
	subagents: z.object({ tools: ToolPolicySchema }).strict().optional(),
	sandbox: z.object({ tools: ToolPolicySchema }).strict().optional(),
	sessions_spawn: z.object({ attachments: z.object({
		enabled: z.boolean().optional(),
		maxTotalBytes: z.number().optional(),
		maxFiles: z.number().optional(),
		maxFileBytes: z.number().optional(),
		retainOnSessionKeep: z.boolean().optional()
	}).strict().optional() }).strict().optional()
}).strict().superRefine((value, ctx) => {
	addAllowAlsoAllowConflictIssue(value, ctx, "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)");
}).optional();
//#endregion
//#region src/config/zod-schema.channels.ts
const ChannelHeartbeatVisibilitySchema = z.object({
	showOk: z.boolean().optional(),
	showAlerts: z.boolean().optional(),
	useIndicator: z.boolean().optional()
}).strict().optional();
const ChannelHealthMonitorSchema = z.object({ enabled: z.boolean().optional() }).strict().optional();
//#endregion
//#region src/infra/scp-host.ts
const SSH_TOKEN = /^[A-Za-z0-9._-]+$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.%]+\]$/;
const WHITESPACE = /\s/;
const SCP_REMOTE_PATH_UNSAFE_CHARS = new Set([
	"\\",
	"'",
	"\"",
	"`",
	"$",
	";",
	"|",
	"&",
	"<",
	">"
]);
function hasControlOrWhitespace(value) {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 31 || code === 127 || WHITESPACE.test(char)) {return true;}
	}
	return false;
}
function normalizeScpRemoteHost(value) {
	if (typeof value !== "string") {return;}
	const trimmed = value.trim();
	if (!trimmed) {return;}
	if (hasControlOrWhitespace(trimmed)) {return;}
	if (trimmed.startsWith("-") || trimmed.includes("/") || trimmed.includes("\\")) {return;}
	const firstAt = trimmed.indexOf("@");
	const lastAt = trimmed.lastIndexOf("@");
	let user;
	let host = trimmed;
	if (firstAt !== -1) {
		if (firstAt !== lastAt || firstAt === 0 || firstAt === trimmed.length - 1) {return;}
		user = trimmed.slice(0, firstAt);
		host = trimmed.slice(firstAt + 1);
		if (!SSH_TOKEN.test(user)) {return;}
	}
	if (!host || host.startsWith("-") || host.includes("@")) {return;}
	if (host.includes(":") && !BRACKETED_IPV6.test(host)) {return;}
	if (!SSH_TOKEN.test(host) && !BRACKETED_IPV6.test(host)) {return;}
	return user ? `${user}@${host}` : host;
}
function isSafeScpRemoteHost(value) {
	return normalizeScpRemoteHost(value) !== void 0;
}
function normalizeScpRemotePath(value) {
	if (typeof value !== "string") {return;}
	const trimmed = value.trim();
	if (!trimmed || !trimmed.startsWith("/")) {return;}
	for (const char of trimmed) {
		const code = char.charCodeAt(0);
		if (code <= 31 || code === 127 || SCP_REMOTE_PATH_UNSAFE_CHARS.has(char)) {return;}
	}
	return trimmed;
}
//#endregion
//#region src/media/inbound-path-policy.ts
const WILDCARD_SEGMENT = "*";
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:$/;
const DEFAULT_IMESSAGE_ATTACHMENT_ROOTS = ["/Users/*/Library/Messages/Attachments"];
function normalizePosixAbsolutePath(value) {
	const trimmed = value.trim();
	if (!trimmed || trimmed.includes("\0")) {return;}
	const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
	if (!(normalized.startsWith("/") || WINDOWS_DRIVE_ABS_RE.test(normalized)) || normalized === "/") {return;}
	const withoutTrailingSlash = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	if (WINDOWS_DRIVE_ROOT_RE.test(withoutTrailingSlash)) {return;}
	return withoutTrailingSlash;
}
function splitPathSegments(value) {
	return value.split("/").filter(Boolean);
}
function matchesRootPattern(params) {
	const candidateSegments = splitPathSegments(params.candidatePath);
	const rootSegments = splitPathSegments(params.rootPattern);
	if (candidateSegments.length < rootSegments.length) {return false;}
	for (let idx = 0; idx < rootSegments.length; idx += 1) {
		const expected = rootSegments[idx];
		const actual = candidateSegments[idx];
		if (expected === WILDCARD_SEGMENT) {continue;}
		if (expected !== actual) {return false;}
	}
	return true;
}
function isValidInboundPathRootPattern(value) {
	const normalized = normalizePosixAbsolutePath(value);
	if (!normalized) {return false;}
	const segments = splitPathSegments(normalized);
	if (segments.length === 0) {return false;}
	return segments.every((segment) => segment === WILDCARD_SEGMENT || !segment.includes("*"));
}
function normalizeInboundPathRoots(roots) {
	const normalized = [];
	const seen = /* @__PURE__ */ new Set();
	for (const root of roots ?? []) {
		if (typeof root !== "string") {continue;}
		if (!isValidInboundPathRootPattern(root)) {continue;}
		const candidate = normalizePosixAbsolutePath(root);
		if (!candidate || seen.has(candidate)) {continue;}
		seen.add(candidate);
		normalized.push(candidate);
	}
	return normalized;
}
function mergeInboundPathRoots(...rootsLists) {
	const merged = [];
	const seen = /* @__PURE__ */ new Set();
	for (const roots of rootsLists) {
		const normalized = normalizeInboundPathRoots(roots);
		for (const root of normalized) {
			if (seen.has(root)) {continue;}
			seen.add(root);
			merged.push(root);
		}
	}
	return merged;
}
function isInboundPathAllowed(params) {
	const candidatePath = normalizePosixAbsolutePath(params.filePath);
	if (!candidatePath) {return false;}
	const roots = normalizeInboundPathRoots(params.roots);
	const effectiveRoots = roots.length > 0 ? roots : normalizeInboundPathRoots(params.fallbackRoots ?? void 0);
	if (effectiveRoots.length === 0) {return false;}
	return effectiveRoots.some((rootPattern) => matchesRootPattern({
		candidatePath,
		rootPattern
	}));
}
function resolveIMessageAccountConfig(params) {
	const accountId = params.accountId?.trim();
	if (!accountId) {return;}
	return params.cfg.channels?.imessage?.accounts?.[accountId];
}
function resolveIMessageAttachmentRoots(params) {
	return mergeInboundPathRoots(resolveIMessageAccountConfig(params)?.attachmentRoots, params.cfg.channels?.imessage?.attachmentRoots, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
}
function resolveIMessageRemoteAttachmentRoots(params) {
	const accountConfig = resolveIMessageAccountConfig(params);
	return mergeInboundPathRoots(accountConfig?.remoteAttachmentRoots, params.cfg.channels?.imessage?.remoteAttachmentRoots, accountConfig?.attachmentRoots, params.cfg.channels?.imessage?.attachmentRoots, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS);
}
//#endregion
//#region src/config/telegram-custom-commands.ts
const TELEGRAM_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
function normalizeTelegramCommandName(value) {
	const trimmed = value.trim();
	if (!trimmed) {return "";}
	return (trimmed.startsWith("/") ? trimmed.slice(1) : trimmed).trim().toLowerCase().replace(/-/g, "_");
}
function normalizeTelegramCommandDescription(value) {
	return value.trim();
}
function resolveTelegramCustomCommands(params) {
	const entries = Array.isArray(params.commands) ? params.commands : [];
	const reserved = params.reservedCommands ?? /* @__PURE__ */ new Set();
	const checkReserved = params.checkReserved !== false;
	const checkDuplicates = params.checkDuplicates !== false;
	const seen = /* @__PURE__ */ new Set();
	const resolved = [];
	const issues = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const normalized = normalizeTelegramCommandName(String(entry?.command ?? ""));
		if (!normalized) {
			issues.push({
				index,
				field: "command",
				message: "Telegram custom command is missing a command name."
			});
			continue;
		}
		if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" is invalid (use a-z, 0-9, underscore; max 32 chars).`
			});
			continue;
		}
		if (checkReserved && reserved.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" conflicts with a native command.`
			});
			continue;
		}
		if (checkDuplicates && seen.has(normalized)) {
			issues.push({
				index,
				field: "command",
				message: `Telegram custom command "/${normalized}" is duplicated.`
			});
			continue;
		}
		const description = normalizeTelegramCommandDescription(String(entry?.description ?? ""));
		if (!description) {
			issues.push({
				index,
				field: "description",
				message: `Telegram custom command "/${normalized}" is missing a description.`
			});
			continue;
		}
		if (checkDuplicates) {seen.add(normalized);}
		resolved.push({
			command: normalized,
			description
		});
	}
	return {
		commands: resolved,
		issues
	};
}
//#endregion
//#region src/config/zod-schema.secret-input-validation.ts
function forEachEnabledAccount(accounts, run) {
	if (!accounts) {return;}
	for (const [accountId, account] of Object.entries(accounts)) {
		if (!account || account.enabled === false) {continue;}
		run(accountId, account);
	}
}
function validateTelegramWebhookSecretRequirements(value, ctx) {
	const baseWebhookUrl = typeof value.webhookUrl === "string" ? value.webhookUrl.trim() : "";
	const hasBaseWebhookSecret = hasConfiguredSecretInput(value.webhookSecret);
	if (baseWebhookUrl && !hasBaseWebhookSecret) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
		path: ["webhookSecret"]
	});}
	forEachEnabledAccount(value.accounts, (accountId, account) => {
		if (!(typeof account.webhookUrl === "string" ? account.webhookUrl.trim() : "")) {return;}
		if (!hasConfiguredSecretInput(account.webhookSecret) && !hasBaseWebhookSecret) {ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
			path: [
				"accounts",
				accountId,
				"webhookSecret"
			]
		});}
	});
}
function validateSlackSigningSecretRequirements(value, ctx) {
	const baseMode = value.mode === "http" || value.mode === "socket" ? value.mode : "socket";
	if (baseMode === "http" && !hasConfiguredSecretInput(value.signingSecret)) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.slack.mode=\"http\" requires channels.slack.signingSecret",
		path: ["signingSecret"]
	});}
	forEachEnabledAccount(value.accounts, (accountId, account) => {
		if ((account.mode === "http" || account.mode === "socket" ? account.mode : baseMode) !== "http") {return;}
		if (!hasConfiguredSecretInput(account.signingSecret ?? value.signingSecret)) {ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "channels.slack.accounts.*.mode=\"http\" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret",
			path: [
				"accounts",
				accountId,
				"signingSecret"
			]
		});}
	});
}
//#endregion
//#region src/config/zod-schema.providers-core.ts
const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();
const DiscordIdSchema = z.union([z.string(), z.number()]).refine((value) => typeof value === "string", { message: "Discord IDs must be strings (wrap numeric IDs in quotes)." });
const DiscordIdListSchema = z.array(DiscordIdSchema);
const TelegramInlineButtonsScopeSchema = z.enum([
	"off",
	"dm",
	"group",
	"all",
	"allowlist"
]);
const TelegramIdListSchema = z.array(z.union([z.string(), z.number()]));
const TelegramCapabilitiesSchema = z.union([z.array(z.string()), z.object({ inlineButtons: TelegramInlineButtonsScopeSchema.optional() }).strict()]);
const SlackCapabilitiesSchema = z.union([z.array(z.string()), z.object({ interactiveReplies: z.boolean().optional() }).strict()]);
const TelegramTopicSchema = z.object({
	requireMention: z.boolean().optional(),
	disableAudioPreflight: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	agentId: z.string().optional()
}).strict();
const TelegramGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	disableAudioPreflight: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	topics: z.record(z.string(), TelegramTopicSchema.optional()).optional()
}).strict();
const TelegramDirectSchema = z.object({
	dmPolicy: DmPolicySchema.optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional(),
	topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
	requireTopic: z.boolean().optional()
}).strict();
const TelegramCustomCommandSchema = z.object({
	command: z.string().overwrite(normalizeTelegramCommandName),
	description: z.string().overwrite(normalizeTelegramCommandDescription)
}).strict();
const validateTelegramCustomCommands = (value, ctx) => {
	if (!value.customCommands || value.customCommands.length === 0) {return;}
	const { issues } = resolveTelegramCustomCommands({
		commands: value.customCommands,
		checkReserved: false,
		checkDuplicates: false
	});
	for (const issue of issues) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: [
			"customCommands",
			issue.index,
			issue.field
		],
		message: issue.message
	});}
};
function normalizeTelegramStreamingConfig(value) {
	value.streaming = resolveTelegramPreviewStreamMode(value);
	delete value.streamMode;
}
function normalizeDiscordStreamingConfig(value) {
	value.streaming = resolveDiscordPreviewStreamMode(value);
	delete value.streamMode;
}
function normalizeSlackStreamingConfig(value) {
	value.nativeStreaming = resolveSlackNativeStreaming(value);
	value.streaming = resolveSlackStreamingMode(value);
	delete value.streamMode;
}
const TelegramAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: TelegramCapabilitiesSchema.optional(),
	execApprovals: z.object({
		enabled: z.boolean().optional(),
		approvers: TelegramIdListSchema.optional(),
		agentFilter: z.array(z.string()).optional(),
		sessionFilter: z.array(z.string()).optional(),
		target: z.enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	customCommands: z.array(TelegramCustomCommandSchema).optional(),
	configWrites: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	botToken: SecretInputSchema.optional().register(sensitive),
	tokenFile: z.string().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.union([z.string(), z.number()]).optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	direct: z.record(z.string(), TelegramDirectSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	streaming: z.union([z.boolean(), z.enum([
		"off",
		"partial",
		"block",
		"progress"
	])]).optional(),
	blockStreaming: z.boolean().optional(),
	draftChunk: BlockStreamingChunkSchema.optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streamMode: z.enum([
		"off",
		"partial",
		"block"
	]).optional(),
	mediaMaxMb: z.number().positive().optional(),
	timeoutSeconds: z.number().int().positive().optional(),
	retry: RetryConfigSchema,
	network: z.object({
		autoSelectFamily: z.boolean().optional(),
		dnsResultOrder: z.enum(["ipv4first", "verbatim"]).optional()
	}).strict().optional(),
	proxy: z.string().optional(),
	webhookUrl: z.string().optional().describe("Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret."),
	webhookSecret: SecretInputSchema.optional().describe("Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.").register(sensitive),
	webhookPath: z.string().optional().describe("Local webhook route path served by the gateway listener. Defaults to /telegram-webhook."),
	webhookHost: z.string().optional().describe("Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress."),
	webhookPort: z.number().int().nonnegative().optional().describe("Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port."),
	webhookCertPath: z.string().optional().describe("Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain)."),
	actions: z.object({
		reactions: z.boolean().optional(),
		sendMessage: z.boolean().optional(),
		poll: z.boolean().optional(),
		deleteMessage: z.boolean().optional(),
		editMessage: z.boolean().optional(),
		sticker: z.boolean().optional(),
		createForumTopic: z.boolean().optional(),
		editForumTopic: z.boolean().optional()
	}).strict().optional(),
	threadBindings: z.object({
		enabled: z.boolean().optional(),
		idleHours: z.number().nonnegative().optional(),
		maxAgeHours: z.number().nonnegative().optional(),
		spawnSubagentSessions: z.boolean().optional(),
		spawnAcpSessions: z.boolean().optional()
	}).strict().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all"
	]).optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	linkPreview: z.boolean().optional(),
	silentErrorReplies: z.boolean().optional(),
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional()
}).strict();
const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
	normalizeTelegramStreamingConfig(value);
	validateTelegramCustomCommands(value, ctx);
});
const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
	accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	normalizeTelegramStreamingConfig(value);
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"open\" requires channels.telegram.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.telegram.dmPolicy=\"allowlist\" requires channels.telegram.allowFrom to contain at least one sender ID"
	});
	validateTelegramCustomCommands(value, ctx);
	if (value.accounts) {for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) continue;
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"open\" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"allowlist\" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to contain at least one sender ID"
		});
	}}
	if (!value.accounts) {
		validateTelegramWebhookSecretRequirements(value, ctx);
		return;
	}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) {continue;}
		if (account.enabled === false) {continue;}
		const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = Array.isArray(account.allowFrom) ? account.allowFrom : value.allowFrom;
		requireOpenAllowFrom({
			policy: effectiveDmPolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"open\" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectiveDmPolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.telegram.accounts.*.dmPolicy=\"allowlist\" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to contain at least one sender ID"
		});
	}
	validateTelegramWebhookSecretRequirements(value, ctx);
});
const DiscordDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: DiscordIdListSchema.optional()
}).strict();
const DiscordGuildChannelSchema = z.object({
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	ignoreOtherMentions: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	systemPrompt: z.string().optional(),
	includeThreadStarter: z.boolean().optional(),
	autoThread: z.boolean().optional(),
	autoArchiveDuration: z.union([
		z.enum([
			"60",
			"1440",
			"4320",
			"10080"
		]),
		z.literal(60),
		z.literal(1440),
		z.literal(4320),
		z.literal(10080)
	]).optional()
}).strict();
const DiscordGuildSchema = z.object({
	slug: z.string().optional(),
	requireMention: z.boolean().optional(),
	ignoreOtherMentions: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	users: DiscordIdListSchema.optional(),
	roles: DiscordIdListSchema.optional(),
	channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional()
}).strict();
const DiscordUiSchema = z.object({ components: z.object({ accentColor: HexColorSchema.optional() }).strict().optional() }).strict().optional();
const DiscordVoiceAutoJoinSchema = z.object({
	guildId: z.string().min(1),
	channelId: z.string().min(1)
}).strict();
const DiscordVoiceSchema = z.object({
	enabled: z.boolean().optional(),
	autoJoin: z.array(DiscordVoiceAutoJoinSchema).optional(),
	daveEncryption: z.boolean().optional(),
	decryptionFailureTolerance: z.number().int().min(0).optional(),
	tts: TtsConfigSchema.optional()
}).strict().optional();
const DiscordAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	token: SecretInputSchema.optional().register(sensitive),
	proxy: z.string().optional(),
	allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streaming: z.union([z.boolean(), z.enum([
		"off",
		"partial",
		"block",
		"progress"
	])]).optional(),
	streamMode: z.enum([
		"partial",
		"block",
		"off"
	]).optional(),
	draftChunk: BlockStreamingChunkSchema.optional(),
	maxLinesPerMessage: z.number().int().positive().optional(),
	mediaMaxMb: z.number().positive().optional(),
	retry: RetryConfigSchema,
	actions: z.object({
		reactions: z.boolean().optional(),
		stickers: z.boolean().optional(),
		emojiUploads: z.boolean().optional(),
		stickerUploads: z.boolean().optional(),
		polls: z.boolean().optional(),
		permissions: z.boolean().optional(),
		messages: z.boolean().optional(),
		threads: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		roleInfo: z.boolean().optional(),
		roles: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		voiceStatus: z.boolean().optional(),
		events: z.boolean().optional(),
		moderation: z.boolean().optional(),
		channels: z.boolean().optional(),
		presence: z.boolean().optional()
	}).strict().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: DiscordIdListSchema.optional(),
	defaultTo: z.string().optional(),
	dm: DiscordDmSchema.optional(),
	guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	execApprovals: z.object({
		enabled: z.boolean().optional(),
		approvers: DiscordIdListSchema.optional(),
		agentFilter: z.array(z.string()).optional(),
		sessionFilter: z.array(z.string()).optional(),
		cleanupAfterResolve: z.boolean().optional(),
		target: z.enum([
			"dm",
			"channel",
			"both"
		]).optional()
	}).strict().optional(),
	agentComponents: z.object({ enabled: z.boolean().optional() }).strict().optional(),
	ui: DiscordUiSchema,
	slashCommand: z.object({ ephemeral: z.boolean().optional() }).strict().optional(),
	threadBindings: z.object({
		enabled: z.boolean().optional(),
		idleHours: z.number().nonnegative().optional(),
		maxAgeHours: z.number().nonnegative().optional(),
		spawnSubagentSessions: z.boolean().optional(),
		spawnAcpSessions: z.boolean().optional()
	}).strict().optional(),
	intents: z.object({
		presence: z.boolean().optional(),
		guildMembers: z.boolean().optional()
	}).strict().optional(),
	voice: DiscordVoiceSchema,
	pluralkit: z.object({
		enabled: z.boolean().optional(),
		token: SecretInputSchema.optional().register(sensitive)
	}).strict().optional(),
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional(),
	ackReactionScope: z.enum([
		"group-mentions",
		"group-all",
		"direct",
		"all",
		"off",
		"none"
	]).optional(),
	activity: z.string().optional(),
	status: z.enum([
		"online",
		"dnd",
		"idle",
		"invisible"
	]).optional(),
	autoPresence: z.object({
		enabled: z.boolean().optional(),
		intervalMs: z.number().int().positive().optional(),
		minUpdateIntervalMs: z.number().int().positive().optional(),
		healthyText: z.string().optional(),
		degradedText: z.string().optional(),
		exhaustedText: z.string().optional()
	}).strict().optional(),
	activityType: z.union([
		z.literal(0),
		z.literal(1),
		z.literal(2),
		z.literal(3),
		z.literal(4),
		z.literal(5)
	]).optional(),
	activityUrl: z.string().url().optional(),
	inboundWorker: z.object({ runTimeoutMs: z.number().int().nonnegative().optional() }).strict().optional(),
	eventQueue: z.object({
		listenerTimeout: z.number().int().positive().optional(),
		maxQueueSize: z.number().int().positive().optional(),
		maxConcurrency: z.number().int().positive().optional()
	}).strict().optional()
}).strict().superRefine((value, ctx) => {
	normalizeDiscordStreamingConfig(value);
	const activityText = typeof value.activity === "string" ? value.activity.trim() : "";
	const hasActivity = Boolean(activityText);
	const hasActivityType = value.activityType !== void 0;
	const activityUrl = typeof value.activityUrl === "string" ? value.activityUrl.trim() : "";
	const hasActivityUrl = Boolean(activityUrl);
	if ((hasActivityType || hasActivityUrl) && !hasActivity) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activity is required when activityType or activityUrl is set",
		path: ["activity"]
	});}
	if (value.activityType === 1 && !hasActivityUrl) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activityUrl is required when activityType is 1 (Streaming)",
		path: ["activityUrl"]
	});}
	if (hasActivityUrl && value.activityType !== 1) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.activityType must be 1 (Streaming) when activityUrl is set",
		path: ["activityType"]
	});}
	const autoPresenceInterval = value.autoPresence?.intervalMs;
	const autoPresenceMinUpdate = value.autoPresence?.minUpdateIntervalMs;
	if (typeof autoPresenceInterval === "number" && typeof autoPresenceMinUpdate === "number" && autoPresenceMinUpdate > autoPresenceInterval) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		message: "channels.discord.autoPresence.minUpdateIntervalMs must be less than or equal to channels.discord.autoPresence.intervalMs",
		path: ["autoPresence", "minUpdateIntervalMs"]
	});}
});
const DiscordConfigSchema = DiscordAccountSchema.extend({
	accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
	const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
	const allowFromPath = value.allowFrom !== void 0 ? ["allowFrom"] : ["dm", "allowFrom"];
	requireOpenAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.discord.dmPolicy=\"open\" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.discord.dmPolicy=\"allowlist\" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to contain at least one sender ID"
	});
	if (!value.accounts) {return;}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) {continue;}
		const effectivePolicy = account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
		const effectiveAllowFrom = account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.discord.accounts.*.dmPolicy=\"open\" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.discord.accounts.*.dmPolicy=\"allowlist\" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to contain at least one sender ID"
		});
	}
});
const GoogleChatDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.googlechat.dm.policy=\"open\" requires channels.googlechat.dm.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.policy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.googlechat.dm.policy=\"allowlist\" requires channels.googlechat.dm.allowFrom to contain at least one sender ID"
	});
});
const GoogleChatGroupSchema = z.object({
	enabled: z.boolean().optional(),
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const GoogleChatAccountSchema = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	allowBots: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
	defaultTo: z.string().optional(),
	serviceAccount: z.union([
		z.string(),
		z.record(z.string(), z.unknown()),
		SecretRefSchema
	]).optional().register(sensitive),
	serviceAccountRef: SecretRefSchema.optional().register(sensitive),
	serviceAccountFile: z.string().optional(),
	audienceType: z.enum(["app-url", "project-number"]).optional(),
	audience: z.string().optional(),
	appPrincipal: z.string().optional(),
	webhookPath: z.string().optional(),
	webhookUrl: z.string().optional(),
	botUser: z.string().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streamMode: z.enum([
		"replace",
		"status_final",
		"append"
	]).optional().default("replace"),
	mediaMaxMb: z.number().positive().optional(),
	replyToMode: ReplyToModeSchema.optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	dm: GoogleChatDmSchema.optional(),
	healthMonitor: ChannelHealthMonitorSchema,
	typingIndicator: z.enum([
		"none",
		"message",
		"reaction"
	]).optional(),
	responsePrefix: z.string().optional()
}).strict();
const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
	accounts: z.record(z.string(), GoogleChatAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
});
const SlackDmSchema = z.object({
	enabled: z.boolean().optional(),
	policy: DmPolicySchema.optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupEnabled: z.boolean().optional(),
	groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional()
}).strict();
const SlackChannelSchema = z.object({
	enabled: z.boolean().optional(),
	allow: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	allowBots: z.boolean().optional(),
	users: z.array(z.union([z.string(), z.number()])).optional(),
	skills: z.array(z.string()).optional(),
	systemPrompt: z.string().optional()
}).strict();
const SlackThreadSchema = z.object({
	historyScope: z.enum(["thread", "channel"]).optional(),
	inheritParent: z.boolean().optional(),
	initialHistoryLimit: z.number().int().min(0).optional()
}).strict();
const SlackReplyToModeByChatTypeSchema = z.object({
	direct: ReplyToModeSchema.optional(),
	group: ReplyToModeSchema.optional(),
	channel: ReplyToModeSchema.optional()
}).strict();
const SlackAccountSchema = z.object({
	name: z.string().optional(),
	mode: z.enum(["socket", "http"]).optional(),
	signingSecret: SecretInputSchema.optional().register(sensitive),
	webhookPath: z.string().optional(),
	capabilities: SlackCapabilitiesSchema.optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	commands: ProviderCommandsSchema,
	configWrites: z.boolean().optional(),
	botToken: SecretInputSchema.optional().register(sensitive),
	appToken: SecretInputSchema.optional().register(sensitive),
	userToken: SecretInputSchema.optional().register(sensitive),
	userTokenReadOnly: z.boolean().optional().default(true),
	allowBots: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	requireMention: z.boolean().optional(),
	groupPolicy: GroupPolicySchema.optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	streaming: z.union([z.boolean(), z.enum([
		"off",
		"partial",
		"block",
		"progress"
	])]).optional(),
	nativeStreaming: z.boolean().optional(),
	streamMode: z.enum([
		"replace",
		"status_final",
		"append"
	]).optional(),
	mediaMaxMb: z.number().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	replyToMode: ReplyToModeSchema.optional(),
	replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
	thread: SlackThreadSchema.optional(),
	actions: z.object({
		reactions: z.boolean().optional(),
		messages: z.boolean().optional(),
		pins: z.boolean().optional(),
		search: z.boolean().optional(),
		permissions: z.boolean().optional(),
		memberInfo: z.boolean().optional(),
		channelInfo: z.boolean().optional(),
		emojiList: z.boolean().optional()
	}).strict().optional(),
	slashCommand: z.object({
		enabled: z.boolean().optional(),
		name: z.string().optional(),
		sessionPrefix: z.string().optional(),
		ephemeral: z.boolean().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	dm: SlackDmSchema.optional(),
	channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional(),
	ackReaction: z.string().optional(),
	typingReaction: z.string().optional()
}).strict().superRefine((value) => {
	normalizeSlackStreamingConfig(value);
});
const SlackConfigSchema = SlackAccountSchema.safeExtend({
	mode: z.enum(["socket", "http"]).optional().default("socket"),
	signingSecret: SecretInputSchema.optional().register(sensitive),
	webhookPath: z.string().optional().default("/slack/events"),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	accounts: z.record(z.string(), SlackAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
	const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
	const allowFromPath = value.allowFrom !== void 0 ? ["allowFrom"] : ["dm", "allowFrom"];
	requireOpenAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.slack.dmPolicy=\"open\" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: dmPolicy,
		allowFrom,
		ctx,
		path: [...allowFromPath],
		message: "channels.slack.dmPolicy=\"allowlist\" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to contain at least one sender ID"
	});
	const baseMode = value.mode ?? "socket";
	if (!value.accounts) {
		validateSlackSigningSecretRequirements(value, ctx);
		return;
	}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) {continue;}
		if (account.enabled === false) {continue;}
		const accountMode = account.mode ?? baseMode;
		const effectivePolicy = account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
		const effectiveAllowFrom = account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.slack.accounts.*.dmPolicy=\"open\" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.slack.accounts.*.dmPolicy=\"allowlist\" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to contain at least one sender ID"
		});
		if (accountMode !== "http") {continue;}
	}
	validateSlackSigningSecretRequirements(value, ctx);
});
const SignalGroupEntrySchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema
}).strict();
const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();
const SignalAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	account: z.string().optional(),
	accountUuid: z.string().optional(),
	httpUrl: z.string().optional(),
	httpHost: z.string().optional(),
	httpPort: z.number().int().positive().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	autoStart: z.boolean().optional(),
	startupTimeoutMs: z.number().int().min(1e3).max(12e4).optional(),
	receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
	ignoreAttachments: z.boolean().optional(),
	ignoreStories: z.boolean().optional(),
	sendReadReceipts: z.boolean().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groups: SignalGroupsSchema,
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	reactionNotifications: z.enum([
		"off",
		"own",
		"all",
		"allowlist"
	]).optional(),
	reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
	actions: z.object({ reactions: z.boolean().optional() }).strict().optional(),
	reactionLevel: z.enum([
		"off",
		"ack",
		"minimal",
		"extensive"
	]).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
}).strict();
const SignalAccountSchema = SignalAccountSchemaBase;
const SignalConfigSchema = SignalAccountSchemaBase.extend({
	accounts: z.record(z.string(), SignalAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"open\" requires channels.signal.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.signal.dmPolicy=\"allowlist\" requires channels.signal.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) {return;}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) {continue;}
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.signal.accounts.*.dmPolicy=\"open\" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.signal.accounts.*.dmPolicy=\"allowlist\" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to contain at least one sender ID"
		});
	}
});
const IrcGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const IrcNickServSchema = z.object({
	enabled: z.boolean().optional(),
	service: z.string().optional(),
	password: SecretInputSchema.optional().register(sensitive),
	passwordFile: z.string().optional(),
	register: z.boolean().optional(),
	registerEmail: z.string().optional()
}).strict();
const IrcAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	host: z.string().optional(),
	port: z.number().int().min(1).max(65535).optional(),
	tls: z.boolean().optional(),
	nick: z.string().optional(),
	username: z.string().optional(),
	realname: z.string().optional(),
	password: SecretInputSchema.optional().register(sensitive),
	passwordFile: z.string().optional(),
	nickserv: IrcNickServSchema.optional(),
	channels: z.array(z.string()).optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
	mentionPatterns: z.array(z.string()).optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaMaxMb: z.number().positive().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
}).strict();
function refineIrcAllowFromAndNickserv(value, ctx) {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"open\" requires channels.irc.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"allowlist\" requires channels.irc.allowFrom to contain at least one sender ID"
	});
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});}
}
const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
	if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) {ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["nickserv", "registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});}
});
const IrcConfigSchema = IrcAccountSchemaBase.extend({
	accounts: z.record(z.string(), IrcAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	refineIrcAllowFromAndNickserv(value, ctx);
	if (!value.accounts) {return;}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) {continue;}
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.irc.accounts.*.dmPolicy=\"open\" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.irc.accounts.*.dmPolicy=\"allowlist\" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to contain at least one sender ID"
		});
	}
});
const IMessageAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	enabled: z.boolean().optional(),
	configWrites: z.boolean().optional(),
	cliPath: ExecutableTokenSchema.optional(),
	dbPath: z.string().optional(),
	remoteHost: z.string().refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)").optional(),
	service: z.union([
		z.literal("imessage"),
		z.literal("sms"),
		z.literal("auto")
	]).optional(),
	region: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	includeAttachments: z.boolean().optional(),
	attachmentRoots: z.array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	remoteAttachmentRoots: z.array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root")).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: z.record(z.string(), z.object({
		requireMention: z.boolean().optional(),
		tools: ToolPolicySchema,
		toolsBySender: ToolPolicyBySenderSchema
	}).strict().optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
}).strict();
const IMessageAccountSchema = IMessageAccountSchemaBase;
const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
	accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"open\" requires channels.imessage.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.imessage.dmPolicy=\"allowlist\" requires channels.imessage.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) {return;}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) {continue;}
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.imessage.accounts.*.dmPolicy=\"open\" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.imessage.accounts.*.dmPolicy=\"allowlist\" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to contain at least one sender ID"
		});
	}
});
const BlueBubblesAllowFromEntry = z.union([z.string(), z.number()]);
const BlueBubblesActionSchema = z.object({
	reactions: z.boolean().optional(),
	edit: z.boolean().optional(),
	unsend: z.boolean().optional(),
	reply: z.boolean().optional(),
	sendWithEffect: z.boolean().optional(),
	renameGroup: z.boolean().optional(),
	setGroupIcon: z.boolean().optional(),
	addParticipant: z.boolean().optional(),
	removeParticipant: z.boolean().optional(),
	leaveGroup: z.boolean().optional(),
	sendAttachment: z.boolean().optional()
}).strict().optional();
const BlueBubblesGroupConfigSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema
}).strict();
const BlueBubblesAccountSchemaBase = z.object({
	name: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	enabled: z.boolean().optional(),
	serverUrl: z.string().optional(),
	password: SecretInputSchema.optional().register(sensitive),
	webhookPath: z.string().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
	groupAllowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	mediaMaxMb: z.number().int().positive().optional(),
	mediaLocalRoots: z.array(z.string()).optional(),
	sendReadReceipts: z.boolean().optional(),
	blockStreaming: z.boolean().optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	groups: z.record(z.string(), BlueBubblesGroupConfigSchema.optional()).optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
}).strict();
const BlueBubblesAccountSchema = BlueBubblesAccountSchemaBase;
const BlueBubblesConfigSchema = BlueBubblesAccountSchemaBase.extend({
	accounts: z.record(z.string(), BlueBubblesAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional(),
	actions: BlueBubblesActionSchema
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.bluebubbles.dmPolicy=\"open\" requires channels.bluebubbles.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.bluebubbles.dmPolicy=\"allowlist\" requires channels.bluebubbles.allowFrom to contain at least one sender ID"
	});
	if (!value.accounts) {return;}
	for (const [accountId, account] of Object.entries(value.accounts)) {
		if (!account) {continue;}
		const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
		const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
		requireOpenAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.bluebubbles.accounts.*.dmPolicy=\"open\" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to include \"*\""
		});
		requireAllowlistAllowFrom({
			policy: effectivePolicy,
			allowFrom: effectiveAllowFrom,
			ctx,
			path: [
				"accounts",
				accountId,
				"allowFrom"
			],
			message: "channels.bluebubbles.accounts.*.dmPolicy=\"allowlist\" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to contain at least one sender ID"
		});
	}
});
const MSTeamsChannelSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	replyStyle: MSTeamsReplyStyleSchema.optional()
}).strict();
const MSTeamsTeamSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: ToolPolicyBySenderSchema,
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional()
}).strict();
const MSTeamsConfigSchema = z.object({
	enabled: z.boolean().optional(),
	capabilities: z.array(z.string()).optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	configWrites: z.boolean().optional(),
	appId: z.string().optional(),
	appPassword: SecretInputSchema.optional().register(sensitive),
	tenantId: z.string().optional(),
	webhook: z.object({
		port: z.number().int().positive().optional(),
		path: z.string().optional()
	}).strict().optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.string()).optional(),
	defaultTo: z.string().optional(),
	groupAllowFrom: z.array(z.string()).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	textChunkLimit: z.number().int().positive().optional(),
	chunkMode: z.enum(["length", "newline"]).optional(),
	blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
	mediaAllowHosts: z.array(z.string()).optional(),
	mediaAuthAllowHosts: z.array(z.string()).optional(),
	requireMention: z.boolean().optional(),
	historyLimit: z.number().int().min(0).optional(),
	dmHistoryLimit: z.number().int().min(0).optional(),
	dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
	replyStyle: MSTeamsReplyStyleSchema.optional(),
	teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
	mediaMaxMb: z.number().positive().optional(),
	sharePointSiteId: z.string().optional(),
	heartbeat: ChannelHeartbeatVisibilitySchema,
	healthMonitor: ChannelHealthMonitorSchema,
	responsePrefix: z.string().optional()
}).strict().superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.msteams.dmPolicy=\"open\" requires channels.msteams.allowFrom to include \"*\""
	});
	requireAllowlistAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.msteams.dmPolicy=\"allowlist\" requires channels.msteams.allowFrom to contain at least one sender ID"
	});
});
//#endregion
//#region src/channels/plugins/normalize/signal.ts
function normalizeSignalMessagingTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) {return;}
	let normalized = trimmed;
	if (normalized.toLowerCase().startsWith("signal:")) {normalized = normalized.slice(7).trim();}
	if (!normalized) {return;}
	const lower = normalized.toLowerCase();
	if (lower.startsWith("group:")) {
		const id = normalized.slice(6).trim();
		return id ? `group:${id}` : void 0;
	}
	if (lower.startsWith("username:")) {
		const id = normalized.slice(9).trim();
		return id ? `username:${id}`.toLowerCase() : void 0;
	}
	if (lower.startsWith("u:")) {
		const id = normalized.slice(2).trim();
		return id ? `username:${id}`.toLowerCase() : void 0;
	}
	if (lower.startsWith("uuid:")) {
		const id = normalized.slice(5).trim();
		return id ? id.toLowerCase() : void 0;
	}
	return normalized.toLowerCase();
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_PATTERN = /^[0-9a-f]{32}$/i;
function looksLikeSignalTargetId(raw, normalized) {
	const candidates = [raw, normalized ?? ""].map((value) => value.trim()).filter(Boolean);
	for (const candidate of candidates) {
		if (/^(signal:)?(group:|username:|u:)/i.test(candidate)) {return true;}
		if (/^(signal:)?uuid:/i.test(candidate)) {
			const stripped = candidate.replace(/^signal:/i, "").replace(/^uuid:/i, "").trim();
			if (!stripped) {continue;}
			if (UUID_PATTERN.test(stripped) || UUID_COMPACT_PATTERN.test(stripped)) {return true;}
			continue;
		}
		const withoutSignalPrefix = candidate.replace(/^signal:/i, "").trim();
		if (UUID_PATTERN.test(withoutSignalPrefix) || UUID_COMPACT_PATTERN.test(withoutSignalPrefix)) {return true;}
		if (/^\+?\d{3,}$/.test(withoutSignalPrefix)) {return true;}
	}
	return false;
}
//#endregion
//#region src/channels/plugins/media-limits.ts
const MB = 1024 * 1024;
function resolveChannelMediaMaxBytes(params) {
	const accountId = normalizeAccountId(params.accountId);
	const channelLimit = params.resolveChannelLimitMb({
		cfg: params.cfg,
		accountId
	});
	if (channelLimit) {return channelLimit * MB;}
	if (params.cfg.agents?.defaults?.mediaMaxMb) {return params.cfg.agents.defaults.mediaMaxMb * MB;}
}
//#endregion
export { ToolPolicySchema as A, resolveSlackStreamingMode as B, ChannelHealthMonitorSchema as C, ElevatedAllowFromSchema as D, AgentSandboxSchema as E, formatSlackStreamModeMigrationMessage as F, buildProbeChannelStatusSummary as G, buildBaseAccountStatusSnapshot as H, formatSlackStreamingBooleanMigrationMessage as I, collectStatusIssuesFromLastError as J, buildRuntimeAccountStatusSnapshot as K, mapStreamingModeToSlackLegacyDraftStreamMode as L, AgentModelSchema as M, getBlockedNetworkModeReason as N, HeartbeatSchema as O, parseDurationMs as P, resolveDiscordPreviewStreamMode as R, normalizeScpRemotePath as S, AgentEntrySchema as T, buildBaseChannelStatusSummary as U, resolveTelegramPreviewStreamMode as V, buildComputedAccountStatusSnapshot as W, createDefaultChannelRuntimeState as Y, isInboundPathAllowed as _, DiscordConfigSchema as a, resolveIMessageRemoteAttachmentRoots as b, IrcConfigSchema as c, SlackConfigSchema as d, TelegramConfigSchema as f, DEFAULT_IMESSAGE_ATTACHMENT_ROOTS as g, resolveTelegramCustomCommands as h, BlueBubblesConfigSchema as i, ToolsSchema as j, MemorySearchSchema as k, MSTeamsConfigSchema as l, normalizeTelegramCommandName as m, looksLikeSignalTargetId as n, GoogleChatConfigSchema as o, TELEGRAM_COMMAND_NAME_PATTERN as p, buildTokenChannelStatusSummary as q, normalizeSignalMessagingTarget as r, IMessageConfigSchema as s, resolveChannelMediaMaxBytes as t, SignalConfigSchema as u, mergeInboundPathRoots as v, ChannelHeartbeatVisibilitySchema as w, normalizeScpRemoteHost as x, resolveIMessageAttachmentRoots as y, resolveSlackNativeStreaming as z };
