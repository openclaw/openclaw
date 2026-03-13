export declare const NodePairRequestParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    displayName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    platform: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    version: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    coreVersion: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    uiVersion: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    deviceFamily: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    modelIdentifier: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    caps: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    commands: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    remoteIp: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    silent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const NodePairListParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const NodePairApproveParamsSchema: import("@sinclair/typebox").TObject<{
    requestId: import("@sinclair/typebox").TString;
}>;
export declare const NodePairRejectParamsSchema: import("@sinclair/typebox").TObject<{
    requestId: import("@sinclair/typebox").TString;
}>;
export declare const NodePairVerifyParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    token: import("@sinclair/typebox").TString;
}>;
export declare const NodeRenameParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    displayName: import("@sinclair/typebox").TString;
}>;
export declare const NodeListParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const NodePendingAckParamsSchema: import("@sinclair/typebox").TObject<{
    ids: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
}>;
export declare const NodeDescribeParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
}>;
export declare const NodeInvokeParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    command: import("@sinclair/typebox").TString;
    params: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    idempotencyKey: import("@sinclair/typebox").TString;
}>;
export declare const NodeInvokeResultParamsSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    nodeId: import("@sinclair/typebox").TString;
    ok: import("@sinclair/typebox").TBoolean;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    payloadJSON: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        code: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
}>;
export declare const NodeEventParamsSchema: import("@sinclair/typebox").TObject<{
    event: import("@sinclair/typebox").TString;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    payloadJSON: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const NodePendingDrainParamsSchema: import("@sinclair/typebox").TObject<{
    maxItems: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const NodePendingDrainItemSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    type: import("@sinclair/typebox").TString;
    priority: import("@sinclair/typebox").TString;
    createdAtMs: import("@sinclair/typebox").TInteger;
    expiresAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>>;
}>;
export declare const NodePendingDrainResultSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    revision: import("@sinclair/typebox").TInteger;
    items: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TString;
        priority: import("@sinclair/typebox").TString;
        createdAtMs: import("@sinclair/typebox").TInteger;
        expiresAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
        payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>>;
    }>>;
    hasMore: import("@sinclair/typebox").TBoolean;
}>;
export declare const NodePendingEnqueueParamsSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    type: import("@sinclair/typebox").TString;
    priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    expiresInMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    wake: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export declare const NodePendingEnqueueResultSchema: import("@sinclair/typebox").TObject<{
    nodeId: import("@sinclair/typebox").TString;
    revision: import("@sinclair/typebox").TInteger;
    queued: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TString;
        priority: import("@sinclair/typebox").TString;
        createdAtMs: import("@sinclair/typebox").TInteger;
        expiresAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
        payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>>;
    }>;
    wakeTriggered: import("@sinclair/typebox").TBoolean;
}>;
export declare const NodeInvokeRequestEventSchema: import("@sinclair/typebox").TObject<{
    id: import("@sinclair/typebox").TString;
    nodeId: import("@sinclair/typebox").TString;
    command: import("@sinclair/typebox").TString;
    paramsJSON: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    idempotencyKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
