export declare const PresenceEntrySchema: import("@sinclair/typebox").TObject<{
    host: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    ip: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    version: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    platform: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    deviceFamily: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    modelIdentifier: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    lastInputSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    ts: import("@sinclair/typebox").TInteger;
    deviceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    roles: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    scopes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    instanceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const HealthSnapshotSchema: import("@sinclair/typebox").TAny;
export declare const SessionDefaultsSchema: import("@sinclair/typebox").TObject<{
    defaultAgentId: import("@sinclair/typebox").TString;
    mainKey: import("@sinclair/typebox").TString;
    mainSessionKey: import("@sinclair/typebox").TString;
    scope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const StateVersionSchema: import("@sinclair/typebox").TObject<{
    presence: import("@sinclair/typebox").TInteger;
    health: import("@sinclair/typebox").TInteger;
}>;
export declare const SnapshotSchema: import("@sinclair/typebox").TObject<{
    presence: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        host: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        ip: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        version: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        platform: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        deviceFamily: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        modelIdentifier: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        lastInputSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        text: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        ts: import("@sinclair/typebox").TInteger;
        deviceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        roles: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        scopes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        instanceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    health: import("@sinclair/typebox").TAny;
    stateVersion: import("@sinclair/typebox").TObject<{
        presence: import("@sinclair/typebox").TInteger;
        health: import("@sinclair/typebox").TInteger;
    }>;
    uptimeMs: import("@sinclair/typebox").TInteger;
    configPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    stateDir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionDefaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        defaultAgentId: import("@sinclair/typebox").TString;
        mainKey: import("@sinclair/typebox").TString;
        mainSessionKey: import("@sinclair/typebox").TString;
        scope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    authMode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"none">, import("@sinclair/typebox").TLiteral<"token">, import("@sinclair/typebox").TLiteral<"password">, import("@sinclair/typebox").TLiteral<"trusted-proxy">]>>;
    updateAvailable: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        currentVersion: import("@sinclair/typebox").TString;
        latestVersion: import("@sinclair/typebox").TString;
        channel: import("@sinclair/typebox").TString;
    }>>;
}>;
