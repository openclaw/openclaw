import { Type } from "typebox";
export declare const NodePresenceAliveReasonSchema: Type.TString;
export declare const NodePresenceAlivePayloadSchema: Type.TObject<{
    trigger: Type.TString;
    sentAtMs: Type.TOptional<Type.TInteger>;
    displayName: Type.TOptional<Type.TString>;
    version: Type.TOptional<Type.TString>;
    platform: Type.TOptional<Type.TString>;
    deviceFamily: Type.TOptional<Type.TString>;
    modelIdentifier: Type.TOptional<Type.TString>;
    pushTransport: Type.TOptional<Type.TString>;
}>;
export declare const NodeEventResultSchema: Type.TObject<{
    ok: Type.TBoolean;
    event: Type.TString;
    handled: Type.TBoolean;
    reason: Type.TOptional<Type.TString>;
}>;
export declare const NodePairRequestParamsSchema: Type.TObject<{
    nodeId: Type.TString;
    displayName: Type.TOptional<Type.TString>;
    platform: Type.TOptional<Type.TString>;
    version: Type.TOptional<Type.TString>;
    coreVersion: Type.TOptional<Type.TString>;
    uiVersion: Type.TOptional<Type.TString>;
    deviceFamily: Type.TOptional<Type.TString>;
    modelIdentifier: Type.TOptional<Type.TString>;
    caps: Type.TOptional<Type.TArray<Type.TString>>;
    commands: Type.TOptional<Type.TArray<Type.TString>>;
    remoteIp: Type.TOptional<Type.TString>;
    silent: Type.TOptional<Type.TBoolean>;
}>;
export declare const NodePairListParamsSchema: Type.TObject<{}>;
export declare const NodePairApproveParamsSchema: Type.TObject<{
    requestId: Type.TString;
}>;
export declare const NodePairRejectParamsSchema: Type.TObject<{
    requestId: Type.TString;
}>;
export declare const NodePairRemoveParamsSchema: Type.TObject<{
    nodeId: Type.TString;
}>;
export declare const NodePairVerifyParamsSchema: Type.TObject<{
    nodeId: Type.TString;
    token: Type.TString;
}>;
export declare const NodeRenameParamsSchema: Type.TObject<{
    nodeId: Type.TString;
    displayName: Type.TString;
}>;
export declare const NodeListParamsSchema: Type.TObject<{}>;
export declare const NodePendingAckParamsSchema: Type.TObject<{
    ids: Type.TArray<Type.TString>;
}>;
export declare const NodeDescribeParamsSchema: Type.TObject<{
    nodeId: Type.TString;
}>;
export declare const NodeInvokeParamsSchema: Type.TObject<{
    nodeId: Type.TString;
    command: Type.TString;
    params: Type.TOptional<Type.TUnknown>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    idempotencyKey: Type.TString;
}>;
export declare const NodeInvokeResultParamsSchema: Type.TObject<{
    id: Type.TString;
    nodeId: Type.TString;
    ok: Type.TBoolean;
    payload: Type.TOptional<Type.TUnknown>;
    payloadJSON: Type.TOptional<Type.TString>;
    error: Type.TOptional<Type.TObject<{
        code: Type.TOptional<Type.TString>;
        message: Type.TOptional<Type.TString>;
    }>>;
}>;
export declare const NodeEventParamsSchema: Type.TObject<{
    event: Type.TString;
    payload: Type.TOptional<Type.TUnknown>;
    payloadJSON: Type.TOptional<Type.TString>;
}>;
export declare const NodePendingDrainParamsSchema: Type.TObject<{
    maxItems: Type.TOptional<Type.TInteger>;
}>;
export declare const NodePendingDrainItemSchema: Type.TObject<{
    id: Type.TString;
    type: Type.TString;
    priority: Type.TString;
    createdAtMs: Type.TInteger;
    expiresAtMs: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
    payload: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
}>;
export declare const NodePendingDrainResultSchema: Type.TObject<{
    nodeId: Type.TString;
    revision: Type.TInteger;
    items: Type.TArray<Type.TObject<{
        id: Type.TString;
        type: Type.TString;
        priority: Type.TString;
        createdAtMs: Type.TInteger;
        expiresAtMs: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
        payload: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    }>>;
    hasMore: Type.TBoolean;
}>;
export declare const NodePendingEnqueueParamsSchema: Type.TObject<{
    nodeId: Type.TString;
    type: Type.TString;
    priority: Type.TOptional<Type.TString>;
    expiresInMs: Type.TOptional<Type.TInteger>;
    wake: Type.TOptional<Type.TBoolean>;
}>;
export declare const NodePendingEnqueueResultSchema: Type.TObject<{
    nodeId: Type.TString;
    revision: Type.TInteger;
    queued: Type.TObject<{
        id: Type.TString;
        type: Type.TString;
        priority: Type.TString;
        createdAtMs: Type.TInteger;
        expiresAtMs: Type.TOptional<Type.TUnion<[Type.TInteger, Type.TNull]>>;
        payload: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    }>;
    wakeTriggered: Type.TBoolean;
}>;
export declare const NodeInvokeRequestEventSchema: Type.TObject<{
    id: Type.TString;
    nodeId: Type.TString;
    command: Type.TString;
    paramsJSON: Type.TOptional<Type.TString>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    idempotencyKey: Type.TOptional<Type.TString>;
}>;
