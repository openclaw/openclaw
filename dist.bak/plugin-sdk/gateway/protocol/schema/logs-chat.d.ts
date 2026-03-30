export declare const LogsTailParamsSchema: import("@sinclair/typebox").TObject<{
    cursor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    maxBytes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const LogsTailResultSchema: import("@sinclair/typebox").TObject<{
    file: import("@sinclair/typebox").TString;
    cursor: import("@sinclair/typebox").TInteger;
    size: import("@sinclair/typebox").TInteger;
    lines: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    truncated: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    reset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const ChatHistoryParamsSchema: import("@sinclair/typebox").TObject<{
    sessionKey: import("@sinclair/typebox").TString;
    limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const ChatSendParamsSchema: import("@sinclair/typebox").TObject<{
    sessionKey: import("@sinclair/typebox").TString;
    message: import("@sinclair/typebox").TString;
    thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    attachments: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnknown>>;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    idempotencyKey: import("@sinclair/typebox").TString;
}>;
export declare const ChatAbortParamsSchema: import("@sinclair/typebox").TObject<{
    sessionKey: import("@sinclair/typebox").TString;
    runId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const ChatInjectParamsSchema: import("@sinclair/typebox").TObject<{
    sessionKey: import("@sinclair/typebox").TString;
    message: import("@sinclair/typebox").TString;
    label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const ChatEventSchema: import("@sinclair/typebox").TObject<{
    runId: import("@sinclair/typebox").TString;
    sessionKey: import("@sinclair/typebox").TString;
    seq: import("@sinclair/typebox").TInteger;
    state: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delta">, import("@sinclair/typebox").TLiteral<"final">, import("@sinclair/typebox").TLiteral<"aborted">, import("@sinclair/typebox").TLiteral<"error">]>;
    message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    errorMessage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    usage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    stopReason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
