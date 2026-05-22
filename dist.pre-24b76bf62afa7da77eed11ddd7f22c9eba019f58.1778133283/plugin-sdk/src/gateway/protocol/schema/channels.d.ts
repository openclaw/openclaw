import { Type } from "typebox";
export declare const TalkModeParamsSchema: Type.TObject<{
    enabled: Type.TBoolean;
    phase: Type.TOptional<Type.TString>;
}>;
export declare const TalkConfigParamsSchema: Type.TObject<{
    includeSecrets: Type.TOptional<Type.TBoolean>;
}>;
export declare const TalkSpeakParamsSchema: Type.TObject<{
    text: Type.TString;
    voiceId: Type.TOptional<Type.TString>;
    modelId: Type.TOptional<Type.TString>;
    outputFormat: Type.TOptional<Type.TString>;
    speed: Type.TOptional<Type.TNumber>;
    rateWpm: Type.TOptional<Type.TInteger>;
    stability: Type.TOptional<Type.TNumber>;
    similarity: Type.TOptional<Type.TNumber>;
    style: Type.TOptional<Type.TNumber>;
    speakerBoost: Type.TOptional<Type.TBoolean>;
    seed: Type.TOptional<Type.TInteger>;
    normalize: Type.TOptional<Type.TString>;
    language: Type.TOptional<Type.TString>;
    latencyTier: Type.TOptional<Type.TInteger>;
}>;
export declare const TalkRealtimeSessionParamsSchema: Type.TObject<{
    sessionKey: Type.TOptional<Type.TString>;
    provider: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TString>;
    voice: Type.TOptional<Type.TString>;
}>;
export declare const TalkRealtimeRelayAudioParamsSchema: Type.TObject<{
    relaySessionId: Type.TString;
    audioBase64: Type.TString;
    timestamp: Type.TOptional<Type.TNumber>;
}>;
export declare const TalkRealtimeRelayMarkParamsSchema: Type.TObject<{
    relaySessionId: Type.TString;
    markName: Type.TOptional<Type.TString>;
}>;
export declare const TalkRealtimeRelayStopParamsSchema: Type.TObject<{
    relaySessionId: Type.TString;
}>;
export declare const TalkRealtimeRelayToolResultParamsSchema: Type.TObject<{
    relaySessionId: Type.TString;
    callId: Type.TString;
    result: Type.TUnknown;
}>;
export declare const TalkRealtimeRelayOkResultSchema: Type.TObject<{
    ok: Type.TBoolean;
}>;
export declare const TalkRealtimeSessionResultSchema: Type.TUnion<[Type.TObject<{
    provider: Type.TString;
    transport: Type.TOptional<Type.TLiteral<"webrtc-sdp">>;
    clientSecret: Type.TString;
    offerUrl: Type.TOptional<Type.TString>;
    offerHeaders: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    model: Type.TOptional<Type.TString>;
    voice: Type.TOptional<Type.TString>;
    expiresAt: Type.TOptional<Type.TNumber>;
}>, Type.TObject<{
    provider: Type.TString;
    transport: Type.TLiteral<"json-pcm-websocket">;
    protocol: Type.TString;
    clientSecret: Type.TString;
    websocketUrl: Type.TString;
    audio: Type.TObject<{
        inputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        inputSampleRateHz: Type.TInteger;
        outputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        outputSampleRateHz: Type.TInteger;
    }>;
    initialMessage: Type.TOptional<Type.TUnknown>;
    model: Type.TOptional<Type.TString>;
    voice: Type.TOptional<Type.TString>;
    expiresAt: Type.TOptional<Type.TNumber>;
}>, Type.TObject<{
    provider: Type.TString;
    transport: Type.TLiteral<"gateway-relay">;
    relaySessionId: Type.TString;
    audio: Type.TObject<{
        inputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        inputSampleRateHz: Type.TInteger;
        outputEncoding: Type.TUnion<[Type.TLiteral<"pcm16">, Type.TLiteral<"g711_ulaw">]>;
        outputSampleRateHz: Type.TInteger;
    }>;
    model: Type.TOptional<Type.TString>;
    voice: Type.TOptional<Type.TString>;
    expiresAt: Type.TOptional<Type.TNumber>;
}>, Type.TObject<{
    provider: Type.TString;
    transport: Type.TLiteral<"managed-room">;
    roomUrl: Type.TString;
    token: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TString>;
    voice: Type.TOptional<Type.TString>;
    expiresAt: Type.TOptional<Type.TNumber>;
}>]>;
export declare const TalkConfigResultSchema: Type.TObject<{
    config: Type.TObject<{
        talk: Type.TOptional<Type.TObject<{
            provider: Type.TOptional<Type.TString>;
            providers: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
                apiKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TUnion<[Type.TObject<{
                    source: Type.TLiteral<"env">;
                    provider: Type.TString;
                    id: Type.TString;
                }>, Type.TObject<{
                    source: Type.TLiteral<"file">;
                    provider: Type.TString;
                    id: Type.TUnsafe<string>;
                }>, Type.TObject<{
                    source: Type.TLiteral<"exec">;
                    provider: Type.TString;
                    id: Type.TString;
                }>]>]>>;
            }>>>;
            resolved: Type.TObject<{
                provider: Type.TString;
                config: Type.TObject<{
                    apiKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TUnion<[Type.TObject<{
                        source: Type.TLiteral<"env">;
                        provider: Type.TString;
                        id: Type.TString;
                    }>, Type.TObject<{
                        source: Type.TLiteral<"file">;
                        provider: Type.TString;
                        id: Type.TUnsafe<string>;
                    }>, Type.TObject<{
                        source: Type.TLiteral<"exec">;
                        provider: Type.TString;
                        id: Type.TString;
                    }>]>]>>;
                }>;
            }>;
            speechLocale: Type.TOptional<Type.TString>;
            interruptOnSpeech: Type.TOptional<Type.TBoolean>;
            silenceTimeoutMs: Type.TOptional<Type.TInteger>;
        }>>;
        session: Type.TOptional<Type.TObject<{
            mainKey: Type.TOptional<Type.TString>;
        }>>;
        ui: Type.TOptional<Type.TObject<{
            seamColor: Type.TOptional<Type.TString>;
        }>>;
    }>;
}>;
export declare const TalkSpeakResultSchema: Type.TObject<{
    audioBase64: Type.TString;
    provider: Type.TString;
    outputFormat: Type.TOptional<Type.TString>;
    voiceCompatible: Type.TOptional<Type.TBoolean>;
    mimeType: Type.TOptional<Type.TString>;
    fileExtension: Type.TOptional<Type.TString>;
}>;
export declare const ChannelsStatusParamsSchema: Type.TObject<{
    probe: Type.TOptional<Type.TBoolean>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export declare const ChannelAccountSnapshotSchema: Type.TObject<{
    accountId: Type.TString;
    name: Type.TOptional<Type.TString>;
    enabled: Type.TOptional<Type.TBoolean>;
    configured: Type.TOptional<Type.TBoolean>;
    linked: Type.TOptional<Type.TBoolean>;
    running: Type.TOptional<Type.TBoolean>;
    connected: Type.TOptional<Type.TBoolean>;
    reconnectAttempts: Type.TOptional<Type.TInteger>;
    lastConnectedAt: Type.TOptional<Type.TInteger>;
    lastError: Type.TOptional<Type.TString>;
    healthState: Type.TOptional<Type.TString>;
    lastStartAt: Type.TOptional<Type.TInteger>;
    lastStopAt: Type.TOptional<Type.TInteger>;
    lastInboundAt: Type.TOptional<Type.TInteger>;
    lastOutboundAt: Type.TOptional<Type.TInteger>;
    lastTransportActivityAt: Type.TOptional<Type.TInteger>;
    busy: Type.TOptional<Type.TBoolean>;
    activeRuns: Type.TOptional<Type.TInteger>;
    lastRunActivityAt: Type.TOptional<Type.TInteger>;
    lastProbeAt: Type.TOptional<Type.TInteger>;
    mode: Type.TOptional<Type.TString>;
    dmPolicy: Type.TOptional<Type.TString>;
    allowFrom: Type.TOptional<Type.TArray<Type.TString>>;
    tokenSource: Type.TOptional<Type.TString>;
    botTokenSource: Type.TOptional<Type.TString>;
    appTokenSource: Type.TOptional<Type.TString>;
    baseUrl: Type.TOptional<Type.TString>;
    allowUnmentionedGroups: Type.TOptional<Type.TBoolean>;
    cliPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    dbPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    port: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    probe: Type.TOptional<Type.TUnknown>;
    audit: Type.TOptional<Type.TUnknown>;
    application: Type.TOptional<Type.TUnknown>;
}>;
export declare const ChannelUiMetaSchema: Type.TObject<{
    id: Type.TString;
    label: Type.TString;
    detailLabel: Type.TString;
    systemImage: Type.TOptional<Type.TString>;
}>;
export declare const ChannelEventLoopHealthSchema: Type.TObject<{
    degraded: Type.TBoolean;
    reasons: Type.TArray<Type.TUnion<[Type.TLiteral<"event_loop_delay">, Type.TLiteral<"event_loop_utilization">, Type.TLiteral<"cpu">]>>;
    intervalMs: Type.TInteger;
    delayP99Ms: Type.TNumber;
    delayMaxMs: Type.TNumber;
    utilization: Type.TNumber;
    cpuCoreRatio: Type.TNumber;
}>;
export declare const ChannelsStatusResultSchema: Type.TObject<{
    ts: Type.TInteger;
    channelOrder: Type.TArray<Type.TString>;
    channelLabels: Type.TRecord<"^.*$", Type.TString>;
    channelDetailLabels: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    channelSystemImages: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    channelMeta: Type.TOptional<Type.TArray<Type.TObject<{
        id: Type.TString;
        label: Type.TString;
        detailLabel: Type.TString;
        systemImage: Type.TOptional<Type.TString>;
    }>>>;
    channels: Type.TRecord<"^.*$", Type.TUnknown>;
    channelAccounts: Type.TRecord<"^.*$", Type.TArray<Type.TObject<{
        accountId: Type.TString;
        name: Type.TOptional<Type.TString>;
        enabled: Type.TOptional<Type.TBoolean>;
        configured: Type.TOptional<Type.TBoolean>;
        linked: Type.TOptional<Type.TBoolean>;
        running: Type.TOptional<Type.TBoolean>;
        connected: Type.TOptional<Type.TBoolean>;
        reconnectAttempts: Type.TOptional<Type.TInteger>;
        lastConnectedAt: Type.TOptional<Type.TInteger>;
        lastError: Type.TOptional<Type.TString>;
        healthState: Type.TOptional<Type.TString>;
        lastStartAt: Type.TOptional<Type.TInteger>;
        lastStopAt: Type.TOptional<Type.TInteger>;
        lastInboundAt: Type.TOptional<Type.TInteger>;
        lastOutboundAt: Type.TOptional<Type.TInteger>;
        lastTransportActivityAt: Type.TOptional<Type.TInteger>;
        busy: Type.TOptional<Type.TBoolean>;
        activeRuns: Type.TOptional<Type.TInteger>;
        lastRunActivityAt: Type.TOptional<Type.TInteger>;
        lastProbeAt: Type.TOptional<Type.TInteger>;
        mode: Type.TOptional<Type.TString>;
        dmPolicy: Type.TOptional<Type.TString>;
        allowFrom: Type.TOptional<Type.TArray<Type.TString>>;
        tokenSource: Type.TOptional<Type.TString>;
        botTokenSource: Type.TOptional<Type.TString>;
        appTokenSource: Type.TOptional<Type.TString>;
        baseUrl: Type.TOptional<Type.TString>;
        allowUnmentionedGroups: Type.TOptional<Type.TBoolean>;
        cliPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        dbPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        port: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
        probe: Type.TOptional<Type.TUnknown>;
        audit: Type.TOptional<Type.TUnknown>;
        application: Type.TOptional<Type.TUnknown>;
    }>>>;
    channelDefaultAccountId: Type.TRecord<"^.*$", Type.TString>;
    eventLoop: Type.TOptional<Type.TObject<{
        degraded: Type.TBoolean;
        reasons: Type.TArray<Type.TUnion<[Type.TLiteral<"event_loop_delay">, Type.TLiteral<"event_loop_utilization">, Type.TLiteral<"cpu">]>>;
        intervalMs: Type.TInteger;
        delayP99Ms: Type.TNumber;
        delayMaxMs: Type.TNumber;
        utilization: Type.TNumber;
        cpuCoreRatio: Type.TNumber;
    }>>;
}>;
export declare const ChannelsLogoutParamsSchema: Type.TObject<{
    channel: Type.TString;
    accountId: Type.TOptional<Type.TString>;
}>;
export declare const ChannelsStopParamsSchema: Type.TObject<{
    channel: Type.TString;
    accountId: Type.TOptional<Type.TString>;
}>;
export declare const ChannelsStartParamsSchema: Type.TObject<{
    channel: Type.TString;
    accountId: Type.TOptional<Type.TString>;
}>;
export declare const WebLoginStartParamsSchema: Type.TObject<{
    force: Type.TOptional<Type.TBoolean>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    verbose: Type.TOptional<Type.TBoolean>;
    accountId: Type.TOptional<Type.TString>;
}>;
export declare const WebLoginWaitParamsSchema: Type.TObject<{
    timeoutMs: Type.TOptional<Type.TInteger>;
    accountId: Type.TOptional<Type.TString>;
    currentQrDataUrl: Type.TOptional<Type.TString>;
}>;
