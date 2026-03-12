export declare const ExecApprovalsAllowlistEntrySchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    pattern: import("@sinclair/typebox").TString;
    lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const ExecApprovalsDefaultsSchema: import("@sinclair/typebox").TObject<{
    security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const ExecApprovalsAgentSchema: import("@sinclair/typebox").TObject<{
    allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        pattern: import("@sinclair/typebox").TString;
        lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>>;
    security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const ExecApprovalsFileSchema: import("@sinclair/typebox").TObject<{
    version: import("@sinclair/typebox").TLiteral<1>;
    socket: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    defaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>>;
    agents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
        allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            pattern: import("@sinclair/typebox").TString;
            lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>>;
        security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>>>;
}>;
export declare const ExecApprovalsSnapshotSchema: import("@sinclair/typebox").TObject<{
    path: import("@sinclair/typebox").TString;
    exists: import("@sinclair/typebox").TBoolean;
    hash: import("@sinclair/typebox").TString;
    file: import("@sinclair/typebox").TObject<{
        version: import("@sinclair/typebox").TLiteral<1>;
        socket: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
        defaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>;
        agents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
            allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                pattern: import("@sinclair/typebox").TString;
                lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
                lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>>;
            security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>>;
    }>;
}>;
export declare const ExecApprovalsGetParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const ExecApprovalsSetParamsSchema: import("@sinclair/typebox").TObject<{
    file: import("@sinclair/typebox").TObject<{
        version: import("@sinclair/typebox").TLiteral<1>;
        socket: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
        defaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>;
        agents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
            allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                pattern: import("@sinclair/typebox").TString;
                lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
                lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>>;
            security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>>;
    }>;
    baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const ExecApprovalsNodeGetParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
}>;
export declare const ExecApprovalsNodeSetParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    file: import("@sinclair/typebox").TObject<{
        version: import("@sinclair/typebox").TLiteral<1>;
        socket: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
        defaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>;
        agents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
            allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                pattern: import("@sinclair/typebox").TString;
                lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
                lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>>;
            security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>>;
    }>;
    baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const ExecApprovalRequestParamsSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    command: import("@sinclair/typebox").TString;
    commandArgv: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    systemRunPlanV2: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        version: import("@sinclair/typebox").TLiteral<2>;
        argv: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        cwd: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        rawCommand: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        agentId: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
        sessionKey: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
    }>>;
    env: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
    cwd: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    nodeId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    host: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    resolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    turnSourceChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    turnSourceTo: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    turnSourceAccountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
    turnSourceThreadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    twoPhase: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const ExecApprovalResolveParamsSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    decision: import("@sinclair/typebox").TString;
}>;
