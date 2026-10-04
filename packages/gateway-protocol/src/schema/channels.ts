import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, SecretInputSchema } from "./primitives.js";
import { GatewayEventLoopHealthSchema } from "./runtime-vitals.js";

// Browser clients, Gateway relays, and channel adapters share this Talk vocabulary.
export const TalkModeParamsSchema = closedObject({
  enabled: Type.Boolean(),
  phase: Type.Optional(Type.String()),
});

/** Reads Talk configuration; secrets are included only for trusted callers. */
export const TalkConfigParamsSchema = closedObject({
  includeSecrets: Type.Optional(Type.Boolean()),
});

export const TalkSpeakParamsSchema = closedObject({
  text: NonEmptyString,
  voiceId: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
  outputFormat: Type.Optional(Type.String()),
  speed: Type.Optional(Type.Number()),
  rateWpm: Type.Optional(Type.Integer({ minimum: 1 })),
  stability: Type.Optional(Type.Number()),
  similarity: Type.Optional(Type.Number()),
  style: Type.Optional(Type.Number()),
  speakerBoost: Type.Optional(Type.Boolean()),
  seed: Type.Optional(Type.Integer({ minimum: 0 })),
  normalize: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  latencyTier: Type.Optional(Type.Integer({ minimum: 0 })),
});

/**
 * One-shot text-to-speech request rendered with the configured TTS provider
 * chain (unlike `talk.speak`, which pins the Talk-mode provider).
 */
export const TtsSpeakParamsSchema = closedObject({
  text: NonEmptyString,
});

const TalkModeSchema = Type.Union([
  Type.Literal("realtime"),
  Type.Literal("stt-tts"),
  Type.Literal("transcription"),
]);

/** Transport families; browser clients branch on this value to choose setup flow. */
const TalkTransportSchema = Type.Union([
  Type.Literal("webrtc"),
  Type.Literal("provider-websocket"),
  Type.Literal("gateway-relay"),
  Type.Literal("managed-room"),
]);

const TalkBrainSchema = Type.Union([
  Type.Literal("agent-consult"),
  Type.Literal("direct-tools"),
  Type.Literal("none"),
]);

const TalkAgentControlModeSchema = Type.Union([
  Type.Literal("status"),
  Type.Literal("steer"),
  Type.Literal("cancel"),
  Type.Literal("followup"),
]);

const TalkEventTypeSchema = Type.Union([
  Type.Literal("session.started"),
  Type.Literal("session.ready"),
  Type.Literal("session.closed"),
  Type.Literal("session.error"),
  Type.Literal("session.replaced"),
  Type.Literal("turn.started"),
  Type.Literal("turn.ended"),
  Type.Literal("turn.cancelled"),
  Type.Literal("capture.started"),
  Type.Literal("capture.stopped"),
  Type.Literal("capture.cancelled"),
  Type.Literal("capture.once"),
  Type.Literal("input.audio.delta"),
  Type.Literal("input.audio.committed"),
  Type.Literal("transcript.delta"),
  Type.Literal("transcript.done"),
  Type.Literal("output.text.delta"),
  Type.Literal("output.text.done"),
  Type.Literal("output.audio.started"),
  Type.Literal("output.audio.delta"),
  Type.Literal("output.audio.done"),
  Type.Literal("tool.call"),
  Type.Literal("tool.progress"),
  Type.Literal("tool.result"),
  Type.Literal("tool.error"),
  Type.Literal("usage.metrics"),
  Type.Literal("latency.metrics"),
  Type.Literal("health.changed"),
]);

/** Event types that must carry a turn id for client-side stream correlation. */
const TURN_SCOPED_TALK_EVENT_TYPES = [
  "turn.started",
  "turn.ended",
  "turn.cancelled",
  "input.audio.delta",
  "input.audio.committed",
  "transcript.delta",
  "transcript.done",
  "output.text.delta",
  "output.text.done",
  "output.audio.started",
  "output.audio.delta",
  "output.audio.done",
  "tool.call",
  "tool.progress",
  "tool.result",
  "tool.error",
];

/** Capture lifecycle events must include capture id to avoid cross-turn ambiguity. */
const CAPTURE_SCOPED_TALK_EVENT_TYPES = [
  "capture.started",
  "capture.stopped",
  "capture.cancelled",
  "capture.once",
];

/** Builds JSON Schema conditional requirements while avoiding reserved word syntax. */
function requireJsonSchemaProperties(properties: string[]): Record<string, { required: string[] }> {
  const conditionalRequirementKey = ["th", "en"].join("");
  return Object.fromEntries([[conditionalRequirementKey, { required: properties }]]);
}

/** Canonical Talk event envelope emitted to browser, relay, and channel consumers. */
export const TalkEventSchema = Type.Object(
  {
    id: NonEmptyString,
    type: TalkEventTypeSchema,
    sessionId: NonEmptyString,
    turnId: Type.Optional(Type.String()),
    captureId: Type.Optional(Type.String()),
    seq: Type.Integer({ minimum: 1 }),
    timestamp: NonEmptyString,
    mode: TalkModeSchema,
    transport: TalkTransportSchema,
    brain: TalkBrainSchema,
    provider: Type.Optional(Type.String()),
    final: Type.Optional(Type.Boolean()),
    callId: Type.Optional(Type.String()),
    itemId: Type.Optional(Type.String()),
    parentId: Type.Optional(Type.String()),
    payload: Type.Unknown(),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: {
          properties: { type: { enum: TURN_SCOPED_TALK_EVENT_TYPES } },
          required: ["type"],
        },
        ...requireJsonSchemaProperties(["turnId"]),
      },
      {
        if: {
          properties: { type: { enum: CAPTURE_SCOPED_TALK_EVENT_TYPES } },
          required: ["type"],
        },
        ...requireJsonSchemaProperties(["captureId"]),
      },
    ],
  },
);

// Voice ids compose into transcript idempotency keys (`voice:<id>:<entry>`), so the
// charset excludes the `:` delimiter to keep distinct id pairs collision-free.
const VoiceIdString = Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" });

export const TalkClientCreateParamsSchema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  voiceSessionId: Type.Optional(VoiceIdString),
  voiceChangeId: Type.Optional(NonEmptyString),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  vadThreshold: Type.Optional(Type.Number()),
  silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  prefixPaddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
  reasoningEffort: Type.Optional(Type.String()),
  mode: Type.Optional(TalkModeSchema),
  transport: Type.Optional(TalkTransportSchema),
  brain: Type.Optional(TalkBrainSchema),
  capabilities: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("camera-frame"),
        Type.Literal("voice-transcript"),
        Type.Literal("gateway-control-v1"),
        Type.Literal("voice-selection"),
      ]),
      { uniqueItems: true },
    ),
  ),
});

export const TalkClientToolCallParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  voiceSessionId: Type.Optional(VoiceIdString),
  callId: NonEmptyString,
  name: NonEmptyString,
  args: Type.Optional(Type.Unknown()),
  relaySessionId: Type.Optional(NonEmptyString),
});

/** One finalized transcript item from a client-owned Talk session. */
export const TalkClientTranscriptParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  voiceSessionId: VoiceIdString,
  entryId: VoiceIdString,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  text: NonEmptyString,
  timestamp: Type.Optional(Type.Number()),
});

export const TalkClientCloseParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  voiceSessionId: VoiceIdString,
});

/** Result for client-owned transcript and close mutations. */
export const TalkClientMutationResultSchema = closedObject({
  ok: Type.Literal(true),
});

export const TalkClientToolCallResultSchema = closedObject({
  runId: NonEmptyString,
  idempotencyKey: NonEmptyString,
  agentId: NonEmptyString,
  agentSessionKey: NonEmptyString,
});

export const TalkClientSteerParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  text: NonEmptyString,
  mode: Type.Optional(TalkAgentControlModeSchema),
});

export const TalkAgentControlResultSchema = closedObject({
  ok: Type.Boolean(),
  mode: TalkAgentControlModeSchema,
  sessionKey: NonEmptyString,
  sessionId: Type.Optional(NonEmptyString),
  active: Type.Boolean(),
  queued: Type.Optional(Type.Boolean()),
  aborted: Type.Optional(Type.Boolean()),
  target: Type.Optional(Type.Union([Type.Literal("embedded_run"), Type.Literal("reply_run")])),
  reason: Type.Optional(Type.String()),
  message: Type.String(),
  speak: Type.Boolean(),
  show: Type.Boolean(),
  suppress: Type.Boolean(),
  providerResult: Type.Optional(
    closedObject({
      status: Type.Literal("cancelled"),
      message: Type.String(),
    }),
  ),
  enqueuedAtMs: Type.Optional(Type.Number()),
  deliveredAtMs: Type.Optional(Type.Number()),
});

export const TalkSessionCreateParamsSchema = closedObject({
  sessionKey: Type.Optional(Type.String()),
  greeting: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" })),
  recovery: Type.Optional(
    closedObject({ interruptedForMs: Type.Integer({ minimum: 0, maximum: 30_000 }) }),
  ),
  voiceChangeId: Type.Optional(NonEmptyString),
  capabilities: Type.Optional(Type.Array(Type.Literal("voice-selection"), { uniqueItems: true })),
  spawnedBy: Type.Optional(NonEmptyString),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  language: Type.Optional(Type.String({ pattern: "^[a-z]{2}$" })),
  vadThreshold: Type.Optional(Type.Number()),
  silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  prefixPaddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
  reasoningEffort: Type.Optional(Type.String()),
  mode: Type.Optional(TalkModeSchema),
  transport: Type.Optional(TalkTransportSchema),
  brain: Type.Optional(TalkBrainSchema),
  ttlMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
});

export const TalkSessionAppendAudioParamsSchema = closedObject({
  sessionId: NonEmptyString,
  audioBase64: NonEmptyString,
  timestamp: Type.Optional(Type.Number()),
});

/** Cancels currently streaming Talk output without necessarily ending the turn. */
export const TalkSessionCancelOutputParamsSchema = closedObject({
  sessionId: NonEmptyString,
  turnId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
});

/** Reports whether a Talk output cancellation applied to the requested turn. */
export const TalkSessionCancelOutputResultSchema = closedObject({
  ok: Type.Literal(true),
  status: Type.Optional(
    Type.Union([Type.Literal("applied"), Type.Literal("stale"), Type.Literal("idle")]),
  ),
  turnId: Type.Optional(NonEmptyString),
});

export const TalkSessionSubmitToolResultParamsSchema = closedObject({
  sessionId: NonEmptyString,
  callId: NonEmptyString,
  result: Type.Unknown(),
  options: Type.Optional(
    closedObject({
      suppressResponse: Type.Optional(Type.Boolean()),
      willContinue: Type.Optional(Type.Boolean()),
    }),
  ),
});

export const TalkSessionSteerParamsSchema = closedObject({
  sessionId: NonEmptyString,
  sessionKey: Type.Optional(NonEmptyString),
  text: NonEmptyString,
  mode: Type.Optional(TalkAgentControlModeSchema),
});

export const TalkSessionCloseParamsSchema = closedObject({
  sessionId: NonEmptyString,
});

export const TalkCatalogParamsSchema = closedObject({
  provider: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
});

const TalkCatalogAudioFormatProperties = {
  encoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
  sampleRateHz: Type.Integer({ minimum: 1 }),
  channels: Type.Integer({ minimum: 1 }),
};

const TalkCatalogProviderSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  configured: Type.Boolean(),
  aliases: Type.Optional(Type.Array(NonEmptyString)),
  models: Type.Optional(Type.Array(Type.String())),
  voices: Type.Optional(Type.Array(Type.String())),
  activeVoices: Type.Optional(Type.Array(Type.String())),
  activeVoiceSelectionPolicy: Type.Optional(Type.Literal("allowlist-default")),
  voicesByModel: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
  defaultModel: Type.Optional(Type.String()),
  modes: Type.Optional(Type.Array(TalkModeSchema)),
  transports: Type.Optional(Type.Array(TalkTransportSchema)),
  brains: Type.Optional(Type.Array(TalkBrainSchema)),
  inputAudioFormats: Type.Optional(Type.Array(closedObject(TalkCatalogAudioFormatProperties))),
  outputAudioFormats: Type.Optional(Type.Array(closedObject(TalkCatalogAudioFormatProperties))),
  supportsBrowserSession: Type.Optional(Type.Boolean()),
  supportsBargeIn: Type.Optional(Type.Boolean()),
  supportsToolCalls: Type.Optional(Type.Boolean()),
  supportsVideoFrames: Type.Optional(Type.Boolean()),
  supportsSessionResumption: Type.Optional(Type.Boolean()),
});

const TalkCatalogProviderGroupSchema = closedObject({
  ready: Type.Optional(Type.Boolean()),
  activeProvider: Type.Optional(Type.String()),
  providers: Type.Array(TalkCatalogProviderSchema),
});

export const TalkCatalogResultSchema = closedObject({
  modes: Type.Array(TalkModeSchema),
  transports: Type.Array(TalkTransportSchema),
  brains: Type.Array(TalkBrainSchema),
  speech: TalkCatalogProviderGroupSchema,
  transcription: TalkCatalogProviderGroupSchema,
  realtime: TalkCatalogProviderGroupSchema,
});

const BrowserRealtimeAudioContractSchema = closedObject({
  inputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
  inputSampleRateHz: Type.Integer({ minimum: 1 }),
  outputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
  outputSampleRateHz: Type.Integer({ minimum: 1 }),
});

export const TalkSessionCreateResultSchema = closedObject({
  sessionId: NonEmptyString,
  provider: Type.Optional(Type.String()),
  mode: TalkModeSchema,
  transport: TalkTransportSchema,
  brain: TalkBrainSchema,
  relaySessionId: Type.Optional(NonEmptyString),
  transcriptionSessionId: Type.Optional(NonEmptyString),
  handoffId: Type.Optional(NonEmptyString),
  roomId: Type.Optional(NonEmptyString),
  roomUrl: Type.Optional(NonEmptyString),
  token: Type.Optional(NonEmptyString),
  audio: Type.Optional(Type.Unknown()),
  model: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Number()),
});

/** Generic success result for Talk session lifecycle calls. */
export const TalkSessionOkResultSchema = closedObject({
  ok: Type.Boolean(),
});

const BrowserRealtimeWebRtcSdpSessionSchema = closedObject({
  provider: NonEmptyString,
  transport: Type.Literal("webrtc"),
  voiceSessionId: NonEmptyString,
  clientSecret: NonEmptyString,
  offerUrl: Type.Optional(Type.String()),
  offerHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
  model: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Number()),
  clientControl: Type.Optional(closedObject({ owner: Type.Literal("gateway") })),
});

const BrowserRealtimeJsonPcmWebSocketSessionSchema = closedObject({
  provider: NonEmptyString,
  transport: Type.Literal("provider-websocket"),
  voiceSessionId: NonEmptyString,
  protocol: NonEmptyString,
  clientSecret: NonEmptyString,
  websocketUrl: NonEmptyString,
  audio: BrowserRealtimeAudioContractSchema,
  initialMessage: Type.Optional(Type.Unknown()),
  model: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Number()),
});

const BrowserRealtimeGatewayRelaySessionSchema = closedObject({
  provider: NonEmptyString,
  transport: Type.Literal("gateway-relay"),
  // Server-owned: older gateways omit it and clients derive it from relaySessionId.
  voiceSessionId: Type.Optional(NonEmptyString),
  relaySessionId: NonEmptyString,
  audio: BrowserRealtimeAudioContractSchema,
  model: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Number()),
});

const BrowserRealtimeManagedRoomSessionSchema = closedObject({
  provider: NonEmptyString,
  transport: Type.Literal("managed-room"),
  // Server-owned rooms carry no client voice bookkeeping yet.
  voiceSessionId: Type.Optional(NonEmptyString),
  roomUrl: NonEmptyString,
  token: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Number()),
});

export const TalkClientCreateResultSchema = Type.Union([
  BrowserRealtimeWebRtcSdpSessionSchema,
  BrowserRealtimeJsonPcmWebSocketSessionSchema,
  BrowserRealtimeGatewayRelaySessionSchema,
  BrowserRealtimeManagedRoomSessionSchema,
]);

/** Secret-bearing provider fields; extra provider options remain provider-owned. */
const TalkProviderConfigSchema = Type.Object(
  { apiKey: Type.Optional(SecretInputSchema) },
  { additionalProperties: true },
);

const TalkRealtimeConfigSchema = closedObject({
  provider: Type.Optional(Type.String()),
  providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
  model: Type.Optional(Type.String()),
  speakerVoice: Type.Optional(Type.String()),
  speakerVoiceId: Type.Optional(Type.String()),
  voice: Type.Optional(Type.String()),
  instructions: Type.Optional(Type.String()),
  mode: Type.Optional(TalkModeSchema),
  transport: Type.Optional(TalkTransportSchema),
  vadThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
  prefixPaddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
  reasoningEffort: Type.Optional(Type.String({ minLength: 1 })),
  brain: Type.Optional(TalkBrainSchema),
  consultRouting: Type.Optional(
    Type.Union([Type.Literal("provider-direct"), Type.Literal("force-agent-consult")]),
  ),
});

const ResolvedTalkConfigSchema = closedObject({
  provider: Type.String(),
  config: TalkProviderConfigSchema,
});

const TalkConfigSchema = closedObject({
  provider: Type.Optional(Type.String()),
  providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
  realtime: Type.Optional(TalkRealtimeConfigSchema),
  resolved: Type.Optional(ResolvedTalkConfigSchema),
  consultThinkingLevel: Type.Optional(Type.String()),
  consultFastMode: Type.Optional(Type.Boolean()),
  speechLocale: Type.Optional(Type.String()),
  interruptOnSpeech: Type.Optional(Type.Boolean()),
  silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const TalkConfigResultSchema = closedObject({
  config: closedObject({
    talk: Type.Optional(TalkConfigSchema),
    session: Type.Optional(
      closedObject({
        mainKey: Type.Optional(Type.String()),
      }),
    ),
    ui: Type.Optional(
      closedObject({
        seamColor: Type.Optional(Type.String()),
      }),
    ),
    clientHints: Type.Optional(
      closedObject({
        realtime: Type.Optional(
          closedObject({
            modelSource: Type.Optional(Type.Literal("gateway")),
            gatewayRelaySupported: Type.Optional(Type.Boolean()),
          }),
        ),
      }),
    ),
  }),
});

export const TalkSpeakResultSchema = closedObject({
  audioBase64: NonEmptyString,
  provider: NonEmptyString,
  outputFormat: Type.Optional(Type.String()),
  voiceCompatible: Type.Optional(Type.Boolean()),
  mimeType: Type.Optional(Type.String()),
  fileExtension: Type.Optional(Type.String()),
});

export const TtsSpeakResultSchema = closedObject({
  audioBase64: NonEmptyString,
  provider: NonEmptyString,
  outputFormat: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  fileExtension: Type.Optional(Type.String()),
});

export const ChannelsStatusParamsSchema = closedObject({
  probe: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  channel: Type.Optional(NonEmptyString),
});

/**
 * Per-account channel status snapshot.
 *
 * This is intentionally schema-light so new channel-specific metadata can ship
 * without a gateway protocol update; known fields stay documented for UI use.
 */
const ChannelAccountSnapshotSchema = Type.Object(
  {
    accountId: NonEmptyString,
    name: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    configured: Type.Optional(Type.Boolean()),
    linked: Type.Optional(Type.Boolean()),
    running: Type.Optional(Type.Boolean()),
    connected: Type.Optional(Type.Boolean()),
    reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    lastConnectedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    lastError: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    healthState: Type.Optional(Type.String()),
    lastStartAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    lastStopAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    lastInboundAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    lastOutboundAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    lastTransportActivityAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    busy: Type.Optional(Type.Boolean()),
    activeRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunActivityAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    activeRunStartedAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    lastProbeAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    mode: Type.Optional(Type.String()),
    dmPolicy: Type.Optional(Type.String()),
    allowFrom: Type.Optional(Type.Array(Type.String())),
    tokenSource: Type.Optional(Type.String()),
    botTokenSource: Type.Optional(Type.String()),
    appTokenSource: Type.Optional(Type.String()),
    credentialSource: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    audienceType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    audience: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    webhookPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    webhookUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    baseUrl: Type.Optional(Type.String()),
    allowUnmentionedGroups: Type.Optional(Type.Boolean()),
    cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    probe: Type.Optional(Type.Unknown()),
    audit: Type.Optional(Type.Unknown()),
    application: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const ChannelUiMetaSchema = closedObject({
  id: NonEmptyString,
  label: NonEmptyString,
  detailLabel: NonEmptyString,
  systemImage: Type.Optional(Type.String()),
});

const ChannelEventLoopHealthSchema = closedObject({
  ...GatewayEventLoopHealthSchema.properties,
  intervalMs: Type.Integer({ minimum: 0 }),
});

export const ChannelsStatusResultSchema = closedObject({
  ts: Type.Integer({ minimum: 0 }),
  channelOrder: Type.Array(NonEmptyString),
  channelLabels: Type.Record(NonEmptyString, NonEmptyString),
  channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
  channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
  channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
  channels: Type.Record(NonEmptyString, Type.Unknown()),
  channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
  channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString),
  eventLoop: Type.Optional(ChannelEventLoopHealthSchema),
  partial: Type.Optional(Type.Boolean()),
  warnings: Type.Optional(Type.Array(Type.String())),
  statusIssues: Type.Optional(
    Type.Array(
      closedObject({
        channel: NonEmptyString,
        accountId: NonEmptyString,
        kind: Type.Union([
          Type.Literal("intent"),
          Type.Literal("permissions"),
          Type.Literal("config"),
          Type.Literal("auth"),
          Type.Literal("runtime"),
        ]),
        message: Type.String(),
        fix: Type.Optional(Type.String()),
      }),
      { maxItems: 50 },
    ),
  ),
});

export const ChannelsLogoutParamsSchema = closedObject({
  channel: NonEmptyString,
  accountId: Type.Optional(Type.String()),
});

export const ChannelsStopParamsSchema = closedObject(ChannelsLogoutParamsSchema.properties);

export const ChannelsStartParamsSchema = closedObject(ChannelsLogoutParamsSchema.properties);

export const WebLoginStartParamsSchema = closedObject({
  channel: Type.Optional(NonEmptyString),
  force: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  verbose: Type.Optional(Type.Boolean()),
  accountId: Type.Optional(Type.String()),
});

const QrDataUrlSchema = Type.String({
  maxLength: 16_384,
  pattern: "^data:image/png;base64,",
});

/** Waits for web login completion or the next QR code. */
export const WebLoginWaitParamsSchema = closedObject({
  channel: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  accountId: Type.Optional(Type.String()),
  currentQrDataUrl: Type.Optional(QrDataUrlSchema),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type TalkEvent = Static<typeof TalkEventSchema>;
export type TalkModeParams = Static<typeof TalkModeParamsSchema>;
export type TalkCatalogParams = Static<typeof TalkCatalogParamsSchema>;
export type TalkCatalogResult = Static<typeof TalkCatalogResultSchema>;
export type TalkConfigParams = Static<typeof TalkConfigParamsSchema>;
export type TalkConfigResult = Static<typeof TalkConfigResultSchema>;
export type TalkClientCreateParams = Static<typeof TalkClientCreateParamsSchema>;
export type TalkClientCreateResult = Static<typeof TalkClientCreateResultSchema>;
export type TalkClientSteerParams = Static<typeof TalkClientSteerParamsSchema>;
export type TalkAgentControlResult = Static<typeof TalkAgentControlResultSchema>;
export type TalkClientToolCallParams = Static<typeof TalkClientToolCallParamsSchema>;
export type TalkClientToolCallResult = Static<typeof TalkClientToolCallResultSchema>;
export type TalkClientTranscriptParams = Static<typeof TalkClientTranscriptParamsSchema>;
export type TalkClientCloseParams = Static<typeof TalkClientCloseParamsSchema>;
export type TalkClientMutationResult = Static<typeof TalkClientMutationResultSchema>;
export type TalkSessionCreateParams = Static<typeof TalkSessionCreateParamsSchema>;
export type TalkSessionCreateResult = Static<typeof TalkSessionCreateResultSchema>;
export type TalkSessionAppendAudioParams = Static<typeof TalkSessionAppendAudioParamsSchema>;
export type TalkSessionCancelOutputParams = Static<typeof TalkSessionCancelOutputParamsSchema>;
export type TalkSessionCancelOutputResult = Static<typeof TalkSessionCancelOutputResultSchema>;
export type TalkSessionSteerParams = Static<typeof TalkSessionSteerParamsSchema>;
export type TalkSessionSubmitToolResultParams = Static<
  typeof TalkSessionSubmitToolResultParamsSchema
>;
export type TalkSessionCloseParams = Static<typeof TalkSessionCloseParamsSchema>;
export type TalkSessionOkResult = Static<typeof TalkSessionOkResultSchema>;
export type TalkSpeakParams = Static<typeof TalkSpeakParamsSchema>;
export type TalkSpeakResult = Static<typeof TalkSpeakResultSchema>;
export type TtsSpeakParams = Static<typeof TtsSpeakParamsSchema>;
export type TtsSpeakResult = Static<typeof TtsSpeakResultSchema>;
export type ChannelsStatusParams = Static<typeof ChannelsStatusParamsSchema>;
export type ChannelsStatusResult = Static<typeof ChannelsStatusResultSchema>;
export type ChannelsStartParams = Static<typeof ChannelsStartParamsSchema>;
export type ChannelsStopParams = Static<typeof ChannelsStopParamsSchema>;
export type ChannelsLogoutParams = Static<typeof ChannelsLogoutParamsSchema>;
export type WebLoginStartParams = Static<typeof WebLoginStartParamsSchema>;
export type WebLoginWaitParams = Static<typeof WebLoginWaitParamsSchema>;
