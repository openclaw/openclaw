import { Type } from "typebox";
export declare const ExecApprovalsAllowlistEntrySchema: Type.TObject<{
    id: Type.TOptional<Type.TString>;
    pattern: Type.TString;
    source: Type.TOptional<Type.TLiteral<"allow-always">>;
    commandText: Type.TOptional<Type.TString>;
    argPattern: Type.TOptional<Type.TString>;
    lastUsedAt: Type.TOptional<Type.TInteger>;
    lastUsedCommand: Type.TOptional<Type.TString>;
    lastResolvedPath: Type.TOptional<Type.TString>;
}>;
export declare const ExecApprovalsDefaultsSchema: Type.TObject<{
    security: Type.TOptional<Type.TString>;
    ask: Type.TOptional<Type.TString>;
    askFallback: Type.TOptional<Type.TString>;
    autoAllowSkills: Type.TOptional<Type.TBoolean>;
}>;
export declare const ExecApprovalsAgentSchema: Type.TObject<{
    security: Type.TOptional<Type.TString>;
    ask: Type.TOptional<Type.TString>;
    askFallback: Type.TOptional<Type.TString>;
    autoAllowSkills: Type.TOptional<Type.TBoolean>;
    allowlist: Type.TOptional<Type.TArray<Type.TObject<{
        id: Type.TOptional<Type.TString>;
        pattern: Type.TString;
        source: Type.TOptional<Type.TLiteral<"allow-always">>;
        commandText: Type.TOptional<Type.TString>;
        argPattern: Type.TOptional<Type.TString>;
        lastUsedAt: Type.TOptional<Type.TInteger>;
        lastUsedCommand: Type.TOptional<Type.TString>;
        lastResolvedPath: Type.TOptional<Type.TString>;
    }>>>;
}>;
export declare const ExecApprovalsFileSchema: Type.TObject<{
    version: Type.TLiteral<1>;
    socket: Type.TOptional<Type.TObject<{
        path: Type.TOptional<Type.TString>;
        token: Type.TOptional<Type.TString>;
    }>>;
    defaults: Type.TOptional<Type.TObject<{
        security: Type.TOptional<Type.TString>;
        ask: Type.TOptional<Type.TString>;
        askFallback: Type.TOptional<Type.TString>;
        autoAllowSkills: Type.TOptional<Type.TBoolean>;
    }>>;
    agents: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
        security: Type.TOptional<Type.TString>;
        ask: Type.TOptional<Type.TString>;
        askFallback: Type.TOptional<Type.TString>;
        autoAllowSkills: Type.TOptional<Type.TBoolean>;
        allowlist: Type.TOptional<Type.TArray<Type.TObject<{
            id: Type.TOptional<Type.TString>;
            pattern: Type.TString;
            source: Type.TOptional<Type.TLiteral<"allow-always">>;
            commandText: Type.TOptional<Type.TString>;
            argPattern: Type.TOptional<Type.TString>;
            lastUsedAt: Type.TOptional<Type.TInteger>;
            lastUsedCommand: Type.TOptional<Type.TString>;
            lastResolvedPath: Type.TOptional<Type.TString>;
        }>>>;
    }>>>;
}>;
export declare const ExecApprovalsSnapshotSchema: Type.TObject<{
    path: Type.TString;
    exists: Type.TBoolean;
    hash: Type.TString;
    file: Type.TObject<{
        version: Type.TLiteral<1>;
        socket: Type.TOptional<Type.TObject<{
            path: Type.TOptional<Type.TString>;
            token: Type.TOptional<Type.TString>;
        }>>;
        defaults: Type.TOptional<Type.TObject<{
            security: Type.TOptional<Type.TString>;
            ask: Type.TOptional<Type.TString>;
            askFallback: Type.TOptional<Type.TString>;
            autoAllowSkills: Type.TOptional<Type.TBoolean>;
        }>>;
        agents: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
            security: Type.TOptional<Type.TString>;
            ask: Type.TOptional<Type.TString>;
            askFallback: Type.TOptional<Type.TString>;
            autoAllowSkills: Type.TOptional<Type.TBoolean>;
            allowlist: Type.TOptional<Type.TArray<Type.TObject<{
                id: Type.TOptional<Type.TString>;
                pattern: Type.TString;
                source: Type.TOptional<Type.TLiteral<"allow-always">>;
                commandText: Type.TOptional<Type.TString>;
                argPattern: Type.TOptional<Type.TString>;
                lastUsedAt: Type.TOptional<Type.TInteger>;
                lastUsedCommand: Type.TOptional<Type.TString>;
                lastResolvedPath: Type.TOptional<Type.TString>;
            }>>>;
        }>>>;
    }>;
}>;
export declare const ExecApprovalsGetParamsSchema: Type.TObject<{}>;
export declare const ExecApprovalsSetParamsSchema: Type.TObject<{
    file: Type.TObject<{
        version: Type.TLiteral<1>;
        socket: Type.TOptional<Type.TObject<{
            path: Type.TOptional<Type.TString>;
            token: Type.TOptional<Type.TString>;
        }>>;
        defaults: Type.TOptional<Type.TObject<{
            security: Type.TOptional<Type.TString>;
            ask: Type.TOptional<Type.TString>;
            askFallback: Type.TOptional<Type.TString>;
            autoAllowSkills: Type.TOptional<Type.TBoolean>;
        }>>;
        agents: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
            security: Type.TOptional<Type.TString>;
            ask: Type.TOptional<Type.TString>;
            askFallback: Type.TOptional<Type.TString>;
            autoAllowSkills: Type.TOptional<Type.TBoolean>;
            allowlist: Type.TOptional<Type.TArray<Type.TObject<{
                id: Type.TOptional<Type.TString>;
                pattern: Type.TString;
                source: Type.TOptional<Type.TLiteral<"allow-always">>;
                commandText: Type.TOptional<Type.TString>;
                argPattern: Type.TOptional<Type.TString>;
                lastUsedAt: Type.TOptional<Type.TInteger>;
                lastUsedCommand: Type.TOptional<Type.TString>;
                lastResolvedPath: Type.TOptional<Type.TString>;
            }>>>;
        }>>>;
    }>;
    baseHash: Type.TOptional<Type.TString>;
}>;
export declare const ExecApprovalsNodeGetParamsSchema: Type.TObject<{
    nodeId: Type.TString;
}>;
export declare const ExecApprovalsNodeSetParamsSchema: Type.TObject<{
    nodeId: Type.TString;
    file: Type.TObject<{
        version: Type.TLiteral<1>;
        socket: Type.TOptional<Type.TObject<{
            path: Type.TOptional<Type.TString>;
            token: Type.TOptional<Type.TString>;
        }>>;
        defaults: Type.TOptional<Type.TObject<{
            security: Type.TOptional<Type.TString>;
            ask: Type.TOptional<Type.TString>;
            askFallback: Type.TOptional<Type.TString>;
            autoAllowSkills: Type.TOptional<Type.TBoolean>;
        }>>;
        agents: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
            security: Type.TOptional<Type.TString>;
            ask: Type.TOptional<Type.TString>;
            askFallback: Type.TOptional<Type.TString>;
            autoAllowSkills: Type.TOptional<Type.TBoolean>;
            allowlist: Type.TOptional<Type.TArray<Type.TObject<{
                id: Type.TOptional<Type.TString>;
                pattern: Type.TString;
                source: Type.TOptional<Type.TLiteral<"allow-always">>;
                commandText: Type.TOptional<Type.TString>;
                argPattern: Type.TOptional<Type.TString>;
                lastUsedAt: Type.TOptional<Type.TInteger>;
                lastUsedCommand: Type.TOptional<Type.TString>;
                lastResolvedPath: Type.TOptional<Type.TString>;
            }>>>;
        }>>>;
    }>;
    baseHash: Type.TOptional<Type.TString>;
}>;
export declare const ExecApprovalGetParamsSchema: Type.TObject<{
    id: Type.TString;
}>;
export declare const ExecApprovalRequestParamsSchema: Type.TObject<{
    id: Type.TOptional<Type.TString>;
    command: Type.TOptional<Type.TString>;
    commandArgv: Type.TOptional<Type.TArray<Type.TString>>;
    systemRunPlan: Type.TOptional<Type.TObject<{
        argv: Type.TArray<Type.TString>;
        cwd: Type.TUnion<[Type.TString, Type.TNull]>;
        commandText: Type.TString;
        commandPreview: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
        agentId: Type.TUnion<[Type.TString, Type.TNull]>;
        sessionKey: Type.TUnion<[Type.TString, Type.TNull]>;
        mutableFileOperand: Type.TOptional<Type.TUnion<[Type.TObject<{
            argvIndex: Type.TInteger;
            path: Type.TString;
            sha256: Type.TString;
        }>, Type.TNull]>>;
    }>>;
    env: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    cwd: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    nodeId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    host: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    security: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    ask: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    warningText: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    agentId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    resolvedPath: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    sessionKey: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    turnSourceChannel: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    turnSourceTo: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    turnSourceAccountId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNull]>>;
    turnSourceThreadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber, Type.TNull]>>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    twoPhase: Type.TOptional<Type.TBoolean>;
}>;
export declare const ExecApprovalResolveParamsSchema: Type.TObject<{
    id: Type.TString;
    decision: Type.TString;
}>;
