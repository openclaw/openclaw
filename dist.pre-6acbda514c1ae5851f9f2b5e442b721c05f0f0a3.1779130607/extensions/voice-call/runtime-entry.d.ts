import { i as OpenClawConfig } from "../../types.openclaw-BYfkTL_f.js";
import { B as ZodLiteral, C as ZodEnum, Mi as output, Q as ZodOptional, Y as ZodNumber, Z as ZodObject, bt as ZodUnion, c as ZodBoolean, ea as $catchall, it as ZodRecord, na as $strict, q as ZodNull, r as ZodArray, ra as $strip, st as ZodString, v as ZodDefault, xt as ZodUnknown, y as ZodDiscriminatedUnion } from "../../schemas-CfdlDXSB.js";
import { Ct as TalkEvent } from "../../diagnostic-events-CTdu6sU-.js";
import { R as TtsDirectiveOverrides } from "../../tts-runtime.types-C6wupPkW.js";
import { $r as RealtimeTranscriptionProviderConfig, C as OpenClawPluginApi, Gr as RealtimeVoiceProviderConfig, Un as RealtimeTranscriptionProviderPlugin, Wn as RealtimeVoiceProviderPlugin, ri as RealtimeTranscriptionSession } from "../../types-CkHYPqDj.js";
import { l as TtsConfigSchema } from "../../zod-schema.core-CiFRtOcK.js";
import { nt as TalkSessionController } from "../../realtime-voice-DwM74GDg.js";
import { Duplex } from "node:stream";
import { WebSocket as WebSocket$1 } from "ws";
import http, { IncomingMessage } from "node:http";

//#region extensions/voice-call/src/config.d.ts
type VoiceCallTtsConfig = output<typeof TtsConfigSchema>;
/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
declare const CallModeSchema: ZodEnum<{
  conversation: "conversation";
  notify: "notify";
}>;
type CallMode = output<typeof CallModeSchema>;
declare const VoiceCallRealtimeConfigSchema: ZodDefault<ZodObject<{
  enabled: ZodDefault<ZodBoolean>;
  provider: ZodOptional<ZodString>;
  streamPath: ZodOptional<ZodString>;
  instructions: ZodDefault<ZodString>;
  toolPolicy: ZodDefault<ZodEnum<{
    none: "none";
    owner: "owner";
    "safe-read-only": "safe-read-only";
  }>>;
  consultPolicy: ZodDefault<ZodEnum<{
    always: "always";
    auto: "auto";
    substantive: "substantive";
  }>>;
  consultThinkingLevel: ZodOptional<ZodEnum<{
    off: "off";
    minimal: "minimal";
    high: "high";
    low: "low";
    medium: "medium";
    xhigh: "xhigh";
    adaptive: "adaptive";
    max: "max";
  }>>;
  consultFastMode: ZodOptional<ZodBoolean>;
  tools: ZodDefault<ZodArray<ZodObject<{
    type: ZodLiteral<"function">;
    name: ZodString;
    description: ZodString;
    parameters: ZodObject<{
      type: ZodLiteral<"object">;
      properties: ZodRecord<ZodString, ZodUnknown>;
      required: ZodOptional<ZodArray<ZodString>>;
    }, $strip>;
  }, $strict>>>;
  fastContext: ZodDefault<ZodObject<{
    enabled: ZodDefault<ZodBoolean>;
    timeoutMs: ZodDefault<ZodNumber>;
    maxResults: ZodDefault<ZodNumber>;
    sources: ZodDefault<ZodArray<ZodEnum<{
      memory: "memory";
      sessions: "sessions";
    }>>>;
    fallbackToConsult: ZodDefault<ZodBoolean>;
  }, $strict>>;
  agentContext: ZodDefault<ZodObject<{
    enabled: ZodDefault<ZodBoolean>;
    maxChars: ZodDefault<ZodNumber>;
    includeIdentity: ZodDefault<ZodBoolean>;
    includeSystemPrompt: ZodDefault<ZodBoolean>;
    includeWorkspaceFiles: ZodDefault<ZodBoolean>;
    files: ZodDefault<ZodArray<ZodString>>;
  }, $strict>>;
  providers: ZodDefault<ZodRecord<ZodString, ZodRecord<ZodString, ZodUnknown>>>;
}, $strict>>;
type VoiceCallRealtimeConfig = output<typeof VoiceCallRealtimeConfigSchema>;
declare const VoiceCallConfigSchema: ZodObject<{
  enabled: ZodDefault<ZodBoolean>;
  provider: ZodOptional<ZodEnum<{
    telnyx: "telnyx";
    twilio: "twilio";
    plivo: "plivo";
    mock: "mock";
  }>>;
  telnyx: ZodOptional<ZodObject<{
    apiKey: ZodOptional<ZodString>;
    connectionId: ZodOptional<ZodString>;
    publicKey: ZodOptional<ZodString>;
  }, $strict>>;
  twilio: ZodOptional<ZodObject<{
    accountSid: ZodOptional<ZodString>;
    authToken: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
      source: ZodLiteral<"env">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"file">;
      provider: ZodString;
      id: ZodString;
    }, $strip>, ZodObject<{
      source: ZodLiteral<"exec">;
      provider: ZodString;
      id: ZodString;
    }, $strip>], "source">]>>;
  }, $strict>>;
  plivo: ZodOptional<ZodObject<{
    authId: ZodOptional<ZodString>;
    authToken: ZodOptional<ZodString>;
  }, $strict>>;
  fromNumber: ZodOptional<ZodString>;
  toNumber: ZodOptional<ZodString>;
  inboundPolicy: ZodDefault<ZodEnum<{
    disabled: "disabled";
    allowlist: "allowlist";
    pairing: "pairing";
    open: "open";
  }>>;
  allowFrom: ZodDefault<ZodArray<ZodString>>;
  inboundGreeting: ZodOptional<ZodString>;
  numbers: ZodDefault<ZodRecord<ZodString, ZodObject<{
    inboundGreeting: ZodOptional<ZodString>;
    tts: ZodOptional<ZodObject<{
      auto: ZodOptional<ZodEnum<{
        off: "off";
        always: "always";
        tagged: "tagged";
        inbound: "inbound";
      }>>;
      enabled: ZodOptional<ZodBoolean>;
      mode: ZodOptional<ZodEnum<{
        all: "all";
        final: "final";
      }>>;
      provider: ZodOptional<ZodString>;
      persona: ZodOptional<ZodString>;
      personas: ZodOptional<ZodRecord<ZodString, ZodObject<{
        label: ZodOptional<ZodString>;
        description: ZodOptional<ZodString>;
        provider: ZodOptional<ZodString>;
        fallbackPolicy: ZodOptional<ZodUnion<readonly [ZodLiteral<"preserve-persona">, ZodLiteral<"provider-defaults">, ZodLiteral<"fail">]>>;
        prompt: ZodOptional<ZodObject<{
          profile: ZodOptional<ZodString>;
          scene: ZodOptional<ZodString>;
          sampleContext: ZodOptional<ZodString>;
          style: ZodOptional<ZodString>;
          accent: ZodOptional<ZodString>;
          pacing: ZodOptional<ZodString>;
          constraints: ZodOptional<ZodArray<ZodString>>;
        }, $strict>>;
        providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
          apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
            source: ZodLiteral<"env">;
            provider: ZodString;
            id: ZodString;
          }, $strict>, ZodObject<{
            source: ZodLiteral<"file">;
            provider: ZodString;
            id: ZodString;
          }, $strict>, ZodObject<{
            source: ZodLiteral<"exec">;
            provider: ZodString;
            id: ZodString;
          }, $strict>], "source">]>>;
        }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
      }, $strict>>>;
      summaryModel: ZodOptional<ZodString>;
      modelOverrides: ZodOptional<ZodObject<{
        enabled: ZodOptional<ZodBoolean>;
        allowText: ZodOptional<ZodBoolean>;
        allowProvider: ZodOptional<ZodBoolean>;
        allowVoice: ZodOptional<ZodBoolean>;
        allowModelId: ZodOptional<ZodBoolean>;
        allowVoiceSettings: ZodOptional<ZodBoolean>;
        allowNormalization: ZodOptional<ZodBoolean>;
        allowSeed: ZodOptional<ZodBoolean>;
      }, $strict>>;
      providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
        apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
          source: ZodLiteral<"env">;
          provider: ZodString;
          id: ZodString;
        }, $strict>, ZodObject<{
          source: ZodLiteral<"file">;
          provider: ZodString;
          id: ZodString;
        }, $strict>, ZodObject<{
          source: ZodLiteral<"exec">;
          provider: ZodString;
          id: ZodString;
        }, $strict>], "source">]>>;
      }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
      prefsPath: ZodOptional<ZodString>;
      maxTextLength: ZodOptional<ZodNumber>;
      timeoutMs: ZodOptional<ZodNumber>;
    }, $strict>>;
    agentId: ZodOptional<ZodString>;
    responseModel: ZodOptional<ZodString>;
    responseSystemPrompt: ZodOptional<ZodString>;
    responseTimeoutMs: ZodOptional<ZodNumber>;
  }, $strict>>>;
  outbound: ZodDefault<ZodObject<{
    defaultMode: ZodDefault<ZodEnum<{
      conversation: "conversation";
      notify: "notify";
    }>>;
    notifyHangupDelaySec: ZodDefault<ZodNumber>;
  }, $strict>>;
  maxDurationSeconds: ZodDefault<ZodNumber>;
  staleCallReaperSeconds: ZodDefault<ZodNumber>;
  silenceTimeoutMs: ZodDefault<ZodNumber>;
  transcriptTimeoutMs: ZodDefault<ZodNumber>;
  ringTimeoutMs: ZodDefault<ZodNumber>;
  maxConcurrentCalls: ZodDefault<ZodNumber>;
  serve: ZodDefault<ZodObject<{
    port: ZodDefault<ZodNumber>;
    bind: ZodDefault<ZodString>;
    path: ZodDefault<ZodString>;
  }, $strict>>;
  tailscale: ZodDefault<ZodObject<{
    mode: ZodDefault<ZodEnum<{
      off: "off";
      serve: "serve";
      funnel: "funnel";
    }>>;
    path: ZodDefault<ZodString>;
  }, $strict>>;
  tunnel: ZodDefault<ZodObject<{
    provider: ZodDefault<ZodEnum<{
      none: "none";
      ngrok: "ngrok";
      "tailscale-serve": "tailscale-serve";
      "tailscale-funnel": "tailscale-funnel";
    }>>;
    ngrokAuthToken: ZodOptional<ZodString>;
    ngrokDomain: ZodOptional<ZodString>;
    allowNgrokFreeTierLoopbackBypass: ZodDefault<ZodBoolean>;
  }, $strict>>;
  webhookSecurity: ZodDefault<ZodObject<{
    allowedHosts: ZodDefault<ZodArray<ZodString>>;
    trustForwardingHeaders: ZodDefault<ZodBoolean>;
    trustedProxyIPs: ZodDefault<ZodArray<ZodString>>;
  }, $strict>>;
  streaming: ZodDefault<ZodObject<{
    enabled: ZodDefault<ZodBoolean>;
    provider: ZodOptional<ZodString>;
    streamPath: ZodDefault<ZodString>;
    providers: ZodDefault<ZodRecord<ZodString, ZodRecord<ZodString, ZodUnknown>>>;
    preStartTimeoutMs: ZodDefault<ZodNumber>;
    maxPendingConnections: ZodDefault<ZodNumber>;
    maxPendingConnectionsPerIp: ZodDefault<ZodNumber>;
    maxConnections: ZodDefault<ZodNumber>;
  }, $strict>>;
  realtime: ZodDefault<ZodObject<{
    enabled: ZodDefault<ZodBoolean>;
    provider: ZodOptional<ZodString>;
    streamPath: ZodOptional<ZodString>;
    instructions: ZodDefault<ZodString>;
    toolPolicy: ZodDefault<ZodEnum<{
      none: "none";
      owner: "owner";
      "safe-read-only": "safe-read-only";
    }>>;
    consultPolicy: ZodDefault<ZodEnum<{
      always: "always";
      auto: "auto";
      substantive: "substantive";
    }>>;
    consultThinkingLevel: ZodOptional<ZodEnum<{
      off: "off";
      minimal: "minimal";
      high: "high";
      low: "low";
      medium: "medium";
      xhigh: "xhigh";
      adaptive: "adaptive";
      max: "max";
    }>>;
    consultFastMode: ZodOptional<ZodBoolean>;
    tools: ZodDefault<ZodArray<ZodObject<{
      type: ZodLiteral<"function">;
      name: ZodString;
      description: ZodString;
      parameters: ZodObject<{
        type: ZodLiteral<"object">;
        properties: ZodRecord<ZodString, ZodUnknown>;
        required: ZodOptional<ZodArray<ZodString>>;
      }, $strip>;
    }, $strict>>>;
    fastContext: ZodDefault<ZodObject<{
      enabled: ZodDefault<ZodBoolean>;
      timeoutMs: ZodDefault<ZodNumber>;
      maxResults: ZodDefault<ZodNumber>;
      sources: ZodDefault<ZodArray<ZodEnum<{
        memory: "memory";
        sessions: "sessions";
      }>>>;
      fallbackToConsult: ZodDefault<ZodBoolean>;
    }, $strict>>;
    agentContext: ZodDefault<ZodObject<{
      enabled: ZodDefault<ZodBoolean>;
      maxChars: ZodDefault<ZodNumber>;
      includeIdentity: ZodDefault<ZodBoolean>;
      includeSystemPrompt: ZodDefault<ZodBoolean>;
      includeWorkspaceFiles: ZodDefault<ZodBoolean>;
      files: ZodDefault<ZodArray<ZodString>>;
    }, $strict>>;
    providers: ZodDefault<ZodRecord<ZodString, ZodRecord<ZodString, ZodUnknown>>>;
  }, $strict>>;
  sessionScope: ZodDefault<ZodEnum<{
    "per-phone": "per-phone";
    "per-call": "per-call";
  }>>;
  publicUrl: ZodOptional<ZodString>;
  skipSignatureVerification: ZodDefault<ZodBoolean>;
  tts: ZodOptional<ZodObject<{
    auto: ZodOptional<ZodEnum<{
      off: "off";
      always: "always";
      tagged: "tagged";
      inbound: "inbound";
    }>>;
    enabled: ZodOptional<ZodBoolean>;
    mode: ZodOptional<ZodEnum<{
      all: "all";
      final: "final";
    }>>;
    provider: ZodOptional<ZodString>;
    persona: ZodOptional<ZodString>;
    personas: ZodOptional<ZodRecord<ZodString, ZodObject<{
      label: ZodOptional<ZodString>;
      description: ZodOptional<ZodString>;
      provider: ZodOptional<ZodString>;
      fallbackPolicy: ZodOptional<ZodUnion<readonly [ZodLiteral<"preserve-persona">, ZodLiteral<"provider-defaults">, ZodLiteral<"fail">]>>;
      prompt: ZodOptional<ZodObject<{
        profile: ZodOptional<ZodString>;
        scene: ZodOptional<ZodString>;
        sampleContext: ZodOptional<ZodString>;
        style: ZodOptional<ZodString>;
        accent: ZodOptional<ZodString>;
        pacing: ZodOptional<ZodString>;
        constraints: ZodOptional<ZodArray<ZodString>>;
      }, $strict>>;
      providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
        apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
          source: ZodLiteral<"env">;
          provider: ZodString;
          id: ZodString;
        }, $strict>, ZodObject<{
          source: ZodLiteral<"file">;
          provider: ZodString;
          id: ZodString;
        }, $strict>, ZodObject<{
          source: ZodLiteral<"exec">;
          provider: ZodString;
          id: ZodString;
        }, $strict>], "source">]>>;
      }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
    }, $strict>>>;
    summaryModel: ZodOptional<ZodString>;
    modelOverrides: ZodOptional<ZodObject<{
      enabled: ZodOptional<ZodBoolean>;
      allowText: ZodOptional<ZodBoolean>;
      allowProvider: ZodOptional<ZodBoolean>;
      allowVoice: ZodOptional<ZodBoolean>;
      allowModelId: ZodOptional<ZodBoolean>;
      allowVoiceSettings: ZodOptional<ZodBoolean>;
      allowNormalization: ZodOptional<ZodBoolean>;
      allowSeed: ZodOptional<ZodBoolean>;
    }, $strict>>;
    providers: ZodOptional<ZodRecord<ZodString, ZodObject<{
      apiKey: ZodOptional<ZodUnion<readonly [ZodString, ZodDiscriminatedUnion<[ZodObject<{
        source: ZodLiteral<"env">;
        provider: ZodString;
        id: ZodString;
      }, $strict>, ZodObject<{
        source: ZodLiteral<"file">;
        provider: ZodString;
        id: ZodString;
      }, $strict>, ZodObject<{
        source: ZodLiteral<"exec">;
        provider: ZodString;
        id: ZodString;
      }, $strict>], "source">]>>;
    }, $catchall<ZodUnion<readonly [ZodString, ZodNumber, ZodBoolean, ZodNull, ZodArray<ZodUnknown>, ZodRecord<ZodString, ZodUnknown>]>>>>>;
    prefsPath: ZodOptional<ZodString>;
    maxTextLength: ZodOptional<ZodNumber>;
    timeoutMs: ZodOptional<ZodNumber>;
  }, $strict>>;
  store: ZodOptional<ZodString>;
  agentId: ZodOptional<ZodString>;
  responseModel: ZodOptional<ZodString>;
  responseSystemPrompt: ZodOptional<ZodString>;
  responseTimeoutMs: ZodDefault<ZodNumber>;
}, $strict>;
type VoiceCallConfig = output<typeof VoiceCallConfigSchema>;
//#endregion
//#region extensions/voice-call/src/core-bridge.d.ts
type CoreConfig = {
  session?: {
    store?: string;
  };
  messages?: {
    tts?: VoiceCallTtsConfig;
  };
  [key: string]: unknown;
};
type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
//#endregion
//#region extensions/voice-call/src/types.d.ts
declare const ProviderNameSchema: ZodEnum<{
  telnyx: "telnyx";
  twilio: "twilio";
  plivo: "plivo";
  mock: "mock";
}>;
type ProviderName = output<typeof ProviderNameSchema>;
/** Internal call identifier (UUID) */
type CallId = string;
/** Provider-specific call identifier */
type ProviderCallId = string;
declare const EndReasonSchema: ZodEnum<{
  error: "error";
  timeout: "timeout";
  completed: "completed";
  failed: "failed";
  busy: "busy";
  "hangup-user": "hangup-user";
  "hangup-bot": "hangup-bot";
  "no-answer": "no-answer";
  voicemail: "voicemail";
}>;
type EndReason = output<typeof EndReasonSchema>;
declare const NormalizedEventSchema: ZodDiscriminatedUnion<[ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.initiated">;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.ringing">;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.answered">;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.active">;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.speaking">;
  text: ZodString;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.speech">;
  transcript: ZodString;
  isFinal: ZodBoolean;
  confidence: ZodOptional<ZodNumber>;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.silence">;
  durationMs: ZodNumber;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.dtmf">;
  digits: ZodString;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.ended">;
  reason: ZodEnum<{
    error: "error";
    timeout: "timeout";
    completed: "completed";
    failed: "failed";
    busy: "busy";
    "hangup-user": "hangup-user";
    "hangup-bot": "hangup-bot";
    "no-answer": "no-answer";
    voicemail: "voicemail";
  }>;
}, $strip>, ZodObject<{
  id: ZodString;
  dedupeKey: ZodOptional<ZodString>;
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  timestamp: ZodNumber;
  turnToken: ZodOptional<ZodString>;
  direction: ZodOptional<ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: ZodOptional<ZodString>;
  to: ZodOptional<ZodString>;
  type: ZodLiteral<"call.error">;
  error: ZodString;
  retryable: ZodOptional<ZodBoolean>;
}, $strip>], "type">;
type NormalizedEvent = output<typeof NormalizedEventSchema>;
declare const CallRecordSchema: ZodObject<{
  callId: ZodString;
  providerCallId: ZodOptional<ZodString>;
  provider: ZodEnum<{
    telnyx: "telnyx";
    twilio: "twilio";
    plivo: "plivo";
    mock: "mock";
  }>;
  direction: ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>;
  state: ZodEnum<{
    error: "error";
    timeout: "timeout";
    completed: "completed";
    failed: "failed";
    busy: "busy";
    active: "active";
    initiated: "initiated";
    ringing: "ringing";
    answered: "answered";
    speaking: "speaking";
    listening: "listening";
    "hangup-user": "hangup-user";
    "hangup-bot": "hangup-bot";
    "no-answer": "no-answer";
    voicemail: "voicemail";
  }>;
  from: ZodString;
  to: ZodString;
  sessionKey: ZodOptional<ZodString>;
  startedAt: ZodNumber;
  answeredAt: ZodOptional<ZodNumber>;
  endedAt: ZodOptional<ZodNumber>;
  endReason: ZodOptional<ZodEnum<{
    error: "error";
    timeout: "timeout";
    completed: "completed";
    failed: "failed";
    busy: "busy";
    "hangup-user": "hangup-user";
    "hangup-bot": "hangup-bot";
    "no-answer": "no-answer";
    voicemail: "voicemail";
  }>>;
  transcript: ZodDefault<ZodArray<ZodObject<{
    timestamp: ZodNumber;
    speaker: ZodEnum<{
      user: "user";
      bot: "bot";
    }>;
    text: ZodString;
    isFinal: ZodDefault<ZodBoolean>;
  }, $strip>>>;
  processedEventIds: ZodDefault<ZodArray<ZodString>>;
  metadata: ZodOptional<ZodRecord<ZodString, ZodUnknown>>;
}, $strip>;
type CallRecord = output<typeof CallRecordSchema>;
type WebhookVerificationResult = {
  ok: boolean;
  reason?: string; /** Signature is valid, but request was seen before within replay window. */
  isReplay?: boolean; /** Stable key derived from authenticated request material. */
  verifiedRequestKey?: string;
};
type WebhookParseOptions = {
  /** Stable request key from verifyWebhook. */verifiedRequestKey?: string;
};
type WebhookContext = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
};
type ProviderWebhookParseResult = {
  events: NormalizedEvent[];
  providerResponseBody?: string;
  providerResponseHeaders?: Record<string, string>;
  statusCode?: number;
};
type InitiateCallInput = {
  callId: CallId;
  from: string;
  to: string;
  webhookUrl: string;
  clientState?: Record<string, string>; /** Inline TwiML to execute without fetching webhook TwiML. */
  inlineTwiml?: string; /** TwiML to serve once before normal webhook-driven call handling resumes. */
  preConnectTwiml?: string;
  /**
   * Optional `wss://` URL the carrier should open for bidirectional Media
   * Streaming on call connect. Used by carriers (e.g. Telnyx) that attach
   * streaming at dial time. Twilio learns the URL from TwiML so it ignores
   * this field.
   */
  streamUrl?: string; /** Per-call auth token the carrier echoes back on the WS upgrade. */
  streamAuthToken?: string;
};
type InitiateCallResult = {
  providerCallId: ProviderCallId;
  status: "initiated" | "queued";
};
type HangupCallInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  reason: EndReason;
};
type AnswerCallInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  /**
   * Optional `wss://` URL the carrier should open for bidirectional Media
   * Streaming on answer. Used by carriers (e.g. Telnyx) that attach
   * streaming at answer time. Twilio learns the URL from TwiML so it ignores
   * this field.
   */
  streamUrl?: string; /** Per-call auth token the carrier echoes back on the WS upgrade. */
  streamAuthToken?: string;
};
type PlayTtsInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  text: string;
  voice?: string;
  locale?: string;
};
type SendDtmfInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  digits: string;
};
type StartListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  language?: string; /** Optional per-turn nonce for provider callbacks (replay hardening). */
  turnToken?: string;
};
type StopListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
};
type GetCallStatusInput = {
  providerCallId: ProviderCallId;
};
type GetCallStatusResult = {
  /** Provider-specific status string (e.g. "completed", "in-progress") */status: string; /** True when the provider confirms the call has ended */
  isTerminal: boolean; /** True when the status could not be determined (transient error) */
  isUnknown?: boolean;
};
type OutboundCallOptions = {
  /** Message to speak when call connects */message?: string; /** Call mode (overrides config default) */
  mode?: CallMode; /** DTMF digits to send after the call is connected */
  dtmfSequence?: string; /** Session that initiated the call, used for agent context/delegated message routing */
  requesterSessionKey?: string;
};
//#endregion
//#region extensions/voice-call/src/providers/base.d.ts
/**
 * Abstract base interface for voice call providers.
 *
 * Each provider (Telnyx, Twilio, etc.) implements this interface to provide
 * a consistent API for the call manager.
 *
 * Responsibilities:
 * - Webhook verification and event parsing
 * - Outbound call initiation and hangup
 * - Media control (TTS playback, STT listening)
 */
interface VoiceCallProvider {
  /** Provider identifier */
  readonly name: ProviderName;
  setPublicUrl?(url: string): void;
  /**
   * Verify webhook signature/HMAC before processing.
   * Must be called before parseWebhookEvent.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;
  /**
   * Parse provider-specific webhook payload into normalized events.
   * Returns events and optional response to send back to provider.
   */
  parseWebhookEvent(ctx: WebhookContext, options?: WebhookParseOptions): ProviderWebhookParseResult;
  /**
   * Consume one-time TwiML that must be served before shortcut handlers such as
   * realtime media streams take over the webhook response.
   */
  consumeInitialTwiML?: (ctx: WebhookContext) => string | null;
  /**
   * Initiate an outbound call.
   * @returns Provider call ID and status
   */
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;
  /**
   * Answer an accepted inbound call when the provider requires an explicit
   * answer command after the initial webhook.
   */
  answerCall?: (input: AnswerCallInput) => Promise<void>;
  /**
   * Hang up an active call.
   */
  hangupCall(input: HangupCallInput): Promise<void>;
  /**
   * Play TTS audio to the caller.
   * The provider should handle streaming if supported.
   */
  playTts(input: PlayTtsInput): Promise<void>;
  /**
   * Send DTMF digits to an active call.
   */
  sendDtmf?: (input: SendDtmfInput) => Promise<void>;
  /**
   * Start listening for user speech (activate STT).
   */
  startListening(input: StartListeningInput): Promise<void>;
  /**
   * Stop listening for user speech (deactivate STT).
   */
  stopListening(input: StopListeningInput): Promise<void>;
  /**
   * Query provider for current call status.
   * Used to verify persisted calls are still active on restart.
   * Must return `isUnknown: true` for transient errors (network, 5xx)
   * so the caller can keep the call and rely on timer-based fallback.
   */
  getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>;
}
//#endregion
//#region extensions/voice-call/src/manager/context.d.ts
type StreamSessionIssuer = (request: {
  providerName: "twilio" | "telnyx";
  callId: CallId;
  from?: string;
  to?: string;
  direction: "inbound" | "outbound";
}) => {
  token: string;
  streamUrl: string;
} | undefined;
//#endregion
//#region extensions/voice-call/src/manager.d.ts
/**
 * Manages voice calls: state ownership and delegation to manager helper modules.
 */
declare class CallManager {
  private activeCalls;
  private providerCallIdMap;
  private processedEventIds;
  private rejectedProviderCallIds;
  private provider;
  private config;
  private storePath;
  private webhookUrl;
  private activeTurnCalls;
  private transcriptWaiters;
  private maxDurationTimers;
  private initialMessageInFlight;
  /**
   * Carrier-side stream session issuer. Wired by the runtime when realtime is
   * enabled so the manager can pre-issue stream URLs for providers (e.g.
   * Telnyx) that attach Media Streaming at dial or answer time.
   */
  streamSessionIssuer: StreamSessionIssuer | undefined;
  constructor(config: VoiceCallConfig, storePath?: string);
  /**
   * Initialize the call manager with a provider.
   * Verifies persisted calls with the provider and restarts timers.
   */
  initialize(provider: VoiceCallProvider, webhookUrl: string): Promise<void>;
  /**
   * Verify persisted calls with the provider before restoring.
   * Calls without providerCallId or older than maxDurationSeconds are skipped.
   * Transient provider errors keep the call (rely on timer fallback).
   */
  private verifyRestoredCalls;
  /**
   * Get the current provider.
   */
  getProvider(): VoiceCallProvider | null;
  /**
   * Initiate an outbound call.
   */
  initiateCall(to: string, sessionKey?: string, options?: OutboundCallOptions | string): Promise<{
    callId: CallId;
    success: boolean;
    error?: string;
  }>;
  /**
   * Speak to user in an active call.
   */
  speak(callId: CallId, text: string): Promise<{
    success: boolean;
    error?: string;
  }>;
  /**
   * Send DTMF digits to an active call.
   */
  sendDtmf(callId: CallId, digits: string): Promise<{
    success: boolean;
    error?: string;
  }>;
  /**
   * Speak the initial message for a call (called when media stream connects).
   */
  speakInitialMessage(providerCallId: string): Promise<void>;
  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  continueCall(callId: CallId, prompt: string): Promise<{
    success: boolean;
    transcript?: string;
    error?: string;
  }>;
  /**
   * End an active call.
   */
  endCall(callId: CallId): Promise<{
    success: boolean;
    error?: string;
  }>;
  private getContext;
  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): void;
  private shouldDeferConversationInitialMessageUntilStreamConnect;
  private maybeSpeakInitialMessageOnAnswered;
  /**
   * Get an active call by ID.
   */
  getCall(callId: CallId): CallRecord | undefined;
  /**
   * Get an active call by provider call ID (e.g., Twilio CallSid).
   */
  getCallByProviderCallId(providerCallId: string): CallRecord | undefined;
  /**
   * Get all active calls.
   */
  getActiveCalls(): CallRecord[];
  /**
   * Get call history (from persisted logs).
   */
  getCallHistory(limit?: number): Promise<CallRecord[]>;
}
//#endregion
//#region extensions/voice-call/src/telephony-tts.d.ts
type TelephonyTtsRuntime = {
  textToSpeechTelephony: (params: {
    text: string;
    cfg: CoreConfig;
    prefsPath?: string;
    overrides?: TtsDirectiveOverrides;
  }) => Promise<{
    success: boolean;
    audioBuffer?: Buffer;
    sampleRate?: number;
    provider?: string;
    fallbackFrom?: string;
    attemptedProviders?: string[];
    error?: string;
  }>;
};
//#endregion
//#region extensions/voice-call/src/media-stream.d.ts
/**
 * Configuration for the media stream handler.
 */
interface MediaStreamConfig {
  /** Realtime transcription provider for streaming STT. */
  transcriptionProvider: RealtimeTranscriptionProviderPlugin;
  /** Provider-owned config blob passed into the transcription session. */
  providerConfig: RealtimeTranscriptionProviderConfig;
  /** Full runtime config, used by providers that can resolve OAuth profiles. */
  cfg?: OpenClawConfig;
  /** Close sockets that never send a valid `start` frame within this window. */
  preStartTimeoutMs?: number;
  /** Max concurrent pre-start sockets. */
  maxPendingConnections?: number;
  /** Max concurrent pre-start sockets from a single source IP. */
  maxPendingConnectionsPerIp?: number;
  /** Max total open sockets (pending + active sessions). */
  maxConnections?: number;
  /** Optional trusted resolver for the source IP used by pending-connection guards. */
  resolveClientIp?: (request: IncomingMessage) => string | undefined;
  /** Validate whether to accept a media stream for the given call ID */
  shouldAcceptStream?: (params: {
    callId: string;
    streamSid: string;
    token?: string;
  }) => boolean;
  /** Callback when transcript is received */
  onTranscript?: (callId: string, transcript: string) => void;
  /** Callback for partial transcripts (streaming UI) */
  onPartialTranscript?: (callId: string, partial: string) => void;
  /** Callback when stream connects */
  onConnect?: (callId: string, streamSid: string) => void;
  /** Callback when realtime transcription is ready for the stream */
  onTranscriptionReady?: (callId: string, streamSid: string) => void;
  /** Callback when speech starts (barge-in) */
  onSpeechStart?: (callId: string) => void;
  /** Callback when stream disconnects */
  onDisconnect?: (callId: string, streamSid: string) => void;
  /** Callback for common Talk events emitted by the telephony STT/TTS adapter. */
  onTalkEvent?: (callId: string, streamSid: string, event: TalkEvent) => void;
}
/**
 * Active media stream session.
 */
interface StreamSession$1 {
  callId: string;
  streamSid: string;
  ws: WebSocket$1;
  sttSession: RealtimeTranscriptionSession;
  talk: TalkSessionController;
}
type StreamSendResult = {
  sent: boolean;
  readyState?: number;
  bufferedBeforeBytes: number;
  bufferedAfterBytes: number;
};
/**
 * Manages WebSocket connections for Twilio media streams.
 */
declare class MediaStreamHandler {
  private wss;
  private sessions;
  private config;
  /** Pending sockets that have upgraded but not yet sent an accepted `start` frame. */
  private pendingConnections;
  /** Pending socket count per remote IP for pre-auth throttling. */
  private pendingByIp;
  private preStartTimeoutMs;
  private maxPendingConnections;
  private maxPendingConnectionsPerIp;
  private maxConnections;
  private inflightUpgrades;
  /** TTS playback queues per stream (serialize audio to prevent overlap) */
  private ttsQueues;
  /** Whether TTS is currently playing per stream */
  private ttsPlaying;
  /** Active TTS playback controllers per stream */
  private ttsActiveControllers;
  constructor(config: MediaStreamConfig);
  /**
   * Handle WebSocket upgrade for media stream connections.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /**
   * Handle new WebSocket connection from Twilio.
   */
  private handleConnection;
  /**
   * Handle stream start event.
   */
  private handleStart;
  private connectTranscriptionAndNotify;
  /**
   * Handle stream stop event.
   */
  private handleStop;
  private getStreamToken;
  private getClientIp;
  private getCurrentConnectionCount;
  private registerPendingConnection;
  private clearPendingConnection;
  private rejectUpgrade;
  /**
   * Get an active session with an open WebSocket, or undefined if unavailable.
   */
  private getOpenSession;
  /**
   * Send a message to a stream's WebSocket if available.
   */
  private sendToStream;
  /**
   * Send audio to a specific stream (for TTS playback).
   * Audio should be mu-law encoded at 8kHz mono.
   */
  sendAudio(streamSid: string, muLawAudio: Buffer): StreamSendResult;
  /**
   * Send a mark event to track audio playback position.
   */
  sendMark(streamSid: string, name: string): StreamSendResult;
  /**
   * Clear audio buffer (interrupt playback).
   */
  clearAudio(streamSid: string): StreamSendResult;
  /**
   * Queue a TTS operation for sequential playback.
   * Only one TTS operation plays at a time per stream to prevent overlap.
   */
  queueTts(streamSid: string, playFn: (signal: AbortSignal) => Promise<void>): Promise<void>;
  /**
   * Clear TTS queue and interrupt current playback (barge-in).
   */
  clearTtsQueue(streamSid: string, _reason?: string): void;
  /**
   * Get active session by call ID.
   */
  getSessionByCallId(callId: string): StreamSession$1 | undefined;
  /**
   * Close all sessions.
   */
  closeAll(): void;
  private getTtsQueue;
  /**
   * Process the TTS queue for a stream.
   * Uses iterative approach to avoid stack accumulation from recursion.
   */
  private processQueue;
  private createTalkEvents;
  private emitTalkEvent;
  private ensureActiveTurn;
  private clearTtsState;
  private resolveQueuedTtsEntries;
}
//#endregion
//#region extensions/voice-call/src/webhook.types.d.ts
type WebhookResponsePayload = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};
//#endregion
//#region extensions/voice-call/src/webhook/realtime-handler.d.ts
type ToolHandlerContext = {
  partialUserTranscript?: string;
};
type ToolHandlerFn = (args: unknown, callId: string, context: ToolHandlerContext) => Promise<unknown>;
type StreamSessionRequest = {
  providerName?: "twilio" | "telnyx";
  callId?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
};
type StreamSession = {
  token: string;
  streamUrl: string;
};
type RealtimeSpeakResult = {
  success: boolean;
  error?: string;
};
declare class RealtimeCallHandler {
  private readonly config;
  private readonly manager;
  private readonly provider;
  private readonly realtimeProvider;
  private readonly providerConfig;
  private readonly servePath;
  private readonly coreConfig?;
  private readonly toolHandlers;
  private readonly pendingStreamTokens;
  private readonly activeBridgesByCallId;
  private readonly activeTelephonyClosersByCallId;
  private readonly partialUserTranscriptsByCallId;
  private readonly partialUserTranscriptUpdatedAtByCallId;
  private readonly recentFinalUserTranscriptsByCallId;
  private readonly recentFinalUserTranscriptTimersByCallId;
  private readonly forcedConsultTimersByCallId;
  private readonly forcedConsultInFlightByCallId;
  private readonly forcedConsultsByCallId;
  private readonly lastProviderConsultAtByCallId;
  private readonly nativeConsultsInFlightByCallId;
  private publicOrigin;
  private publicPathPrefix;
  constructor(config: VoiceCallRealtimeConfig, manager: CallManager, provider: VoiceCallProvider, realtimeProvider: RealtimeVoiceProviderPlugin, providerConfig: RealtimeVoiceProviderConfig, servePath: string, coreConfig?: OpenClawConfig | undefined);
  setPublicUrl(url: string): void;
  getStreamPathPattern(): string;
  buildTwiMLPayload(req: http.IncomingMessage, params?: URLSearchParams): WebhookResponsePayload;
  handleWebSocketUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  registerToolHandler(name: string, fn: ToolHandlerFn): void;
  speak(callId: string, instructions: string): RealtimeSpeakResult;
  issueStreamSession(request?: StreamSessionRequest): StreamSession;
  private issueStreamToken;
  private consumeStreamToken;
  private handleCall;
  private recordPartialUserTranscript;
  private clearPartialUserTranscript;
  private setRecentFinalUserTranscript;
  private clearRecentFinalUserTranscript;
  private clearUserTranscriptState;
  private resolveUserTranscriptContext;
  private consumePartialUserTranscript;
  private waitForConsultTranscriptSettle;
  private clearForcedConsultState;
  private closeTelephonyBridge;
  private scheduleForcedAgentConsult;
  private runForcedAgentConsult;
  private registerCallInManager;
  private resolveRealtimeCall;
  private extractInitialGreeting;
  private endCallInManager;
  private executeToolCall;
}
//#endregion
//#region extensions/voice-call/src/webhook.d.ts
type Logger$1 = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};
/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
declare class VoiceCallWebhookServer {
  private server;
  private listeningUrl;
  private startPromise;
  private config;
  private manager;
  private provider;
  private coreConfig;
  private fullConfig;
  private agentRuntime;
  private logger;
  private stopStaleCallReaper;
  private readonly webhookInFlightLimiter;
  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler;
  /** Delayed auto-hangup timers keyed by provider call ID after stream disconnect. */
  private pendingDisconnectHangups;
  /** Realtime voice handler for duplex provider bridges. */
  private realtimeHandler;
  constructor(config: VoiceCallConfig, manager: CallManager, provider: VoiceCallProvider, coreConfig?: CoreConfig, fullConfig?: OpenClawConfig, agentRuntime?: CoreAgentDeps, logger?: Logger$1);
  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler(): MediaStreamHandler | null;
  getRealtimeHandler(): RealtimeCallHandler | null;
  speakRealtime(callId: string, instructions: string): {
    success: boolean;
    error?: string;
  };
  setRealtimeHandler(handler: RealtimeCallHandler): void;
  private clearPendingDisconnectHangup;
  private resolveMediaStreamClientIp;
  private shouldSuppressBargeInForInitialMessage;
  /**
   * Initialize media streaming with the selected realtime transcription provider.
   */
  private initializeMediaStreaming;
  /**
   * Start the webhook server.
   * Idempotent: returns immediately if the server is already listening.
   */
  start(): Promise<string>;
  /**
   * Stop the webhook server.
   */
  stop(): Promise<void>;
  private resolveListeningUrl;
  private getUpgradePathname;
  private normalizeWebhookPathForMatch;
  private isWebhookPathMatch;
  /**
   * Handle incoming HTTP request.
   */
  private handleRequest;
  private runWebhookPipeline;
  private verifyPreAuthWebhookHeaders;
  private isRealtimeWebSocketUpgrade;
  private getRealtimeTwimlParams;
  private shouldAcceptRealtimeInboundRequest;
  private processParsedEvents;
  private writeWebhookResponse;
  /**
   * Read request body as string with timeout protection.
   */
  private readBody;
  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   */
  private handleInboundResponse;
}
//#endregion
//#region extensions/voice-call/src/runtime.d.ts
type VoiceCallRuntime = {
  config: VoiceCallConfig;
  provider: VoiceCallProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};
type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};
declare function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  fullConfig?: OpenClawConfig;
  agentRuntime: CoreAgentDeps;
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: Logger;
}): Promise<VoiceCallRuntime>;
//#endregion
export { type VoiceCallRuntime, createVoiceCallRuntime };