import type { TSchema } from "@sinclair/typebox";
export declare const ProtocolSchemas: {
    ConnectParams: import("@sinclair/typebox").TObject<{
        minProtocol: import("@sinclair/typebox").TInteger;
        maxProtocol: import("@sinclair/typebox").TInteger;
        client: import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TUnion<import("@sinclair/typebox").TLiteral<"cli" | "webchat" | "webchat-ui" | "openclaw-control-ui" | "gateway-client" | "openclaw-macos" | "openclaw-ios" | "openclaw-android" | "node-host" | "test" | "fingerprint" | "openclaw-probe">[]>;
            displayName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            version: import("@sinclair/typebox").TString;
            platform: import("@sinclair/typebox").TString;
            deviceFamily: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            modelIdentifier: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            mode: import("@sinclair/typebox").TUnion<import("@sinclair/typebox").TLiteral<"node" | "cli" | "ui" | "webchat" | "test" | "backend" | "probe">[]>;
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
            bootstrapToken: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            deviceToken: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            password: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
        locale: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        userAgent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    HelloOk: import("@sinclair/typebox").TObject<{
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
    RequestFrame: import("@sinclair/typebox").TObject<{
        type: import("@sinclair/typebox").TLiteral<"req">;
        id: import("@sinclair/typebox").TString;
        method: import("@sinclair/typebox").TString;
        params: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    }>;
    ResponseFrame: import("@sinclair/typebox").TObject<{
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
    EventFrame: import("@sinclair/typebox").TObject<{
        type: import("@sinclair/typebox").TLiteral<"event">;
        event: import("@sinclair/typebox").TString;
        payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        seq: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        stateVersion: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            presence: import("@sinclair/typebox").TInteger;
            health: import("@sinclair/typebox").TInteger;
        }>>;
    }>;
    GatewayFrame: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
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
    PresenceEntry: import("@sinclair/typebox").TObject<{
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
    StateVersion: import("@sinclair/typebox").TObject<{
        presence: import("@sinclair/typebox").TInteger;
        health: import("@sinclair/typebox").TInteger;
    }>;
    Snapshot: import("@sinclair/typebox").TObject<{
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
    ErrorShape: import("@sinclair/typebox").TObject<{
        code: import("@sinclair/typebox").TString;
        message: import("@sinclair/typebox").TString;
        details: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        retryable: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        retryAfterMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    AgentEvent: import("@sinclair/typebox").TObject<{
        runId: import("@sinclair/typebox").TString;
        seq: import("@sinclair/typebox").TInteger;
        stream: import("@sinclair/typebox").TString;
        ts: import("@sinclair/typebox").TInteger;
        data: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>;
    }>;
    SendParams: import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TString;
        message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        mediaUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        mediaUrls: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        gifPlayback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        threadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        idempotencyKey: import("@sinclair/typebox").TString;
    }>;
    PollParams: import("@sinclair/typebox").TObject<{
        to: import("@sinclair/typebox").TString;
        question: import("@sinclair/typebox").TString;
        options: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        maxSelections: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        durationSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        durationHours: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        silent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        isAnonymous: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        threadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        idempotencyKey: import("@sinclair/typebox").TString;
    }>;
    AgentParams: import("@sinclair/typebox").TObject<{
        message: import("@sinclair/typebox").TString;
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        replyTo: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        attachments: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnknown>>;
        channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        replyChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        replyAccountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        threadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        groupId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        groupChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        groupSpace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        timeout: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        lane: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        extraSystemPrompt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        internalEvents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            type: import("@sinclair/typebox").TLiteral<"task_completion">;
            source: import("@sinclair/typebox").TString;
            childSessionKey: import("@sinclair/typebox").TString;
            childSessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            announceType: import("@sinclair/typebox").TString;
            taskLabel: import("@sinclair/typebox").TString;
            status: import("@sinclair/typebox").TString;
            statusLabel: import("@sinclair/typebox").TString;
            result: import("@sinclair/typebox").TString;
            statsLine: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            replyInstruction: import("@sinclair/typebox").TString;
        }>>>;
        inputProvenance: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TString;
            originSessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sourceSessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sourceChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sourceTool: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
        idempotencyKey: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    AgentIdentityParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    AgentIdentityResult: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    AgentWaitParams: import("@sinclair/typebox").TObject<{
        runId: import("@sinclair/typebox").TString;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    WakeParams: import("@sinclair/typebox").TObject<{
        mode: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"now">, import("@sinclair/typebox").TLiteral<"next-heartbeat">]>;
        text: import("@sinclair/typebox").TString;
    }>;
    NodePairRequestParams: import("@sinclair/typebox").TObject<{
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
    NodePairListParams: import("@sinclair/typebox").TObject<{}>;
    NodePairApproveParams: import("@sinclair/typebox").TObject<{
        requestId: import("@sinclair/typebox").TString;
    }>;
    NodePairRejectParams: import("@sinclair/typebox").TObject<{
        requestId: import("@sinclair/typebox").TString;
    }>;
    NodePairVerifyParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
        token: import("@sinclair/typebox").TString;
    }>;
    NodeRenameParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
        displayName: import("@sinclair/typebox").TString;
    }>;
    NodeListParams: import("@sinclair/typebox").TObject<{}>;
    NodePendingAckParams: import("@sinclair/typebox").TObject<{
        ids: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    }>;
    NodeDescribeParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
    }>;
    NodeInvokeParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
        command: import("@sinclair/typebox").TString;
        params: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        idempotencyKey: import("@sinclair/typebox").TString;
    }>;
    NodeInvokeResultParams: import("@sinclair/typebox").TObject<{
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
    NodeEventParams: import("@sinclair/typebox").TObject<{
        event: import("@sinclair/typebox").TString;
        payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        payloadJSON: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    NodePendingDrainParams: import("@sinclair/typebox").TObject<{
        maxItems: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    NodePendingDrainResult: import("@sinclair/typebox").TObject<{
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
    NodePendingEnqueueParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TString;
        priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        expiresInMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        wake: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    NodePendingEnqueueResult: import("@sinclair/typebox").TObject<{
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
    NodeInvokeRequestEvent: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        nodeId: import("@sinclair/typebox").TString;
        command: import("@sinclair/typebox").TString;
        paramsJSON: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        idempotencyKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    PushTestParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
        title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        body: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        environment: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    PushTestResult: import("@sinclair/typebox").TObject<{
        ok: import("@sinclair/typebox").TBoolean;
        status: import("@sinclair/typebox").TInteger;
        apnsId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        tokenSuffix: import("@sinclair/typebox").TString;
        topic: import("@sinclair/typebox").TString;
        environment: import("@sinclair/typebox").TString;
        transport: import("@sinclair/typebox").TString;
    }>;
    SecretsReloadParams: import("@sinclair/typebox").TObject<{}>;
    SecretsResolveParams: import("@sinclair/typebox").TObject<{
        commandName: import("@sinclair/typebox").TString;
        targetIds: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    }>;
    SecretsResolveAssignment: import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        pathSegments: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        value: import("@sinclair/typebox").TUnknown;
    }>;
    SecretsResolveResult: import("@sinclair/typebox").TObject<{
        ok: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        assignments: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            pathSegments: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
            value: import("@sinclair/typebox").TUnknown;
        }>>>;
        diagnostics: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        inactiveRefPaths: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    }>;
    SessionsListParams: import("@sinclair/typebox").TObject<{
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        activeMinutes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        includeGlobal: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        includeUnknown: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        includeDerivedTitles: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        includeLastMessage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        spawnedBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        search: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    SessionsPreviewParams: import("@sinclair/typebox").TObject<{
        keys: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        maxChars: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    SessionsResolveParams: import("@sinclair/typebox").TObject<{
        key: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        spawnedBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        includeGlobal: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        includeUnknown: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    SessionsPatchParams: import("@sinclair/typebox").TObject<{
        key: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        thinkingLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        fastMode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TBoolean, import("@sinclair/typebox").TNull]>>;
        verboseLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        reasoningLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        responseUsage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"off">, import("@sinclair/typebox").TLiteral<"tokens">, import("@sinclair/typebox").TLiteral<"full">, import("@sinclair/typebox").TLiteral<"on">, import("@sinclair/typebox").TNull]>>;
        elevatedLevel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        execHost: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        execSecurity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        execAsk: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        execNode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        spawnedBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        spawnedWorkspaceDir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        spawnDepth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
        subagentRole: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"orchestrator">, import("@sinclair/typebox").TLiteral<"leaf">, import("@sinclair/typebox").TNull]>>;
        subagentControlScope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"children">, import("@sinclair/typebox").TLiteral<"none">, import("@sinclair/typebox").TNull]>>;
        sendPolicy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"allow">, import("@sinclair/typebox").TLiteral<"deny">, import("@sinclair/typebox").TNull]>>;
        groupActivation: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"mention">, import("@sinclair/typebox").TLiteral<"always">, import("@sinclair/typebox").TNull]>>;
    }>;
    SessionsResetParams: import("@sinclair/typebox").TObject<{
        key: import("@sinclair/typebox").TString;
        reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"new">, import("@sinclair/typebox").TLiteral<"reset">]>>;
    }>;
    SessionsDeleteParams: import("@sinclair/typebox").TObject<{
        key: import("@sinclair/typebox").TString;
        deleteTranscript: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        emitLifecycleHooks: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    SessionsCompactParams: import("@sinclair/typebox").TObject<{
        key: import("@sinclair/typebox").TString;
        maxLines: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    SessionsUsageParams: import("@sinclair/typebox").TObject<{
        key: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        startDate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        endDate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"utc">, import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"specific">]>>;
        utcOffset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        includeContextWeight: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    ConfigGetParams: import("@sinclair/typebox").TObject<{}>;
    ConfigSetParams: import("@sinclair/typebox").TObject<{
        raw: import("@sinclair/typebox").TString;
        baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    ConfigApplyParams: import("@sinclair/typebox").TObject<{
        raw: import("@sinclair/typebox").TString;
        baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        restartDelayMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    ConfigPatchParams: import("@sinclair/typebox").TObject<{
        raw: import("@sinclair/typebox").TString;
        baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        restartDelayMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    ConfigSchemaParams: import("@sinclair/typebox").TObject<{}>;
    ConfigSchemaLookupParams: import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
    }>;
    ConfigSchemaResponse: import("@sinclair/typebox").TObject<{
        schema: import("@sinclair/typebox").TUnknown;
        uiHints: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
            label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            help: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            group: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            order: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            advanced: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            itemTemplate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        }>>;
        version: import("@sinclair/typebox").TString;
        generatedAt: import("@sinclair/typebox").TString;
    }>;
    ConfigSchemaLookupResult: import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        schema: import("@sinclair/typebox").TUnknown;
        hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            help: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            group: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            order: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            advanced: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            itemTemplate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        }>>;
        hintPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        children: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            key: import("@sinclair/typebox").TString;
            path: import("@sinclair/typebox").TString;
            type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>]>>;
            required: import("@sinclair/typebox").TBoolean;
            hasChildren: import("@sinclair/typebox").TBoolean;
            hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                help: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
                group: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                order: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
                advanced: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
                sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
                placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                itemTemplate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
            }>>;
            hintPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
    }>;
    WizardStartParams: import("@sinclair/typebox").TObject<{
        mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"local">, import("@sinclair/typebox").TLiteral<"remote">]>>;
        workspace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    WizardNextParams: import("@sinclair/typebox").TObject<{
        sessionId: import("@sinclair/typebox").TString;
        answer: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            stepId: import("@sinclair/typebox").TString;
            value: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        }>>;
    }>;
    WizardCancelParams: import("@sinclair/typebox").TObject<{
        sessionId: import("@sinclair/typebox").TString;
    }>;
    WizardStatusParams: import("@sinclair/typebox").TObject<{
        sessionId: import("@sinclair/typebox").TString;
    }>;
    WizardStep: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"note">, import("@sinclair/typebox").TLiteral<"select">, import("@sinclair/typebox").TLiteral<"text">, import("@sinclair/typebox").TLiteral<"confirm">, import("@sinclair/typebox").TLiteral<"multiselect">, import("@sinclair/typebox").TLiteral<"progress">, import("@sinclair/typebox").TLiteral<"action">]>;
        title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        options: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            value: import("@sinclair/typebox").TUnknown;
            label: import("@sinclair/typebox").TString;
            hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>>;
        initialValue: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        executor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"client">]>>;
    }>;
    WizardNextResult: import("@sinclair/typebox").TObject<{
        done: import("@sinclair/typebox").TBoolean;
        step: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"note">, import("@sinclair/typebox").TLiteral<"select">, import("@sinclair/typebox").TLiteral<"text">, import("@sinclair/typebox").TLiteral<"confirm">, import("@sinclair/typebox").TLiteral<"multiselect">, import("@sinclair/typebox").TLiteral<"progress">, import("@sinclair/typebox").TLiteral<"action">]>;
            title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            options: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                value: import("@sinclair/typebox").TUnknown;
                label: import("@sinclair/typebox").TString;
                hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>>;
            initialValue: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
            placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            executor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"client">]>>;
        }>>;
        status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"done">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"error">]>>;
        error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    WizardStartResult: import("@sinclair/typebox").TObject<{
        done: import("@sinclair/typebox").TBoolean;
        step: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            type: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"note">, import("@sinclair/typebox").TLiteral<"select">, import("@sinclair/typebox").TLiteral<"text">, import("@sinclair/typebox").TLiteral<"confirm">, import("@sinclair/typebox").TLiteral<"multiselect">, import("@sinclair/typebox").TLiteral<"progress">, import("@sinclair/typebox").TLiteral<"action">]>;
            title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            options: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                value: import("@sinclair/typebox").TUnknown;
                label: import("@sinclair/typebox").TString;
                hint: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>>;
            initialValue: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
            placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            executor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"gateway">, import("@sinclair/typebox").TLiteral<"client">]>>;
        }>>;
        status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"done">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"error">]>>;
        error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionId: import("@sinclair/typebox").TString;
    }>;
    WizardStatusResult: import("@sinclair/typebox").TObject<{
        status: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"running">, import("@sinclair/typebox").TLiteral<"done">, import("@sinclair/typebox").TLiteral<"cancelled">, import("@sinclair/typebox").TLiteral<"error">]>;
        error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    TalkModeParams: import("@sinclair/typebox").TObject<{
        enabled: import("@sinclair/typebox").TBoolean;
        phase: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    TalkConfigParams: import("@sinclair/typebox").TObject<{
        includeSecrets: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    TalkConfigResult: import("@sinclair/typebox").TObject<{
        config: import("@sinclair/typebox").TObject<{
            talk: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
                voiceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                voiceAliases: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
                modelId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                outputFormat: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
                    source: import("@sinclair/typebox").TLiteral<"env">;
                    provider: import("@sinclair/typebox").TString;
                    id: import("@sinclair/typebox").TString;
                }>, import("@sinclair/typebox").TObject<{
                    source: import("@sinclair/typebox").TLiteral<"file">;
                    provider: import("@sinclair/typebox").TString;
                    id: import("@sinclair/typebox").TString;
                }>, import("@sinclair/typebox").TObject<{
                    source: import("@sinclair/typebox").TLiteral<"exec">;
                    provider: import("@sinclair/typebox").TString;
                    id: import("@sinclair/typebox").TString;
                }>]>]>>;
                interruptOnSpeech: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
                silenceTimeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            }>, import("@sinclair/typebox").TObject<{
                provider: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                providers: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
                    voiceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    voiceAliases: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
                    modelId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    outputFormat: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
                        source: import("@sinclair/typebox").TLiteral<"env">;
                        provider: import("@sinclair/typebox").TString;
                        id: import("@sinclair/typebox").TString;
                    }>, import("@sinclair/typebox").TObject<{
                        source: import("@sinclair/typebox").TLiteral<"file">;
                        provider: import("@sinclair/typebox").TString;
                        id: import("@sinclair/typebox").TString;
                    }>, import("@sinclair/typebox").TObject<{
                        source: import("@sinclair/typebox").TLiteral<"exec">;
                        provider: import("@sinclair/typebox").TString;
                        id: import("@sinclair/typebox").TString;
                    }>]>]>>;
                }>>>;
                resolved: import("@sinclair/typebox").TObject<{
                    provider: import("@sinclair/typebox").TString;
                    config: import("@sinclair/typebox").TObject<{
                        voiceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                        voiceAliases: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
                        modelId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                        outputFormat: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                        apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
                            source: import("@sinclair/typebox").TLiteral<"env">;
                            provider: import("@sinclair/typebox").TString;
                            id: import("@sinclair/typebox").TString;
                        }>, import("@sinclair/typebox").TObject<{
                            source: import("@sinclair/typebox").TLiteral<"file">;
                            provider: import("@sinclair/typebox").TString;
                            id: import("@sinclair/typebox").TString;
                        }>, import("@sinclair/typebox").TObject<{
                            source: import("@sinclair/typebox").TLiteral<"exec">;
                            provider: import("@sinclair/typebox").TString;
                            id: import("@sinclair/typebox").TString;
                        }>]>]>>;
                    }>;
                }>;
                voiceId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                voiceAliases: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
                modelId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                outputFormat: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
                    source: import("@sinclair/typebox").TLiteral<"env">;
                    provider: import("@sinclair/typebox").TString;
                    id: import("@sinclair/typebox").TString;
                }>, import("@sinclair/typebox").TObject<{
                    source: import("@sinclair/typebox").TLiteral<"file">;
                    provider: import("@sinclair/typebox").TString;
                    id: import("@sinclair/typebox").TString;
                }>, import("@sinclair/typebox").TObject<{
                    source: import("@sinclair/typebox").TLiteral<"exec">;
                    provider: import("@sinclair/typebox").TString;
                    id: import("@sinclair/typebox").TString;
                }>]>]>>;
                interruptOnSpeech: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
                silenceTimeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            }>]>>;
            session: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                mainKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>;
            ui: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                seamColor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>;
        }>;
    }>;
    ChannelsStatusParams: import("@sinclair/typebox").TObject<{
        probe: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    ChannelsStatusResult: import("@sinclair/typebox").TObject<{
        ts: import("@sinclair/typebox").TInteger;
        channelOrder: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        channelLabels: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>;
        channelDetailLabels: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
        channelSystemImages: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
        channelMeta: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            label: import("@sinclair/typebox").TString;
            detailLabel: import("@sinclair/typebox").TString;
            systemImage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>>;
        channels: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>;
        channelAccounts: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            accountId: import("@sinclair/typebox").TString;
            name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            configured: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            linked: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            running: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            connected: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            reconnectAttempts: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastConnectedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            lastStartAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastStopAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastInboundAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastOutboundAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            busy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            activeRuns: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastRunActivityAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastProbeAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            dmPolicy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            allowFrom: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            tokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            botTokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            appTokenSource: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            baseUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            allowUnmentionedGroups: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            cliPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            dbPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            port: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TInteger, import("@sinclair/typebox").TNull]>>;
            probe: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
            audit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
            application: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        }>>>;
        channelDefaultAccountId: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>;
    }>;
    ChannelsLogoutParams: import("@sinclair/typebox").TObject<{
        channel: import("@sinclair/typebox").TString;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    WebLoginStartParams: import("@sinclair/typebox").TObject<{
        force: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        verbose: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    WebLoginWaitParams: import("@sinclair/typebox").TObject<{
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    AgentSummary: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        identity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            theme: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            avatarUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
    }>;
    AgentsCreateParams: import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        workspace: import("@sinclair/typebox").TString;
        emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    AgentsCreateResult: import("@sinclair/typebox").TObject<{
        ok: import("@sinclair/typebox").TLiteral<true>;
        agentId: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TString;
        workspace: import("@sinclair/typebox").TString;
    }>;
    AgentsUpdateParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        workspace: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    AgentsUpdateResult: import("@sinclair/typebox").TObject<{
        ok: import("@sinclair/typebox").TLiteral<true>;
        agentId: import("@sinclair/typebox").TString;
    }>;
    AgentsDeleteParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        deleteFiles: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    AgentsDeleteResult: import("@sinclair/typebox").TObject<{
        ok: import("@sinclair/typebox").TLiteral<true>;
        agentId: import("@sinclair/typebox").TString;
        removedBindings: import("@sinclair/typebox").TInteger;
    }>;
    AgentsFileEntry: import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        path: import("@sinclair/typebox").TString;
        missing: import("@sinclair/typebox").TBoolean;
        size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    AgentsFilesListParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
    }>;
    AgentsFilesListResult: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        workspace: import("@sinclair/typebox").TString;
        files: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            name: import("@sinclair/typebox").TString;
            path: import("@sinclair/typebox").TString;
            missing: import("@sinclair/typebox").TBoolean;
            size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
    }>;
    AgentsFilesGetParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TString;
    }>;
    AgentsFilesGetResult: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        workspace: import("@sinclair/typebox").TString;
        file: import("@sinclair/typebox").TObject<{
            name: import("@sinclair/typebox").TString;
            path: import("@sinclair/typebox").TString;
            missing: import("@sinclair/typebox").TBoolean;
            size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>;
    }>;
    AgentsFilesSetParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TString;
        content: import("@sinclair/typebox").TString;
    }>;
    AgentsFilesSetResult: import("@sinclair/typebox").TObject<{
        ok: import("@sinclair/typebox").TLiteral<true>;
        agentId: import("@sinclair/typebox").TString;
        workspace: import("@sinclair/typebox").TString;
        file: import("@sinclair/typebox").TObject<{
            name: import("@sinclair/typebox").TString;
            path: import("@sinclair/typebox").TString;
            missing: import("@sinclair/typebox").TBoolean;
            size: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            updatedAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>;
    }>;
    AgentsListParams: import("@sinclair/typebox").TObject<{}>;
    AgentsListResult: import("@sinclair/typebox").TObject<{
        defaultId: import("@sinclair/typebox").TString;
        mainKey: import("@sinclair/typebox").TString;
        scope: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"per-sender">, import("@sinclair/typebox").TLiteral<"global">]>;
        agents: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            identity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                theme: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                emoji: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                avatar: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                avatarUrl: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>;
        }>>;
    }>;
    ModelChoice: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        name: import("@sinclair/typebox").TString;
        provider: import("@sinclair/typebox").TString;
        contextWindow: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        reasoning: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    ModelsListParams: import("@sinclair/typebox").TObject<{}>;
    ModelsListResult: import("@sinclair/typebox").TObject<{
        models: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            name: import("@sinclair/typebox").TString;
            provider: import("@sinclair/typebox").TString;
            contextWindow: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            reasoning: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>>;
    }>;
    SkillsStatusParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    ToolsCatalogParams: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        includePlugins: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    ToolCatalogProfile: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>;
        label: import("@sinclair/typebox").TString;
    }>;
    ToolCatalogEntry: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TString;
        description: import("@sinclair/typebox").TString;
        source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
        pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        optional: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        defaultProfiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>>;
    }>;
    ToolCatalogGroup: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TString;
        source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
        pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        tools: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            label: import("@sinclair/typebox").TString;
            description: import("@sinclair/typebox").TString;
            source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
            pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            optional: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            defaultProfiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>>;
        }>>;
    }>;
    ToolsCatalogResult: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        profiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>;
            label: import("@sinclair/typebox").TString;
        }>>;
        groups: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
            id: import("@sinclair/typebox").TString;
            label: import("@sinclair/typebox").TString;
            source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
            pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            tools: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                id: import("@sinclair/typebox").TString;
                label: import("@sinclair/typebox").TString;
                description: import("@sinclair/typebox").TString;
                source: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"core">, import("@sinclair/typebox").TLiteral<"plugin">]>;
                pluginId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                optional: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
                defaultProfiles: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"minimal">, import("@sinclair/typebox").TLiteral<"coding">, import("@sinclair/typebox").TLiteral<"messaging">, import("@sinclair/typebox").TLiteral<"full">]>>;
            }>>;
        }>>;
    }>;
    SkillsBinsParams: import("@sinclair/typebox").TObject<{}>;
    SkillsBinsResult: import("@sinclair/typebox").TObject<{
        bins: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    }>;
    SkillsInstallParams: import("@sinclair/typebox").TObject<{
        name: import("@sinclair/typebox").TString;
        installId: import("@sinclair/typebox").TString;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    SkillsUpdateParams: import("@sinclair/typebox").TObject<{
        skillKey: import("@sinclair/typebox").TString;
        enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        apiKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        env: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
    }>;
    CronJob: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        name: import("@sinclair/typebox").TString;
        description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        enabled: import("@sinclair/typebox").TBoolean;
        deleteAfterRun: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        createdAtMs: import("@sinclair/typebox").TInteger;
        updatedAtMs: import("@sinclair/typebox").TInteger;
        schedule: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"at">;
            at: import("@sinclair/typebox").TString;
        }>, import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"every">;
            everyMs: import("@sinclair/typebox").TInteger;
            anchorMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        }>, import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"cron">;
            expr: import("@sinclair/typebox").TString;
            tz: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            staggerMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        }>]>;
        sessionTarget: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"main">, import("@sinclair/typebox").TLiteral<"isolated">]>;
        wakeMode: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"next-heartbeat">, import("@sinclair/typebox").TLiteral<"now">]>;
        payload: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"systemEvent">;
            text: import("@sinclair/typebox").TString;
        }>, import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"agentTurn">;
            message: TSchema;
            model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            fallbacks: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            timeoutSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            allowUnsafeExternalContent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            lightContext: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>]>;
        delivery: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            failureDestination: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
                to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("@sinclair/typebox").TLiteral<"none">;
        }>, import("@sinclair/typebox").TObject<{
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            failureDestination: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
                to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("@sinclair/typebox").TLiteral<"announce">;
        }>, import("@sinclair/typebox").TObject<{
            to: import("@sinclair/typebox").TString;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            failureDestination: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
                to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("@sinclair/typebox").TLiteral<"webhook">;
        }>]>>;
        failureAlert: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<false>, import("@sinclair/typebox").TObject<{
            after: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            cooldownMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>]>>;
        state: import("@sinclair/typebox").TObject<{
            nextRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            runningAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastRunStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
            lastStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
            lastError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            lastErrorReason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"auth">, import("@sinclair/typebox").TLiteral<"format">, import("@sinclair/typebox").TLiteral<"rate_limit">, import("@sinclair/typebox").TLiteral<"billing">, import("@sinclair/typebox").TLiteral<"timeout">, import("@sinclair/typebox").TLiteral<"model_not_found">, import("@sinclair/typebox").TLiteral<"unknown">]>>;
            lastDurationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            consecutiveErrors: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            lastDelivered: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            lastDeliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
            lastDeliveryError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            lastFailureAlertAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        }>;
    }>;
    CronListParams: import("@sinclair/typebox").TObject<{
        includeDisabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        offset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        query: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"all">, import("@sinclair/typebox").TLiteral<"enabled">, import("@sinclair/typebox").TLiteral<"disabled">]>>;
        sortBy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"nextRunAtMs">, import("@sinclair/typebox").TLiteral<"updatedAtMs">, import("@sinclair/typebox").TLiteral<"name">]>>;
        sortDir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"asc">, import("@sinclair/typebox").TLiteral<"desc">]>>;
    }>;
    CronStatusParams: import("@sinclair/typebox").TObject<{}>;
    CronAddParams: import("@sinclair/typebox").TObject<{
        schedule: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"at">;
            at: import("@sinclair/typebox").TString;
        }>, import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"every">;
            everyMs: import("@sinclair/typebox").TInteger;
            anchorMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        }>, import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"cron">;
            expr: import("@sinclair/typebox").TString;
            tz: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            staggerMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        }>]>;
        sessionTarget: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"main">, import("@sinclair/typebox").TLiteral<"isolated">]>;
        wakeMode: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"next-heartbeat">, import("@sinclair/typebox").TLiteral<"now">]>;
        payload: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"systemEvent">;
            text: import("@sinclair/typebox").TString;
        }>, import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TLiteral<"agentTurn">;
            message: TSchema;
            model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            fallbacks: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
            thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            timeoutSeconds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            allowUnsafeExternalContent: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            lightContext: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffortDeliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>]>;
        delivery: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            failureDestination: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
                to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("@sinclair/typebox").TLiteral<"none">;
        }>, import("@sinclair/typebox").TObject<{
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            failureDestination: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
                to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("@sinclair/typebox").TLiteral<"announce">;
        }>, import("@sinclair/typebox").TObject<{
            to: import("@sinclair/typebox").TString;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            bestEffort: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            failureDestination: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
                to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("@sinclair/typebox").TLiteral<"webhook">;
        }>]>>;
        failureAlert: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<false>, import("@sinclair/typebox").TObject<{
            after: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            channel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"last">, import("@sinclair/typebox").TString]>>;
            to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            cooldownMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
            mode: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"announce">, import("@sinclair/typebox").TLiteral<"webhook">]>>;
            accountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>]>>;
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        enabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        deleteAfterRun: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        name: import("@sinclair/typebox").TString;
    }>;
    CronUpdateParams: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        jobId: import("@sinclair/typebox").TString;
    }>]>;
    CronRemoveParams: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        jobId: import("@sinclair/typebox").TString;
    }>]>;
    CronRunParams: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
    }>, import("@sinclair/typebox").TObject<{
        jobId: import("@sinclair/typebox").TString;
    }>]>;
    CronRunsParams: import("@sinclair/typebox").TObject<{
        scope: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"job">, import("@sinclair/typebox").TLiteral<"all">]>>;
        id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        jobId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        offset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        statuses: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>>;
        status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"all">, import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
        deliveryStatuses: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>>;
        deliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
        query: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sortDir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"asc">, import("@sinclair/typebox").TLiteral<"desc">]>>;
    }>;
    CronRunLogEntry: import("@sinclair/typebox").TObject<{
        ts: import("@sinclair/typebox").TInteger;
        jobId: import("@sinclair/typebox").TString;
        action: import("@sinclair/typebox").TLiteral<"finished">;
        status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"ok">, import("@sinclair/typebox").TLiteral<"error">, import("@sinclair/typebox").TLiteral<"skipped">]>>;
        error: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        summary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        delivered: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        deliveryStatus: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delivered">, import("@sinclair/typebox").TLiteral<"not-delivered">, import("@sinclair/typebox").TLiteral<"unknown">, import("@sinclair/typebox").TLiteral<"not-requested">]>>;
        deliveryError: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        runAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        durationMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        nextRunAtMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        provider: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        usage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            input_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            output_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            total_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            cache_read_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
            cache_write_tokens: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        }>>;
        jobName: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    LogsTailParams: import("@sinclair/typebox").TObject<{
        cursor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        maxBytes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    LogsTailResult: import("@sinclair/typebox").TObject<{
        file: import("@sinclair/typebox").TString;
        cursor: import("@sinclair/typebox").TInteger;
        size: import("@sinclair/typebox").TInteger;
        lines: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        truncated: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        reset: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    ExecApprovalsGetParams: import("@sinclair/typebox").TObject<{}>;
    ExecApprovalsSetParams: import("@sinclair/typebox").TObject<{
        file: import("@sinclair/typebox").TObject<{
            version: import("@sinclair/typebox").TLiteral<1>;
            socket: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>;
            defaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            }>>;
            agents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
                allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                    id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    pattern: import("@sinclair/typebox").TString;
                    lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
                    lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                }>>>;
                security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            }>>>;
        }>;
        baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    ExecApprovalsNodeGetParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
    }>;
    ExecApprovalsNodeSetParams: import("@sinclair/typebox").TObject<{
        nodeId: import("@sinclair/typebox").TString;
        file: import("@sinclair/typebox").TObject<{
            version: import("@sinclair/typebox").TLiteral<1>;
            socket: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>;
            defaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            }>>;
            agents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
                allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                    id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    pattern: import("@sinclair/typebox").TString;
                    lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
                    lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                }>>>;
                security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            }>>>;
        }>;
        baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    ExecApprovalsSnapshot: import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TString;
        exists: import("@sinclair/typebox").TBoolean;
        hash: import("@sinclair/typebox").TString;
        file: import("@sinclair/typebox").TObject<{
            version: import("@sinclair/typebox").TLiteral<1>;
            socket: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                token: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            }>>;
            defaults: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
                security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            }>>;
            agents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
                allowlist: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
                    id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    pattern: import("@sinclair/typebox").TString;
                    lastUsedAt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
                    lastUsedCommand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                    lastResolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                }>>>;
                security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                askFallback: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
                autoAllowSkills: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            }>>>;
        }>;
    }>;
    ExecApprovalRequestParams: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        command: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        commandArgv: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        systemRunPlan: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            argv: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
            cwd: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
            commandText: import("@sinclair/typebox").TString;
            commandPreview: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
            agentId: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
            sessionKey: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>;
            mutableFileOperand: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
                argvIndex: import("@sinclair/typebox").TInteger;
                path: import("@sinclair/typebox").TString;
                sha256: import("@sinclair/typebox").TString;
            }>, import("@sinclair/typebox").TNull]>>;
        }>>;
        env: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TString>>;
        cwd: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        nodeId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        host: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        security: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        ask: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        resolvedPath: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        turnSourceChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        turnSourceTo: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        turnSourceAccountId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNull]>>;
        turnSourceThreadId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TNumber, import("@sinclair/typebox").TNull]>>;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        twoPhase: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    ExecApprovalResolveParams: import("@sinclair/typebox").TObject<{
        id: import("@sinclair/typebox").TString;
        decision: import("@sinclair/typebox").TString;
    }>;
    DevicePairListParams: import("@sinclair/typebox").TObject<{}>;
    DevicePairApproveParams: import("@sinclair/typebox").TObject<{
        requestId: import("@sinclair/typebox").TString;
    }>;
    DevicePairRejectParams: import("@sinclair/typebox").TObject<{
        requestId: import("@sinclair/typebox").TString;
    }>;
    DevicePairRemoveParams: import("@sinclair/typebox").TObject<{
        deviceId: import("@sinclair/typebox").TString;
    }>;
    DeviceTokenRotateParams: import("@sinclair/typebox").TObject<{
        deviceId: import("@sinclair/typebox").TString;
        role: import("@sinclair/typebox").TString;
        scopes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    }>;
    DeviceTokenRevokeParams: import("@sinclair/typebox").TObject<{
        deviceId: import("@sinclair/typebox").TString;
        role: import("@sinclair/typebox").TString;
    }>;
    DevicePairRequestedEvent: import("@sinclair/typebox").TObject<{
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
    DevicePairResolvedEvent: import("@sinclair/typebox").TObject<{
        requestId: import("@sinclair/typebox").TString;
        deviceId: import("@sinclair/typebox").TString;
        decision: import("@sinclair/typebox").TString;
        ts: import("@sinclair/typebox").TInteger;
    }>;
    ChatHistoryParams: import("@sinclair/typebox").TObject<{
        sessionKey: import("@sinclair/typebox").TString;
        limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    ChatSendParams: import("@sinclair/typebox").TObject<{
        sessionKey: import("@sinclair/typebox").TString;
        message: import("@sinclair/typebox").TString;
        thinking: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        deliver: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        attachments: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnknown>>;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        systemInputProvenance: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
            kind: import("@sinclair/typebox").TString;
            originSessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sourceSessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sourceChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
            sourceTool: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        }>>;
        systemProvenanceReceipt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        idempotencyKey: import("@sinclair/typebox").TString;
    }>;
    ChatAbortParams: import("@sinclair/typebox").TObject<{
        sessionKey: import("@sinclair/typebox").TString;
        runId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    ChatInjectParams: import("@sinclair/typebox").TObject<{
        sessionKey: import("@sinclair/typebox").TString;
        message: import("@sinclair/typebox").TString;
        label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    ChatEvent: import("@sinclair/typebox").TObject<{
        runId: import("@sinclair/typebox").TString;
        sessionKey: import("@sinclair/typebox").TString;
        seq: import("@sinclair/typebox").TInteger;
        state: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"delta">, import("@sinclair/typebox").TLiteral<"final">, import("@sinclair/typebox").TLiteral<"aborted">, import("@sinclair/typebox").TLiteral<"error">]>;
        message: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        errorMessage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        usage: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
        stopReason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    UpdateRunParams: import("@sinclair/typebox").TObject<{
        sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        restartDelayMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
    TickEvent: import("@sinclair/typebox").TObject<{
        ts: import("@sinclair/typebox").TInteger;
    }>;
    ShutdownEvent: import("@sinclair/typebox").TObject<{
        reason: import("@sinclair/typebox").TString;
        restartExpectedMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    }>;
};
export declare const PROTOCOL_VERSION: 3;
