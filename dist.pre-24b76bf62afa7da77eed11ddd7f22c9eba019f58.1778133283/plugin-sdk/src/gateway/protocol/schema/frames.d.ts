import { Type } from "typebox";
export declare const TickEventSchema: Type.TObject<{
    ts: Type.TInteger;
}>;
export declare const ShutdownEventSchema: Type.TObject<{
    reason: Type.TString;
    restartExpectedMs: Type.TOptional<Type.TInteger>;
}>;
export declare const ConnectParamsSchema: Type.TObject<{
    minProtocol: Type.TInteger;
    maxProtocol: Type.TInteger;
    client: Type.TObject<{
        id: Type.TEnum<["openclaw-android", "cli", "openclaw-control-ui", "fingerprint", "gateway-client", "openclaw-ios", "openclaw-macos", "node-host", "openclaw-probe", "test", "openclaw-tui", "webchat", "webchat-ui"]>;
        displayName: Type.TOptional<Type.TString>;
        version: Type.TString;
        platform: Type.TString;
        deviceFamily: Type.TOptional<Type.TString>;
        modelIdentifier: Type.TOptional<Type.TString>;
        mode: Type.TEnum<["backend", "cli", "node", "probe", "test", "ui", "webchat"]>;
        instanceId: Type.TOptional<Type.TString>;
    }>;
    caps: Type.TOptional<Type.TArray<Type.TString>>;
    commands: Type.TOptional<Type.TArray<Type.TString>>;
    permissions: Type.TOptional<Type.TRecord<"^.*$", Type.TBoolean>>;
    pathEnv: Type.TOptional<Type.TString>;
    role: Type.TOptional<Type.TString>;
    scopes: Type.TOptional<Type.TArray<Type.TString>>;
    device: Type.TOptional<Type.TObject<{
        id: Type.TString;
        publicKey: Type.TString;
        signature: Type.TString;
        signedAt: Type.TInteger;
        nonce: Type.TString;
    }>>;
    auth: Type.TOptional<Type.TObject<{
        token: Type.TOptional<Type.TString>;
        bootstrapToken: Type.TOptional<Type.TString>;
        deviceToken: Type.TOptional<Type.TString>;
        password: Type.TOptional<Type.TString>;
    }>>;
    locale: Type.TOptional<Type.TString>;
    userAgent: Type.TOptional<Type.TString>;
}>;
export declare const HelloOkSchema: Type.TObject<{
    type: Type.TLiteral<"hello-ok">;
    protocol: Type.TInteger;
    server: Type.TObject<{
        version: Type.TString;
        connId: Type.TString;
    }>;
    features: Type.TObject<{
        methods: Type.TArray<Type.TString>;
        events: Type.TArray<Type.TString>;
    }>;
    snapshot: Type.TObject<{
        presence: Type.TArray<Type.TObject<{
            host: Type.TOptional<Type.TString>;
            ip: Type.TOptional<Type.TString>;
            version: Type.TOptional<Type.TString>;
            platform: Type.TOptional<Type.TString>;
            deviceFamily: Type.TOptional<Type.TString>;
            modelIdentifier: Type.TOptional<Type.TString>;
            mode: Type.TOptional<Type.TString>;
            lastInputSeconds: Type.TOptional<Type.TInteger>;
            reason: Type.TOptional<Type.TString>;
            tags: Type.TOptional<Type.TArray<Type.TString>>;
            text: Type.TOptional<Type.TString>;
            ts: Type.TInteger;
            deviceId: Type.TOptional<Type.TString>;
            roles: Type.TOptional<Type.TArray<Type.TString>>;
            scopes: Type.TOptional<Type.TArray<Type.TString>>;
            instanceId: Type.TOptional<Type.TString>;
        }>>;
        health: Type.TAny;
        stateVersion: Type.TObject<{
            presence: Type.TInteger;
            health: Type.TInteger;
        }>;
        uptimeMs: Type.TInteger;
        configPath: Type.TOptional<Type.TString>;
        stateDir: Type.TOptional<Type.TString>;
        sessionDefaults: Type.TOptional<Type.TObject<{
            defaultAgentId: Type.TString;
            mainKey: Type.TString;
            mainSessionKey: Type.TString;
            scope: Type.TOptional<Type.TString>;
        }>>;
        authMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"none">, Type.TLiteral<"token">, Type.TLiteral<"password">, Type.TLiteral<"trusted-proxy">]>>;
        updateAvailable: Type.TOptional<Type.TObject<{
            currentVersion: Type.TString;
            latestVersion: Type.TString;
            channel: Type.TString;
        }>>;
    }>;
    canvasHostUrl: Type.TOptional<Type.TString>;
    auth: Type.TObject<{
        deviceToken: Type.TOptional<Type.TString>;
        role: Type.TString;
        scopes: Type.TArray<Type.TString>;
        issuedAtMs: Type.TOptional<Type.TInteger>;
        deviceTokens: Type.TOptional<Type.TArray<Type.TObject<{
            deviceToken: Type.TString;
            role: Type.TString;
            scopes: Type.TArray<Type.TString>;
            issuedAtMs: Type.TInteger;
        }>>>;
    }>;
    policy: Type.TObject<{
        maxPayload: Type.TInteger;
        maxBufferedBytes: Type.TInteger;
        tickIntervalMs: Type.TInteger;
    }>;
}>;
export declare const ErrorShapeSchema: Type.TObject<{
    code: Type.TString;
    message: Type.TString;
    details: Type.TOptional<Type.TUnknown>;
    retryable: Type.TOptional<Type.TBoolean>;
    retryAfterMs: Type.TOptional<Type.TInteger>;
}>;
export declare const RequestFrameSchema: Type.TObject<{
    type: Type.TLiteral<"req">;
    id: Type.TString;
    method: Type.TString;
    params: Type.TOptional<Type.TUnknown>;
}>;
export declare const ResponseFrameSchema: Type.TObject<{
    type: Type.TLiteral<"res">;
    id: Type.TString;
    ok: Type.TBoolean;
    payload: Type.TOptional<Type.TUnknown>;
    error: Type.TOptional<Type.TObject<{
        code: Type.TString;
        message: Type.TString;
        details: Type.TOptional<Type.TUnknown>;
        retryable: Type.TOptional<Type.TBoolean>;
        retryAfterMs: Type.TOptional<Type.TInteger>;
    }>>;
}>;
export declare const EventFrameSchema: Type.TObject<{
    type: Type.TLiteral<"event">;
    event: Type.TString;
    payload: Type.TOptional<Type.TUnknown>;
    seq: Type.TOptional<Type.TInteger>;
    stateVersion: Type.TOptional<Type.TObject<{
        presence: Type.TInteger;
        health: Type.TInteger;
    }>>;
}>;
export declare const GatewayFrameSchema: Type.TUnion<[Type.TObject<{
    type: Type.TLiteral<"req">;
    id: Type.TString;
    method: Type.TString;
    params: Type.TOptional<Type.TUnknown>;
}>, Type.TObject<{
    type: Type.TLiteral<"res">;
    id: Type.TString;
    ok: Type.TBoolean;
    payload: Type.TOptional<Type.TUnknown>;
    error: Type.TOptional<Type.TObject<{
        code: Type.TString;
        message: Type.TString;
        details: Type.TOptional<Type.TUnknown>;
        retryable: Type.TOptional<Type.TBoolean>;
        retryAfterMs: Type.TOptional<Type.TInteger>;
    }>>;
}>, Type.TObject<{
    type: Type.TLiteral<"event">;
    event: Type.TString;
    payload: Type.TOptional<Type.TUnknown>;
    seq: Type.TOptional<Type.TInteger>;
    stateVersion: Type.TOptional<Type.TObject<{
        presence: Type.TInteger;
        health: Type.TInteger;
    }>>;
}>]>;
