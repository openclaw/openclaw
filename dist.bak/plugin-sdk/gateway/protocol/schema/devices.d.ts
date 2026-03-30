export declare const DevicePairListParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const DevicePairApproveParamsSchema: import("@sinclair/typebox").TObject<{
    requestId: import("@sinclair/typebox").TString;
}>;
export declare const DevicePairRejectParamsSchema: import("@sinclair/typebox").TObject<{
    requestId: import("@sinclair/typebox").TString;
}>;
export declare const DevicePairRemoveParamsSchema: import("@sinclair/typebox").TObject<{
    deviceId: import("@sinclair/typebox").TString;
}>;
export declare const DeviceTokenRotateParamsSchema: import("@sinclair/typebox").TObject<{
    deviceId: import("@sinclair/typebox").TString;
    role: import("@sinclair/typebox").TString;
    scopes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
}>;
export declare const DeviceTokenRevokeParamsSchema: import("@sinclair/typebox").TObject<{
    deviceId: import("@sinclair/typebox").TString;
    role: import("@sinclair/typebox").TString;
}>;
export declare const DevicePairRequestedEventSchema: import("@sinclair/typebox").TObject<{
    requestId: import("@sinclair/typebox").TString;
    deviceId: import("@sinclair/typebox").TString;
    publicKey: import("@sinclair/typebox").TString;
    displayName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    platform: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    deviceFamily: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    clientId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    clientMode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    role: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    roles: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    scopes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    remoteIp: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    silent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    isRepair: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    ts: import("@sinclair/typebox").TInteger;
}>;
export declare const DevicePairResolvedEventSchema: import("@sinclair/typebox").TObject<{
    requestId: import("@sinclair/typebox").TString;
    deviceId: import("@sinclair/typebox").TString;
    decision: import("@sinclair/typebox").TString;
    ts: import("@sinclair/typebox").TInteger;
}>;
