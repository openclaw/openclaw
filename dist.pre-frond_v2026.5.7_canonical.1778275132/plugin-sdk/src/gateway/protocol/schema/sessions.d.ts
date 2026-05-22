import { Type } from "typebox";
export declare const SessionCompactionCheckpointReasonSchema: Type.TUnion<[Type.TLiteral<"manual">, Type.TLiteral<"auto-threshold">, Type.TLiteral<"overflow-retry">, Type.TLiteral<"timeout-retry">]>;
export declare const SessionCompactionTranscriptReferenceSchema: Type.TObject<{
    sessionId: Type.TString;
    sessionFile: Type.TOptional<Type.TString>;
    leafId: Type.TOptional<Type.TString>;
    entryId: Type.TOptional<Type.TString>;
}>;
export declare const SessionCompactionCheckpointSchema: Type.TObject<{
    checkpointId: Type.TString;
    sessionKey: Type.TString;
    sessionId: Type.TString;
    createdAt: Type.TInteger;
    reason: Type.TUnion<[Type.TLiteral<"manual">, Type.TLiteral<"auto-threshold">, Type.TLiteral<"overflow-retry">, Type.TLiteral<"timeout-retry">]>;
    tokensBefore: Type.TOptional<Type.TInteger>;
    tokensAfter: Type.TOptional<Type.TInteger>;
    summary: Type.TOptional<Type.TString>;
    firstKeptEntryId: Type.TOptional<Type.TString>;
    preCompaction: Type.TObject<{
        sessionId: Type.TString;
        sessionFile: Type.TOptional<Type.TString>;
        leafId: Type.TOptional<Type.TString>;
        entryId: Type.TOptional<Type.TString>;
    }>;
    postCompaction: Type.TObject<{
        sessionId: Type.TString;
        sessionFile: Type.TOptional<Type.TString>;
        leafId: Type.TOptional<Type.TString>;
        entryId: Type.TOptional<Type.TString>;
    }>;
}>;
export declare const SessionsListParamsSchema: Type.TObject<{
    /**
     * Maximum rows to return. Omitted Gateway RPC calls use a bounded default
     * to keep large session stores from monopolizing the event loop.
     */
    limit: Type.TOptional<Type.TInteger>;
    activeMinutes: Type.TOptional<Type.TInteger>;
    includeGlobal: Type.TOptional<Type.TBoolean>;
    includeUnknown: Type.TOptional<Type.TBoolean>;
    /**
     * Read first 8KB of each session transcript to derive title from first user message.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeDerivedTitles: Type.TOptional<Type.TBoolean>;
    /**
     * Read last 16KB of each session transcript to extract most recent message preview.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeLastMessage: Type.TOptional<Type.TBoolean>;
    label: Type.TOptional<Type.TString>;
    spawnedBy: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    search: Type.TOptional<Type.TString>;
}>;
export declare const SessionsCleanupParamsSchema: Type.TObject<{
    agent: Type.TOptional<Type.TString>;
    allAgents: Type.TOptional<Type.TBoolean>;
    enforce: Type.TOptional<Type.TBoolean>;
    activeKey: Type.TOptional<Type.TString>;
    fixMissing: Type.TOptional<Type.TBoolean>;
}>;
export declare const SessionsPreviewParamsSchema: Type.TObject<{
    keys: Type.TArray<Type.TString>;
    limit: Type.TOptional<Type.TInteger>;
    maxChars: Type.TOptional<Type.TInteger>;
}>;
export declare const SessionsDescribeParamsSchema: Type.TObject<{
    key: Type.TString;
    includeDerivedTitles: Type.TOptional<Type.TBoolean>;
    includeLastMessage: Type.TOptional<Type.TBoolean>;
}>;
export declare const SessionsResolveParamsSchema: Type.TObject<{
    key: Type.TOptional<Type.TString>;
    sessionId: Type.TOptional<Type.TString>;
    label: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    spawnedBy: Type.TOptional<Type.TString>;
    includeGlobal: Type.TOptional<Type.TBoolean>;
    includeUnknown: Type.TOptional<Type.TBoolean>;
}>;
export declare const SessionsCreateParamsSchema: Type.TObject<{
    key: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    label: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TString>;
    parentSessionKey: Type.TOptional<Type.TString>;
    emitCommandHooks: Type.TOptional<Type.TBoolean>;
    task: Type.TOptional<Type.TString>;
    message: Type.TOptional<Type.TString>;
}>;
export declare const SessionsSendParamsSchema: Type.TObject<{
    key: Type.TString;
    message: Type.TString;
    thinking: Type.TOptional<Type.TString>;
    attachments: Type.TOptional<Type.TArray<Type.TUnknown>>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    idempotencyKey: Type.TOptional<Type.TString>;
}>;
export declare const SessionsMessagesSubscribeParamsSchema: Type.TObject<{
    key: Type.TString;
}>;
export declare const SessionsMessagesUnsubscribeParamsSchema: Type.TObject<{
    key: Type.TString;
}>;
export declare const SessionsAbortParamsSchema: Type.TObject<{
    key: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
}>;
export declare const SessionsPatchParamsSchema: Type.TObject<{
    key: Type.TString;
    label: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    thinkingLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    fastMode: Type.TOptional<Type.TUnion<[Type.TBoolean, Type.TNull]>>;
    verboseLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    traceLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    reasoningLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    responseUsage: Type.TOptional<Type.TUnion<[Type.TLiteral<"off">, Type.TLiteral<"tokens">, Type.TLiteral<"full">, Type.TLiteral<"on">, Type.TNull]>>;
    elevatedLevel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    execHost: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    execSecurity: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    execAsk: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    execNode: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    model: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    spawnedBy: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    spawnedWorkspaceDir: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    spawnDepth: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    subagentRole: Type.TOptional<Type.TUnion<[Type.TLiteral<"orchestrator">, Type.TLiteral<"leaf">, Type.TNull]>>;
    subagentControlScope: Type.TOptional<Type.TUnion<[Type.TLiteral<"children">, Type.TLiteral<"none">, Type.TNull]>>;
    sendPolicy: Type.TOptional<Type.TUnion<[Type.TLiteral<"allow">, Type.TLiteral<"deny">, Type.TNull]>>;
    groupActivation: Type.TOptional<Type.TUnion<[Type.TLiteral<"mention">, Type.TLiteral<"always">, Type.TNull]>>;
}>;
export declare const SessionsPluginPatchParamsSchema: Type.TObject<{
    key: Type.TString;
    pluginId: Type.TString;
    namespace: Type.TString;
    value: Type.TOptional<Type.TUnknown>;
    unset: Type.TOptional<Type.TBoolean>;
}>;
export declare const SessionsPluginPatchResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    key: Type.TString;
    value: Type.TOptional<Type.TUnknown>;
}>;
export declare const SessionsResetParamsSchema: Type.TObject<{
    key: Type.TString;
    reason: Type.TOptional<Type.TUnion<[Type.TLiteral<"new">, Type.TLiteral<"reset">]>>;
}>;
export declare const SessionsDeleteParamsSchema: Type.TObject<{
    key: Type.TString;
    deleteTranscript: Type.TOptional<Type.TBoolean>;
    emitLifecycleHooks: Type.TOptional<Type.TBoolean>;
}>;
export declare const SessionsCompactParamsSchema: Type.TObject<{
    key: Type.TString;
    maxLines: Type.TOptional<Type.TInteger>;
}>;
export declare const SessionsCompactionListParamsSchema: Type.TObject<{
    key: Type.TString;
}>;
export declare const SessionsCompactionGetParamsSchema: Type.TObject<{
    key: Type.TString;
    checkpointId: Type.TString;
}>;
export declare const SessionsCompactionBranchParamsSchema: Type.TObject<{
    key: Type.TString;
    checkpointId: Type.TString;
}>;
export declare const SessionsCompactionRestoreParamsSchema: Type.TObject<{
    key: Type.TString;
    checkpointId: Type.TString;
}>;
export declare const SessionsCompactionListResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    key: Type.TString;
    checkpoints: Type.TArray<Type.TObject<{
        checkpointId: Type.TString;
        sessionKey: Type.TString;
        sessionId: Type.TString;
        createdAt: Type.TInteger;
        reason: Type.TUnion<[Type.TLiteral<"manual">, Type.TLiteral<"auto-threshold">, Type.TLiteral<"overflow-retry">, Type.TLiteral<"timeout-retry">]>;
        tokensBefore: Type.TOptional<Type.TInteger>;
        tokensAfter: Type.TOptional<Type.TInteger>;
        summary: Type.TOptional<Type.TString>;
        firstKeptEntryId: Type.TOptional<Type.TString>;
        preCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
        postCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
    }>>;
}>;
export declare const SessionsCompactionGetResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    key: Type.TString;
    checkpoint: Type.TObject<{
        checkpointId: Type.TString;
        sessionKey: Type.TString;
        sessionId: Type.TString;
        createdAt: Type.TInteger;
        reason: Type.TUnion<[Type.TLiteral<"manual">, Type.TLiteral<"auto-threshold">, Type.TLiteral<"overflow-retry">, Type.TLiteral<"timeout-retry">]>;
        tokensBefore: Type.TOptional<Type.TInteger>;
        tokensAfter: Type.TOptional<Type.TInteger>;
        summary: Type.TOptional<Type.TString>;
        firstKeptEntryId: Type.TOptional<Type.TString>;
        preCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
        postCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
    }>;
}>;
export declare const SessionsCompactionBranchResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    sourceKey: Type.TString;
    key: Type.TString;
    sessionId: Type.TString;
    checkpoint: Type.TObject<{
        checkpointId: Type.TString;
        sessionKey: Type.TString;
        sessionId: Type.TString;
        createdAt: Type.TInteger;
        reason: Type.TUnion<[Type.TLiteral<"manual">, Type.TLiteral<"auto-threshold">, Type.TLiteral<"overflow-retry">, Type.TLiteral<"timeout-retry">]>;
        tokensBefore: Type.TOptional<Type.TInteger>;
        tokensAfter: Type.TOptional<Type.TInteger>;
        summary: Type.TOptional<Type.TString>;
        firstKeptEntryId: Type.TOptional<Type.TString>;
        preCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
        postCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
    }>;
    entry: Type.TObject<{
        sessionId: Type.TString;
        updatedAt: Type.TInteger;
    }>;
}>;
export declare const SessionsCompactionRestoreResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    key: Type.TString;
    sessionId: Type.TString;
    checkpoint: Type.TObject<{
        checkpointId: Type.TString;
        sessionKey: Type.TString;
        sessionId: Type.TString;
        createdAt: Type.TInteger;
        reason: Type.TUnion<[Type.TLiteral<"manual">, Type.TLiteral<"auto-threshold">, Type.TLiteral<"overflow-retry">, Type.TLiteral<"timeout-retry">]>;
        tokensBefore: Type.TOptional<Type.TInteger>;
        tokensAfter: Type.TOptional<Type.TInteger>;
        summary: Type.TOptional<Type.TString>;
        firstKeptEntryId: Type.TOptional<Type.TString>;
        preCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
        postCompaction: Type.TObject<{
            sessionId: Type.TString;
            sessionFile: Type.TOptional<Type.TString>;
            leafId: Type.TOptional<Type.TString>;
            entryId: Type.TOptional<Type.TString>;
        }>;
    }>;
    entry: Type.TObject<{
        sessionId: Type.TString;
        updatedAt: Type.TInteger;
    }>;
}>;
export declare const SessionsUsageParamsSchema: Type.TObject<{
    /** Specific session key to analyze; if omitted returns all sessions. */
    key: Type.TOptional<Type.TString>;
    /** Start date for range filter (YYYY-MM-DD). */
    startDate: Type.TOptional<Type.TString>;
    /** End date for range filter (YYYY-MM-DD). */
    endDate: Type.TOptional<Type.TString>;
    /** How start/end dates should be interpreted. Defaults to UTC when omitted. */
    mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"utc">, Type.TLiteral<"gateway">, Type.TLiteral<"specific">]>>;
    /** UTC offset to use when mode is `specific` (for example, UTC-4 or UTC+5:30). */
    utcOffset: Type.TOptional<Type.TString>;
    /** Maximum sessions to return (default 50). */
    limit: Type.TOptional<Type.TInteger>;
    /** Include context weight breakdown (systemPromptReport). */
    includeContextWeight: Type.TOptional<Type.TBoolean>;
}>;
