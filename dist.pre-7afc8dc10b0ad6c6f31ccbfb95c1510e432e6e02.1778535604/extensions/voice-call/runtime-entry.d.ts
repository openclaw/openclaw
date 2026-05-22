import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { Ct as TalkEvent } from "../../diagnostic-events-DtMZzCAw.js";
import { R as TtsDirectiveOverrides } from "../../tts-runtime.types-CxTU0vS3.js";
import { An as RealtimeTranscriptionProviderPlugin, Br as RealtimeTranscriptionProviderConfig, Mr as RealtimeVoiceProviderConfig, Wr as RealtimeTranscriptionSession, g as OpenClawPluginApi, jn as RealtimeVoiceProviderPlugin } from "../../types-DaukV8xd.js";
import { t as zod_d_exports } from "../../zod-Cjas1ftF.js";
import { l as TtsConfigSchema } from "../../zod-schema.core-B8Gi0B9c.js";
import { nt as TalkSessionController } from "../../realtime-voice-BAi1vexl.js";
import { Duplex } from "node:stream";
import { WebSocket as WebSocket$1 } from "ws";
import http, { IncomingMessage } from "node:http";

//#region extensions/voice-call/src/config.d.ts
type VoiceCallTtsConfig = zod_d_exports.z.infer<typeof TtsConfigSchema>;
/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
declare const CallModeSchema: zod_d_exports.z.ZodEnum<{
  conversation: "conversation";
  notify: "notify";
}>;
type CallMode = zod_d_exports.z.infer<typeof CallModeSchema>;
declare const VoiceCallRealtimeConfigSchema: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
  enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
  provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  streamPath: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  instructions: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodString>;
  toolPolicy: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
    none: "none";
    owner: "owner";
    "safe-read-only": "safe-read-only";
  }>>;
  consultPolicy: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
    always: "always";
    auto: "auto";
    substantive: "substantive";
  }>>;
  consultThinkingLevel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    off: "off";
    minimal: "minimal";
    low: "low";
    medium: "medium";
    high: "high";
    xhigh: "xhigh";
    adaptive: "adaptive";
    max: "max";
  }>>;
  consultFastMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
  tools: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodObject<{
    type: zod_d_exports.z.ZodLiteral<"function">;
    name: zod_d_exports.z.ZodString;
    description: zod_d_exports.z.ZodString;
    parameters: zod_d_exports.z.ZodObject<{
      type: zod_d_exports.z.ZodLiteral<"object">;
      properties: zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>;
      required: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
    }, zod_d_exports.z.core.$strip>;
  }, zod_d_exports.z.core.$strict>>>;
  fastContext: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    timeoutMs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
    maxResults: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
    sources: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodEnum<{
      memory: "memory";
      sessions: "sessions";
    }>>>;
    fallbackToConsult: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
  }, zod_d_exports.z.core.$strict>>;
  agentContext: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    maxChars: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
    includeIdentity: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    includeSystemPrompt: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    includeWorkspaceFiles: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    files: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
  }, zod_d_exports.z.core.$strict>>;
  providers: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>>;
}, zod_d_exports.z.core.$strict>>;
type VoiceCallRealtimeConfig = zod_d_exports.z.infer<typeof VoiceCallRealtimeConfigSchema>;
declare const VoiceCallConfigSchema: zod_d_exports.z.ZodObject<{
  enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
  provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    telnyx: "telnyx";
    twilio: "twilio";
    plivo: "plivo";
    mock: "mock";
  }>>;
  telnyx: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    apiKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    connectionId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    publicKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  }, zod_d_exports.z.core.$strict>>;
  twilio: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    accountSid: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    authToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"env">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"file">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
      source: zod_d_exports.z.ZodLiteral<"exec">;
      provider: zod_d_exports.z.ZodString;
      id: zod_d_exports.z.ZodString;
    }, zod_d_exports.z.core.$strip>], "source">]>>;
  }, zod_d_exports.z.core.$strict>>;
  plivo: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    authId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    authToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  }, zod_d_exports.z.core.$strict>>;
  fromNumber: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  toNumber: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  inboundPolicy: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
    pairing: "pairing";
    disabled: "disabled";
    allowlist: "allowlist";
    open: "open";
  }>>;
  allowFrom: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
  inboundGreeting: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  numbers: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodObject<{
    inboundGreeting: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    tts: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      auto: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        off: "off";
        tagged: "tagged";
        always: "always";
        inbound: "inbound";
      }>>;
      enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      mode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
        all: "all";
        final: "final";
      }>>;
      provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      persona: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      personas: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodObject<{
        label: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        description: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        fallbackPolicy: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodLiteral<"preserve-persona">, zod_d_exports.z.ZodLiteral<"provider-defaults">, zod_d_exports.z.ZodLiteral<"fail">]>>;
        prompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
          profile: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
          scene: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
          sampleContext: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
          style: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
          accent: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
          pacing: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
          constraints: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
        }, zod_d_exports.z.core.$strict>>;
        providers: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodObject<{
          apiKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
            source: zod_d_exports.z.ZodLiteral<"env">;
            provider: zod_d_exports.z.ZodString;
            id: zod_d_exports.z.ZodString;
          }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
            source: zod_d_exports.z.ZodLiteral<"file">;
            provider: zod_d_exports.z.ZodString;
            id: zod_d_exports.z.ZodString;
          }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
            source: zod_d_exports.z.ZodLiteral<"exec">;
            provider: zod_d_exports.z.ZodString;
            id: zod_d_exports.z.ZodString;
          }, zod_d_exports.z.core.$strict>], "source">]>>;
        }, zod_d_exports.z.core.$catchall<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber, zod_d_exports.z.ZodBoolean, zod_d_exports.z.ZodNull, zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnknown>, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>]>>>>>;
      }, zod_d_exports.z.core.$strict>>>;
      summaryModel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      modelOverrides: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
        enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
        allowText: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
        allowProvider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
        allowVoice: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
        allowModelId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
        allowVoiceSettings: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
        allowNormalization: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
        allowSeed: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      }, zod_d_exports.z.core.$strict>>;
      providers: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodObject<{
        apiKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
          source: zod_d_exports.z.ZodLiteral<"env">;
          provider: zod_d_exports.z.ZodString;
          id: zod_d_exports.z.ZodString;
        }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
          source: zod_d_exports.z.ZodLiteral<"file">;
          provider: zod_d_exports.z.ZodString;
          id: zod_d_exports.z.ZodString;
        }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
          source: zod_d_exports.z.ZodLiteral<"exec">;
          provider: zod_d_exports.z.ZodString;
          id: zod_d_exports.z.ZodString;
        }, zod_d_exports.z.core.$strict>], "source">]>>;
      }, zod_d_exports.z.core.$catchall<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber, zod_d_exports.z.ZodBoolean, zod_d_exports.z.ZodNull, zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnknown>, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>]>>>>>;
      prefsPath: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      maxTextLength: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
      timeoutMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    }, zod_d_exports.z.core.$strict>>;
    agentId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    responseModel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    responseSystemPrompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    responseTimeoutMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>>;
  outbound: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    defaultMode: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
      conversation: "conversation";
      notify: "notify";
    }>>;
    notifyHangupDelaySec: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>;
  maxDurationSeconds: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  staleCallReaperSeconds: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  silenceTimeoutMs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  transcriptTimeoutMs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  ringTimeoutMs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  maxConcurrentCalls: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  serve: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    port: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
    bind: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodString>;
    path: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodString>;
  }, zod_d_exports.z.core.$strict>>;
  tailscale: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    mode: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
      off: "off";
      serve: "serve";
      funnel: "funnel";
    }>>;
    path: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodString>;
  }, zod_d_exports.z.core.$strict>>;
  tunnel: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    provider: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
      none: "none";
      ngrok: "ngrok";
      "tailscale-serve": "tailscale-serve";
      "tailscale-funnel": "tailscale-funnel";
    }>>;
    ngrokAuthToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    ngrokDomain: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    allowNgrokFreeTierLoopbackBypass: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
  }, zod_d_exports.z.core.$strict>>;
  webhookSecurity: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    allowedHosts: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
    trustForwardingHeaders: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    trustedProxyIPs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
  }, zod_d_exports.z.core.$strict>>;
  streaming: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    streamPath: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodString>;
    providers: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>>;
    preStartTimeoutMs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
    maxPendingConnections: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
    maxPendingConnectionsPerIp: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
    maxConnections: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>;
  realtime: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
    enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    streamPath: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    instructions: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodString>;
    toolPolicy: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
      none: "none";
      owner: "owner";
      "safe-read-only": "safe-read-only";
    }>>;
    consultPolicy: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
      always: "always";
      auto: "auto";
      substantive: "substantive";
    }>>;
    consultThinkingLevel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      off: "off";
      minimal: "minimal";
      low: "low";
      medium: "medium";
      high: "high";
      xhigh: "xhigh";
      adaptive: "adaptive";
      max: "max";
    }>>;
    consultFastMode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    tools: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodObject<{
      type: zod_d_exports.z.ZodLiteral<"function">;
      name: zod_d_exports.z.ZodString;
      description: zod_d_exports.z.ZodString;
      parameters: zod_d_exports.z.ZodObject<{
        type: zod_d_exports.z.ZodLiteral<"object">;
        properties: zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>;
        required: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
      }, zod_d_exports.z.core.$strip>;
    }, zod_d_exports.z.core.$strict>>>;
    fastContext: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
      enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
      timeoutMs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
      maxResults: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
      sources: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodEnum<{
        memory: "memory";
        sessions: "sessions";
      }>>>;
      fallbackToConsult: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
    }, zod_d_exports.z.core.$strict>>;
    agentContext: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodObject<{
      enabled: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
      maxChars: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
      includeIdentity: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
      includeSystemPrompt: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
      includeWorkspaceFiles: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
      files: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
    }, zod_d_exports.z.core.$strict>>;
    providers: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>>;
  }, zod_d_exports.z.core.$strict>>;
  sessionScope: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodEnum<{
    "per-phone": "per-phone";
    "per-call": "per-call";
  }>>;
  publicUrl: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  skipSignatureVerification: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
  tts: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
    auto: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      off: "off";
      tagged: "tagged";
      always: "always";
      inbound: "inbound";
    }>>;
    enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    mode: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
      all: "all";
      final: "final";
    }>>;
    provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    persona: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    personas: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodObject<{
      label: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      description: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      provider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
      fallbackPolicy: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodLiteral<"preserve-persona">, zod_d_exports.z.ZodLiteral<"provider-defaults">, zod_d_exports.z.ZodLiteral<"fail">]>>;
      prompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
        profile: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        scene: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        sampleContext: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        style: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        accent: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        pacing: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
        constraints: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
      }, zod_d_exports.z.core.$strict>>;
      providers: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodObject<{
        apiKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
          source: zod_d_exports.z.ZodLiteral<"env">;
          provider: zod_d_exports.z.ZodString;
          id: zod_d_exports.z.ZodString;
        }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
          source: zod_d_exports.z.ZodLiteral<"file">;
          provider: zod_d_exports.z.ZodString;
          id: zod_d_exports.z.ZodString;
        }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
          source: zod_d_exports.z.ZodLiteral<"exec">;
          provider: zod_d_exports.z.ZodString;
          id: zod_d_exports.z.ZodString;
        }, zod_d_exports.z.core.$strict>], "source">]>>;
      }, zod_d_exports.z.core.$catchall<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber, zod_d_exports.z.ZodBoolean, zod_d_exports.z.ZodNull, zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnknown>, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>]>>>>>;
    }, zod_d_exports.z.core.$strict>>>;
    summaryModel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    modelOverrides: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodObject<{
      enabled: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowText: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowProvider: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowVoice: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowModelId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowVoiceSettings: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowNormalization: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
      allowSeed: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
    }, zod_d_exports.z.core.$strict>>;
    providers: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodObject<{
      apiKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
        source: zod_d_exports.z.ZodLiteral<"env">;
        provider: zod_d_exports.z.ZodString;
        id: zod_d_exports.z.ZodString;
      }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
        source: zod_d_exports.z.ZodLiteral<"file">;
        provider: zod_d_exports.z.ZodString;
        id: zod_d_exports.z.ZodString;
      }, zod_d_exports.z.core.$strict>, zod_d_exports.z.ZodObject<{
        source: zod_d_exports.z.ZodLiteral<"exec">;
        provider: zod_d_exports.z.ZodString;
        id: zod_d_exports.z.ZodString;
      }, zod_d_exports.z.core.$strict>], "source">]>>;
    }, zod_d_exports.z.core.$catchall<zod_d_exports.z.ZodUnion<readonly [zod_d_exports.z.ZodString, zod_d_exports.z.ZodNumber, zod_d_exports.z.ZodBoolean, zod_d_exports.z.ZodNull, zod_d_exports.z.ZodArray<zod_d_exports.z.ZodUnknown>, zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>]>>>>>;
    prefsPath: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
    maxTextLength: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
    timeoutMs: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  }, zod_d_exports.z.core.$strict>>;
  store: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  agentId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  responseModel: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  responseSystemPrompt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  responseTimeoutMs: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodNumber>;
}, zod_d_exports.z.core.$strict>;
type VoiceCallConfig = zod_d_exports.z.infer<typeof VoiceCallConfigSchema>;
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
declare const ProviderNameSchema: zod_d_exports.z.ZodEnum<{
  telnyx: "telnyx";
  twilio: "twilio";
  plivo: "plivo";
  mock: "mock";
}>;
type ProviderName = zod_d_exports.z.infer<typeof ProviderNameSchema>;
/** Internal call identifier (UUID) */
type CallId = string;
/** Provider-specific call identifier */
type ProviderCallId = string;
declare const EndReasonSchema: zod_d_exports.z.ZodEnum<{
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
type EndReason = zod_d_exports.z.infer<typeof EndReasonSchema>;
declare const NormalizedEventSchema: zod_d_exports.z.ZodDiscriminatedUnion<[zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.initiated">;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.ringing">;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.answered">;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.active">;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.speaking">;
  text: zod_d_exports.z.ZodString;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.speech">;
  transcript: zod_d_exports.z.ZodString;
  isFinal: zod_d_exports.z.ZodBoolean;
  confidence: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.silence">;
  durationMs: zod_d_exports.z.ZodNumber;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.dtmf">;
  digits: zod_d_exports.z.ZodString;
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.ended">;
  reason: zod_d_exports.z.ZodEnum<{
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
}, zod_d_exports.z.core.$strip>, zod_d_exports.z.ZodObject<{
  id: zod_d_exports.z.ZodString;
  dedupeKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  timestamp: zod_d_exports.z.ZodNumber;
  turnToken: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  direction: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>>;
  from: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  to: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  type: zod_d_exports.z.ZodLiteral<"call.error">;
  error: zod_d_exports.z.ZodString;
  retryable: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodBoolean>;
}, zod_d_exports.z.core.$strip>], "type">;
type NormalizedEvent = zod_d_exports.z.infer<typeof NormalizedEventSchema>;
declare const CallRecordSchema: zod_d_exports.z.ZodObject<{
  callId: zod_d_exports.z.ZodString;
  providerCallId: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  provider: zod_d_exports.z.ZodEnum<{
    telnyx: "telnyx";
    twilio: "twilio";
    plivo: "plivo";
    mock: "mock";
  }>;
  direction: zod_d_exports.z.ZodEnum<{
    inbound: "inbound";
    outbound: "outbound";
  }>;
  state: zod_d_exports.z.ZodEnum<{
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
  from: zod_d_exports.z.ZodString;
  to: zod_d_exports.z.ZodString;
  sessionKey: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodString>;
  startedAt: zod_d_exports.z.ZodNumber;
  answeredAt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  endedAt: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodNumber>;
  endReason: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodEnum<{
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
  transcript: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodObject<{
    timestamp: zod_d_exports.z.ZodNumber;
    speaker: zod_d_exports.z.ZodEnum<{
      user: "user";
      bot: "bot";
    }>;
    text: zod_d_exports.z.ZodString;
    isFinal: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodBoolean>;
  }, zod_d_exports.z.core.$strip>>>;
  processedEventIds: zod_d_exports.z.ZodDefault<zod_d_exports.z.ZodArray<zod_d_exports.z.ZodString>>;
  metadata: zod_d_exports.z.ZodOptional<zod_d_exports.z.ZodRecord<zod_d_exports.z.ZodString, zod_d_exports.z.ZodUnknown>>;
}, zod_d_exports.z.core.$strip>;
type CallRecord = zod_d_exports.z.infer<typeof CallRecordSchema>;
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
interface StreamSession {
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
  getSessionByCallId(callId: string): StreamSession | undefined;
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