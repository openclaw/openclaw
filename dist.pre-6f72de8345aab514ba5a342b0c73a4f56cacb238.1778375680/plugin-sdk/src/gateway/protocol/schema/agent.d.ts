import { Type } from "typebox";
export declare const AgentInternalEventSchema: Type.TObject<{
    type: Type.TLiteral<"task_completion">;
    source: Type.TString;
    childSessionKey: Type.TString;
    childSessionId: Type.TOptional<Type.TString>;
    announceType: Type.TString;
    taskLabel: Type.TString;
    status: Type.TString;
    statusLabel: Type.TString;
    result: Type.TString;
    mediaUrls: Type.TOptional<Type.TArray<Type.TString>>;
    statsLine: Type.TOptional<Type.TString>;
    replyInstruction: Type.TString;
}>;
export declare const AgentEventSchema: Type.TObject<{
    runId: Type.TString;
    seq: Type.TInteger;
    stream: Type.TString;
    ts: Type.TInteger;
    spawnedBy: Type.TOptional<Type.TString>;
    data: Type.TRecord<"^.*$", Type.TUnknown>;
}>;
export declare const MessageActionToolContextSchema: Type.TObject<{
    currentChannelId: Type.TOptional<Type.TString>;
    currentGraphChannelId: Type.TOptional<Type.TString>;
    currentChannelProvider: Type.TOptional<Type.TString>;
    currentThreadTs: Type.TOptional<Type.TString>;
    currentMessageId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    replyToMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"off">, Type.TLiteral<"first">, Type.TLiteral<"all">, Type.TLiteral<"batched">]>>;
    hasRepliedRef: Type.TOptional<Type.TObject<{
        value: Type.TBoolean;
    }>>;
    skipCrossContextDecoration: Type.TOptional<Type.TBoolean>;
}>;
export declare const MessageActionParamsSchema: Type.TObject<{
    channel: Type.TString;
    action: Type.TString;
    params: Type.TRecord<"^.*$", Type.TUnknown>;
    accountId: Type.TOptional<Type.TString>;
    requesterSenderId: Type.TOptional<Type.TString>;
    senderIsOwner: Type.TOptional<Type.TBoolean>;
    sessionKey: Type.TOptional<Type.TString>;
    sessionId: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    toolContext: Type.TOptional<Type.TObject<{
        currentChannelId: Type.TOptional<Type.TString>;
        currentGraphChannelId: Type.TOptional<Type.TString>;
        currentChannelProvider: Type.TOptional<Type.TString>;
        currentThreadTs: Type.TOptional<Type.TString>;
        currentMessageId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
        replyToMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"off">, Type.TLiteral<"first">, Type.TLiteral<"all">, Type.TLiteral<"batched">]>>;
        hasRepliedRef: Type.TOptional<Type.TObject<{
            value: Type.TBoolean;
        }>>;
        skipCrossContextDecoration: Type.TOptional<Type.TBoolean>;
    }>>;
    idempotencyKey: Type.TString;
}>;
export declare const SendParamsSchema: Type.TObject<{
    to: Type.TString;
    message: Type.TOptional<Type.TString>;
    mediaUrl: Type.TOptional<Type.TString>;
    mediaUrls: Type.TOptional<Type.TArray<Type.TString>>;
    asVoice: Type.TOptional<Type.TBoolean>;
    gifPlayback: Type.TOptional<Type.TBoolean>;
    channel: Type.TOptional<Type.TString>;
    accountId: Type.TOptional<Type.TString>;
    /** Optional agent id for per-agent media root resolution on gateway sends. */
    agentId: Type.TOptional<Type.TString>;
    /** Reply target message id for native quoted/threaded sends where supported. */
    replyToId: Type.TOptional<Type.TString>;
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.TOptional<Type.TString>;
    /** Optional session key for mirroring delivered output back into the transcript. */
    sessionKey: Type.TOptional<Type.TString>;
    idempotencyKey: Type.TString;
}>;
export declare const PollParamsSchema: Type.TObject<{
    to: Type.TString;
    question: Type.TString;
    options: Type.TArray<Type.TString>;
    maxSelections: Type.TOptional<Type.TInteger>;
    /** Poll duration in seconds (channel-specific limits may apply). */
    durationSeconds: Type.TOptional<Type.TInteger>;
    durationHours: Type.TOptional<Type.TInteger>;
    /** Send silently (no notification) where supported. */
    silent: Type.TOptional<Type.TBoolean>;
    /** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
    isAnonymous: Type.TOptional<Type.TBoolean>;
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.TOptional<Type.TString>;
    channel: Type.TOptional<Type.TString>;
    accountId: Type.TOptional<Type.TString>;
    idempotencyKey: Type.TString;
}>;
export declare const AgentParamsSchema: Type.TObject<{
    message: Type.TString;
    agentId: Type.TOptional<Type.TString>;
    provider: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TString>;
    to: Type.TOptional<Type.TString>;
    replyTo: Type.TOptional<Type.TString>;
    sessionId: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
    thinking: Type.TOptional<Type.TString>;
    deliver: Type.TOptional<Type.TBoolean>;
    attachments: Type.TOptional<Type.TArray<Type.TUnknown>>;
    channel: Type.TOptional<Type.TString>;
    replyChannel: Type.TOptional<Type.TString>;
    accountId: Type.TOptional<Type.TString>;
    replyAccountId: Type.TOptional<Type.TString>;
    threadId: Type.TOptional<Type.TString>;
    groupId: Type.TOptional<Type.TString>;
    groupChannel: Type.TOptional<Type.TString>;
    groupSpace: Type.TOptional<Type.TString>;
    timeout: Type.TOptional<Type.TInteger>;
    bestEffortDeliver: Type.TOptional<Type.TBoolean>;
    lane: Type.TOptional<Type.TString>;
    cleanupBundleMcpOnRunEnd: Type.TOptional<Type.TBoolean>;
    modelRun: Type.TOptional<Type.TBoolean>;
    promptMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"full">, Type.TLiteral<"minimal">, Type.TLiteral<"none">]>>;
    extraSystemPrompt: Type.TOptional<Type.TString>;
    bootstrapContextMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"full">, Type.TLiteral<"lightweight">]>>;
    bootstrapContextRunKind: Type.TOptional<Type.TUnion<[Type.TLiteral<"default">, Type.TLiteral<"heartbeat">, Type.TLiteral<"cron">]>>;
    acpTurnSource: Type.TOptional<Type.TLiteral<"manual_spawn">>;
    internalEvents: Type.TOptional<Type.TArray<Type.TObject<{
        type: Type.TLiteral<"task_completion">;
        source: Type.TString;
        childSessionKey: Type.TString;
        childSessionId: Type.TOptional<Type.TString>;
        announceType: Type.TString;
        taskLabel: Type.TString;
        status: Type.TString;
        statusLabel: Type.TString;
        result: Type.TString;
        mediaUrls: Type.TOptional<Type.TArray<Type.TString>>;
        statsLine: Type.TOptional<Type.TString>;
        replyInstruction: Type.TString;
    }>>>;
    inputProvenance: Type.TOptional<Type.TObject<{
        kind: Type.TString;
        originSessionId: Type.TOptional<Type.TString>;
        sourceSessionKey: Type.TOptional<Type.TString>;
        sourceChannel: Type.TOptional<Type.TString>;
        sourceTool: Type.TOptional<Type.TString>;
    }>>;
    voiceWakeTrigger: Type.TOptional<Type.TString>;
    idempotencyKey: Type.TString;
    label: Type.TOptional<Type.TString>;
}>;
export declare const AgentIdentityParamsSchema: Type.TObject<{
    agentId: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
}>;
export declare const AgentIdentityResultSchema: Type.TObject<{
    agentId: Type.TString;
    name: Type.TOptional<Type.TString>;
    avatar: Type.TOptional<Type.TString>;
    avatarSource: Type.TOptional<Type.TString>;
    avatarStatus: Type.TOptional<Type.TString>;
    avatarReason: Type.TOptional<Type.TString>;
    emoji: Type.TOptional<Type.TString>;
}>;
export declare const AgentWaitParamsSchema: Type.TObject<{
    runId: Type.TString;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export declare const WakeParamsSchema: Type.TObject<{
    mode: Type.TUnion<[Type.TLiteral<"now">, Type.TLiteral<"next-heartbeat">]>;
    text: Type.TString;
}>;
