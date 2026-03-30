export declare const AgentEventSchema: import("@sinclair/typebox").TObject<{
    runId: import("@sinclair/typebox").TString;
    seq: import("@sinclair/typebox").TInteger;
    stream: import("@sinclair/typebox").TString;
    ts: import("@sinclair/typebox").TInteger;
    data: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>;
}>;
export declare const SendParamsSchema: import("@sinclair/typebox").TObject<{
    to: import("@sinclair/typebox").TString;
    message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    mediaUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    mediaUrls: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    gifPlayback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Optional agent id for per-agent media root resolution on gateway sends. */
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Optional session key for mirroring delivered output back into the transcript. */
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    idempotencyKey: import("@sinclair/typebox").TString;
}>;
export declare const PollParamsSchema: import("@sinclair/typebox").TObject<{
    to: import("@sinclair/typebox").TString;
    question: import("@sinclair/typebox").TString;
    options: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    maxSelections: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    /** Poll duration in seconds (channel-specific limits may apply). */
    durationSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    durationHours: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    /** Send silently (no notification) where supported. */
    silent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    /** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
    isAnonymous: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    idempotencyKey: import("@sinclair/typebox").TString;
}>;
export declare const AgentParamsSchema: import("@sinclair/typebox").TObject<{
    message: import("@sinclair/typebox").TString;
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    replyTo: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    attachments: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnknown>>;
    channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    replyChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    replyAccountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    threadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    groupId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    groupChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    groupSpace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    timeout: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    lane: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    extraSystemPrompt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    inputProvenance: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        kind: import("@sinclair/typebox").TString;
        sourceSessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sourceChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sourceTool: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    idempotencyKey: import("@sinclair/typebox").TString;
    label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    spawnedBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const AgentIdentityParamsSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const AgentIdentityResultSchema: import("@sinclair/typebox").TObject<{
    agentId: import("@sinclair/typebox").TString;
    name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const AgentWaitParamsSchema: import("@sinclair/typebox").TObject<{
    runId: import("@sinclair/typebox").TString;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const WakeParamsSchema: import("@sinclair/typebox").TObject<{
    mode: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"now">, import("@sinclair/typebox").TLiteral<"next-heartbeat">]>;
    text: import("@sinclair/typebox").TString;
}>;
