export declare const TalkModeParamsSchema: import("@sinclair/typebox").TObject<{
    enabled: import("@sinclair/typebox").TBoolean;
    phase: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const TalkConfigParamsSchema: import("@sinclair/typebox").TObject<{
    includeSecrets: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const TalkConfigResultSchema: import("@sinclair/typebox").TObject<{
    config: import("@sinclair/typebox").TObject<{
        talk: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            provider: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            providers: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
                voiceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                voiceAliases: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
                modelId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                outputFormat: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>>;
            voiceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            voiceAliases: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
            modelId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            outputFormat: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            interruptOnSpeech: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>;
        session: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            mainKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
        ui: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            seamColor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
    }>;
}>;
export declare const ChannelsStatusParamsSchema: import("@sinclair/typebox").TObject<{
    probe: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const ChannelAccountSnapshotSchema: import("@sinclair/typebox").TObject<{
    accountId: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    configured: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    linked: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    running: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    connected: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    reconnectAttempts: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastConnectedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    lastStartAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastStopAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastInboundAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastOutboundAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastProbeAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    dmPolicy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    allowFrom: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    tokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    botTokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    appTokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    baseUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    allowUnmentionedGroups: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    cliPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    dbPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    port: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
    probe: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    audit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    application: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
}>;
export declare const ChannelUiMetaSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    label: import("@sinclair/typebox").TString;
    detailLabel: import("@sinclair/typebox").TString;
    systemImage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const ChannelsStatusResultSchema: import("@sinclair/typebox").TObject<{
    ts: import("@sinclair/typebox").TInteger;
    channelOrder: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    channelLabels: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>;
    channelDetailLabels: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
    channelSystemImages: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
    channelMeta: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TString;
        detailLabel: import("@sinclair/typebox").TString;
        systemImage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    channels: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>;
    channelAccounts: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        accountId: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        configured: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        linked: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        running: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        connected: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        reconnectAttempts: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastConnectedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        lastStartAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastStopAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastInboundAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastOutboundAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastProbeAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        dmPolicy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        allowFrom: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        tokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        botTokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        appTokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        baseUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        allowUnmentionedGroups: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        cliPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        dbPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        port: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
        probe: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        audit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        application: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    }>>>;
    channelDefaultAccountId: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>;
}>;
export declare const ChannelsLogoutParamsSchema: import("@sinclair/typebox").TObject<{
    channel: import("@sinclair/typebox").TString;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const WebLoginStartParamsSchema: import("@sinclair/typebox").TObject<{
    force: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    verbose: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const WebLoginWaitParamsSchema: import("@sinclair/typebox").TObject<{
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
