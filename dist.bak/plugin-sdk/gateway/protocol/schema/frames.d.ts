export declare const TickEventSchema: import("@sinclair/typebox").TObject<{
    ts: import("@sinclair/typebox").TInteger;
}>;
export declare const ShutdownEventSchema: import("@sinclair/typebox").TObject<{
    reason: import("@sinclair/typebox").TString;
    restartExpectedMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const ConnectParamsSchema: import("@sinclair/typebox").TObject<{
    minProtocol: import("@sinclair/typebox").TInteger;
    maxProtocol: import("@sinclair/typebox").TInteger;
    client: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TUnion<import("@sinclair/typebox").TLiteral<"cli" | "test" | "webchat" | "webchat-ui" | "openclaw-control-ui" | "gateway-client" | "openclaw-macos" | "openclaw-ios" | "openclaw-android" | "node-host" | "fingerprint" | "openclaw-probe">[]>;
        displayName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        version: import("@sinclair/typebox").TString;
        platform: import("@sinclair/typebox").TString;
        deviceFamily: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        modelIdentifier: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        mode: import("@sinclair/typebox").TUnion<import("@sinclair/typebox").TLiteral<"node" | "cli" | "ui" | "test" | "webchat" | "backend" | "probe">[]>;
        instanceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    caps: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    commands: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    permissions: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TBoolean>>;
    pathEnv: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    role: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    scopes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    device: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        publicKey: import("@sinclair/typebox").TString;
        signature: import("@sinclair/typebox").TString;
        signedAt: import("@sinclair/typebox").TInteger;
        nonce: import("@sinclair/typebox").TString;
    }>>;
    auth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        deviceToken: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        password: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>>;
    locale: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    userAgent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const HelloOkSchema: import("@sinclair/typebox").TObject<{
    type: import("@sinclair/typebox").TLiteral<"hello-ok">;
    protocol: import("@sinclair/typebox").TInteger;
    server: import("@sinclair/typebox").TObject<{
        version: import("@sinclair/typebox").TString;
        connId: import("@sinclair/typebox").TString;
    }>;
    features: import("@sinclair/typebox").TObject<{
        methods: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        events: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    }>;
    snapshot: import("@sinclair/typebox").TObject<{
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
    canvasHostUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    auth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        deviceToken: import("@sinclair/typebox").TString;
        role: import("@sinclair/typebox").TString;
        scopes: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        issuedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>>;
    policy: import("@sinclair/typebox").TObject<{
        maxPayload: import("@sinclair/typebox").TInteger;
        maxBufferedBytes: import("@sinclair/typebox").TInteger;
        tickIntervalMs: import("@sinclair/typebox").TInteger;
    }>;
}>;
export declare const ErrorShapeSchema: import("@sinclair/typebox").TObject<{
    code: import("@sinclair/typebox").TString;
    message: import("@sinclair/typebox").TString;
    details: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    retryable: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    retryAfterMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const RequestFrameSchema: import("@sinclair/typebox").TObject<{
    type: import("@sinclair/typebox").TLiteral<"req">;
    id: import("@sinclair/typebox").TString;
    method: import("@sinclair/typebox").TString;
    params: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
}>;
export declare const ResponseFrameSchema: import("@sinclair/typebox").TObject<{
    type: import("@sinclair/typebox").TLiteral<"res">;
    id: import("@sinclair/typebox").TString;
    ok: import("@sinclair/typebox").TBoolean;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        code: import("@sinclair/typebox").TString;
        message: import("@sinclair/typebox").TString;
        details: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        retryable: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        retryAfterMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>>;
}>;
export declare const EventFrameSchema: import("@sinclair/typebox").TObject<{
    type: import("@sinclair/typebox").TLiteral<"event">;
    event: import("@sinclair/typebox").TString;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    seq: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    stateVersion: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        presence: import("@sinclair/typebox").TInteger;
        health: import("@sinclair/typebox").TInteger;
    }>>;
}>;
export declare const GatewayFrameSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    type: import("@sinclair/typebox").TLiteral<"req">;
    id: import("@sinclair/typebox").TString;
    method: import("@sinclair/typebox").TString;
    params: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
}>, import("@sinclair/typebox").TObject<{
    type: import("@sinclair/typebox").TLiteral<"res">;
    id: import("@sinclair/typebox").TString;
    ok: import("@sinclair/typebox").TBoolean;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        code: import("@sinclair/typebox").TString;
        message: import("@sinclair/typebox").TString;
        details: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        retryable: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        retryAfterMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>>;
}>, import("@sinclair/typebox").TObject<{
    type: import("@sinclair/typebox").TLiteral<"event">;
    event: import("@sinclair/typebox").TString;
    payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    seq: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    stateVersion: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        presence: import("@sinclair/typebox").TInteger;
        health: import("@sinclair/typebox").TInteger;
    }>>;
}>]>;
