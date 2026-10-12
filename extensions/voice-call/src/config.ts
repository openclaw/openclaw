import { mergeDeep } from "openclaw/plugin-sdk/plugin-config-runtime";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";
import {
  canonicalizeMainSessionAlias,
  type SessionScope,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveSpeechProviderApiKey } from "openclaw/plugin-sdk/speech-core";
import { normalizeWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import { z } from "zod";
import { TtsConfigSchema } from "../api.js";
import { normalizePhoneNumber } from "./allowlist.js";
import {
  CallCallbacksConfigSchema,
  CallLiveConfigSchema,
  CallReportsConfigSchema,
  CallVoicemailConfigSchema,
} from "./errand-config.js";
import { TWILIO_REGIONS } from "./providers/twilio-region.js";
import { DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS } from "./realtime-defaults.js";
import { isTailscalePortAllowed, VoiceCallTailscaleConfigSchema } from "./tailscale-config.js";

const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

const InboundPolicySchema = z.enum(["disabled", "allowlist", "pairing", "open"]);

const SecretInputSchema = buildSecretInputSchema();

const TelnyxConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    connectionId: z.string().min(1).optional(),
    /** Public key for webhook signature verification */
    publicKey: z.string().min(1).optional(),
  })
  .strict();
export type TelnyxConfig = z.infer<typeof TelnyxConfigSchema>;

const TwilioConfigSchema = z
  .object({
    accountSid: z.string().min(1).optional(),
    authToken: SecretInputSchema.optional(),
    /** Twilio processing Region (for example, ie1) */
    region: z.enum(TWILIO_REGIONS).optional(),
  })
  .strict();

const PlivoConfigSchema = z
  .object({
    authId: z.string().min(1).optional(),
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type PlivoConfig = z.infer<typeof PlivoConfigSchema>;

export type VoiceCallTtsConfig = z.infer<typeof TtsConfigSchema>;

const VoiceCallNumberRouteConfigSchema = z
  .object({
    inboundGreeting: z.string().optional(),
    /** TTS override for inbound calls to this number. Deep-merges with global voice-call TTS. */
    tts: TtsConfigSchema,
    agentId: z.string().min(1).optional(),
    responseModel: z.string().optional(),
    responseSystemPrompt: z.string().optional(),
    responseTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const VoiceCallServeConfigSchema = z
  .object({
    port: z.number().int().positive().default(3334),
    bind: z.string().default("127.0.0.1"),
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict();

const VoiceCallTunnelConfigSchema = z
  .object({
    provider: z.enum(["none", "ngrok", "tailscale-serve", "tailscale-funnel"]).default("none"),
    /** ngrok auth token (optional, enables longer sessions and more features) */
    ngrokAuthToken: z.string().min(1).optional(),
    /** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
    ngrokDomain: z.string().min(1).optional(),
    /** Trust loopback forwarding for ngrok URL reconstruction; signatures remain mandatory. */
    allowNgrokFreeTierLoopbackBypass: z.boolean().default(false),
  })
  .strict();

const VoiceCallWebhookSecurityConfigSchema = z
  .object({
    /** Only these hosts are accepted from forwarding headers. */
    allowedHosts: z.array(z.string().min(1)).default([]),
    /**
     * Trust X-Forwarded-* headers without a hostname allowlist.
     * WARNING: Only enable if you trust your proxy configuration.
     */
    trustForwardingHeaders: z.boolean().default(false),
    /**
     * Trusted proxy IP addresses. Forwarded headers are only trusted when
     * the remote IP matches one of these addresses.
     */
    trustedProxyIPs: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type WebhookSecurityConfig = z.infer<typeof VoiceCallWebhookSecurityConfigSchema>;

const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

const VoiceCallSessionScopeSchema = z.enum(["per-phone", "per-call", "main"]);

const OutboundConfigSchema = z
  .object({
    defaultMode: CallModeSchema.default("notify"),
    /** Seconds to wait after TTS before auto-hangup in notify mode */
    notifyHangupDelaySec: z.number().int().nonnegative().default(3),
  })
  .strict();

const RealtimeToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string(),
    parameters: z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.unknown()),
      required: z.array(z.string()).optional(),
    }),
  })
  .strict();
type RealtimeToolConfig = z.infer<typeof RealtimeToolSchema>;

const VoiceCallProvidersConfigSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .default({});

const VoiceCallRealtimeToolPolicySchema = z.enum(REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES);
const VoiceCallRealtimeConsultPolicySchema = z.enum(["auto", "substantive", "always"]);

const VoiceCallRealtimeFastContextSourceSchema = z.enum(["memory", "sessions"]);

const VoiceCallRealtimeFastContextConfigSchema = z
  .object({
    /** Enable bounded memory/session lookup before the full consult agent. */
    enabled: z.boolean().default(false),
    /** Hard deadline for the fast context lookup. */
    timeoutMs: z.number().int().positive().default(800),
    /** Maximum memory/session hits to inject into the realtime tool result. */
    maxResults: z.number().int().positive().default(3),
    /** Indexed sources used by the fast context lookup. */
    sources: z
      .array(VoiceCallRealtimeFastContextSourceSchema)
      .min(1)
      .default(["memory", "sessions"]),
    /** Fall back to the full agent consult when fast context has no answer. */
    fallbackToConsult: z.boolean().default(false),
  })
  .strict();
const VoiceCallRealtimeAgentContextConfigSchema = z
  .object({
    /** Include configured identity and selected profile files alongside the always-on agent context. */
    enabled: z.boolean().default(false),
    /** Maximum number of characters in the generated profile-file block. */
    maxChars: z.number().int().positive().default(6000),
    includeIdentity: z.boolean().default(true),
    /** Include selected workspace files such as SOUL.md and IDENTITY.md. */
    includeWorkspaceFiles: z.boolean().default(true),
    /** Workspace-relative files to include, bounded by maxChars. */
    files: z.array(z.string().min(1)).default(["SOUL.md", "IDENTITY.md", "USER.md"]),
  })
  .strict();

const VoiceCallRealtimeConsultThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
]);

const VoiceCallRealtimeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Provider id from registered realtime voice providers. */
    provider: z.string().min(1).optional(),
    /** Optional override for the local WebSocket route path. */
    streamPath: z.string().min(1).optional(),
    /** End an active realtime call after this much speech inactivity. */
    idleHangupMs: z.number().int().positive().optional(),
    /** System instructions passed to the realtime provider. */
    instructions: z.string().default(DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS),
    /** Tool policy for the shared OpenClaw agent consult tool. */
    toolPolicy: VoiceCallRealtimeToolPolicySchema.default("safe-read-only"),
    /** Guidance for when the realtime model should call the OpenClaw agent consult tool. */
    consultPolicy: VoiceCallRealtimeConsultPolicySchema.default("auto"),
    /** Optional thinking level override for the regular agent behind realtime consults. */
    consultThinkingLevel: VoiceCallRealtimeConsultThinkingLevelSchema.optional(),
    /** Optional fast mode override for the regular agent behind realtime consults. */
    consultFastMode: z.boolean().optional(),
    tools: z.array(RealtimeToolSchema).default([]),
    /** Low-latency memory/session context for the consult tool. */
    fastContext: VoiceCallRealtimeFastContextConfigSchema.default(
      VoiceCallRealtimeFastContextConfigSchema.parse({}),
    ),
    /** Bounded agent persona/context injection for the fast realtime voice path. */
    agentContext: VoiceCallRealtimeAgentContextConfigSchema.default(
      VoiceCallRealtimeAgentContextConfigSchema.parse({}),
    ),
    /** Provider-owned raw config blobs keyed by provider id. */
    providers: VoiceCallProvidersConfigSchema,
  })
  .strict();
export type VoiceCallRealtimeConfig = z.infer<typeof VoiceCallRealtimeConfigSchema>;

const VoiceCallStreamingConfigSchema = z
  .object({
    /** Enable Twilio Media Streams for real-time transcription. */
    enabled: z.boolean().default(false),
    /** Provider id from registered realtime transcription providers. */
    provider: z.string().min(1).optional(),
    streamPath: z.string().min(1).default("/voice/stream"),
    /** Provider-owned raw config blobs keyed by provider id. */
    providers: VoiceCallProvidersConfigSchema,
    /**
     * Close unauthenticated media stream sockets if no valid `start` frame arrives in time.
     * Protects against pre-auth idle connection hold attacks.
     */
    preStartTimeoutMs: z.number().int().positive().default(5000),
    /** Maximum number of concurrently pending (pre-start) media stream sockets. */
    maxPendingConnections: z.number().int().positive().default(32),
    /** Maximum pending media stream sockets per source IP. */
    maxPendingConnectionsPerIp: z.number().int().positive().default(4),
    /** Hard cap for all open media stream sockets (pending + active). */
    maxConnections: z.number().int().positive().default(128),
  })
  .strict();

export const VoiceCallConfigSchema = z
  .object({
    enabled: z.boolean().default(false),

    provider: z.enum(["telnyx", "twilio", "plivo", "mock"]).optional(),

    telnyx: TelnyxConfigSchema.optional(),

    twilio: TwilioConfigSchema.optional(),

    plivo: PlivoConfigSchema.optional(),

    fromNumber: E164Schema.optional(),

    /** Default outbound target. */
    toNumber: E164Schema.optional(),

    inboundPolicy: InboundPolicySchema.default("disabled"),

    allowFrom: z.array(E164Schema).default([]),

    inboundGreeting: z.string().optional(),

    /** Per-dialed-number overrides for inbound calls. Keys are E.164 numbers. */
    numbers: z.record(E164Schema, VoiceCallNumberRouteConfigSchema).default({}),

    outbound: OutboundConfigSchema.default(OutboundConfigSchema.parse({})),

    reports: CallReportsConfigSchema,
    live: CallLiveConfigSchema,
    callbacks: CallCallbacksConfigSchema,
    voicemail: CallVoicemailConfigSchema,

    /** Maximum call duration in seconds */
    maxDurationSeconds: z.number().int().positive().default(300),

    /**
     * Maximum age of a call in seconds before it is automatically reaped.
     * Catches calls stuck before answer (for example, local mock calls that
     * never receive provider webhooks). Set to 0 to disable.
     */
    staleCallReaperSeconds: z.number().int().nonnegative().default(120),

    /** Silence timeout for end-of-speech detection (ms) */
    silenceTimeoutMs: z.number().int().positive().default(800),

    transcriptTimeoutMs: z.number().int().positive().default(180000),

    ringTimeoutMs: z.number().int().positive().default(30000),

    maxConcurrentCalls: z.number().int().positive().default(1),

    serve: VoiceCallServeConfigSchema.default(VoiceCallServeConfigSchema.parse({})),

    /** @deprecated Prefer tunnel config. */
    tailscale: VoiceCallTailscaleConfigSchema,

    tunnel: VoiceCallTunnelConfigSchema.default(VoiceCallTunnelConfigSchema.parse({})),

    webhookSecurity: VoiceCallWebhookSecurityConfigSchema.default(
      VoiceCallWebhookSecurityConfigSchema.parse({}),
    ),

    streaming: VoiceCallStreamingConfigSchema.default(VoiceCallStreamingConfigSchema.parse({})),

    realtime: VoiceCallRealtimeConfigSchema.default(VoiceCallRealtimeConfigSchema.parse({})),

    /** Session memory scope for voice conversations. */
    sessionScope: VoiceCallSessionScopeSchema.default("per-phone"),

    /** Public webhook URL override (if set, bypasses tunnel auto-detection) */
    publicUrl: z.string().url().optional(),

    /** Skip webhook signature verification (development only, NOT for production) */
    skipSignatureVerification: z.boolean().default(false),

    /** TTS override (deep-merges with core tts) */
    tts: TtsConfigSchema,

    store: z.string().optional(),

    /** Response/session owner. Required when multiple agents have no legacy owner. */
    agentId: z.string().min(1).optional(),

    responseModel: z.string().optional(),

    responseSystemPrompt: z.string().optional(),

    responseTimeoutMs: z.number().int().positive().default(30000),
  })
  .strict()
  .refine(isTailscalePortAllowed, {
    path: ["tailscale", "port"],
    message: "Tailscale Funnel HTTPS port must be one of 443, 8443, 10000",
  });

export type VoiceCallConfig = z.infer<typeof VoiceCallConfigSchema>;
type VoiceCallEffectiveConfigResult = {
  config: VoiceCallConfig;
  numberRouteKey?: string;
};
type DeepPartial<T> = T extends SecretInput
  ? T
  : T extends Array<infer U>
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;
type VoiceCallConfigInput = DeepPartial<VoiceCallConfig>;
const TWILIO_AUTH_TOKEN_PATH = "plugins.entries.voice-call.config.twilio.authToken";

const DEFAULT_VOICE_CALL_CONFIG = VoiceCallConfigSchema.parse({});

function defaultRealtimeStreamPathForServePath(servePath: string): string {
  const normalized = normalizeWebhookPath(servePath);
  if (normalized.endsWith("/webhook")) {
    return `${normalized.slice(0, -"/webhook".length)}/stream/realtime`;
  }
  if (normalized === "/") {
    return "/voice/stream/realtime";
  }
  return `${normalized}/stream/realtime`;
}

export type VoiceCallStreamExposurePath = {
  publicPath: string;
  localPath: string;
};

export function resolveVoiceCallPublicPathPrefix(
  publicWebhookPath: string,
  localWebhookPath: string,
): string {
  const publicPath = normalizeWebhookPath(publicWebhookPath);
  const localPathIndex = publicPath.indexOf(normalizeWebhookPath(localWebhookPath));
  return localPathIndex > 0 ? publicPath.slice(0, localPathIndex) : "";
}

export function resolveVoiceCallStreamExposurePaths(
  config: VoiceCallConfig,
  webhookPaths: { publicWebhookPath?: string; localWebhookPath?: string } = {},
): VoiceCallStreamExposurePath[] {
  const exposurePaths: VoiceCallStreamExposurePath[] = [];
  const localWebhookPath = webhookPaths.localWebhookPath ?? config.serve.path;
  const publicWebhookPath = webhookPaths.publicWebhookPath ?? config.tailscale.path;
  const publicPathPrefix = resolveVoiceCallPublicPathPrefix(publicWebhookPath, localWebhookPath);
  if (config.realtime.enabled) {
    const localPath = normalizeWebhookPath(
      config.realtime.streamPath ?? defaultRealtimeStreamPathForServePath(config.serve.path),
    );
    exposurePaths.push({
      localPath,
      publicPath: `${publicPathPrefix}${localPath}`,
    });
  }
  if (config.streaming.enabled) {
    const localPath = normalizeWebhookPath(config.streaming.streamPath);
    if (
      !exposurePaths.some((path) => path.localPath === localPath && path.publicPath === localPath)
    ) {
      exposurePaths.push({ localPath, publicPath: localPath });
    }
  }
  return exposurePaths;
}

function normalizeVoiceCallTtsConfig(
  defaults: VoiceCallTtsConfig,
  overrides: DeepPartial<NonNullable<VoiceCallTtsConfig>> | undefined,
): VoiceCallTtsConfig {
  if (!defaults && !overrides) {
    return undefined;
  }

  return TtsConfigSchema.parse(mergeDeep(defaults ?? {}, overrides ?? {}));
}

function resolveVoiceCallNumberRouteKey(
  config: Pick<VoiceCallConfig, "numbers">,
  phone: string | undefined,
): string | undefined {
  const routes = config.numbers;
  if (phone && Object.hasOwn(routes, phone)) {
    return phone;
  }

  const normalizedPhone = normalizePhoneNumber(phone);
  if (!normalizedPhone) {
    return undefined;
  }
  return Object.keys(routes).find((routeKey) => normalizePhoneNumber(routeKey) === normalizedPhone);
}

/** Resolve inbound-only number routing from a persisted call record. */
export function resolveVoiceCallNumberRouteKeyForCall(call: {
  direction?: "inbound" | "outbound";
  to?: string;
  metadata?: { numberRouteKey?: unknown };
}): string | undefined {
  if (call.direction !== "inbound") {
    return undefined;
  }
  const storedRouteKey = call.metadata?.numberRouteKey;
  if (typeof storedRouteKey === "string") {
    return storedRouteKey;
  }
  return call.to;
}

export function resolveVoiceCallEffectiveConfig(
  config: VoiceCallConfig,
  phoneOrRouteKey: string | undefined,
): VoiceCallEffectiveConfigResult {
  const numberRouteKey = resolveVoiceCallNumberRouteKey(config, phoneOrRouteKey);
  if (!numberRouteKey) {
    return { config };
  }

  const route = config.numbers[numberRouteKey];
  if (!route) {
    return { config };
  }

  return {
    numberRouteKey,
    config: {
      ...config,
      ...route,
      tts: normalizeVoiceCallTtsConfig(config.tts, route.tts),
    },
  };
}

function sanitizeVoiceCallProviderConfigs(
  value: Record<string, Record<string, unknown> | undefined> | undefined,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(
      (entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined,
    ),
  );
}

function sanitizeVoiceCallNumberRoutes(
  value: Record<string, unknown> | undefined,
): VoiceCallConfig["numbers"] {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([, route]) => route !== undefined)
      .map(([key, route]) => [key, VoiceCallNumberRouteConfigSchema.parse(route)]),
  );
}

export function resolveTwilioAuthToken(
  config: Pick<VoiceCallConfig, "twilio">,
): string | undefined {
  return normalizeResolvedSecretInputString({
    value: config.twilio?.authToken,
    path: TWILIO_AUTH_TOKEN_PATH,
  });
}

export function normalizeVoiceCallConfig(config: VoiceCallConfigInput): VoiceCallConfig {
  const defaults = structuredClone(DEFAULT_VOICE_CALL_CONFIG);
  const serve = { ...defaults.serve, ...config.serve };
  const streamingProvider = config.streaming?.provider;
  const streamingProviders = sanitizeVoiceCallProviderConfigs(
    config.streaming?.providers ?? defaults.streaming.providers,
  );
  const realtimeProvider = config.realtime?.provider ?? defaults.realtime.provider;
  const realtimeProviders = sanitizeVoiceCallProviderConfigs(
    config.realtime?.providers ?? defaults.realtime.providers,
  );
  const realtimeFastContext = {
    ...defaults.realtime.fastContext,
    ...config.realtime?.fastContext,
    sources: config.realtime?.fastContext?.sources ?? defaults.realtime.fastContext.sources,
  };
  const realtimeAgentContext = {
    ...defaults.realtime.agentContext,
    ...config.realtime?.agentContext,
    files: config.realtime?.agentContext?.files ?? defaults.realtime.agentContext.files,
  };
  return {
    ...defaults,
    ...config,
    allowFrom: config.allowFrom ?? defaults.allowFrom,
    numbers: sanitizeVoiceCallNumberRoutes(config.numbers ?? defaults.numbers),
    outbound: { ...defaults.outbound, ...config.outbound },
    reports: CallReportsConfigSchema.parse(config.reports),
    live: CallLiveConfigSchema.parse(config.live),
    callbacks: CallCallbacksConfigSchema.parse(config.callbacks),
    voicemail: CallVoicemailConfigSchema.parse(config.voicemail),
    serve,
    tailscale: { ...defaults.tailscale, ...config.tailscale },
    tunnel: { ...defaults.tunnel, ...config.tunnel },
    webhookSecurity: {
      ...defaults.webhookSecurity,
      ...config.webhookSecurity,
      allowedHosts: config.webhookSecurity?.allowedHosts ?? defaults.webhookSecurity.allowedHosts,
      trustedProxyIPs:
        config.webhookSecurity?.trustedProxyIPs ?? defaults.webhookSecurity.trustedProxyIPs,
    },
    streaming: {
      ...defaults.streaming,
      ...config.streaming,
      provider: streamingProvider,
      providers: streamingProviders,
    },
    realtime: {
      ...defaults.realtime,
      ...config.realtime,
      provider: realtimeProvider,
      streamPath:
        config.realtime?.streamPath ??
        defaultRealtimeStreamPathForServePath(serve.path ?? defaults.serve.path),
      tools:
        (config.realtime?.tools as RealtimeToolConfig[] | undefined) ?? defaults.realtime.tools,
      consultThinkingLevel: VoiceCallRealtimeConsultThinkingLevelSchema.optional().parse(
        config.realtime?.consultThinkingLevel ?? defaults.realtime.consultThinkingLevel,
      ),
      consultFastMode: config.realtime?.consultFastMode ?? defaults.realtime.consultFastMode,
      fastContext: realtimeFastContext,
      agentContext: realtimeAgentContext,
      providers: realtimeProviders,
    },
    tts: normalizeVoiceCallTtsConfig(defaults.tts, config.tts),
  };
}

export type VoiceCallCoreSessionConfig = { mainKey?: string; scope?: SessionScope };

export function resolveVoiceCallSessionKey(params: {
  config: Pick<VoiceCallConfig, "agentId" | "sessionScope">;
  callId: string;
  phone?: string;
  explicitSessionKey?: string;
  coreSession?: VoiceCallCoreSessionConfig;
}): string {
  const explicit = params.explicitSessionKey?.trim();
  if (explicit || params.config.sessionScope === "main") {
    return resolveVoiceCallAgentSessionKey({
      config: params.config,
      sessionKey: explicit || "main",
      coreSession: params.coreSession,
    });
  }
  // Startup migration promotes unambiguous shipped `voice:*` rows;
  // generate only canonical keys here so new history never needs repair.
  const prefix = `agent:${normalizeAgentId(params.config.agentId)}:voice`;
  if (params.config.sessionScope === "per-call") {
    return `${prefix}:call:${params.callId}`.toLowerCase();
  }
  const normalizedPhone = normalizePhoneNumber(params.phone);
  return (
    normalizedPhone ? `${prefix}:${normalizedPhone}` : `${prefix}:${params.callId}`
  ).toLowerCase();
}

/** Resolve persisted or integration-provided keys into the configured agent namespace. */
function resolveVoiceCallAgentSessionKey(params: {
  config: Pick<VoiceCallConfig, "agentId">;
  sessionKey: string;
  coreSession?: VoiceCallCoreSessionConfig;
}): string {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("Voice Call session key cannot be empty");
  }
  const lower = sessionKey.toLowerCase();
  const agentId = normalizeAgentId(params.config.agentId);
  if (lower === "global" || lower === "unknown") {
    return lower;
  }
  const parsedInput = parseAgentSessionKey(sessionKey);
  let normalizedScopedKey: string;
  if (
    parsedInput &&
    normalizeAgentId(parsedInput.agentId) === parsedInput.agentId &&
    parsedInput.agentId === agentId
  ) {
    normalizedScopedKey = `agent:${parsedInput.agentId}:${parsedInput.rest}`;
  } else {
    // Voice Call's configured agent owns both the store and runtime. Foreign or
    // malformed agent-shaped input is an opaque integration key, not a route.
    const wrappedInput = parseAgentSessionKey(`agent:${agentId}:${sessionKey}`);
    if (!wrappedInput) {
      throw new Error("Voice Call session key could not be normalized");
    }
    normalizedScopedKey = `agent:${agentId}:${wrappedInput.rest}`;
  }
  return canonicalizeMainSessionAlias({
    cfg: { session: params.coreSession },
    agentId,
    sessionKey: normalizedScopedKey,
  });
}

export function resolveVoiceCallConfig(config: VoiceCallConfigInput): VoiceCallConfig {
  const resolved = normalizeVoiceCallConfig(config);

  if (resolved.provider === "telnyx") {
    resolved.telnyx = resolved.telnyx ?? {};
    resolved.telnyx.apiKey =
      resolved.telnyx.apiKey ?? resolveSpeechProviderApiKey(process.env.TELNYX_API_KEY);
    resolved.telnyx.connectionId =
      resolved.telnyx.connectionId ?? resolveSpeechProviderApiKey(process.env.TELNYX_CONNECTION_ID);
    resolved.telnyx.publicKey =
      resolved.telnyx.publicKey ?? resolveSpeechProviderApiKey(process.env.TELNYX_PUBLIC_KEY);
  }

  if (resolved.provider === "twilio") {
    resolved.fromNumber =
      resolved.fromNumber ?? resolveSpeechProviderApiKey(process.env.TWILIO_FROM_NUMBER);
    resolved.twilio = resolved.twilio ?? {};
    resolved.twilio.accountSid =
      resolved.twilio.accountSid ?? resolveSpeechProviderApiKey(process.env.TWILIO_ACCOUNT_SID);
    resolved.twilio.authToken =
      resolved.twilio.authToken ?? resolveSpeechProviderApiKey(process.env.TWILIO_AUTH_TOKEN);
  }

  if (resolved.provider === "plivo") {
    resolved.plivo = resolved.plivo ?? {};
    resolved.plivo.authId =
      resolved.plivo.authId ?? resolveSpeechProviderApiKey(process.env.PLIVO_AUTH_ID);
    resolved.plivo.authToken =
      resolved.plivo.authToken ?? resolveSpeechProviderApiKey(process.env.PLIVO_AUTH_TOKEN);
  }

  resolved.tunnel.allowNgrokFreeTierLoopbackBypass =
    resolved.tunnel.allowNgrokFreeTierLoopbackBypass ?? false;
  resolved.tunnel.ngrokAuthToken =
    resolved.tunnel.ngrokAuthToken ?? resolveSpeechProviderApiKey(process.env.NGROK_AUTHTOKEN);
  resolved.tunnel.ngrokDomain =
    resolved.tunnel.ngrokDomain ?? resolveSpeechProviderApiKey(process.env.NGROK_DOMAIN);

  resolved.webhookSecurity.trustForwardingHeaders =
    resolved.webhookSecurity.trustForwardingHeaders ?? false;

  return resolved;
}

export function validateProviderConfig(config: VoiceCallConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.provider) {
    errors.push("plugins.entries.voice-call.config.provider is required");
  }

  if (!config.fromNumber && config.provider !== "mock") {
    errors.push(
      config.provider === "twilio"
        ? "plugins.entries.voice-call.config.fromNumber is required (or set TWILIO_FROM_NUMBER env)"
        : "plugins.entries.voice-call.config.fromNumber is required",
    );
  }

  const requireCredential = (
    field: string,
    value: string | boolean | undefined,
    envName: string,
  ) => {
    if (!value) {
      errors.push(
        `plugins.entries.voice-call.config.${config.provider}.${field} is required (or set ${envName} env)`,
      );
    }
  };
  if (config.provider === "telnyx") {
    requireCredential("apiKey", config.telnyx?.apiKey, "TELNYX_API_KEY");
    requireCredential("connectionId", config.telnyx?.connectionId, "TELNYX_CONNECTION_ID");
    if (!config.skipSignatureVerification) {
      requireCredential("publicKey", config.telnyx?.publicKey, "TELNYX_PUBLIC_KEY");
    }
  }
  if (config.provider === "twilio") {
    requireCredential("accountSid", config.twilio?.accountSid, "TWILIO_ACCOUNT_SID");
    requireCredential(
      "authToken",
      hasConfiguredSecretInput(config.twilio?.authToken),
      "TWILIO_AUTH_TOKEN",
    );
  }
  if (config.provider === "plivo") {
    requireCredential("authId", config.plivo?.authId, "PLIVO_AUTH_ID");
    requireCredential("authToken", config.plivo?.authToken, "PLIVO_AUTH_TOKEN");
  }

  if (config.realtime.enabled && config.inboundPolicy === "disabled") {
    errors.push(
      'plugins.entries.voice-call.config.inboundPolicy must not be "disabled" when realtime.enabled is true',
    );
  }

  if (config.realtime.enabled && config.streaming.enabled) {
    errors.push(
      "plugins.entries.voice-call.config.realtime.enabled and plugins.entries.voice-call.config.streaming.enabled cannot both be true",
    );
  }

  if (config.streaming.enabled && config.provider && config.provider !== "twilio") {
    errors.push(
      'plugins.entries.voice-call.config.provider must be "twilio" when streaming.enabled is true',
    );
  }

  if (
    config.realtime.enabled &&
    config.provider &&
    config.provider !== "twilio" &&
    config.provider !== "telnyx" &&
    config.provider !== "mock"
  ) {
    errors.push(
      'plugins.entries.voice-call.config.provider must be "twilio", "telnyx", or "mock" when realtime.enabled is true',
    );
  }

  return { valid: errors.length === 0, errors };
}
