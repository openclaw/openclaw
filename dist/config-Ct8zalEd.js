import { s as hasConfiguredSecretInput, u as normalizeResolvedSecretInputString } from "./types.secrets-DwPik3M8.js";
import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, Zn as unknown, dn as literal, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { j as TtsConfigSchema } from "./zod-schema.core-D7Y_eqdd.js";
import { r as buildSecretInputSchema } from "./secret-input-CWnTb0tw.js";
import { c as REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, l as REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES } from "./session-runtime-CCTSwqCz.js";
import "./realtime-voice-D-uczs8E.js";
import "./api-DJljBPJY.js";
//#region extensions/voice-call/src/deep-merge.ts
const BLOCKED_MERGE_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function deepMergeDefined(base, override) {
	if (!isPlainObject(base) || !isPlainObject(override)) return override === void 0 ? base : override;
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (BLOCKED_MERGE_KEYS.has(key) || value === void 0) continue;
		const existing = result[key];
		result[key] = key in result ? deepMergeDefined(existing, value) : value;
	}
	return result;
}
function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
//#endregion
//#region extensions/voice-call/src/realtime-defaults.ts
const DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS = `You are OpenClaw's phone-call realtime voice interface. Keep spoken replies brief and natural. When a question needs deeper reasoning, current information, or tools, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} before answering.`;
//#endregion
//#region extensions/voice-call/src/config.ts
/**
* E.164 phone number format: +[country code][number]
* Examples use 555 prefix (reserved for fictional numbers)
*/
const E164Schema = string().regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");
/**
* Controls how inbound calls are handled:
* - "disabled": Block all inbound calls (outbound only)
* - "allowlist": Only accept calls from numbers in allowFrom
* - "pairing": Unknown callers can request pairing (future)
* - "open": Accept all inbound calls (dangerous!)
*/
const InboundPolicySchema = _enum([
	"disabled",
	"allowlist",
	"pairing",
	"open"
]);
const SecretInputSchema = buildSecretInputSchema();
const TelnyxConfigSchema = object({
	/** Telnyx API v2 key */
	apiKey: string().min(1).optional(),
	/** Telnyx connection ID (from Call Control app) */
	connectionId: string().min(1).optional(),
	/** Public key for webhook signature verification */
	publicKey: string().min(1).optional()
}).strict();
const TwilioConfigSchema = object({
	/** Twilio Account SID */
	accountSid: string().min(1).optional(),
	/** Twilio Auth Token */
	authToken: SecretInputSchema.optional()
}).strict();
const PlivoConfigSchema = object({
	/** Plivo Auth ID (starts with MA/SA) */
	authId: string().min(1).optional(),
	/** Plivo Auth Token */
	authToken: string().min(1).optional()
}).strict();
const VoiceCallNumberRouteConfigSchema = object({
	/** Greeting message for inbound calls to this number. */
	inboundGreeting: string().optional(),
	/** TTS override for inbound calls to this number. Deep-merges with global voice-call TTS. */
	tts: TtsConfigSchema,
	/** Agent ID to use for voice response generation for this number. */
	agentId: string().min(1).optional(),
	/** Optional model override for voice responses for this number. */
	responseModel: string().optional(),
	/** System prompt for voice responses for this number. */
	responseSystemPrompt: string().optional(),
	/** Timeout for response generation in ms for this number. */
	responseTimeoutMs: number().int().positive().optional()
}).strict();
const VoiceCallServeConfigSchema = object({
	/** Port to listen on */
	port: number().int().positive().default(3334),
	/** Bind address */
	bind: string().default("127.0.0.1"),
	/** Webhook path */
	path: string().min(1).default("/voice/webhook")
}).strict().default({
	port: 3334,
	bind: "127.0.0.1",
	path: "/voice/webhook"
});
const VoiceCallTailscaleConfigSchema = object({
	/**
	* Tailscale exposure mode:
	* - "off": No Tailscale exposure
	* - "serve": Tailscale serve (private to tailnet)
	* - "funnel": Tailscale funnel (public HTTPS)
	*/
	mode: _enum([
		"off",
		"serve",
		"funnel"
	]).default("off"),
	/** Path for Tailscale serve/funnel (should usually match serve.path) */
	path: string().min(1).default("/voice/webhook")
}).strict().default({
	mode: "off",
	path: "/voice/webhook"
});
const VoiceCallTunnelConfigSchema = object({
	/**
	* Tunnel provider:
	* - "none": No tunnel (use publicUrl if set, or manual setup)
	* - "ngrok": Use ngrok for public HTTPS tunnel
	* - "tailscale-serve": Tailscale serve (private to tailnet)
	* - "tailscale-funnel": Tailscale funnel (public HTTPS)
	*/
	provider: _enum([
		"none",
		"ngrok",
		"tailscale-serve",
		"tailscale-funnel"
	]).default("none"),
	/** ngrok auth token (optional, enables longer sessions and more features) */
	ngrokAuthToken: string().min(1).optional(),
	/** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
	ngrokDomain: string().min(1).optional(),
	/**
	* Allow ngrok free tier compatibility mode.
	* When true, forwarded headers may be trusted for loopback requests
	* to reconstruct the public ngrok URL used for signing.
	*
	* IMPORTANT: This does NOT bypass signature verification.
	*/
	allowNgrokFreeTierLoopbackBypass: boolean().default(false)
}).strict().default({
	provider: "none",
	allowNgrokFreeTierLoopbackBypass: false
});
const VoiceCallWebhookSecurityConfigSchema = object({
	/**
	* Allowed hostnames for webhook URL reconstruction.
	* Only these hosts are accepted from forwarding headers.
	*/
	allowedHosts: array(string().min(1)).default([]),
	/**
	* Trust X-Forwarded-* headers without a hostname allowlist.
	* WARNING: Only enable if you trust your proxy configuration.
	*/
	trustForwardingHeaders: boolean().default(false),
	/**
	* Trusted proxy IP addresses. Forwarded headers are only trusted when
	* the remote IP matches one of these addresses.
	*/
	trustedProxyIPs: array(string().min(1)).default([])
}).strict().default({
	allowedHosts: [],
	trustForwardingHeaders: false,
	trustedProxyIPs: []
});
/**
* Call mode determines how outbound calls behave:
* - "notify": Deliver message and auto-hangup after delay (one-way notification)
* - "conversation": Stay open for back-and-forth until explicit end or timeout
*/
const CallModeSchema = _enum(["notify", "conversation"]);
const VoiceCallSessionScopeSchema = _enum(["per-phone", "per-call"]);
const OutboundConfigSchema = object({
	/** Default call mode for outbound calls */
	defaultMode: CallModeSchema.default("notify"),
	/** Seconds to wait after TTS before auto-hangup in notify mode */
	notifyHangupDelaySec: number().int().nonnegative().default(3)
}).strict().default({
	defaultMode: "notify",
	notifyHangupDelaySec: 3
});
const RealtimeToolSchema = object({
	type: literal("function"),
	name: string().min(1),
	description: string(),
	parameters: object({
		type: literal("object"),
		properties: record(string(), unknown()),
		required: array(string()).optional()
	})
}).strict();
const VoiceCallRealtimeProvidersConfigSchema = record(string(), record(string(), unknown())).default({});
const VoiceCallRealtimeToolPolicySchema = _enum(REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES);
const VoiceCallRealtimeConsultPolicySchema = _enum([
	"auto",
	"substantive",
	"always"
]);
const VoiceCallRealtimeFastContextSourceSchema = _enum(["memory", "sessions"]);
const VoiceCallRealtimeFastContextConfigSchema = object({
	/** Enable bounded memory/session lookup before the full consult agent. */
	enabled: boolean().default(false),
	/** Hard deadline for the fast context lookup. */
	timeoutMs: number().int().positive().default(800),
	/** Maximum memory/session hits to inject into the realtime tool result. */
	maxResults: number().int().positive().default(3),
	/** Indexed sources used by the fast context lookup. */
	sources: array(VoiceCallRealtimeFastContextSourceSchema).min(1).default(["memory", "sessions"]),
	/** Fall back to the full agent consult when fast context has no answer. */
	fallbackToConsult: boolean().default(false)
}).strict().default({
	enabled: false,
	timeoutMs: 800,
	maxResults: 3,
	sources: ["memory", "sessions"],
	fallbackToConsult: false
});
const VoiceCallRealtimeAgentContextConfigSchema = object({
	/** Inject a compact agent persona/context capsule into realtime voice instructions. */
	enabled: boolean().default(false),
	/** Maximum number of characters from the generated capsule to append. */
	maxChars: number().int().positive().default(6e3),
	/** Include configured agent identity fields. */
	includeIdentity: boolean().default(true),
	/** Include agents.defaults/list systemPromptOverride when configured. */
	includeSystemPrompt: boolean().default(true),
	/** Include selected workspace files such as SOUL.md and IDENTITY.md. */
	includeWorkspaceFiles: boolean().default(true),
	/** Workspace-relative files to include, bounded by maxChars. */
	files: array(string().min(1)).default([
		"SOUL.md",
		"IDENTITY.md",
		"USER.md"
	])
}).strict().default({
	enabled: false,
	maxChars: 6e3,
	includeIdentity: true,
	includeSystemPrompt: true,
	includeWorkspaceFiles: true,
	files: [
		"SOUL.md",
		"IDENTITY.md",
		"USER.md"
	]
});
const VoiceCallRealtimeConsultThinkingLevelSchema = _enum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"adaptive",
	"max"
]);
const VoiceCallStreamingProvidersConfigSchema = record(string(), record(string(), unknown())).default({});
const VoiceCallRealtimeConfigSchema = object({
	/** Enable realtime voice-to-voice mode. */
	enabled: boolean().default(false),
	/** Provider id from registered realtime voice providers. */
	provider: string().min(1).optional(),
	/** Optional override for the local WebSocket route path. */
	streamPath: string().min(1).optional(),
	/** System instructions passed to the realtime provider. */
	instructions: string().default(DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS),
	/** Tool policy for the shared OpenClaw agent consult tool. */
	toolPolicy: VoiceCallRealtimeToolPolicySchema.default("safe-read-only"),
	/** Guidance for when the realtime model should call the OpenClaw agent consult tool. */
	consultPolicy: VoiceCallRealtimeConsultPolicySchema.default("auto"),
	/** Optional thinking level override for the regular agent behind realtime consults. */
	consultThinkingLevel: VoiceCallRealtimeConsultThinkingLevelSchema.optional(),
	/** Optional fast mode override for the regular agent behind realtime consults. */
	consultFastMode: boolean().optional(),
	/** Tool definitions exposed to the realtime provider. */
	tools: array(RealtimeToolSchema).default([]),
	/** Low-latency memory/session context for the consult tool. */
	fastContext: VoiceCallRealtimeFastContextConfigSchema,
	/** Bounded agent persona/context injection for the fast realtime voice path. */
	agentContext: VoiceCallRealtimeAgentContextConfigSchema,
	/** Provider-owned raw config blobs keyed by provider id. */
	providers: VoiceCallRealtimeProvidersConfigSchema
}).strict().default({
	enabled: false,
	instructions: DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS,
	toolPolicy: "safe-read-only",
	consultPolicy: "auto",
	tools: [],
	fastContext: {
		enabled: false,
		timeoutMs: 800,
		maxResults: 3,
		sources: ["memory", "sessions"],
		fallbackToConsult: false
	},
	agentContext: {
		enabled: false,
		maxChars: 6e3,
		includeIdentity: true,
		includeSystemPrompt: true,
		includeWorkspaceFiles: true,
		files: [
			"SOUL.md",
			"IDENTITY.md",
			"USER.md"
		]
	},
	providers: {}
});
const VoiceCallStreamingConfigSchema = object({
	/** Enable real-time audio streaming (requires WebSocket support) */
	enabled: boolean().default(false),
	/** Provider id from registered realtime transcription providers. */
	provider: string().min(1).optional(),
	/** WebSocket path for media stream connections */
	streamPath: string().min(1).default("/voice/stream"),
	/** Provider-owned raw config blobs keyed by provider id. */
	providers: VoiceCallStreamingProvidersConfigSchema,
	/**
	* Close unauthenticated media stream sockets if no valid `start` frame arrives in time.
	* Protects against pre-auth idle connection hold attacks.
	*/
	preStartTimeoutMs: number().int().positive().default(5e3),
	/** Maximum number of concurrently pending (pre-start) media stream sockets. */
	maxPendingConnections: number().int().positive().default(32),
	/** Maximum pending media stream sockets per source IP. */
	maxPendingConnectionsPerIp: number().int().positive().default(4),
	/** Hard cap for all open media stream sockets (pending + active). */
	maxConnections: number().int().positive().default(128)
}).strict().default({
	enabled: false,
	streamPath: "/voice/stream",
	providers: {},
	preStartTimeoutMs: 5e3,
	maxPendingConnections: 32,
	maxPendingConnectionsPerIp: 4,
	maxConnections: 128
});
const VoiceCallConfigSchema = object({
	/** Enable voice call functionality */
	enabled: boolean().default(false),
	/** Active provider (telnyx, twilio, plivo, or mock) */
	provider: _enum([
		"telnyx",
		"twilio",
		"plivo",
		"mock"
	]).optional(),
	/** Telnyx-specific configuration */
	telnyx: TelnyxConfigSchema.optional(),
	/** Twilio-specific configuration */
	twilio: TwilioConfigSchema.optional(),
	/** Plivo-specific configuration */
	plivo: PlivoConfigSchema.optional(),
	/** Phone number to call from (E.164) */
	fromNumber: E164Schema.optional(),
	/** Default phone number to call (E.164) */
	toNumber: E164Schema.optional(),
	/** Inbound call policy */
	inboundPolicy: InboundPolicySchema.default("disabled"),
	/** Allowlist of phone numbers for inbound calls (E.164) */
	allowFrom: array(E164Schema).default([]),
	/** Greeting message for inbound calls */
	inboundGreeting: string().optional(),
	/** Per-dialed-number overrides for inbound calls. Keys are E.164 numbers. */
	numbers: record(E164Schema, VoiceCallNumberRouteConfigSchema).default({}),
	/** Outbound call configuration */
	outbound: OutboundConfigSchema,
	/** Maximum call duration in seconds */
	maxDurationSeconds: number().int().positive().default(300),
	/**
	* Maximum age of a call in seconds before it is automatically reaped.
	* Catches calls stuck before answer (for example, local mock calls that
	* never receive provider webhooks). Set to 0 to disable.
	*/
	staleCallReaperSeconds: number().int().nonnegative().default(120),
	/** Silence timeout for end-of-speech detection (ms) */
	silenceTimeoutMs: number().int().positive().default(800),
	/** Timeout for user transcript (ms) */
	transcriptTimeoutMs: number().int().positive().default(18e4),
	/** Ring timeout for outbound calls (ms) */
	ringTimeoutMs: number().int().positive().default(3e4),
	/** Maximum concurrent calls */
	maxConcurrentCalls: number().int().positive().default(1),
	/** Webhook server configuration */
	serve: VoiceCallServeConfigSchema,
	/** @deprecated Prefer tunnel config. */
	tailscale: VoiceCallTailscaleConfigSchema,
	/** Tunnel configuration (unified ngrok/tailscale) */
	tunnel: VoiceCallTunnelConfigSchema,
	/** Webhook signature reconstruction and proxy trust configuration */
	webhookSecurity: VoiceCallWebhookSecurityConfigSchema,
	/** Real-time audio streaming configuration */
	streaming: VoiceCallStreamingConfigSchema,
	/** Realtime voice-to-voice configuration */
	realtime: VoiceCallRealtimeConfigSchema,
	/** Session memory scope for voice conversations. */
	sessionScope: VoiceCallSessionScopeSchema.default("per-phone"),
	/** Public webhook URL override (if set, bypasses tunnel auto-detection) */
	publicUrl: string().url().optional(),
	/** Skip webhook signature verification (development only, NOT for production) */
	skipSignatureVerification: boolean().default(false),
	/** TTS override (deep-merges with core messages.tts) */
	tts: TtsConfigSchema,
	/** Store path for call logs */
	store: string().optional(),
	/** Agent ID to use for voice response generation. Defaults to "main". */
	agentId: string().min(1).optional(),
	/** Optional model override for generating voice responses. */
	responseModel: string().optional(),
	/** System prompt for voice responses */
	responseSystemPrompt: string().optional(),
	/** Timeout for response generation in ms (default 30s) */
	responseTimeoutMs: number().int().positive().default(3e4)
}).strict();
const TWILIO_AUTH_TOKEN_PATH = "plugins.entries.voice-call.config.twilio.authToken";
const DEFAULT_VOICE_CALL_CONFIG = VoiceCallConfigSchema.parse({});
function cloneDefaultVoiceCallConfig() {
	return structuredClone(DEFAULT_VOICE_CALL_CONFIG);
}
function normalizeWebhookLikePath(pathname) {
	const trimmed = pathname.trim();
	if (!trimmed) return "/";
	const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	if (prefixed === "/") return prefixed;
	return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}
function defaultRealtimeStreamPathForServePath(servePath) {
	const normalized = normalizeWebhookLikePath(servePath);
	if (normalized.endsWith("/webhook")) return `${normalized.slice(0, -8)}/stream/realtime`;
	if (normalized === "/") return "/voice/stream/realtime";
	return `${normalized}/stream/realtime`;
}
function normalizeVoiceCallTtsConfig(defaults, overrides) {
	if (!defaults && !overrides) return;
	return TtsConfigSchema.parse(deepMergeDefined(defaults ?? {}, overrides ?? {}));
}
function normalizePhoneRouteKey(phone) {
	return phone?.replace(/\D/g, "") ?? "";
}
function resolveVoiceCallNumberRouteKey(config, phone) {
	const routes = config.numbers;
	if (!routes) return;
	if (phone && Object.prototype.hasOwnProperty.call(routes, phone)) return phone;
	const normalizedPhone = normalizePhoneRouteKey(phone);
	if (!normalizedPhone) return;
	return Object.keys(routes).find((routeKey) => normalizePhoneRouteKey(routeKey) === normalizedPhone);
}
function resolveVoiceCallEffectiveConfig(config, phoneOrRouteKey) {
	const numberRouteKey = resolveVoiceCallNumberRouteKey(config, phoneOrRouteKey);
	if (!numberRouteKey) return { config };
	const route = config.numbers[numberRouteKey];
	if (!route) return { config };
	return {
		numberRouteKey,
		config: {
			...config,
			...route,
			tts: normalizeVoiceCallTtsConfig(config.tts, route.tts),
			numbers: config.numbers
		}
	};
}
function sanitizeVoiceCallProviderConfigs(value) {
	if (!value) return {};
	return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== void 0));
}
function sanitizeVoiceCallNumberRoutes(value) {
	if (!value) return {};
	return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== void 0).map(([key, route]) => [key, VoiceCallNumberRouteConfigSchema.parse(route)]));
}
function resolveTwilioAuthToken(config) {
	return normalizeResolvedSecretInputString({
		value: config.twilio?.authToken,
		path: TWILIO_AUTH_TOKEN_PATH
	});
}
function normalizeVoiceCallConfig(config) {
	const defaults = cloneDefaultVoiceCallConfig();
	const serve = {
		...defaults.serve,
		...config.serve
	};
	const streamingProvider = config.streaming?.provider;
	const streamingProviders = sanitizeVoiceCallProviderConfigs(config.streaming?.providers ?? defaults.streaming.providers);
	const realtimeProvider = config.realtime?.provider ?? defaults.realtime.provider;
	const realtimeProviders = sanitizeVoiceCallProviderConfigs(config.realtime?.providers ?? defaults.realtime.providers);
	const realtimeFastContext = {
		...defaults.realtime.fastContext,
		...config.realtime?.fastContext,
		sources: config.realtime?.fastContext?.sources ?? defaults.realtime.fastContext.sources
	};
	const realtimeAgentContext = {
		...defaults.realtime.agentContext,
		...config.realtime?.agentContext,
		files: config.realtime?.agentContext?.files ?? defaults.realtime.agentContext.files
	};
	return {
		...defaults,
		...config,
		allowFrom: config.allowFrom ?? defaults.allowFrom,
		numbers: sanitizeVoiceCallNumberRoutes(config.numbers ?? defaults.numbers),
		outbound: {
			...defaults.outbound,
			...config.outbound
		},
		serve,
		tailscale: {
			...defaults.tailscale,
			...config.tailscale
		},
		tunnel: {
			...defaults.tunnel,
			...config.tunnel
		},
		webhookSecurity: {
			...defaults.webhookSecurity,
			...config.webhookSecurity,
			allowedHosts: config.webhookSecurity?.allowedHosts ?? defaults.webhookSecurity.allowedHosts,
			trustedProxyIPs: config.webhookSecurity?.trustedProxyIPs ?? defaults.webhookSecurity.trustedProxyIPs
		},
		streaming: {
			...defaults.streaming,
			...config.streaming,
			provider: streamingProvider,
			providers: streamingProviders
		},
		realtime: {
			...defaults.realtime,
			...config.realtime,
			provider: realtimeProvider,
			streamPath: config.realtime?.streamPath ?? defaultRealtimeStreamPathForServePath(serve.path ?? defaults.serve.path),
			tools: config.realtime?.tools ?? defaults.realtime.tools,
			consultThinkingLevel: VoiceCallRealtimeConsultThinkingLevelSchema.optional().parse(config.realtime?.consultThinkingLevel ?? defaults.realtime.consultThinkingLevel),
			consultFastMode: config.realtime?.consultFastMode ?? defaults.realtime.consultFastMode,
			fastContext: realtimeFastContext,
			agentContext: realtimeAgentContext,
			providers: realtimeProviders
		},
		tts: normalizeVoiceCallTtsConfig(defaults.tts, config.tts)
	};
}
function resolveVoiceCallSessionKey(params) {
	const explicit = params.explicitSessionKey?.trim();
	if (explicit) return explicit;
	if (params.config.sessionScope === "per-call") return `voice:call:${params.callId}`;
	const normalizedPhone = params.phone?.replace(/\D/g, "");
	return normalizedPhone ? `voice:${normalizedPhone}` : `voice:${params.callId}`;
}
/**
* Resolves the configuration by merging environment variables into missing fields.
* Returns a new configuration object with environment variables applied.
*/
function resolveVoiceCallConfig(config) {
	const resolved = normalizeVoiceCallConfig(config);
	if (resolved.provider === "telnyx") {
		resolved.telnyx = resolved.telnyx ?? {};
		resolved.telnyx.apiKey = resolved.telnyx.apiKey ?? process.env.TELNYX_API_KEY;
		resolved.telnyx.connectionId = resolved.telnyx.connectionId ?? process.env.TELNYX_CONNECTION_ID;
		resolved.telnyx.publicKey = resolved.telnyx.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
	}
	if (resolved.provider === "twilio") {
		resolved.fromNumber = resolved.fromNumber ?? process.env.TWILIO_FROM_NUMBER;
		resolved.twilio = resolved.twilio ?? {};
		resolved.twilio.accountSid = resolved.twilio.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
		resolved.twilio.authToken = resolved.twilio.authToken ?? process.env.TWILIO_AUTH_TOKEN;
	}
	if (resolved.provider === "plivo") {
		resolved.plivo = resolved.plivo ?? {};
		resolved.plivo.authId = resolved.plivo.authId ?? process.env.PLIVO_AUTH_ID;
		resolved.plivo.authToken = resolved.plivo.authToken ?? process.env.PLIVO_AUTH_TOKEN;
	}
	resolved.tunnel = resolved.tunnel ?? {
		provider: "none",
		allowNgrokFreeTierLoopbackBypass: false
	};
	resolved.tunnel.allowNgrokFreeTierLoopbackBypass = resolved.tunnel.allowNgrokFreeTierLoopbackBypass ?? false;
	resolved.tunnel.ngrokAuthToken = resolved.tunnel.ngrokAuthToken ?? process.env.NGROK_AUTHTOKEN;
	resolved.tunnel.ngrokDomain = resolved.tunnel.ngrokDomain ?? process.env.NGROK_DOMAIN;
	resolved.webhookSecurity = resolved.webhookSecurity ?? {
		allowedHosts: [],
		trustForwardingHeaders: false,
		trustedProxyIPs: []
	};
	resolved.webhookSecurity.allowedHosts = resolved.webhookSecurity.allowedHosts ?? [];
	resolved.webhookSecurity.trustForwardingHeaders = resolved.webhookSecurity.trustForwardingHeaders ?? false;
	resolved.webhookSecurity.trustedProxyIPs = resolved.webhookSecurity.trustedProxyIPs ?? [];
	return normalizeVoiceCallConfig(resolved);
}
/**
* Validate that the configuration has all required fields for the selected provider.
*/
function validateProviderConfig(config) {
	const errors = [];
	if (!config.enabled) return {
		valid: true,
		errors: []
	};
	if (!config.provider) errors.push("plugins.entries.voice-call.config.provider is required");
	if (!config.fromNumber && config.provider !== "mock") errors.push(config.provider === "twilio" ? "plugins.entries.voice-call.config.fromNumber is required (or set TWILIO_FROM_NUMBER env)" : "plugins.entries.voice-call.config.fromNumber is required");
	if (config.provider === "telnyx") {
		if (!config.telnyx?.apiKey) errors.push("plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)");
		if (!config.telnyx?.connectionId) errors.push("plugins.entries.voice-call.config.telnyx.connectionId is required (or set TELNYX_CONNECTION_ID env)");
		if (!config.skipSignatureVerification && !config.telnyx?.publicKey) errors.push("plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)");
	}
	if (config.provider === "twilio") {
		if (!config.twilio?.accountSid) errors.push("plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)");
		if (!hasConfiguredSecretInput(config.twilio?.authToken)) errors.push("plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)");
	}
	if (config.provider === "plivo") {
		if (!config.plivo?.authId) errors.push("plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)");
		if (!config.plivo?.authToken) errors.push("plugins.entries.voice-call.config.plivo.authToken is required (or set PLIVO_AUTH_TOKEN env)");
	}
	if (config.realtime.enabled && config.inboundPolicy === "disabled") errors.push("plugins.entries.voice-call.config.inboundPolicy must not be \"disabled\" when realtime.enabled is true");
	if (config.realtime.enabled && config.streaming.enabled) errors.push("plugins.entries.voice-call.config.realtime.enabled and plugins.entries.voice-call.config.streaming.enabled cannot both be true");
	if (config.realtime.enabled && config.provider && config.provider !== "twilio" && config.provider !== "telnyx") errors.push("plugins.entries.voice-call.config.provider must be \"twilio\" or \"telnyx\" when realtime.enabled is true");
	return {
		valid: errors.length === 0,
		errors
	};
}
//#endregion
export { resolveVoiceCallEffectiveConfig as a, deepMergeDefined as c, resolveVoiceCallConfig as i, normalizeVoiceCallConfig as n, resolveVoiceCallSessionKey as o, resolveTwilioAuthToken as r, validateProviderConfig as s, VoiceCallConfigSchema as t };
