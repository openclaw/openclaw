export declare const SessionsListParamsSchema: import("@sinclair/typebox").TObject<{
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    activeMinutes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    includeGlobal: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    includeUnknown: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    /**
     * Read first 8KB of each session transcript to derive title from first user message.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeDerivedTitles: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    /**
     * Read last 16KB of each session transcript to extract most recent message preview.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeLastMessage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    spawnedBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    search: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const SessionsPreviewParamsSchema: import("@sinclair/typebox").TObject<{
    keys: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    maxChars: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const SessionsResolveParamsSchema: import("@sinclair/typebox").TObject<{
    key: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    spawnedBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    includeGlobal: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    includeUnknown: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const SessionsPatchParamsSchema: import("@sinclair/typebox").TObject<{
    key: import("@sinclair/typebox").TString;
    label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    thinkingLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    verboseLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    reasoningLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    responseUsage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"off">, import("@sinclair/typebox").TLiteral<"tokens">, import("@sinclair/typebox").TLiteral<"full">, import("@sinclair/typebox").TLiteral<"on">, import("@sinclair/typebox").TNull]>>;
    elevatedLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    execHost: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    execSecurity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    execAsk: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    execNode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    spawnedBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    spawnDepth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
    sendPolicy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"allow">, import("@sinclair/typebox").TLiteral<"deny">, import("@sinclair/typebox").TNull]>>;
    groupActivation: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"mention">, import("@sinclair/typebox").TLiteral<"always">, import("@sinclair/typebox").TNull]>>;
}>;
export declare const SessionsResetParamsSchema: import("@sinclair/typebox").TObject<{
    key: import("@sinclair/typebox").TString;
    reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"new">, import("@sinclair/typebox").TLiteral<"reset">]>>;
}>;
export declare const SessionsDeleteParamsSchema: import("@sinclair/typebox").TObject<{
    key: import("@sinclair/typebox").TString;
    deleteTranscript: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    emitLifecycleHooks: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const SessionsCompactParamsSchema: import("@sinclair/typebox").TObject<{
    key: import("@sinclair/typebox").TString;
    maxLines: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const SessionsUsageParamsSchema: import("@sinclair/typebox").TObject<{
    /** Specific session key to analyze; if omitted returns all sessions. */
    key: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Start date for range filter (YYYY-MM-DD). */
    startDate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** End date for range filter (YYYY-MM-DD). */
    endDate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** How start/end dates should be interpreted. Defaults to UTC when omitted. */
    mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"utc">, import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"specific">]>>;
    /** UTC offset to use when mode is `specific` (for example, UTC-4 or UTC+5:30). */
    utcOffset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Maximum sessions to return (default 50). */
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    /** Include context weight breakdown (systemPromptReport). */
    includeContextWeight: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
