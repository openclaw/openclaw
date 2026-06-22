// Voice Call helper module supports config behavior.
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES } from "openclaw/plugin-sdk/realtime-voice";
import {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { TtsConfigSchema } from "../api.js";
import { deepMergeDefined } from "./deep-merge.js";
import { resolveGroupCallGateConfig } from "./group-call-gate.js";
import { DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS } from "./realtime-defaults.js";

// -----------------------------------------------------------------------------
// Phone Number Validation
// -----------------------------------------------------------------------------

/**
 * E.164 phone number format: +[country code][number]
 * Examples use 555 prefix (reserved for fictional numbers)
 */
const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

/**
 * Microsoft Teams caller id: an AAD object id (a GUID). Teams calls carry no
 * E.164 number — the caller is identified by `aadId` — so allowlist entries
 * accept this form too, letting the msteams provider use
 * `inboundPolicy: "allowlist"`. Runtime matching is in `isAllowlistedCaller`.
 */
const AadObjectIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Expected an AAD object id (GUID), e.g. 00000000-0000-0000-0000-000000000000",
  );

/** An inbound allowlist entry: an E.164 phone number or a Teams AAD object id. */
const AllowFromEntrySchema = z.union([E164Schema, AadObjectIdSchema]);

// -----------------------------------------------------------------------------
// Inbound Policy
// -----------------------------------------------------------------------------

/**
 * Controls how inbound calls are handled:
 * - "disabled": Block all inbound calls (outbound only)
 * - "allowlist": Only accept calls from numbers in allowFrom
 * - "pairing": Unknown callers can request pairing (future)
 * - "open": Accept all inbound calls (dangerous!)
 */
const InboundPolicySchema = z.enum(["disabled", "allowlist", "pairing", "open"]);

// -----------------------------------------------------------------------------
// Provider-Specific Configuration
// -----------------------------------------------------------------------------

const SecretInputSchema = buildSecretInputSchema();

const TelnyxConfigSchema = z
  .object({
    /** Telnyx API v2 key */
    apiKey: z.string().min(1).optional(),
    /** Telnyx connection ID (from Call Control app) */
    connectionId: z.string().min(1).optional(),
    /** Public key for webhook signature verification */
    publicKey: z.string().min(1).optional(),
  })
  .strict();
export type TelnyxConfig = z.infer<typeof TelnyxConfigSchema>;

const TwilioConfigSchema = z
  .object({
    /** Twilio Account SID */
    accountSid: z.string().min(1).optional(),
    /** Twilio Auth Token */
    authToken: SecretInputSchema.optional(),
  })
  .strict();

const MsteamsConfigSchema = z
  .object({
    /** TCP port the Teams bridge WebSocket server listens on. */
    port: z.number().int().min(1).max(65535).optional(),
    /**
     * Address the Teams bridge WebSocket server binds to. Defaults to the
     * loopback interface (127.0.0.1) so the bridge is never exposed on all
     * interfaces. Set to a specific trusted-network address only when the
     * Windows worker connects from another host (e.g. a private/VPN IP).
     */
    bindAddress: z.string().min(1).optional(),
    /** URL path prefix for the WebSocket upgrade (per-call path = {path}/{callId}). */
    path: z.string().min(1).default("/voice/msteams/stream"),
    /** Shared secret used to verify HMAC-SHA256 on the WS handshake (SecretRef-compatible). */
    sharedSecret: SecretInputSchema.optional(),
    /**
     * Require the worker to report active Teams recording status before any
     * media-derived transcript is persisted or processed (Microsoft Media
     * Access API obligation). Default true; set false only if recording/
     * compliance is enforced out-of-band.
     */
    requireRecordingStatus: z.boolean().default(true),
    /**
     * Outbound calling: let OpenClaw ask the worker to place a 1:1 Teams call to
     * a user ("call me when the task is done"). The worker exposes an
     * HMAC-authenticated `POST {workerBaseUrl}/api/calls/place`.
     */
    outbound: z
      .object({
        enabled: z.boolean().default(false),
        /** Base URL of the worker HTTP API (e.g. https://virtual-employee.pcfc.ae). */
        workerBaseUrl: z.string().url().optional(),
        /** AAD tenant id used when placing calls (the target user's tenant). */
        tenantId: z.string().min(1).optional(),
        /**
         * Safety-net timeout (ms) for a placed outbound call to connect its media WebSocket back.
         * If it never connects, the CallRecord is finalized so it doesn't linger. Default 120000:
         * comfortably longer than a typical Teams ring-to-answer (~30-60s before missed/voicemail),
         * so it only fires on a genuinely dead placement, not a slow answer. Tune per environment.
         */
        answerTimeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .default({ enabled: false }),
    /**
     * Group/meeting calls: when more than one human is on the call, only respond once the assistant
     * is addressed by name — mirroring the chat channel's group @mention gate. 1:1 calls always
     * respond. A call has no structured @mention, so "addressed" is matched from the transcript
     * against `wakePhrases` (the bot's name). After being addressed, `followUpWindowMs` keeps the
     * bot engaged for a natural back-and-forth without re-stating its name each turn.
     */
    groupCall: z
      .object({
        /** Require the bot to be addressed by name before responding in a group call. Default true. */
        requireAddress: z.boolean().default(true),
        /**
         * Phrases that count as addressing the bot (case-insensitive, boundary-aware), e.g. the
         * bot's display name. With the gate on and this empty, the gate is inert (the bot would
         * otherwise be muted forever). Set this to your bot's name. Default ["assistant"].
         */
        wakePhrases: z.array(z.string().min(1)).default(["assistant"]),
        /**
         * After an addressed turn, keep responding to follow-ups without re-addressing for this many
         * ms. Default 12000. 0 = the bot must be addressed on every turn.
         */
        followUpWindowMs: z.number().int().nonnegative().default(12_000),
      })
      .strict()
      .default({ requireAddress: true, wakePhrases: ["assistant"], followUpWindowMs: 12_000 }),
    /**
     * CVI vision spend cap: max vision-model / frame consumptions per minute per call. Bounds the cost
     * of continuous perception across all three consumers — the `look_at_screen` tool (realtime), the
     * streaming per-turn frame attach, and the realtime ambient frame push (`sendImage`, ~every 6s on a
     * changed frame). 0 = unlimited.
     */
    maxVisionPerMinute: z.number().int().nonnegative().default(30),
  })
  .strict();
export type MsteamsConfig = z.infer<typeof MsteamsConfigSchema>;

const PlivoConfigSchema = z
  .object({
    /** Plivo Auth ID (starts with MA/SA) */
    authId: z.string().min(1).optional(),
    /** Plivo Auth Token */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type PlivoConfig = z.infer<typeof PlivoConfigSchema>;

export type VoiceCallTtsConfig = z.infer<typeof TtsConfigSchema>;

const VoiceCallNumberRouteConfigSchema = z
  .object({
    /** Greeting message for inbound calls to this number. */
    inboundGreeting: z.string().optional(),
    /** TTS override for inbound calls to this number. Deep-merges with global voice-call TTS. */
    tts: TtsConfigSchema,
    /** Agent ID to use for voice response generation for this number. */
    agentId: z.string().min(1).optional(),
    /** Optional model override for voice responses for this number. */
    responseModel: z.string().optional(),
    /** System prompt for voice responses for this number. */
    responseSystemPrompt: z.string().optional(),
    /** Timeout for response generation in ms for this number. */
    responseTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type VoiceCallNumberRouteConfig = z.infer<typeof VoiceCallNumberRouteConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

const VoiceCallServeConfigSchema = z
  .object({
    /** Port to listen on */
    port: z.number().int().positive().default(3334),
    /** Bind address */
    bind: z.string().default("127.0.0.1"),
    /** Webhook path */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ port: 3334, bind: "127.0.0.1", path: "/voice/webhook" });

const VoiceCallTailscaleConfigSchema = z
  .object({
    /**
     * Tailscale exposure mode:
     * - "off": No Tailscale exposure
     * - "serve": Tailscale serve (private to tailnet)
     * - "funnel": Tailscale funnel (public HTTPS)
     */
    mode: z.enum(["off", "serve", "funnel"]).default("off"),
    /** Path for Tailscale serve/funnel (should usually match serve.path) */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ mode: "off", path: "/voice/webhook" });

// -----------------------------------------------------------------------------
// Tunnel Configuration (unified ngrok/tailscale)
// -----------------------------------------------------------------------------

const VoiceCallTunnelConfigSchema = z
  .object({
    /**
     * Tunnel provider:
     * - "none": No tunnel (use publicUrl if set, or manual setup)
     * - "ngrok": Use ngrok for public HTTPS tunnel
     * - "tailscale-serve": Tailscale serve (private to tailnet)
     * - "tailscale-funnel": Tailscale funnel (public HTTPS)
     */
    provider: z.enum(["none", "ngrok", "tailscale-serve", "tailscale-funnel"]).default("none"),
    /** ngrok auth token (optional, enables longer sessions and more features) */
    ngrokAuthToken: z.string().min(1).optional(),
    /** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
    ngrokDomain: z.string().min(1).optional(),
    /**
     * Allow ngrok free tier compatibility mode.
     * When true, forwarded headers may be trusted for loopback requests
     * to reconstruct the public ngrok URL used for signing.
     *
     * IMPORTANT: This does NOT bypass signature verification.
     */
    allowNgrokFreeTierLoopbackBypass: z.boolean().default(false),
  })
  .strict()
  .default({ provider: "none", allowNgrokFreeTierLoopbackBypass: false });

// -----------------------------------------------------------------------------
// Webhook Security Configuration
// -----------------------------------------------------------------------------

const VoiceCallWebhookSecurityConfigSchema = z
  .object({
    /**
     * Allowed hostnames for webhook URL reconstruction.
     * Only these hosts are accepted from forwarding headers.
     */
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
  .strict()
  .default({ allowedHosts: [], trustForwardingHeaders: false, trustedProxyIPs: [] });
export type WebhookSecurityConfig = z.infer<typeof VoiceCallWebhookSecurityConfigSchema>;

// -----------------------------------------------------------------------------
// Outbound Call Configuration
// -----------------------------------------------------------------------------

/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

const VoiceCallSessionScopeSchema = z.enum(["per-phone", "per-call"]);

const OutboundConfigSchema = z
  .object({
    /** Default call mode for outbound calls */
    defaultMode: CallModeSchema.default("notify"),
    /** Seconds to wait after TTS before auto-hangup in notify mode */
    notifyHangupDelaySec: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({ defaultMode: "notify", notifyHangupDelaySec: 3 });

// -----------------------------------------------------------------------------
// Realtime Voice Configuration
// -----------------------------------------------------------------------------

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

const VoiceCallRealtimeProvidersConfigSchema = z
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
  .strict()
  .default({
    enabled: false,
    timeoutMs: 800,
    maxResults: 3,
    sources: ["memory", "sessions"],
    fallbackToConsult: false,
  });
export type VoiceCallRealtimeFastContextConfig = z.infer<
  typeof VoiceCallRealtimeFastContextConfigSchema
>;

const VoiceCallRealtimeAgentContextConfigSchema = z
  .object({
    /** Inject a compact agent persona/context capsule into realtime voice instructions. */
    enabled: z.boolean().default(false),
    /** Maximum number of characters from the generated capsule to append. */
    maxChars: z.number().int().positive().default(6000),
    /** Include configured agent identity fields. */
    includeIdentity: z.boolean().default(true),
    /** Include selected workspace files such as SOUL.md and IDENTITY.md. */
    includeWorkspaceFiles: z.boolean().default(true),
    /** Workspace-relative files to include, bounded by maxChars. */
    files: z.array(z.string().min(1)).default(["SOUL.md", "IDENTITY.md", "USER.md"]),
  })
  .strict()
  .default({
    enabled: false,
    maxChars: 6000,
    includeIdentity: true,
    includeWorkspaceFiles: true,
    files: ["SOUL.md", "IDENTITY.md", "USER.md"],
  });

export const VoiceCallRealtimeConsultThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
]);

const VoiceCallStreamingProvidersConfigSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .default({});

const VoiceCallRealtimeConfigSchema = z
  .object({
    /** Enable realtime voice-to-voice mode. */
    enabled: z.boolean().default(false),
    /** Provider id from registered realtime voice providers. */
    provider: z.string().min(1).optional(),
    /** Optional override for the local WebSocket route path. */
    streamPath: z.string().min(1).optional(),
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
    /**
     * Suppress caller-leg input while assistant audio is playing (self-echo guard).
     * Off by default: the msteams bridge delivers remote-participant audio (not our
     * own playback), and gating input would also defeat the model's barge-in.
     */
    suppressInputDuringPlayback: z.boolean().optional(),
    /** Tool definitions exposed to the realtime provider. */
    tools: z.array(RealtimeToolSchema).default([]),
    /** Low-latency memory/session context for the consult tool. */
    fastContext: VoiceCallRealtimeFastContextConfigSchema,
    /** Bounded agent persona/context injection for the fast realtime voice path. */
    agentContext: VoiceCallRealtimeAgentContextConfigSchema,
    /** Provider-owned raw config blobs keyed by provider id. */
    providers: VoiceCallRealtimeProvidersConfigSchema,
  })
  .strict()
  .default({
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
      fallbackToConsult: false,
    },
    agentContext: {
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    },
    providers: {},
  });
export type VoiceCallRealtimeConfig = z.infer<typeof VoiceCallRealtimeConfigSchema>;

// -----------------------------------------------------------------------------
// Streaming Configuration (Realtime Transcription)
// -----------------------------------------------------------------------------

const VoiceCallStreamingConfigSchema = z
  .object({
    /** Enable real-time audio streaming (requires WebSocket support) */
    enabled: z.boolean().default(false),
    /** Provider id from registered realtime transcription providers. */
    provider: z.string().min(1).optional(),
    /** WebSocket path for media stream connections */
    streamPath: z.string().min(1).default("/voice/stream"),
    /** Provider-owned raw config blobs keyed by provider id. */
    providers: VoiceCallStreamingProvidersConfigSchema,
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
  .strict()
  .default({
    enabled: false,
    streamPath: "/voice/stream",
    providers: {},
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  });

// -----------------------------------------------------------------------------
// Main Voice Call Configuration
// -----------------------------------------------------------------------------

export const VoiceCallConfigSchema = z
  .object({
    /** Enable voice call functionality */
    enabled: z.boolean().default(false),

    /** Active provider (telnyx, twilio, plivo, mock, or msteams) */
    provider: z.enum(["telnyx", "twilio", "plivo", "mock", "msteams"]).optional(),

    /** Telnyx-specific configuration */
    telnyx: TelnyxConfigSchema.optional(),

    /** Twilio-specific configuration */
    twilio: TwilioConfigSchema.optional(),

    /** Plivo-specific configuration */
    plivo: PlivoConfigSchema.optional(),

    /** Microsoft Teams provider — bridges Teams call audio via an external Windows worker */
    msteams: MsteamsConfigSchema.optional(),

    /** Phone number to call from (E.164) */
    fromNumber: E164Schema.optional(),

    /** Default phone number to call (E.164) */
    toNumber: E164Schema.optional(),

    /** Inbound call policy */
    inboundPolicy: InboundPolicySchema.default("disabled"),

    /** Allowlist for inbound calls: E.164 phone numbers or Teams AAD object ids. */
    allowFrom: z.array(AllowFromEntrySchema).default([]),

    /** Greeting message for inbound calls */
    inboundGreeting: z.string().optional(),

    /** Per-dialed-number overrides for inbound calls. Keys are E.164 numbers. */
    numbers: z.record(E164Schema, VoiceCallNumberRouteConfigSchema).default({}),

    /** Outbound call configuration */
    outbound: OutboundConfigSchema,

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

    /** Timeout for user transcript (ms) */
    transcriptTimeoutMs: z.number().int().positive().default(180000),

    /** Ring timeout for outbound calls (ms) */
    ringTimeoutMs: z.number().int().positive().default(30000),

    /** Maximum concurrent calls */
    maxConcurrentCalls: z.number().int().positive().default(1),

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
    publicUrl: z.string().url().optional(),

    /** Skip webhook signature verification (development only, NOT for production) */
    skipSignatureVerification: z.boolean().default(false),

    /** TTS override (deep-merges with core messages.tts) */
    tts: TtsConfigSchema,

    /** Store path for call logs */
    store: z.string().optional(),

    /** Agent ID to use for voice response generation. Defaults to "main". */
    agentId: z.string().min(1).optional(),

    /** Optional model override for generating voice responses. */
    responseModel: z.string().optional(),

    /** System prompt for voice responses */
    responseSystemPrompt: z.string().optional(),

    /** Timeout for response generation in ms (default 30s) */
    responseTimeoutMs: z.number().int().positive().default(30000),
  })
  .strict();

export type VoiceCallConfig = z.infer<typeof VoiceCallConfigSchema>;
export type VoiceCallEffectiveConfigResult = {
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
export type VoiceCallConfigInput = DeepPartial<VoiceCallConfig>;
const TWILIO_AUTH_TOKEN_PATH = "plugins.entries.voice-call.config.twilio.authToken";

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

const DEFAULT_VOICE_CALL_CONFIG = VoiceCallConfigSchema.parse({});

function cloneDefaultVoiceCallConfig(): VoiceCallConfig {
  return structuredClone(DEFAULT_VOICE_CALL_CONFIG);
}

function normalizeWebhookLikePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (prefixed === "/") {
    return prefixed;
  }
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

function defaultRealtimeStreamPathForServePath(servePath: string): string {
  const normalized = normalizeWebhookLikePath(servePath);
  if (normalized.endsWith("/webhook")) {
    return `${normalized.slice(0, -"/webhook".length)}/stream/realtime`;
  }
  if (normalized === "/") {
    return "/voice/stream/realtime";
  }
  return `${normalized}/stream/realtime`;
}

function normalizeVoiceCallTtsConfig(
  defaults: VoiceCallTtsConfig,
  overrides: DeepPartial<NonNullable<VoiceCallTtsConfig>> | undefined,
): VoiceCallTtsConfig {
  if (!defaults && !overrides) {
    return undefined;
  }

  return TtsConfigSchema.parse(deepMergeDefined(defaults ?? {}, overrides ?? {}));
}

function normalizePhoneRouteKey(phone: string | undefined): string {
  return phone?.replace(/\D/g, "") ?? "";
}

export function resolveVoiceCallNumberRouteKey(
  config: Pick<VoiceCallConfig, "numbers">,
  phone: string | undefined,
): string | undefined {
  const routes = config.numbers;
  if (!routes) {
    return undefined;
  }
  if (phone && Object.hasOwn(routes, phone)) {
    return phone;
  }

  const normalizedPhone = normalizePhoneRouteKey(phone);
  if (!normalizedPhone) {
    return undefined;
  }
  return Object.keys(routes).find(
    (routeKey) => normalizePhoneRouteKey(routeKey) === normalizedPhone,
  );
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
      numbers: config.numbers,
    },
  };
}

function sanitizeVoiceCallProviderConfigs(
  value: Record<string, Record<string, unknown> | undefined> | undefined,
): Record<string, Record<string, unknown>> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined,
    ),
  );
}

function sanitizeVoiceCallNumberRoutes(
  value: Record<string, unknown> | undefined,
): Record<string, VoiceCallNumberRouteConfig> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
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

const MSTEAMS_SHARED_SECRET_PATH = "plugins.entries.voice-call.config.msteams.sharedSecret";

/** Resolve the msteams HMAC shared secret from its SecretRef-compatible config value. */
export function resolveMsteamsSharedSecret(
  config: Pick<VoiceCallConfig, "msteams">,
): string | undefined {
  return normalizeResolvedSecretInputString({
    value: config.msteams?.sharedSecret,
    path: MSTEAMS_SHARED_SECRET_PATH,
  });
}

export function normalizeVoiceCallConfig(config: VoiceCallConfigInput): VoiceCallConfig {
  const defaults = cloneDefaultVoiceCallConfig();
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
    numbers: sanitizeVoiceCallNumberRoutes(
      (config.numbers ?? defaults.numbers) as Record<string, unknown>,
    ),
    outbound: { ...defaults.outbound, ...config.outbound },
    serve,
    tailscale: { ...defaults.tailscale, ...config.tailscale },
    tunnel: { ...defaults.tunnel, ...config.tunnel },
    // msteams.path and requireRecordingStatus carry schema defaults, so apply
    // them explicitly here — the `...config` spread above only sees the optional
    // input shape.
    msteams: config.msteams
      ? {
          ...config.msteams,
          path: config.msteams.path ?? "/voice/msteams/stream",
          requireRecordingStatus: config.msteams.requireRecordingStatus ?? true,
          outbound: {
            enabled: config.msteams.outbound?.enabled ?? false,
            workerBaseUrl: config.msteams.outbound?.workerBaseUrl,
            tenantId: config.msteams.outbound?.tenantId,
            answerTimeoutMs: config.msteams.outbound?.answerTimeoutMs,
          },
          groupCall: resolveGroupCallGateConfig(config.msteams.groupCall),
          maxVisionPerMinute: config.msteams.maxVisionPerMinute ?? 30,
        }
      : config.msteams,
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

export function resolveVoiceCallSessionKey(params: {
  config: Pick<VoiceCallConfig, "sessionScope">;
  callId: string;
  phone?: string;
  explicitSessionKey?: string;
}): string {
  const explicit = params.explicitSessionKey?.trim();
  if (explicit) {
    return explicit;
  }
  if (params.config.sessionScope === "per-call") {
    return `voice:call:${params.callId}`;
  }
  const normalizedPhone = params.phone?.replace(/\D/g, "");
  return normalizedPhone ? `voice:${normalizedPhone}` : `voice:${params.callId}`;
}

/**
 * Resolves the configuration by merging environment variables into missing fields.
 * Returns a new configuration object with environment variables applied.
 */
export function resolveVoiceCallConfig(config: VoiceCallConfigInput): VoiceCallConfig {
  const resolved = normalizeVoiceCallConfig(config);

  // Telnyx
  if (resolved.provider === "telnyx") {
    resolved.telnyx = resolved.telnyx ?? {};
    resolved.telnyx.apiKey = resolved.telnyx.apiKey ?? process.env.TELNYX_API_KEY;
    resolved.telnyx.connectionId = resolved.telnyx.connectionId ?? process.env.TELNYX_CONNECTION_ID;
    resolved.telnyx.publicKey = resolved.telnyx.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
  }

  // Twilio
  if (resolved.provider === "twilio") {
    resolved.fromNumber = resolved.fromNumber ?? process.env.TWILIO_FROM_NUMBER;
    resolved.twilio = resolved.twilio ?? {};
    resolved.twilio.accountSid = resolved.twilio.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    resolved.twilio.authToken = resolved.twilio.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  }

  // Plivo
  if (resolved.provider === "plivo") {
    resolved.plivo = resolved.plivo ?? {};
    resolved.plivo.authId = resolved.plivo.authId ?? process.env.PLIVO_AUTH_ID;
    resolved.plivo.authToken = resolved.plivo.authToken ?? process.env.PLIVO_AUTH_TOKEN;
  }

  // Tunnel Config
  resolved.tunnel = resolved.tunnel ?? {
    provider: "none",
    allowNgrokFreeTierLoopbackBypass: false,
  };
  resolved.tunnel.allowNgrokFreeTierLoopbackBypass =
    resolved.tunnel.allowNgrokFreeTierLoopbackBypass ?? false;
  resolved.tunnel.ngrokAuthToken = resolved.tunnel.ngrokAuthToken ?? process.env.NGROK_AUTHTOKEN;
  resolved.tunnel.ngrokDomain = resolved.tunnel.ngrokDomain ?? process.env.NGROK_DOMAIN;

  // Webhook Security Config
  resolved.webhookSecurity = resolved.webhookSecurity ?? {
    allowedHosts: [],
    trustForwardingHeaders: false,
    trustedProxyIPs: [],
  };
  resolved.webhookSecurity.allowedHosts = resolved.webhookSecurity.allowedHosts ?? [];
  resolved.webhookSecurity.trustForwardingHeaders =
    resolved.webhookSecurity.trustForwardingHeaders ?? false;
  resolved.webhookSecurity.trustedProxyIPs = resolved.webhookSecurity.trustedProxyIPs ?? [];

  // Microsoft Teams is inbound-first, but defaulting inbound to "open" would
  // accept every authenticated Teams caller out of the box. Use a safe
  // allowlist-oriented default instead: with an empty allowFrom no caller is
  // accepted until the operator opts callers in (the allowlist accepts AAD
  // object ids) or explicitly sets inboundPolicy: "open". No unsafe default.
  if (resolved.provider === "msteams" && config.inboundPolicy === undefined) {
    resolved.inboundPolicy = "allowlist";
  }

  return normalizeVoiceCallConfig(resolved);
}

/**
 * Validate that the configuration has all required fields for the selected provider.
 */
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

  // msteams and mock are inbound-first providers that never place outbound PSTN
  // calls, so a fromNumber is meaningless for them.
  if (!config.fromNumber && config.provider !== "mock" && config.provider !== "msteams") {
    errors.push(
      config.provider === "twilio"
        ? "plugins.entries.voice-call.config.fromNumber is required (or set TWILIO_FROM_NUMBER env)"
        : "plugins.entries.voice-call.config.fromNumber is required",
    );
  }

  if (config.provider === "telnyx") {
    if (!config.telnyx?.apiKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
      );
    }
    if (!config.telnyx?.connectionId) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.connectionId is required (or set TELNYX_CONNECTION_ID env)",
      );
    }
    if (!config.skipSignatureVerification && !config.telnyx?.publicKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)",
      );
    }
  }

  if (config.provider === "twilio") {
    if (!config.twilio?.accountSid) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
      );
    }
    if (!hasConfiguredSecretInput(config.twilio?.authToken)) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
      );
    }
  }

  if (config.provider === "plivo") {
    if (!config.plivo?.authId) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)",
      );
    }
    if (!config.plivo?.authToken) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authToken is required (or set PLIVO_AUTH_TOKEN env)",
      );
    }
  }

  if (config.provider === "msteams") {
    // The Teams bridge cannot accept calls without a listening port and an HMAC
    // shared secret, so require them up front rather than starting a runtime that
    // silently never binds. (path has a schema default.)
    if (!config.msteams?.port) {
      errors.push("plugins.entries.voice-call.config.msteams.port is required");
    }
    if (!hasConfiguredSecretInput(config.msteams?.sharedSecret)) {
      errors.push("plugins.entries.voice-call.config.msteams.sharedSecret is required");
    }
    // msteams is driven entirely by a realtime path: either streaming
    // transcription or realtime voice-to-voice. Refuse to bind a listener that
    // would accept calls it can neither transcribe nor answer.
    if (!config.streaming?.enabled && !config.realtime?.enabled) {
      errors.push(
        'plugins.entries.voice-call.config.streaming.enabled (or realtime.enabled) must be true for provider "msteams"',
      );
    }
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

  if (
    config.realtime.enabled &&
    config.provider &&
    config.provider !== "twilio" &&
    config.provider !== "telnyx" &&
    config.provider !== "msteams"
  ) {
    errors.push(
      'plugins.entries.voice-call.config.provider must be "twilio", "telnyx", or "msteams" when realtime.enabled is true',
    );
  }

  return { valid: errors.length === 0, errors };
}
