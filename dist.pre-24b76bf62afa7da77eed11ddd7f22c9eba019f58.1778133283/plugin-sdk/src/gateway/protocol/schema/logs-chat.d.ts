import { Type } from "typebox";
export declare const LogsTailParamsSchema: Type.TObject<{
    cursor: Type.TOptional<Type.TInteger>;
    limit: Type.TOptional<Type.TInteger>;
    maxBytes: Type.TOptional<Type.TInteger>;
}>;
export declare const LogsTailResultSchema: Type.TObject<{
    file: Type.TString;
    cursor: Type.TInteger;
    size: Type.TInteger;
    lines: Type.TArray<Type.TString>;
    truncated: Type.TOptional<Type.TBoolean>;
    reset: Type.TOptional<Type.TBoolean>;
}>;
export declare const ChatHistoryParamsSchema: Type.TObject<{
    sessionKey: Type.TString;
    limit: Type.TOptional<Type.TInteger>;
    maxChars: Type.TOptional<Type.TInteger>;
}>;
export declare const ChatSendParamsSchema: Type.TObject<{
    sessionKey: Type.TString;
    sessionId: Type.TOptional<Type.TString>;
    message: Type.TString;
    thinking: Type.TOptional<Type.TString>;
    deliver: Type.TOptional<Type.TBoolean>;
    originatingChannel: Type.TOptional<Type.TString>;
    originatingTo: Type.TOptional<Type.TString>;
    originatingAccountId: Type.TOptional<Type.TString>;
    originatingThreadId: Type.TOptional<Type.TString>;
    attachments: Type.TOptional<Type.TArray<Type.TUnknown>>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    systemInputProvenance: Type.TOptional<Type.TObject<{
        kind: Type.TString;
        originSessionId: Type.TOptional<Type.TString>;
        sourceSessionKey: Type.TOptional<Type.TString>;
        sourceChannel: Type.TOptional<Type.TString>;
        sourceTool: Type.TOptional<Type.TString>;
    }>>;
    systemProvenanceReceipt: Type.TOptional<Type.TString>;
    idempotencyKey: Type.TString;
}>;
export declare const ChatAbortParamsSchema: Type.TObject<{
    sessionKey: Type.TString;
    runId: Type.TOptional<Type.TString>;
}>;
export declare const ChatInjectParamsSchema: Type.TObject<{
    sessionKey: Type.TString;
    message: Type.TString;
    label: Type.TOptional<Type.TString>;
}>;
export declare const ChatEventSchema: Type.TObject<{
    runId: Type.TString;
    sessionKey: Type.TString;
    spawnedBy: Type.TOptional<Type.TString>;
    seq: Type.TInteger;
    state: Type.TUnion<[Type.TLiteral<"delta">, Type.TLiteral<"final">, Type.TLiteral<"aborted">, Type.TLiteral<"error">]>;
    message: Type.TOptional<Type.TUnknown>;
    errorMessage: Type.TOptional<Type.TString>;
    errorKind: Type.TOptional<Type.TUnion<[Type.TLiteral<"refusal">, Type.TLiteral<"timeout">, Type.TLiteral<"rate_limit">, Type.TLiteral<"context_length">, Type.TLiteral<"unknown">]>>;
    usage: Type.TOptional<Type.TUnknown>;
    stopReason: Type.TOptional<Type.TString>;
}>;
