export declare const PushTestParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    body: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    environment: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const PushTestResultSchema: import("@sinclair/typebox").TObject<{
    ok: import("@sinclair/typebox").TBoolean;
    status: import("@sinclair/typebox").TInteger;
    apnsId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    tokenSuffix: import("@sinclair/typebox").TString;
    topic: import("@sinclair/typebox").TString;
    environment: import("@sinclair/typebox").TString;
}>;
