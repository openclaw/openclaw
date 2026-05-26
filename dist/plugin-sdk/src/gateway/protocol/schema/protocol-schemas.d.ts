import type { TSchema } from "typebox";
export declare const ProtocolSchemas: {
    ConnectParams: import("typebox").TObject<{
        minProtocol: import("typebox").TInteger;
        maxProtocol: import("typebox").TInteger;
        client: import("typebox").TObject<{
            id: import("typebox").TEnum<["openclaw-android", "cli", "openclaw-control-ui", "fingerprint", "gateway-client", "openclaw-ios", "openclaw-macos", "node-host", "openclaw-probe", "test", "openclaw-tui", "webchat", "webchat-ui"]>;
            displayName: import("typebox").TOptional<import("typebox").TString>;
            version: import("typebox").TString;
            platform: import("typebox").TString;
            deviceFamily: import("typebox").TOptional<import("typebox").TString>;
            modelIdentifier: import("typebox").TOptional<import("typebox").TString>;
            mode: import("typebox").TEnum<["backend", "cli", "node", "probe", "test", "ui", "webchat"]>;
            instanceId: import("typebox").TOptional<import("typebox").TString>;
        }>;
        caps: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        commands: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        permissions: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TBoolean>>;
        pathEnv: import("typebox").TOptional<import("typebox").TString>;
        role: import("typebox").TOptional<import("typebox").TString>;
        scopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        device: import("typebox").TOptional<import("typebox").TObject<{
            id: import("typebox").TString;
            publicKey: import("typebox").TString;
            signature: import("typebox").TString;
            signedAt: import("typebox").TInteger;
            nonce: import("typebox").TString;
        }>>;
        auth: import("typebox").TOptional<import("typebox").TObject<{
            token: import("typebox").TOptional<import("typebox").TString>;
            bootstrapToken: import("typebox").TOptional<import("typebox").TString>;
            deviceToken: import("typebox").TOptional<import("typebox").TString>;
            password: import("typebox").TOptional<import("typebox").TString>;
            approvalRuntimeToken: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        locale: import("typebox").TOptional<import("typebox").TString>;
        userAgent: import("typebox").TOptional<import("typebox").TString>;
    }>;
    HelloOk: import("typebox").TObject<{
        type: import("typebox").TLiteral<"hello-ok">;
        protocol: import("typebox").TInteger;
        server: import("typebox").TObject<{
            version: import("typebox").TString;
            connId: import("typebox").TString;
        }>;
        features: import("typebox").TObject<{
            methods: import("typebox").TArray<import("typebox").TString>;
            events: import("typebox").TArray<import("typebox").TString>;
        }>;
        snapshot: import("typebox").TObject<{
            presence: import("typebox").TArray<import("typebox").TObject<{
                host: import("typebox").TOptional<import("typebox").TString>;
                ip: import("typebox").TOptional<import("typebox").TString>;
                version: import("typebox").TOptional<import("typebox").TString>;
                platform: import("typebox").TOptional<import("typebox").TString>;
                deviceFamily: import("typebox").TOptional<import("typebox").TString>;
                modelIdentifier: import("typebox").TOptional<import("typebox").TString>;
                mode: import("typebox").TOptional<import("typebox").TString>;
                lastInputSeconds: import("typebox").TOptional<import("typebox").TInteger>;
                reason: import("typebox").TOptional<import("typebox").TString>;
                tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                text: import("typebox").TOptional<import("typebox").TString>;
                ts: import("typebox").TInteger;
                deviceId: import("typebox").TOptional<import("typebox").TString>;
                roles: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                scopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                instanceId: import("typebox").TOptional<import("typebox").TString>;
            }>>;
            health: import("typebox").TAny;
            stateVersion: import("typebox").TObject<{
                presence: import("typebox").TInteger;
                health: import("typebox").TInteger;
            }>;
            uptimeMs: import("typebox").TInteger;
            configPath: import("typebox").TOptional<import("typebox").TString>;
            stateDir: import("typebox").TOptional<import("typebox").TString>;
            sessionDefaults: import("typebox").TOptional<import("typebox").TObject<{
                defaultAgentId: import("typebox").TString;
                mainKey: import("typebox").TString;
                mainSessionKey: import("typebox").TString;
                scope: import("typebox").TOptional<import("typebox").TString>;
            }>>;
            authMode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"none">, import("typebox").TLiteral<"token">, import("typebox").TLiteral<"password">, import("typebox").TLiteral<"trusted-proxy">]>>;
            updateAvailable: import("typebox").TOptional<import("typebox").TObject<{
                currentVersion: import("typebox").TString;
                latestVersion: import("typebox").TString;
                channel: import("typebox").TString;
            }>>;
        }>;
        pluginSurfaceUrls: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
        auth: import("typebox").TObject<{
            deviceToken: import("typebox").TOptional<import("typebox").TString>;
            role: import("typebox").TString;
            scopes: import("typebox").TArray<import("typebox").TString>;
            issuedAtMs: import("typebox").TOptional<import("typebox").TInteger>;
            deviceTokens: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                deviceToken: import("typebox").TString;
                role: import("typebox").TString;
                scopes: import("typebox").TArray<import("typebox").TString>;
                issuedAtMs: import("typebox").TInteger;
            }>>>;
        }>;
        policy: import("typebox").TObject<{
            maxPayload: import("typebox").TInteger;
            maxBufferedBytes: import("typebox").TInteger;
            tickIntervalMs: import("typebox").TInteger;
        }>;
    }>;
    RequestFrame: import("typebox").TObject<{
        type: import("typebox").TLiteral<"req">;
        id: import("typebox").TString;
        method: import("typebox").TString;
        params: import("typebox").TOptional<import("typebox").TUnknown>;
    }>;
    ResponseFrame: import("typebox").TObject<{
        type: import("typebox").TLiteral<"res">;
        id: import("typebox").TString;
        ok: import("typebox").TBoolean;
        payload: import("typebox").TOptional<import("typebox").TUnknown>;
        error: import("typebox").TOptional<import("typebox").TObject<{
            code: import("typebox").TString;
            message: import("typebox").TString;
            details: import("typebox").TOptional<import("typebox").TUnknown>;
            retryable: import("typebox").TOptional<import("typebox").TBoolean>;
            retryAfterMs: import("typebox").TOptional<import("typebox").TInteger>;
        }>>;
    }>;
    EventFrame: import("typebox").TObject<{
        type: import("typebox").TLiteral<"event">;
        event: import("typebox").TString;
        payload: import("typebox").TOptional<import("typebox").TUnknown>;
        seq: import("typebox").TOptional<import("typebox").TInteger>;
        stateVersion: import("typebox").TOptional<import("typebox").TObject<{
            presence: import("typebox").TInteger;
            health: import("typebox").TInteger;
        }>>;
    }>;
    GatewayFrame: import("typebox").TUnion<[import("typebox").TObject<{
        type: import("typebox").TLiteral<"req">;
        id: import("typebox").TString;
        method: import("typebox").TString;
        params: import("typebox").TOptional<import("typebox").TUnknown>;
    }>, import("typebox").TObject<{
        type: import("typebox").TLiteral<"res">;
        id: import("typebox").TString;
        ok: import("typebox").TBoolean;
        payload: import("typebox").TOptional<import("typebox").TUnknown>;
        error: import("typebox").TOptional<import("typebox").TObject<{
            code: import("typebox").TString;
            message: import("typebox").TString;
            details: import("typebox").TOptional<import("typebox").TUnknown>;
            retryable: import("typebox").TOptional<import("typebox").TBoolean>;
            retryAfterMs: import("typebox").TOptional<import("typebox").TInteger>;
        }>>;
    }>, import("typebox").TObject<{
        type: import("typebox").TLiteral<"event">;
        event: import("typebox").TString;
        payload: import("typebox").TOptional<import("typebox").TUnknown>;
        seq: import("typebox").TOptional<import("typebox").TInteger>;
        stateVersion: import("typebox").TOptional<import("typebox").TObject<{
            presence: import("typebox").TInteger;
            health: import("typebox").TInteger;
        }>>;
    }>]>;
    PresenceEntry: import("typebox").TObject<{
        host: import("typebox").TOptional<import("typebox").TString>;
        ip: import("typebox").TOptional<import("typebox").TString>;
        version: import("typebox").TOptional<import("typebox").TString>;
        platform: import("typebox").TOptional<import("typebox").TString>;
        deviceFamily: import("typebox").TOptional<import("typebox").TString>;
        modelIdentifier: import("typebox").TOptional<import("typebox").TString>;
        mode: import("typebox").TOptional<import("typebox").TString>;
        lastInputSeconds: import("typebox").TOptional<import("typebox").TInteger>;
        reason: import("typebox").TOptional<import("typebox").TString>;
        tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        text: import("typebox").TOptional<import("typebox").TString>;
        ts: import("typebox").TInteger;
        deviceId: import("typebox").TOptional<import("typebox").TString>;
        roles: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        scopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        instanceId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    StateVersion: import("typebox").TObject<{
        presence: import("typebox").TInteger;
        health: import("typebox").TInteger;
    }>;
    Snapshot: import("typebox").TObject<{
        presence: import("typebox").TArray<import("typebox").TObject<{
            host: import("typebox").TOptional<import("typebox").TString>;
            ip: import("typebox").TOptional<import("typebox").TString>;
            version: import("typebox").TOptional<import("typebox").TString>;
            platform: import("typebox").TOptional<import("typebox").TString>;
            deviceFamily: import("typebox").TOptional<import("typebox").TString>;
            modelIdentifier: import("typebox").TOptional<import("typebox").TString>;
            mode: import("typebox").TOptional<import("typebox").TString>;
            lastInputSeconds: import("typebox").TOptional<import("typebox").TInteger>;
            reason: import("typebox").TOptional<import("typebox").TString>;
            tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            text: import("typebox").TOptional<import("typebox").TString>;
            ts: import("typebox").TInteger;
            deviceId: import("typebox").TOptional<import("typebox").TString>;
            roles: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            scopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            instanceId: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        health: import("typebox").TAny;
        stateVersion: import("typebox").TObject<{
            presence: import("typebox").TInteger;
            health: import("typebox").TInteger;
        }>;
        uptimeMs: import("typebox").TInteger;
        configPath: import("typebox").TOptional<import("typebox").TString>;
        stateDir: import("typebox").TOptional<import("typebox").TString>;
        sessionDefaults: import("typebox").TOptional<import("typebox").TObject<{
            defaultAgentId: import("typebox").TString;
            mainKey: import("typebox").TString;
            mainSessionKey: import("typebox").TString;
            scope: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        authMode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"none">, import("typebox").TLiteral<"token">, import("typebox").TLiteral<"password">, import("typebox").TLiteral<"trusted-proxy">]>>;
        updateAvailable: import("typebox").TOptional<import("typebox").TObject<{
            currentVersion: import("typebox").TString;
            latestVersion: import("typebox").TString;
            channel: import("typebox").TString;
        }>>;
    }>;
    ErrorShape: import("typebox").TObject<{
        code: import("typebox").TString;
        message: import("typebox").TString;
        details: import("typebox").TOptional<import("typebox").TUnknown>;
        retryable: import("typebox").TOptional<import("typebox").TBoolean>;
        retryAfterMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    EnvironmentStatus: import("typebox").TString;
    EnvironmentSummary: import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TString;
        label: import("typebox").TOptional<import("typebox").TString>;
        status: import("typebox").TString;
        capabilities: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    EnvironmentsListParams: import("typebox").TObject<{}>;
    EnvironmentsListResult: import("typebox").TObject<{
        environments: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            label: import("typebox").TOptional<import("typebox").TString>;
            status: import("typebox").TString;
            capabilities: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        }>>;
    }>;
    EnvironmentsStatusParams: import("typebox").TObject<{
        environmentId: import("typebox").TString;
    }>;
    EnvironmentsStatusResult: import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TString;
        label: import("typebox").TOptional<import("typebox").TString>;
        status: import("typebox").TString;
        capabilities: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    AgentEvent: import("typebox").TObject<{
        runId: import("typebox").TString;
        seq: import("typebox").TInteger;
        stream: import("typebox").TString;
        ts: import("typebox").TInteger;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        isHeartbeat: import("typebox").TOptional<import("typebox").TBoolean>;
        data: import("typebox").TRecord<"^.*$", import("typebox").TUnknown>;
    }>;
    MessageActionParams: import("typebox").TObject<{
        channel: import("typebox").TString;
        action: import("typebox").TString;
        params: import("typebox").TRecord<"^.*$", import("typebox").TUnknown>;
        accountId: import("typebox").TOptional<import("typebox").TString>;
        requesterSenderId: import("typebox").TOptional<import("typebox").TString>;
        senderIsOwner: import("typebox").TOptional<import("typebox").TBoolean>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        sessionId: import("typebox").TOptional<import("typebox").TString>;
        inboundTurnKind: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        toolContext: import("typebox").TOptional<import("typebox").TObject<{
            currentChannelId: import("typebox").TOptional<import("typebox").TString>;
            currentGraphChannelId: import("typebox").TOptional<import("typebox").TString>;
            currentChannelProvider: import("typebox").TOptional<import("typebox").TString>;
            currentThreadTs: import("typebox").TOptional<import("typebox").TString>;
            currentMessageId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
            replyToMode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"off">, import("typebox").TLiteral<"first">, import("typebox").TLiteral<"all">, import("typebox").TLiteral<"batched">]>>;
            hasRepliedRef: import("typebox").TOptional<import("typebox").TObject<{
                value: import("typebox").TBoolean;
            }>>;
            skipCrossContextDecoration: import("typebox").TOptional<import("typebox").TBoolean>;
        }>>;
        idempotencyKey: import("typebox").TString;
    }>;
    SendParams: import("typebox").TObject<{
        to: import("typebox").TString;
        message: import("typebox").TOptional<import("typebox").TString>;
        mediaUrl: import("typebox").TOptional<import("typebox").TString>;
        mediaUrls: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        asVoice: import("typebox").TOptional<import("typebox").TBoolean>;
        gifPlayback: import("typebox").TOptional<import("typebox").TBoolean>;
        channel: import("typebox").TOptional<import("typebox").TString>;
        accountId: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        replyToId: import("typebox").TOptional<import("typebox").TString>;
        threadId: import("typebox").TOptional<import("typebox").TString>;
        forceDocument: import("typebox").TOptional<import("typebox").TBoolean>;
        silent: import("typebox").TOptional<import("typebox").TBoolean>;
        parseMode: import("typebox").TOptional<import("typebox").TLiteral<"HTML">>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        idempotencyKey: import("typebox").TString;
    }>;
    PollParams: import("typebox").TObject<{
        to: import("typebox").TString;
        question: import("typebox").TString;
        options: import("typebox").TArray<import("typebox").TString>;
        maxSelections: import("typebox").TOptional<import("typebox").TInteger>;
        durationSeconds: import("typebox").TOptional<import("typebox").TInteger>;
        durationHours: import("typebox").TOptional<import("typebox").TInteger>;
        silent: import("typebox").TOptional<import("typebox").TBoolean>;
        isAnonymous: import("typebox").TOptional<import("typebox").TBoolean>;
        threadId: import("typebox").TOptional<import("typebox").TString>;
        channel: import("typebox").TOptional<import("typebox").TString>;
        accountId: import("typebox").TOptional<import("typebox").TString>;
        idempotencyKey: import("typebox").TString;
    }>;
    AgentParams: import("typebox").TObject<{
        message: import("typebox").TString;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        provider: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TString>;
        to: import("typebox").TOptional<import("typebox").TString>;
        replyTo: import("typebox").TOptional<import("typebox").TString>;
        sessionId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        thinking: import("typebox").TOptional<import("typebox").TString>;
        deliver: import("typebox").TOptional<import("typebox").TBoolean>;
        attachments: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnknown>>;
        channel: import("typebox").TOptional<import("typebox").TString>;
        replyChannel: import("typebox").TOptional<import("typebox").TString>;
        accountId: import("typebox").TOptional<import("typebox").TString>;
        replyAccountId: import("typebox").TOptional<import("typebox").TString>;
        threadId: import("typebox").TOptional<import("typebox").TString>;
        groupId: import("typebox").TOptional<import("typebox").TString>;
        groupChannel: import("typebox").TOptional<import("typebox").TString>;
        groupSpace: import("typebox").TOptional<import("typebox").TString>;
        timeout: import("typebox").TOptional<import("typebox").TInteger>;
        bestEffortDeliver: import("typebox").TOptional<import("typebox").TBoolean>;
        lane: import("typebox").TOptional<import("typebox").TString>;
        cleanupBundleMcpOnRunEnd: import("typebox").TOptional<import("typebox").TBoolean>;
        modelRun: import("typebox").TOptional<import("typebox").TBoolean>;
        promptMode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"full">, import("typebox").TLiteral<"minimal">, import("typebox").TLiteral<"none">]>>;
        extraSystemPrompt: import("typebox").TOptional<import("typebox").TString>;
        bootstrapContextMode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"full">, import("typebox").TLiteral<"lightweight">]>>;
        bootstrapContextRunKind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"default">, import("typebox").TLiteral<"heartbeat">, import("typebox").TLiteral<"cron">]>>;
        acpTurnSource: import("typebox").TOptional<import("typebox").TLiteral<"manual_spawn">>;
        internalRuntimeHandoffId: import("typebox").TOptional<import("typebox").TString>;
        internalEvents: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
            type: import("typebox").TLiteral<"task_completion">;
            source: import("typebox").TString;
            childSessionKey: import("typebox").TString;
            childSessionId: import("typebox").TOptional<import("typebox").TString>;
            announceType: import("typebox").TString;
            taskLabel: import("typebox").TString;
            status: import("typebox").TString;
            statusLabel: import("typebox").TString;
            result: import("typebox").TString;
            attachments: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                type: import("typebox").TOptional<import("typebox").TString>;
                path: import("typebox").TOptional<import("typebox").TString>;
                url: import("typebox").TOptional<import("typebox").TString>;
                mediaUrl: import("typebox").TOptional<import("typebox").TString>;
                filePath: import("typebox").TOptional<import("typebox").TString>;
                mimeType: import("typebox").TOptional<import("typebox").TString>;
                name: import("typebox").TOptional<import("typebox").TString>;
            }>>>;
            mediaUrls: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            statsLine: import("typebox").TOptional<import("typebox").TString>;
            replyInstruction: import("typebox").TString;
        }>>>;
        inputProvenance: import("typebox").TOptional<import("typebox").TObject<{
            kind: import("typebox").TString;
            originSessionId: import("typebox").TOptional<import("typebox").TString>;
            sourceSessionKey: import("typebox").TOptional<import("typebox").TString>;
            sourceChannel: import("typebox").TOptional<import("typebox").TString>;
            sourceTool: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        sourceReplyDeliveryMode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"automatic">, import("typebox").TLiteral<"message_tool_only">]>>;
        voiceWakeTrigger: import("typebox").TOptional<import("typebox").TString>;
        idempotencyKey: import("typebox").TString;
        label: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentIdentityParams: import("typebox").TObject<{
        agentId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentIdentityResult: import("typebox").TObject<{
        agentId: import("typebox").TString;
        name: import("typebox").TOptional<import("typebox").TString>;
        avatar: import("typebox").TOptional<import("typebox").TString>;
        avatarSource: import("typebox").TOptional<import("typebox").TString>;
        avatarStatus: import("typebox").TOptional<import("typebox").TString>;
        avatarReason: import("typebox").TOptional<import("typebox").TString>;
        emoji: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentWaitParams: import("typebox").TObject<{
        runId: import("typebox").TString;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    WakeParams: import("typebox").TObject<{
        mode: import("typebox").TUnion<[import("typebox").TLiteral<"now">, import("typebox").TLiteral<"next-heartbeat">]>;
        text: import("typebox").TString;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
    }>;
    NodePairRequestParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        displayName: import("typebox").TOptional<import("typebox").TString>;
        platform: import("typebox").TOptional<import("typebox").TString>;
        version: import("typebox").TOptional<import("typebox").TString>;
        coreVersion: import("typebox").TOptional<import("typebox").TString>;
        uiVersion: import("typebox").TOptional<import("typebox").TString>;
        deviceFamily: import("typebox").TOptional<import("typebox").TString>;
        modelIdentifier: import("typebox").TOptional<import("typebox").TString>;
        caps: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        commands: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        permissions: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TBoolean>>;
        remoteIp: import("typebox").TOptional<import("typebox").TString>;
        silent: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    NodePairListParams: import("typebox").TObject<{}>;
    NodePairApproveParams: import("typebox").TObject<{
        requestId: import("typebox").TString;
    }>;
    NodePairRejectParams: import("typebox").TObject<{
        requestId: import("typebox").TString;
    }>;
    NodePairRemoveParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
    }>;
    NodePairVerifyParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        token: import("typebox").TString;
    }>;
    NodeRenameParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        displayName: import("typebox").TString;
    }>;
    NodeListParams: import("typebox").TObject<{}>;
    NodePendingAckParams: import("typebox").TObject<{
        ids: import("typebox").TArray<import("typebox").TString>;
    }>;
    NodeDescribeParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
    }>;
    NodeInvokeParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        command: import("typebox").TString;
        params: import("typebox").TOptional<import("typebox").TUnknown>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        idempotencyKey: import("typebox").TString;
    }>;
    NodeInvokeResultParams: import("typebox").TObject<{
        id: import("typebox").TString;
        nodeId: import("typebox").TString;
        ok: import("typebox").TBoolean;
        payload: import("typebox").TOptional<import("typebox").TUnknown>;
        payloadJSON: import("typebox").TOptional<import("typebox").TString>;
        error: import("typebox").TOptional<import("typebox").TObject<{
            code: import("typebox").TOptional<import("typebox").TString>;
            message: import("typebox").TOptional<import("typebox").TString>;
        }>>;
    }>;
    NodeEventParams: import("typebox").TObject<{
        event: import("typebox").TString;
        payload: import("typebox").TOptional<import("typebox").TUnknown>;
        payloadJSON: import("typebox").TOptional<import("typebox").TString>;
    }>;
    NodeEventResult: import("typebox").TObject<{
        ok: import("typebox").TBoolean;
        event: import("typebox").TString;
        handled: import("typebox").TBoolean;
        reason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    NodePresenceAlivePayload: import("typebox").TObject<{
        trigger: import("typebox").TString;
        sentAtMs: import("typebox").TOptional<import("typebox").TInteger>;
        displayName: import("typebox").TOptional<import("typebox").TString>;
        version: import("typebox").TOptional<import("typebox").TString>;
        platform: import("typebox").TOptional<import("typebox").TString>;
        deviceFamily: import("typebox").TOptional<import("typebox").TString>;
        modelIdentifier: import("typebox").TOptional<import("typebox").TString>;
        pushTransport: import("typebox").TOptional<import("typebox").TString>;
    }>;
    NodePresenceAliveReason: import("typebox").TString;
    NodePendingDrainParams: import("typebox").TObject<{
        maxItems: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    NodePendingDrainResult: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        revision: import("typebox").TInteger;
        items: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            priority: import("typebox").TString;
            createdAtMs: import("typebox").TInteger;
            expiresAtMs: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>>;
            payload: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TUnknown>>;
        }>>;
        hasMore: import("typebox").TBoolean;
    }>;
    NodePendingEnqueueParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        type: import("typebox").TString;
        priority: import("typebox").TOptional<import("typebox").TString>;
        expiresInMs: import("typebox").TOptional<import("typebox").TInteger>;
        wake: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    NodePendingEnqueueResult: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        revision: import("typebox").TInteger;
        queued: import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            priority: import("typebox").TString;
            createdAtMs: import("typebox").TInteger;
            expiresAtMs: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>>;
            payload: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TUnknown>>;
        }>;
        wakeTriggered: import("typebox").TBoolean;
    }>;
    NodeInvokeRequestEvent: import("typebox").TObject<{
        id: import("typebox").TString;
        nodeId: import("typebox").TString;
        command: import("typebox").TString;
        paramsJSON: import("typebox").TOptional<import("typebox").TString>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        idempotencyKey: import("typebox").TOptional<import("typebox").TString>;
    }>;
    PushTestParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        title: import("typebox").TOptional<import("typebox").TString>;
        body: import("typebox").TOptional<import("typebox").TString>;
        environment: import("typebox").TOptional<import("typebox").TString>;
    }>;
    PushTestResult: import("typebox").TObject<{
        ok: import("typebox").TBoolean;
        status: import("typebox").TInteger;
        apnsId: import("typebox").TOptional<import("typebox").TString>;
        reason: import("typebox").TOptional<import("typebox").TString>;
        tokenSuffix: import("typebox").TString;
        topic: import("typebox").TString;
        environment: import("typebox").TString;
        transport: import("typebox").TString;
    }>;
    SecretsReloadParams: import("typebox").TObject<{}>;
    SecretsResolveParams: import("typebox").TObject<{
        commandName: import("typebox").TString;
        targetIds: import("typebox").TArray<import("typebox").TString>;
        allowedPaths: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        forcedActivePaths: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        optionalActivePaths: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        providerOverrides: import("typebox").TOptional<import("typebox").TObject<{
            webSearch: import("typebox").TOptional<import("typebox").TString>;
            webFetch: import("typebox").TOptional<import("typebox").TString>;
        }>>;
    }>;
    SecretsResolveAssignment: import("typebox").TObject<{
        path: import("typebox").TOptional<import("typebox").TString>;
        pathSegments: import("typebox").TArray<import("typebox").TString>;
        value: import("typebox").TUnknown;
    }>;
    SecretsResolveResult: import("typebox").TObject<{
        ok: import("typebox").TOptional<import("typebox").TBoolean>;
        assignments: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
            path: import("typebox").TOptional<import("typebox").TString>;
            pathSegments: import("typebox").TArray<import("typebox").TString>;
            value: import("typebox").TUnknown;
        }>>>;
        diagnostics: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        inactiveRefPaths: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    SessionsListParams: import("typebox").TObject<{
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        offset: import("typebox").TOptional<import("typebox").TInteger>;
        activeMinutes: import("typebox").TOptional<import("typebox").TInteger>;
        includeGlobal: import("typebox").TOptional<import("typebox").TBoolean>;
        includeUnknown: import("typebox").TOptional<import("typebox").TBoolean>;
        configuredAgentsOnly: import("typebox").TOptional<import("typebox").TBoolean>;
        includeDerivedTitles: import("typebox").TOptional<import("typebox").TBoolean>;
        includeLastMessage: import("typebox").TOptional<import("typebox").TBoolean>;
        label: import("typebox").TOptional<import("typebox").TString>;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        search: import("typebox").TOptional<import("typebox").TString>;
    }>;
    SessionsCleanupParams: import("typebox").TObject<{
        agent: import("typebox").TOptional<import("typebox").TString>;
        allAgents: import("typebox").TOptional<import("typebox").TBoolean>;
        enforce: import("typebox").TOptional<import("typebox").TBoolean>;
        activeKey: import("typebox").TOptional<import("typebox").TString>;
        fixMissing: import("typebox").TOptional<import("typebox").TBoolean>;
        fixDmScope: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    SessionsPreviewParams: import("typebox").TObject<{
        keys: import("typebox").TArray<import("typebox").TString>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        maxChars: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    SessionsDescribeParams: import("typebox").TObject<{
        key: import("typebox").TString;
        includeDerivedTitles: import("typebox").TOptional<import("typebox").TBoolean>;
        includeLastMessage: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    SessionsResolveParams: import("typebox").TObject<{
        key: import("typebox").TOptional<import("typebox").TString>;
        sessionId: import("typebox").TOptional<import("typebox").TString>;
        label: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        includeGlobal: import("typebox").TOptional<import("typebox").TBoolean>;
        includeUnknown: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    SessionCompactionCheckpoint: import("typebox").TObject<{
        checkpointId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        sessionId: import("typebox").TString;
        createdAt: import("typebox").TInteger;
        reason: import("typebox").TUnion<[import("typebox").TLiteral<"manual">, import("typebox").TLiteral<"auto-threshold">, import("typebox").TLiteral<"overflow-retry">, import("typebox").TLiteral<"timeout-retry">]>;
        tokensBefore: import("typebox").TOptional<import("typebox").TInteger>;
        tokensAfter: import("typebox").TOptional<import("typebox").TInteger>;
        summary: import("typebox").TOptional<import("typebox").TString>;
        firstKeptEntryId: import("typebox").TOptional<import("typebox").TString>;
        preCompaction: import("typebox").TObject<{
            sessionId: import("typebox").TString;
            sessionFile: import("typebox").TOptional<import("typebox").TString>;
            leafId: import("typebox").TOptional<import("typebox").TString>;
            entryId: import("typebox").TOptional<import("typebox").TString>;
        }>;
        postCompaction: import("typebox").TObject<{
            sessionId: import("typebox").TString;
            sessionFile: import("typebox").TOptional<import("typebox").TString>;
            leafId: import("typebox").TOptional<import("typebox").TString>;
            entryId: import("typebox").TOptional<import("typebox").TString>;
        }>;
    }>;
    SessionOperationEvent: import("typebox").TObject<{
        operationId: import("typebox").TString;
        operation: import("typebox").TLiteral<"compact">;
        phase: import("typebox").TUnion<[import("typebox").TLiteral<"start">, import("typebox").TLiteral<"end">]>;
        sessionKey: import("typebox").TString;
        ts: import("typebox").TInteger;
        completed: import("typebox").TOptional<import("typebox").TBoolean>;
        reason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    SessionsCompactionListParams: import("typebox").TObject<{
        key: import("typebox").TString;
    }>;
    SessionsCompactionGetParams: import("typebox").TObject<{
        key: import("typebox").TString;
        checkpointId: import("typebox").TString;
    }>;
    SessionsCompactionBranchParams: import("typebox").TObject<{
        key: import("typebox").TString;
        checkpointId: import("typebox").TString;
    }>;
    SessionsCompactionRestoreParams: import("typebox").TObject<{
        key: import("typebox").TString;
        checkpointId: import("typebox").TString;
    }>;
    SessionsCompactionListResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        key: import("typebox").TString;
        checkpoints: import("typebox").TArray<import("typebox").TObject<{
            checkpointId: import("typebox").TString;
            sessionKey: import("typebox").TString;
            sessionId: import("typebox").TString;
            createdAt: import("typebox").TInteger;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"manual">, import("typebox").TLiteral<"auto-threshold">, import("typebox").TLiteral<"overflow-retry">, import("typebox").TLiteral<"timeout-retry">]>;
            tokensBefore: import("typebox").TOptional<import("typebox").TInteger>;
            tokensAfter: import("typebox").TOptional<import("typebox").TInteger>;
            summary: import("typebox").TOptional<import("typebox").TString>;
            firstKeptEntryId: import("typebox").TOptional<import("typebox").TString>;
            preCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
            postCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
        }>>;
    }>;
    SessionsCompactionGetResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        key: import("typebox").TString;
        checkpoint: import("typebox").TObject<{
            checkpointId: import("typebox").TString;
            sessionKey: import("typebox").TString;
            sessionId: import("typebox").TString;
            createdAt: import("typebox").TInteger;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"manual">, import("typebox").TLiteral<"auto-threshold">, import("typebox").TLiteral<"overflow-retry">, import("typebox").TLiteral<"timeout-retry">]>;
            tokensBefore: import("typebox").TOptional<import("typebox").TInteger>;
            tokensAfter: import("typebox").TOptional<import("typebox").TInteger>;
            summary: import("typebox").TOptional<import("typebox").TString>;
            firstKeptEntryId: import("typebox").TOptional<import("typebox").TString>;
            preCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
            postCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
        }>;
    }>;
    SessionsCompactionBranchResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        sourceKey: import("typebox").TString;
        key: import("typebox").TString;
        sessionId: import("typebox").TString;
        checkpoint: import("typebox").TObject<{
            checkpointId: import("typebox").TString;
            sessionKey: import("typebox").TString;
            sessionId: import("typebox").TString;
            createdAt: import("typebox").TInteger;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"manual">, import("typebox").TLiteral<"auto-threshold">, import("typebox").TLiteral<"overflow-retry">, import("typebox").TLiteral<"timeout-retry">]>;
            tokensBefore: import("typebox").TOptional<import("typebox").TInteger>;
            tokensAfter: import("typebox").TOptional<import("typebox").TInteger>;
            summary: import("typebox").TOptional<import("typebox").TString>;
            firstKeptEntryId: import("typebox").TOptional<import("typebox").TString>;
            preCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
            postCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
        }>;
        entry: import("typebox").TObject<{
            sessionId: import("typebox").TString;
            updatedAt: import("typebox").TInteger;
        }>;
    }>;
    SessionsCompactionRestoreResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        key: import("typebox").TString;
        sessionId: import("typebox").TString;
        checkpoint: import("typebox").TObject<{
            checkpointId: import("typebox").TString;
            sessionKey: import("typebox").TString;
            sessionId: import("typebox").TString;
            createdAt: import("typebox").TInteger;
            reason: import("typebox").TUnion<[import("typebox").TLiteral<"manual">, import("typebox").TLiteral<"auto-threshold">, import("typebox").TLiteral<"overflow-retry">, import("typebox").TLiteral<"timeout-retry">]>;
            tokensBefore: import("typebox").TOptional<import("typebox").TInteger>;
            tokensAfter: import("typebox").TOptional<import("typebox").TInteger>;
            summary: import("typebox").TOptional<import("typebox").TString>;
            firstKeptEntryId: import("typebox").TOptional<import("typebox").TString>;
            preCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
            postCompaction: import("typebox").TObject<{
                sessionId: import("typebox").TString;
                sessionFile: import("typebox").TOptional<import("typebox").TString>;
                leafId: import("typebox").TOptional<import("typebox").TString>;
                entryId: import("typebox").TOptional<import("typebox").TString>;
            }>;
        }>;
        entry: import("typebox").TObject<{
            sessionId: import("typebox").TString;
            updatedAt: import("typebox").TInteger;
        }>;
    }>;
    SessionsCreateParams: import("typebox").TObject<{
        key: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        label: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TString>;
        parentSessionKey: import("typebox").TOptional<import("typebox").TString>;
        emitCommandHooks: import("typebox").TOptional<import("typebox").TBoolean>;
        task: import("typebox").TOptional<import("typebox").TString>;
        message: import("typebox").TOptional<import("typebox").TString>;
    }>;
    SessionsSendParams: import("typebox").TObject<{
        key: import("typebox").TString;
        message: import("typebox").TString;
        thinking: import("typebox").TOptional<import("typebox").TString>;
        attachments: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnknown>>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        idempotencyKey: import("typebox").TOptional<import("typebox").TString>;
    }>;
    SessionsMessagesSubscribeParams: import("typebox").TObject<{
        key: import("typebox").TString;
    }>;
    SessionsMessagesUnsubscribeParams: import("typebox").TObject<{
        key: import("typebox").TString;
    }>;
    SessionsAbortParams: import("typebox").TObject<{
        key: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    SessionsPatchParams: import("typebox").TObject<{
        key: import("typebox").TString;
        label: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        thinkingLevel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        fastMode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TBoolean, import("typebox").TNull]>>;
        verboseLevel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        traceLevel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        reasoningLevel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        responseUsage: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"off">, import("typebox").TLiteral<"tokens">, import("typebox").TLiteral<"full">, import("typebox").TLiteral<"on">, import("typebox").TNull]>>;
        elevatedLevel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        execHost: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        execSecurity: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        execAsk: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        execNode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        model: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        spawnedBy: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        spawnedWorkspaceDir: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        spawnDepth: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>>;
        subagentRole: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"orchestrator">, import("typebox").TLiteral<"leaf">, import("typebox").TNull]>>;
        subagentControlScope: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"children">, import("typebox").TLiteral<"none">, import("typebox").TNull]>>;
        inheritedToolAllow: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TString>, import("typebox").TNull]>>;
        inheritedToolDeny: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TString>, import("typebox").TNull]>>;
        sendPolicy: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"allow">, import("typebox").TLiteral<"deny">, import("typebox").TNull]>>;
        groupActivation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"mention">, import("typebox").TLiteral<"always">, import("typebox").TNull]>>;
    }>;
    SessionsPluginPatchParams: import("typebox").TObject<{
        key: import("typebox").TString;
        pluginId: import("typebox").TString;
        namespace: import("typebox").TString;
        value: import("typebox").TOptional<import("typebox").TUnknown>;
        unset: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    SessionsPluginPatchResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        key: import("typebox").TString;
        value: import("typebox").TOptional<import("typebox").TUnknown>;
    }>;
    SessionsResetParams: import("typebox").TObject<{
        key: import("typebox").TString;
        reason: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"new">, import("typebox").TLiteral<"reset">]>>;
    }>;
    SessionsDeleteParams: import("typebox").TObject<{
        key: import("typebox").TString;
        deleteTranscript: import("typebox").TOptional<import("typebox").TBoolean>;
        emitLifecycleHooks: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    SessionsCompactParams: import("typebox").TObject<{
        key: import("typebox").TString;
        maxLines: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    SessionsUsageParams: import("typebox").TObject<{
        key: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        startDate: import("typebox").TOptional<import("typebox").TString>;
        endDate: import("typebox").TOptional<import("typebox").TString>;
        mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"utc">, import("typebox").TLiteral<"gateway">, import("typebox").TLiteral<"specific">]>>;
        range: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"7d">, import("typebox").TLiteral<"30d">, import("typebox").TLiteral<"90d">, import("typebox").TLiteral<"1y">, import("typebox").TLiteral<"all">]>>;
        groupBy: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"instance">, import("typebox").TLiteral<"family">]>>;
        includeHistorical: import("typebox").TOptional<import("typebox").TBoolean>;
        utcOffset: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        includeContextWeight: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    TaskSummary: import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TOptional<import("typebox").TString>;
        runtime: import("typebox").TOptional<import("typebox").TString>;
        status: import("typebox").TUnion<[import("typebox").TLiteral<"queued">, import("typebox").TLiteral<"running">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"failed">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"timed_out">]>;
        title: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        childSessionKey: import("typebox").TOptional<import("typebox").TString>;
        ownerKey: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        taskId: import("typebox").TOptional<import("typebox").TString>;
        flowId: import("typebox").TOptional<import("typebox").TString>;
        parentTaskId: import("typebox").TOptional<import("typebox").TString>;
        sourceId: import("typebox").TOptional<import("typebox").TString>;
        createdAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
        updatedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
        startedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
        endedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
        progressSummary: import("typebox").TOptional<import("typebox").TString>;
        terminalSummary: import("typebox").TOptional<import("typebox").TString>;
        error: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TasksListParams: import("typebox").TObject<{
        status: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"queued">, import("typebox").TLiteral<"running">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"failed">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"timed_out">]>, import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"queued">, import("typebox").TLiteral<"running">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"failed">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"timed_out">]>>]>>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        cursor: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TasksListResult: import("typebox").TObject<{
        tasks: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TOptional<import("typebox").TString>;
            runtime: import("typebox").TOptional<import("typebox").TString>;
            status: import("typebox").TUnion<[import("typebox").TLiteral<"queued">, import("typebox").TLiteral<"running">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"failed">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"timed_out">]>;
            title: import("typebox").TOptional<import("typebox").TString>;
            agentId: import("typebox").TOptional<import("typebox").TString>;
            sessionKey: import("typebox").TOptional<import("typebox").TString>;
            childSessionKey: import("typebox").TOptional<import("typebox").TString>;
            ownerKey: import("typebox").TOptional<import("typebox").TString>;
            runId: import("typebox").TOptional<import("typebox").TString>;
            taskId: import("typebox").TOptional<import("typebox").TString>;
            flowId: import("typebox").TOptional<import("typebox").TString>;
            parentTaskId: import("typebox").TOptional<import("typebox").TString>;
            sourceId: import("typebox").TOptional<import("typebox").TString>;
            createdAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            updatedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            startedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            endedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            progressSummary: import("typebox").TOptional<import("typebox").TString>;
            terminalSummary: import("typebox").TOptional<import("typebox").TString>;
            error: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        nextCursor: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TasksGetParams: import("typebox").TObject<{
        taskId: import("typebox").TString;
    }>;
    TasksGetResult: import("typebox").TObject<{
        task: import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TOptional<import("typebox").TString>;
            runtime: import("typebox").TOptional<import("typebox").TString>;
            status: import("typebox").TUnion<[import("typebox").TLiteral<"queued">, import("typebox").TLiteral<"running">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"failed">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"timed_out">]>;
            title: import("typebox").TOptional<import("typebox").TString>;
            agentId: import("typebox").TOptional<import("typebox").TString>;
            sessionKey: import("typebox").TOptional<import("typebox").TString>;
            childSessionKey: import("typebox").TOptional<import("typebox").TString>;
            ownerKey: import("typebox").TOptional<import("typebox").TString>;
            runId: import("typebox").TOptional<import("typebox").TString>;
            taskId: import("typebox").TOptional<import("typebox").TString>;
            flowId: import("typebox").TOptional<import("typebox").TString>;
            parentTaskId: import("typebox").TOptional<import("typebox").TString>;
            sourceId: import("typebox").TOptional<import("typebox").TString>;
            createdAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            updatedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            startedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            endedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            progressSummary: import("typebox").TOptional<import("typebox").TString>;
            terminalSummary: import("typebox").TOptional<import("typebox").TString>;
            error: import("typebox").TOptional<import("typebox").TString>;
        }>;
    }>;
    TasksCancelParams: import("typebox").TObject<{
        taskId: import("typebox").TString;
        reason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TasksCancelResult: import("typebox").TObject<{
        found: import("typebox").TBoolean;
        cancelled: import("typebox").TBoolean;
        reason: import("typebox").TOptional<import("typebox").TString>;
        task: import("typebox").TOptional<import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TOptional<import("typebox").TString>;
            runtime: import("typebox").TOptional<import("typebox").TString>;
            status: import("typebox").TUnion<[import("typebox").TLiteral<"queued">, import("typebox").TLiteral<"running">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"failed">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"timed_out">]>;
            title: import("typebox").TOptional<import("typebox").TString>;
            agentId: import("typebox").TOptional<import("typebox").TString>;
            sessionKey: import("typebox").TOptional<import("typebox").TString>;
            childSessionKey: import("typebox").TOptional<import("typebox").TString>;
            ownerKey: import("typebox").TOptional<import("typebox").TString>;
            runId: import("typebox").TOptional<import("typebox").TString>;
            taskId: import("typebox").TOptional<import("typebox").TString>;
            flowId: import("typebox").TOptional<import("typebox").TString>;
            parentTaskId: import("typebox").TOptional<import("typebox").TString>;
            sourceId: import("typebox").TOptional<import("typebox").TString>;
            createdAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            updatedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            startedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            endedAt: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TInteger]>>;
            progressSummary: import("typebox").TOptional<import("typebox").TString>;
            terminalSummary: import("typebox").TOptional<import("typebox").TString>;
            error: import("typebox").TOptional<import("typebox").TString>;
        }>>;
    }>;
    ConfigGetParams: import("typebox").TObject<{}>;
    ConfigSetParams: import("typebox").TObject<{
        raw: import("typebox").TString;
        baseHash: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ConfigApplyParams: import("typebox").TObject<{
        raw: import("typebox").TString;
        baseHash: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        deliveryContext: import("typebox").TOptional<import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TString>;
            to: import("typebox").TOptional<import("typebox").TString>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
        }>>;
        note: import("typebox").TOptional<import("typebox").TString>;
        restartDelayMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    ConfigPatchParams: import("typebox").TObject<{
        raw: import("typebox").TString;
        baseHash: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        deliveryContext: import("typebox").TOptional<import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TString>;
            to: import("typebox").TOptional<import("typebox").TString>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
        }>>;
        note: import("typebox").TOptional<import("typebox").TString>;
        restartDelayMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    ConfigSchemaParams: import("typebox").TObject<{}>;
    ConfigSchemaLookupParams: import("typebox").TObject<{
        path: import("typebox").TString;
    }>;
    ConfigSchemaResponse: import("typebox").TObject<{
        schema: import("typebox").TUnknown;
        uiHints: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
            label: import("typebox").TOptional<import("typebox").TString>;
            help: import("typebox").TOptional<import("typebox").TString>;
            tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            group: import("typebox").TOptional<import("typebox").TString>;
            order: import("typebox").TOptional<import("typebox").TInteger>;
            advanced: import("typebox").TOptional<import("typebox").TBoolean>;
            sensitive: import("typebox").TOptional<import("typebox").TBoolean>;
            placeholder: import("typebox").TOptional<import("typebox").TString>;
            itemTemplate: import("typebox").TOptional<import("typebox").TUnknown>;
        }>>;
        version: import("typebox").TString;
        generatedAt: import("typebox").TString;
    }>;
    ConfigSchemaLookupResult: import("typebox").TObject<{
        path: import("typebox").TString;
        schema: import("typebox").TUnknown;
        reloadKind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"restart">, import("typebox").TLiteral<"hot">, import("typebox").TLiteral<"none">]>>;
        hint: import("typebox").TOptional<import("typebox").TObject<{
            label: import("typebox").TOptional<import("typebox").TString>;
            help: import("typebox").TOptional<import("typebox").TString>;
            tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            group: import("typebox").TOptional<import("typebox").TString>;
            order: import("typebox").TOptional<import("typebox").TInteger>;
            advanced: import("typebox").TOptional<import("typebox").TBoolean>;
            sensitive: import("typebox").TOptional<import("typebox").TBoolean>;
            placeholder: import("typebox").TOptional<import("typebox").TString>;
            itemTemplate: import("typebox").TOptional<import("typebox").TUnknown>;
        }>>;
        hintPath: import("typebox").TOptional<import("typebox").TString>;
        children: import("typebox").TArray<import("typebox").TObject<{
            key: import("typebox").TString;
            path: import("typebox").TString;
            type: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>>;
            required: import("typebox").TBoolean;
            hasChildren: import("typebox").TBoolean;
            reloadKind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"restart">, import("typebox").TLiteral<"hot">, import("typebox").TLiteral<"none">]>>;
            hint: import("typebox").TOptional<import("typebox").TObject<{
                label: import("typebox").TOptional<import("typebox").TString>;
                help: import("typebox").TOptional<import("typebox").TString>;
                tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                group: import("typebox").TOptional<import("typebox").TString>;
                order: import("typebox").TOptional<import("typebox").TInteger>;
                advanced: import("typebox").TOptional<import("typebox").TBoolean>;
                sensitive: import("typebox").TOptional<import("typebox").TBoolean>;
                placeholder: import("typebox").TOptional<import("typebox").TString>;
                itemTemplate: import("typebox").TOptional<import("typebox").TUnknown>;
            }>>;
            hintPath: import("typebox").TOptional<import("typebox").TString>;
        }>>;
    }>;
    WizardStartParams: import("typebox").TObject<{
        mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"local">, import("typebox").TLiteral<"remote">]>>;
        workspace: import("typebox").TOptional<import("typebox").TString>;
    }>;
    WizardNextParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        answer: import("typebox").TOptional<import("typebox").TObject<{
            stepId: import("typebox").TString;
            value: import("typebox").TOptional<import("typebox").TUnknown>;
        }>>;
    }>;
    WizardCancelParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
    }>;
    WizardStatusParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
    }>;
    WizardStep: import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TUnion<[import("typebox").TLiteral<"note">, import("typebox").TLiteral<"select">, import("typebox").TLiteral<"text">, import("typebox").TLiteral<"confirm">, import("typebox").TLiteral<"multiselect">, import("typebox").TLiteral<"progress">, import("typebox").TLiteral<"action">]>;
        title: import("typebox").TOptional<import("typebox").TString>;
        message: import("typebox").TOptional<import("typebox").TString>;
        format: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"plain">]>>;
        options: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
            value: import("typebox").TUnknown;
            label: import("typebox").TString;
            hint: import("typebox").TOptional<import("typebox").TString>;
        }>>>;
        initialValue: import("typebox").TOptional<import("typebox").TUnknown>;
        placeholder: import("typebox").TOptional<import("typebox").TString>;
        sensitive: import("typebox").TOptional<import("typebox").TBoolean>;
        executor: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"gateway">, import("typebox").TLiteral<"client">]>>;
    }>;
    WizardNextResult: import("typebox").TObject<{
        done: import("typebox").TBoolean;
        step: import("typebox").TOptional<import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TUnion<[import("typebox").TLiteral<"note">, import("typebox").TLiteral<"select">, import("typebox").TLiteral<"text">, import("typebox").TLiteral<"confirm">, import("typebox").TLiteral<"multiselect">, import("typebox").TLiteral<"progress">, import("typebox").TLiteral<"action">]>;
            title: import("typebox").TOptional<import("typebox").TString>;
            message: import("typebox").TOptional<import("typebox").TString>;
            format: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"plain">]>>;
            options: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                value: import("typebox").TUnknown;
                label: import("typebox").TString;
                hint: import("typebox").TOptional<import("typebox").TString>;
            }>>>;
            initialValue: import("typebox").TOptional<import("typebox").TUnknown>;
            placeholder: import("typebox").TOptional<import("typebox").TString>;
            sensitive: import("typebox").TOptional<import("typebox").TBoolean>;
            executor: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"gateway">, import("typebox").TLiteral<"client">]>>;
        }>>;
        status: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"running">, import("typebox").TLiteral<"done">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"error">]>>;
        error: import("typebox").TOptional<import("typebox").TString>;
    }>;
    WizardStartResult: import("typebox").TObject<{
        done: import("typebox").TBoolean;
        step: import("typebox").TOptional<import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TUnion<[import("typebox").TLiteral<"note">, import("typebox").TLiteral<"select">, import("typebox").TLiteral<"text">, import("typebox").TLiteral<"confirm">, import("typebox").TLiteral<"multiselect">, import("typebox").TLiteral<"progress">, import("typebox").TLiteral<"action">]>;
            title: import("typebox").TOptional<import("typebox").TString>;
            message: import("typebox").TOptional<import("typebox").TString>;
            format: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"plain">]>>;
            options: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                value: import("typebox").TUnknown;
                label: import("typebox").TString;
                hint: import("typebox").TOptional<import("typebox").TString>;
            }>>>;
            initialValue: import("typebox").TOptional<import("typebox").TUnknown>;
            placeholder: import("typebox").TOptional<import("typebox").TString>;
            sensitive: import("typebox").TOptional<import("typebox").TBoolean>;
            executor: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"gateway">, import("typebox").TLiteral<"client">]>>;
        }>>;
        status: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"running">, import("typebox").TLiteral<"done">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"error">]>>;
        error: import("typebox").TOptional<import("typebox").TString>;
        sessionId: import("typebox").TString;
    }>;
    WizardStatusResult: import("typebox").TObject<{
        status: import("typebox").TUnion<[import("typebox").TLiteral<"running">, import("typebox").TLiteral<"done">, import("typebox").TLiteral<"cancelled">, import("typebox").TLiteral<"error">]>;
        error: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TalkModeParams: import("typebox").TObject<{
        enabled: import("typebox").TBoolean;
        phase: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TalkEvent: import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TUnion<[import("typebox").TLiteral<"session.started">, import("typebox").TLiteral<"session.ready">, import("typebox").TLiteral<"session.closed">, import("typebox").TLiteral<"session.error">, import("typebox").TLiteral<"session.replaced">, import("typebox").TLiteral<"turn.started">, import("typebox").TLiteral<"turn.ended">, import("typebox").TLiteral<"turn.cancelled">, import("typebox").TLiteral<"capture.started">, import("typebox").TLiteral<"capture.stopped">, import("typebox").TLiteral<"capture.cancelled">, import("typebox").TLiteral<"capture.once">, import("typebox").TLiteral<"input.audio.delta">, import("typebox").TLiteral<"input.audio.committed">, import("typebox").TLiteral<"transcript.delta">, import("typebox").TLiteral<"transcript.done">, import("typebox").TLiteral<"output.text.delta">, import("typebox").TLiteral<"output.text.done">, import("typebox").TLiteral<"output.audio.started">, import("typebox").TLiteral<"output.audio.delta">, import("typebox").TLiteral<"output.audio.done">, import("typebox").TLiteral<"tool.call">, import("typebox").TLiteral<"tool.progress">, import("typebox").TLiteral<"tool.result">, import("typebox").TLiteral<"tool.error">, import("typebox").TLiteral<"usage.metrics">, import("typebox").TLiteral<"latency.metrics">, import("typebox").TLiteral<"health.changed">]>;
        sessionId: import("typebox").TString;
        turnId: import("typebox").TOptional<import("typebox").TString>;
        captureId: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        timestamp: import("typebox").TString;
        mode: import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>;
        transport: import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>;
        brain: import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>;
        provider: import("typebox").TOptional<import("typebox").TString>;
        final: import("typebox").TOptional<import("typebox").TBoolean>;
        callId: import("typebox").TOptional<import("typebox").TString>;
        itemId: import("typebox").TOptional<import("typebox").TString>;
        parentId: import("typebox").TOptional<import("typebox").TString>;
        payload: import("typebox").TUnknown;
    }>;
    TalkCatalogParams: import("typebox").TObject<{}>;
    TalkCatalogResult: import("typebox").TObject<{
        modes: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>>;
        transports: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>>;
        brains: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>>;
        speech: import("typebox").TObject<{
            activeProvider: import("typebox").TOptional<import("typebox").TString>;
            providers: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                label: import("typebox").TString;
                configured: import("typebox").TBoolean;
                models: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                voices: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                defaultModel: import("typebox").TOptional<import("typebox").TString>;
                modes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>>>;
                transports: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>>>;
                brains: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>>>;
                inputAudioFormats: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    encoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
                    sampleRateHz: import("typebox").TInteger;
                    channels: import("typebox").TInteger;
                }>>>;
                outputAudioFormats: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    encoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
                    sampleRateHz: import("typebox").TInteger;
                    channels: import("typebox").TInteger;
                }>>>;
                supportsBrowserSession: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsBargeIn: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsToolCalls: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsVideoFrames: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsSessionResumption: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>;
        }>;
        transcription: import("typebox").TObject<{
            activeProvider: import("typebox").TOptional<import("typebox").TString>;
            providers: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                label: import("typebox").TString;
                configured: import("typebox").TBoolean;
                models: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                voices: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                defaultModel: import("typebox").TOptional<import("typebox").TString>;
                modes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>>>;
                transports: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>>>;
                brains: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>>>;
                inputAudioFormats: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    encoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
                    sampleRateHz: import("typebox").TInteger;
                    channels: import("typebox").TInteger;
                }>>>;
                outputAudioFormats: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    encoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
                    sampleRateHz: import("typebox").TInteger;
                    channels: import("typebox").TInteger;
                }>>>;
                supportsBrowserSession: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsBargeIn: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsToolCalls: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsVideoFrames: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsSessionResumption: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>;
        }>;
        realtime: import("typebox").TObject<{
            activeProvider: import("typebox").TOptional<import("typebox").TString>;
            providers: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                label: import("typebox").TString;
                configured: import("typebox").TBoolean;
                models: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                voices: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                defaultModel: import("typebox").TOptional<import("typebox").TString>;
                modes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>>>;
                transports: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>>>;
                brains: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>>>;
                inputAudioFormats: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    encoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
                    sampleRateHz: import("typebox").TInteger;
                    channels: import("typebox").TInteger;
                }>>>;
                outputAudioFormats: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    encoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
                    sampleRateHz: import("typebox").TInteger;
                    channels: import("typebox").TInteger;
                }>>>;
                supportsBrowserSession: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsBargeIn: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsToolCalls: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsVideoFrames: import("typebox").TOptional<import("typebox").TBoolean>;
                supportsSessionResumption: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>;
        }>;
    }>;
    TalkClientCreateParams: import("typebox").TObject<{
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        provider: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        vadThreshold: import("typebox").TOptional<import("typebox").TNumber>;
        silenceDurationMs: import("typebox").TOptional<import("typebox").TInteger>;
        prefixPaddingMs: import("typebox").TOptional<import("typebox").TInteger>;
        reasoningEffort: import("typebox").TOptional<import("typebox").TString>;
        mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>>;
        transport: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>>;
        brain: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>>;
    }>;
    TalkClientCreateResult: import("typebox").TUnion<[import("typebox").TObject<{
        provider: import("typebox").TString;
        transport: import("typebox").TLiteral<"webrtc">;
        clientSecret: import("typebox").TString;
        offerUrl: import("typebox").TOptional<import("typebox").TString>;
        offerHeaders: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        expiresAt: import("typebox").TOptional<import("typebox").TNumber>;
    }>, import("typebox").TObject<{
        provider: import("typebox").TString;
        transport: import("typebox").TLiteral<"provider-websocket">;
        protocol: import("typebox").TString;
        clientSecret: import("typebox").TString;
        websocketUrl: import("typebox").TString;
        audio: import("typebox").TObject<{
            inputEncoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
            inputSampleRateHz: import("typebox").TInteger;
            outputEncoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
            outputSampleRateHz: import("typebox").TInteger;
        }>;
        initialMessage: import("typebox").TOptional<import("typebox").TUnknown>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        expiresAt: import("typebox").TOptional<import("typebox").TNumber>;
    }>, import("typebox").TObject<{
        provider: import("typebox").TString;
        transport: import("typebox").TLiteral<"gateway-relay">;
        relaySessionId: import("typebox").TString;
        audio: import("typebox").TObject<{
            inputEncoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
            inputSampleRateHz: import("typebox").TInteger;
            outputEncoding: import("typebox").TUnion<[import("typebox").TLiteral<"pcm16">, import("typebox").TLiteral<"g711_ulaw">]>;
            outputSampleRateHz: import("typebox").TInteger;
        }>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        expiresAt: import("typebox").TOptional<import("typebox").TNumber>;
    }>, import("typebox").TObject<{
        provider: import("typebox").TString;
        transport: import("typebox").TLiteral<"managed-room">;
        roomUrl: import("typebox").TString;
        token: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        expiresAt: import("typebox").TOptional<import("typebox").TNumber>;
    }>]>;
    TalkClientToolCallParams: import("typebox").TObject<{
        sessionKey: import("typebox").TString;
        callId: import("typebox").TString;
        name: import("typebox").TString;
        args: import("typebox").TOptional<import("typebox").TUnknown>;
        relaySessionId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TalkClientToolCallResult: import("typebox").TObject<{
        runId: import("typebox").TString;
        idempotencyKey: import("typebox").TString;
    }>;
    TalkConfigParams: import("typebox").TObject<{
        includeSecrets: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    TalkConfigResult: import("typebox").TObject<{
        config: import("typebox").TObject<{
            talk: import("typebox").TOptional<import("typebox").TObject<{
                provider: import("typebox").TOptional<import("typebox").TString>;
                providers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    apiKey: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TUnion<[import("typebox").TObject<{
                        source: import("typebox").TLiteral<"env">;
                        provider: import("typebox").TString;
                        id: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        source: import("typebox").TLiteral<"file">;
                        provider: import("typebox").TString;
                        id: import("typebox").TUnsafe<string>;
                    }>, import("typebox").TObject<{
                        source: import("typebox").TLiteral<"exec">;
                        provider: import("typebox").TString;
                        id: import("typebox").TString;
                    }>]>]>>;
                }>>>;
                realtime: import("typebox").TOptional<import("typebox").TObject<{
                    provider: import("typebox").TOptional<import("typebox").TString>;
                    providers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                        apiKey: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TUnion<[import("typebox").TObject<{
                            source: import("typebox").TLiteral<"env">;
                            provider: import("typebox").TString;
                            id: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            source: import("typebox").TLiteral<"file">;
                            provider: import("typebox").TString;
                            id: import("typebox").TUnsafe<string>;
                        }>, import("typebox").TObject<{
                            source: import("typebox").TLiteral<"exec">;
                            provider: import("typebox").TString;
                            id: import("typebox").TString;
                        }>]>]>>;
                    }>>>;
                    model: import("typebox").TOptional<import("typebox").TString>;
                    voice: import("typebox").TOptional<import("typebox").TString>;
                    instructions: import("typebox").TOptional<import("typebox").TString>;
                    mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>>;
                    transport: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>>;
                    brain: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>>;
                }>>;
                resolved: import("typebox").TOptional<import("typebox").TObject<{
                    provider: import("typebox").TString;
                    config: import("typebox").TObject<{
                        apiKey: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TUnion<[import("typebox").TObject<{
                            source: import("typebox").TLiteral<"env">;
                            provider: import("typebox").TString;
                            id: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            source: import("typebox").TLiteral<"file">;
                            provider: import("typebox").TString;
                            id: import("typebox").TUnsafe<string>;
                        }>, import("typebox").TObject<{
                            source: import("typebox").TLiteral<"exec">;
                            provider: import("typebox").TString;
                            id: import("typebox").TString;
                        }>]>]>>;
                    }>;
                }>>;
                consultThinkingLevel: import("typebox").TOptional<import("typebox").TString>;
                consultFastMode: import("typebox").TOptional<import("typebox").TBoolean>;
                speechLocale: import("typebox").TOptional<import("typebox").TString>;
                interruptOnSpeech: import("typebox").TOptional<import("typebox").TBoolean>;
                silenceTimeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
            }>>;
            session: import("typebox").TOptional<import("typebox").TObject<{
                mainKey: import("typebox").TOptional<import("typebox").TString>;
            }>>;
            ui: import("typebox").TOptional<import("typebox").TObject<{
                seamColor: import("typebox").TOptional<import("typebox").TString>;
            }>>;
        }>;
    }>;
    TalkSessionAppendAudioParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        audioBase64: import("typebox").TString;
        timestamp: import("typebox").TOptional<import("typebox").TNumber>;
    }>;
    TalkSessionCancelOutputParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        turnId: import("typebox").TOptional<import("typebox").TString>;
        reason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TalkSessionCancelTurnParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        turnId: import("typebox").TOptional<import("typebox").TString>;
        reason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TalkSessionCreateParams: import("typebox").TObject<{
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        provider: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        vadThreshold: import("typebox").TOptional<import("typebox").TNumber>;
        silenceDurationMs: import("typebox").TOptional<import("typebox").TInteger>;
        prefixPaddingMs: import("typebox").TOptional<import("typebox").TInteger>;
        reasoningEffort: import("typebox").TOptional<import("typebox").TString>;
        mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>>;
        transport: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>>;
        brain: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>>;
        ttlMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    TalkSessionCreateResult: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        provider: import("typebox").TOptional<import("typebox").TString>;
        mode: import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>;
        transport: import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>;
        brain: import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>;
        relaySessionId: import("typebox").TOptional<import("typebox").TString>;
        transcriptionSessionId: import("typebox").TOptional<import("typebox").TString>;
        handoffId: import("typebox").TOptional<import("typebox").TString>;
        roomId: import("typebox").TOptional<import("typebox").TString>;
        roomUrl: import("typebox").TOptional<import("typebox").TString>;
        token: import("typebox").TOptional<import("typebox").TString>;
        audio: import("typebox").TOptional<import("typebox").TUnknown>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        expiresAt: import("typebox").TOptional<import("typebox").TNumber>;
    }>;
    TalkSessionJoinParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        token: import("typebox").TString;
    }>;
    TalkSessionJoinResult: import("typebox").TObject<{
        id: import("typebox").TString;
        roomId: import("typebox").TString;
        roomUrl: import("typebox").TString;
        sessionKey: import("typebox").TString;
        sessionId: import("typebox").TOptional<import("typebox").TString>;
        channel: import("typebox").TOptional<import("typebox").TString>;
        target: import("typebox").TOptional<import("typebox").TString>;
        provider: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TString>;
        voice: import("typebox").TOptional<import("typebox").TString>;
        mode: import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>;
        transport: import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>;
        brain: import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>;
        createdAt: import("typebox").TNumber;
        expiresAt: import("typebox").TNumber;
        room: import("typebox").TObject<{
            activeClientId: import("typebox").TOptional<import("typebox").TString>;
            activeTurnId: import("typebox").TOptional<import("typebox").TString>;
            recentTalkEvents: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TUnion<[import("typebox").TLiteral<"session.started">, import("typebox").TLiteral<"session.ready">, import("typebox").TLiteral<"session.closed">, import("typebox").TLiteral<"session.error">, import("typebox").TLiteral<"session.replaced">, import("typebox").TLiteral<"turn.started">, import("typebox").TLiteral<"turn.ended">, import("typebox").TLiteral<"turn.cancelled">, import("typebox").TLiteral<"capture.started">, import("typebox").TLiteral<"capture.stopped">, import("typebox").TLiteral<"capture.cancelled">, import("typebox").TLiteral<"capture.once">, import("typebox").TLiteral<"input.audio.delta">, import("typebox").TLiteral<"input.audio.committed">, import("typebox").TLiteral<"transcript.delta">, import("typebox").TLiteral<"transcript.done">, import("typebox").TLiteral<"output.text.delta">, import("typebox").TLiteral<"output.text.done">, import("typebox").TLiteral<"output.audio.started">, import("typebox").TLiteral<"output.audio.delta">, import("typebox").TLiteral<"output.audio.done">, import("typebox").TLiteral<"tool.call">, import("typebox").TLiteral<"tool.progress">, import("typebox").TLiteral<"tool.result">, import("typebox").TLiteral<"tool.error">, import("typebox").TLiteral<"usage.metrics">, import("typebox").TLiteral<"latency.metrics">, import("typebox").TLiteral<"health.changed">]>;
                sessionId: import("typebox").TString;
                turnId: import("typebox").TOptional<import("typebox").TString>;
                captureId: import("typebox").TOptional<import("typebox").TString>;
                seq: import("typebox").TInteger;
                timestamp: import("typebox").TString;
                mode: import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>;
                transport: import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>;
                brain: import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>;
                provider: import("typebox").TOptional<import("typebox").TString>;
                final: import("typebox").TOptional<import("typebox").TBoolean>;
                callId: import("typebox").TOptional<import("typebox").TString>;
                itemId: import("typebox").TOptional<import("typebox").TString>;
                parentId: import("typebox").TOptional<import("typebox").TString>;
                payload: import("typebox").TUnknown;
            }>>;
        }>;
    }>;
    TalkSessionTurnParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        turnId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    TalkSessionTurnResult: import("typebox").TObject<{
        ok: import("typebox").TBoolean;
        turnId: import("typebox").TOptional<import("typebox").TString>;
        events: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TUnion<[import("typebox").TLiteral<"session.started">, import("typebox").TLiteral<"session.ready">, import("typebox").TLiteral<"session.closed">, import("typebox").TLiteral<"session.error">, import("typebox").TLiteral<"session.replaced">, import("typebox").TLiteral<"turn.started">, import("typebox").TLiteral<"turn.ended">, import("typebox").TLiteral<"turn.cancelled">, import("typebox").TLiteral<"capture.started">, import("typebox").TLiteral<"capture.stopped">, import("typebox").TLiteral<"capture.cancelled">, import("typebox").TLiteral<"capture.once">, import("typebox").TLiteral<"input.audio.delta">, import("typebox").TLiteral<"input.audio.committed">, import("typebox").TLiteral<"transcript.delta">, import("typebox").TLiteral<"transcript.done">, import("typebox").TLiteral<"output.text.delta">, import("typebox").TLiteral<"output.text.done">, import("typebox").TLiteral<"output.audio.started">, import("typebox").TLiteral<"output.audio.delta">, import("typebox").TLiteral<"output.audio.done">, import("typebox").TLiteral<"tool.call">, import("typebox").TLiteral<"tool.progress">, import("typebox").TLiteral<"tool.result">, import("typebox").TLiteral<"tool.error">, import("typebox").TLiteral<"usage.metrics">, import("typebox").TLiteral<"latency.metrics">, import("typebox").TLiteral<"health.changed">]>;
            sessionId: import("typebox").TString;
            turnId: import("typebox").TOptional<import("typebox").TString>;
            captureId: import("typebox").TOptional<import("typebox").TString>;
            seq: import("typebox").TInteger;
            timestamp: import("typebox").TString;
            mode: import("typebox").TUnion<[import("typebox").TLiteral<"realtime">, import("typebox").TLiteral<"stt-tts">, import("typebox").TLiteral<"transcription">]>;
            transport: import("typebox").TUnion<[import("typebox").TLiteral<"webrtc">, import("typebox").TLiteral<"provider-websocket">, import("typebox").TLiteral<"gateway-relay">, import("typebox").TLiteral<"managed-room">]>;
            brain: import("typebox").TUnion<[import("typebox").TLiteral<"agent-consult">, import("typebox").TLiteral<"direct-tools">, import("typebox").TLiteral<"none">]>;
            provider: import("typebox").TOptional<import("typebox").TString>;
            final: import("typebox").TOptional<import("typebox").TBoolean>;
            callId: import("typebox").TOptional<import("typebox").TString>;
            itemId: import("typebox").TOptional<import("typebox").TString>;
            parentId: import("typebox").TOptional<import("typebox").TString>;
            payload: import("typebox").TUnknown;
        }>>>;
    }>;
    TalkSessionSubmitToolResultParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
        callId: import("typebox").TString;
        result: import("typebox").TUnknown;
        options: import("typebox").TOptional<import("typebox").TObject<{
            suppressResponse: import("typebox").TOptional<import("typebox").TBoolean>;
            willContinue: import("typebox").TOptional<import("typebox").TBoolean>;
        }>>;
    }>;
    TalkSessionCloseParams: import("typebox").TObject<{
        sessionId: import("typebox").TString;
    }>;
    TalkSessionOkResult: import("typebox").TObject<{
        ok: import("typebox").TBoolean;
    }>;
    TalkSpeakParams: import("typebox").TObject<{
        text: import("typebox").TString;
        voiceId: import("typebox").TOptional<import("typebox").TString>;
        modelId: import("typebox").TOptional<import("typebox").TString>;
        outputFormat: import("typebox").TOptional<import("typebox").TString>;
        speed: import("typebox").TOptional<import("typebox").TNumber>;
        rateWpm: import("typebox").TOptional<import("typebox").TInteger>;
        stability: import("typebox").TOptional<import("typebox").TNumber>;
        similarity: import("typebox").TOptional<import("typebox").TNumber>;
        style: import("typebox").TOptional<import("typebox").TNumber>;
        speakerBoost: import("typebox").TOptional<import("typebox").TBoolean>;
        seed: import("typebox").TOptional<import("typebox").TInteger>;
        normalize: import("typebox").TOptional<import("typebox").TString>;
        language: import("typebox").TOptional<import("typebox").TString>;
        latencyTier: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    TalkSpeakResult: import("typebox").TObject<{
        audioBase64: import("typebox").TString;
        provider: import("typebox").TString;
        outputFormat: import("typebox").TOptional<import("typebox").TString>;
        voiceCompatible: import("typebox").TOptional<import("typebox").TBoolean>;
        mimeType: import("typebox").TOptional<import("typebox").TString>;
        fileExtension: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChannelsStatusParams: import("typebox").TObject<{
        probe: import("typebox").TOptional<import("typebox").TBoolean>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        channel: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChannelsStatusResult: import("typebox").TObject<{
        ts: import("typebox").TInteger;
        channelOrder: import("typebox").TArray<import("typebox").TString>;
        channelLabels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
        channelDetailLabels: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
        channelSystemImages: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
        channelMeta: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            label: import("typebox").TString;
            detailLabel: import("typebox").TString;
            systemImage: import("typebox").TOptional<import("typebox").TString>;
        }>>>;
        channels: import("typebox").TRecord<"^.*$", import("typebox").TUnknown>;
        channelAccounts: import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TObject<{
            accountId: import("typebox").TString;
            name: import("typebox").TOptional<import("typebox").TString>;
            enabled: import("typebox").TOptional<import("typebox").TBoolean>;
            configured: import("typebox").TOptional<import("typebox").TBoolean>;
            linked: import("typebox").TOptional<import("typebox").TBoolean>;
            running: import("typebox").TOptional<import("typebox").TBoolean>;
            connected: import("typebox").TOptional<import("typebox").TBoolean>;
            reconnectAttempts: import("typebox").TOptional<import("typebox").TInteger>;
            lastConnectedAt: import("typebox").TOptional<import("typebox").TInteger>;
            lastError: import("typebox").TOptional<import("typebox").TString>;
            healthState: import("typebox").TOptional<import("typebox").TString>;
            lastStartAt: import("typebox").TOptional<import("typebox").TInteger>;
            lastStopAt: import("typebox").TOptional<import("typebox").TInteger>;
            lastInboundAt: import("typebox").TOptional<import("typebox").TInteger>;
            lastOutboundAt: import("typebox").TOptional<import("typebox").TInteger>;
            lastTransportActivityAt: import("typebox").TOptional<import("typebox").TInteger>;
            busy: import("typebox").TOptional<import("typebox").TBoolean>;
            activeRuns: import("typebox").TOptional<import("typebox").TInteger>;
            lastRunActivityAt: import("typebox").TOptional<import("typebox").TInteger>;
            lastProbeAt: import("typebox").TOptional<import("typebox").TInteger>;
            mode: import("typebox").TOptional<import("typebox").TString>;
            dmPolicy: import("typebox").TOptional<import("typebox").TString>;
            allowFrom: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            tokenSource: import("typebox").TOptional<import("typebox").TString>;
            botTokenSource: import("typebox").TOptional<import("typebox").TString>;
            appTokenSource: import("typebox").TOptional<import("typebox").TString>;
            baseUrl: import("typebox").TOptional<import("typebox").TString>;
            allowUnmentionedGroups: import("typebox").TOptional<import("typebox").TBoolean>;
            cliPath: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
            dbPath: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
            port: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>>;
            probe: import("typebox").TOptional<import("typebox").TUnknown>;
            audit: import("typebox").TOptional<import("typebox").TUnknown>;
            application: import("typebox").TOptional<import("typebox").TUnknown>;
        }>>>;
        channelDefaultAccountId: import("typebox").TRecord<"^.*$", import("typebox").TString>;
        eventLoop: import("typebox").TOptional<import("typebox").TObject<{
            degraded: import("typebox").TBoolean;
            reasons: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"event_loop_delay">, import("typebox").TLiteral<"event_loop_utilization">, import("typebox").TLiteral<"cpu">]>>;
            intervalMs: import("typebox").TInteger;
            delayP99Ms: import("typebox").TNumber;
            delayMaxMs: import("typebox").TNumber;
            utilization: import("typebox").TNumber;
            cpuCoreRatio: import("typebox").TNumber;
        }>>;
        partial: import("typebox").TOptional<import("typebox").TBoolean>;
        warnings: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    ChannelsStartParams: import("typebox").TObject<{
        channel: import("typebox").TString;
        accountId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChannelsStopParams: import("typebox").TObject<{
        channel: import("typebox").TString;
        accountId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChannelsLogoutParams: import("typebox").TObject<{
        channel: import("typebox").TString;
        accountId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    WebLoginStartParams: import("typebox").TObject<{
        force: import("typebox").TOptional<import("typebox").TBoolean>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        verbose: import("typebox").TOptional<import("typebox").TBoolean>;
        accountId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    WebLoginWaitParams: import("typebox").TObject<{
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        accountId: import("typebox").TOptional<import("typebox").TString>;
        currentQrDataUrl: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentSummary: import("typebox").TObject<{
        id: import("typebox").TString;
        name: import("typebox").TOptional<import("typebox").TString>;
        identity: import("typebox").TOptional<import("typebox").TObject<{
            name: import("typebox").TOptional<import("typebox").TString>;
            theme: import("typebox").TOptional<import("typebox").TString>;
            emoji: import("typebox").TOptional<import("typebox").TString>;
            avatar: import("typebox").TOptional<import("typebox").TString>;
            avatarUrl: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        workspace: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TObject<{
            primary: import("typebox").TOptional<import("typebox").TString>;
            fallbacks: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        }>>;
        agentRuntime: import("typebox").TOptional<import("typebox").TObject<{
            id: import("typebox").TString;
            fallback: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"pi">, import("typebox").TLiteral<"none">]>>;
            source: import("typebox").TUnion<[import("typebox").TLiteral<"env">, import("typebox").TLiteral<"agent">, import("typebox").TLiteral<"defaults">, import("typebox").TLiteral<"model">, import("typebox").TLiteral<"provider">, import("typebox").TLiteral<"implicit">]>;
        }>>;
    }>;
    AgentsCreateParams: import("typebox").TObject<{
        name: import("typebox").TString;
        workspace: import("typebox").TString;
        model: import("typebox").TOptional<import("typebox").TString>;
        emoji: import("typebox").TOptional<import("typebox").TString>;
        avatar: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentsCreateResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        agentId: import("typebox").TString;
        name: import("typebox").TString;
        workspace: import("typebox").TString;
        model: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentsUpdateParams: import("typebox").TObject<{
        agentId: import("typebox").TString;
        name: import("typebox").TOptional<import("typebox").TString>;
        workspace: import("typebox").TOptional<import("typebox").TString>;
        model: import("typebox").TOptional<import("typebox").TString>;
        emoji: import("typebox").TOptional<import("typebox").TString>;
        avatar: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentsUpdateResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        agentId: import("typebox").TString;
    }>;
    AgentsDeleteParams: import("typebox").TObject<{
        agentId: import("typebox").TString;
        deleteFiles: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    AgentsDeleteResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        agentId: import("typebox").TString;
        removedBindings: import("typebox").TInteger;
    }>;
    AgentsFileEntry: import("typebox").TObject<{
        name: import("typebox").TString;
        path: import("typebox").TString;
        missing: import("typebox").TBoolean;
        size: import("typebox").TOptional<import("typebox").TInteger>;
        updatedAtMs: import("typebox").TOptional<import("typebox").TInteger>;
        content: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentsFilesListParams: import("typebox").TObject<{
        agentId: import("typebox").TString;
    }>;
    AgentsFilesListResult: import("typebox").TObject<{
        agentId: import("typebox").TString;
        workspace: import("typebox").TString;
        files: import("typebox").TArray<import("typebox").TObject<{
            name: import("typebox").TString;
            path: import("typebox").TString;
            missing: import("typebox").TBoolean;
            size: import("typebox").TOptional<import("typebox").TInteger>;
            updatedAtMs: import("typebox").TOptional<import("typebox").TInteger>;
            content: import("typebox").TOptional<import("typebox").TString>;
        }>>;
    }>;
    AgentsFilesGetParams: import("typebox").TObject<{
        agentId: import("typebox").TString;
        name: import("typebox").TString;
    }>;
    AgentsFilesGetResult: import("typebox").TObject<{
        agentId: import("typebox").TString;
        workspace: import("typebox").TString;
        file: import("typebox").TObject<{
            name: import("typebox").TString;
            path: import("typebox").TString;
            missing: import("typebox").TBoolean;
            size: import("typebox").TOptional<import("typebox").TInteger>;
            updatedAtMs: import("typebox").TOptional<import("typebox").TInteger>;
            content: import("typebox").TOptional<import("typebox").TString>;
        }>;
    }>;
    AgentsFilesSetParams: import("typebox").TObject<{
        agentId: import("typebox").TString;
        name: import("typebox").TString;
        content: import("typebox").TString;
    }>;
    AgentsFilesSetResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        agentId: import("typebox").TString;
        workspace: import("typebox").TString;
        file: import("typebox").TObject<{
            name: import("typebox").TString;
            path: import("typebox").TString;
            missing: import("typebox").TBoolean;
            size: import("typebox").TOptional<import("typebox").TInteger>;
            updatedAtMs: import("typebox").TOptional<import("typebox").TInteger>;
            content: import("typebox").TOptional<import("typebox").TString>;
        }>;
    }>;
    ArtifactSummary: import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TString;
        title: import("typebox").TString;
        mimeType: import("typebox").TOptional<import("typebox").TString>;
        sizeBytes: import("typebox").TOptional<import("typebox").TInteger>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        taskId: import("typebox").TOptional<import("typebox").TString>;
        messageSeq: import("typebox").TOptional<import("typebox").TInteger>;
        source: import("typebox").TOptional<import("typebox").TString>;
        download: import("typebox").TObject<{
            mode: import("typebox").TUnion<[import("typebox").TLiteral<"bytes">, import("typebox").TLiteral<"url">, import("typebox").TLiteral<"unsupported">]>;
        }>;
    }>;
    ArtifactsListParams: import("typebox").TObject<{
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        taskId: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ArtifactsListResult: import("typebox").TObject<{
        artifacts: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            title: import("typebox").TString;
            mimeType: import("typebox").TOptional<import("typebox").TString>;
            sizeBytes: import("typebox").TOptional<import("typebox").TInteger>;
            sessionKey: import("typebox").TOptional<import("typebox").TString>;
            runId: import("typebox").TOptional<import("typebox").TString>;
            taskId: import("typebox").TOptional<import("typebox").TString>;
            messageSeq: import("typebox").TOptional<import("typebox").TInteger>;
            source: import("typebox").TOptional<import("typebox").TString>;
            download: import("typebox").TObject<{
                mode: import("typebox").TUnion<[import("typebox").TLiteral<"bytes">, import("typebox").TLiteral<"url">, import("typebox").TLiteral<"unsupported">]>;
            }>;
        }>>;
    }>;
    ArtifactsGetParams: import("typebox").TObject<{
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        taskId: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        artifactId: import("typebox").TString;
    }>;
    ArtifactsGetResult: import("typebox").TObject<{
        artifact: import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            title: import("typebox").TString;
            mimeType: import("typebox").TOptional<import("typebox").TString>;
            sizeBytes: import("typebox").TOptional<import("typebox").TInteger>;
            sessionKey: import("typebox").TOptional<import("typebox").TString>;
            runId: import("typebox").TOptional<import("typebox").TString>;
            taskId: import("typebox").TOptional<import("typebox").TString>;
            messageSeq: import("typebox").TOptional<import("typebox").TInteger>;
            source: import("typebox").TOptional<import("typebox").TString>;
            download: import("typebox").TObject<{
                mode: import("typebox").TUnion<[import("typebox").TLiteral<"bytes">, import("typebox").TLiteral<"url">, import("typebox").TLiteral<"unsupported">]>;
            }>;
        }>;
    }>;
    ArtifactsDownloadParams: import("typebox").TObject<{
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        taskId: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        artifactId: import("typebox").TString;
    }>;
    ArtifactsDownloadResult: import("typebox").TObject<{
        artifact: import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            title: import("typebox").TString;
            mimeType: import("typebox").TOptional<import("typebox").TString>;
            sizeBytes: import("typebox").TOptional<import("typebox").TInteger>;
            sessionKey: import("typebox").TOptional<import("typebox").TString>;
            runId: import("typebox").TOptional<import("typebox").TString>;
            taskId: import("typebox").TOptional<import("typebox").TString>;
            messageSeq: import("typebox").TOptional<import("typebox").TInteger>;
            source: import("typebox").TOptional<import("typebox").TString>;
            download: import("typebox").TObject<{
                mode: import("typebox").TUnion<[import("typebox").TLiteral<"bytes">, import("typebox").TLiteral<"url">, import("typebox").TLiteral<"unsupported">]>;
            }>;
        }>;
        encoding: import("typebox").TOptional<import("typebox").TLiteral<"base64">>;
        data: import("typebox").TOptional<import("typebox").TString>;
        url: import("typebox").TOptional<import("typebox").TString>;
    }>;
    AgentsListParams: import("typebox").TObject<{}>;
    AgentsListResult: import("typebox").TObject<{
        defaultId: import("typebox").TString;
        mainKey: import("typebox").TString;
        scope: import("typebox").TUnion<[import("typebox").TLiteral<"per-sender">, import("typebox").TLiteral<"global">]>;
        agents: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            name: import("typebox").TOptional<import("typebox").TString>;
            identity: import("typebox").TOptional<import("typebox").TObject<{
                name: import("typebox").TOptional<import("typebox").TString>;
                theme: import("typebox").TOptional<import("typebox").TString>;
                emoji: import("typebox").TOptional<import("typebox").TString>;
                avatar: import("typebox").TOptional<import("typebox").TString>;
                avatarUrl: import("typebox").TOptional<import("typebox").TString>;
            }>>;
            workspace: import("typebox").TOptional<import("typebox").TString>;
            model: import("typebox").TOptional<import("typebox").TObject<{
                primary: import("typebox").TOptional<import("typebox").TString>;
                fallbacks: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            }>>;
            agentRuntime: import("typebox").TOptional<import("typebox").TObject<{
                id: import("typebox").TString;
                fallback: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"pi">, import("typebox").TLiteral<"none">]>>;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"env">, import("typebox").TLiteral<"agent">, import("typebox").TLiteral<"defaults">, import("typebox").TLiteral<"model">, import("typebox").TLiteral<"provider">, import("typebox").TLiteral<"implicit">]>;
            }>>;
        }>>;
    }>;
    ModelChoice: import("typebox").TObject<{
        id: import("typebox").TString;
        name: import("typebox").TString;
        provider: import("typebox").TString;
        alias: import("typebox").TOptional<import("typebox").TString>;
        contextWindow: import("typebox").TOptional<import("typebox").TInteger>;
        reasoning: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    ModelsListParams: import("typebox").TObject<{
        view: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"default">, import("typebox").TLiteral<"configured">, import("typebox").TLiteral<"all">]>>;
    }>;
    ModelsListResult: import("typebox").TObject<{
        models: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            name: import("typebox").TString;
            provider: import("typebox").TString;
            alias: import("typebox").TOptional<import("typebox").TString>;
            contextWindow: import("typebox").TOptional<import("typebox").TInteger>;
            reasoning: import("typebox").TOptional<import("typebox").TBoolean>;
        }>>;
    }>;
    CommandEntry: import("typebox").TObject<{
        name: import("typebox").TString;
        nativeName: import("typebox").TOptional<import("typebox").TString>;
        textAliases: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        description: import("typebox").TString;
        category: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"session">, import("typebox").TLiteral<"options">, import("typebox").TLiteral<"status">, import("typebox").TLiteral<"management">, import("typebox").TLiteral<"media">, import("typebox").TLiteral<"tools">, import("typebox").TLiteral<"docks">]>>;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"skill">, import("typebox").TLiteral<"plugin">]>;
        scope: import("typebox").TUnion<[import("typebox").TLiteral<"text">, import("typebox").TLiteral<"native">, import("typebox").TLiteral<"both">]>;
        acceptsArgs: import("typebox").TBoolean;
        args: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
            name: import("typebox").TString;
            description: import("typebox").TString;
            type: import("typebox").TUnion<[import("typebox").TLiteral<"string">, import("typebox").TLiteral<"number">, import("typebox").TLiteral<"boolean">]>;
            required: import("typebox").TOptional<import("typebox").TBoolean>;
            choices: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                value: import("typebox").TString;
                label: import("typebox").TString;
            }>>>;
            dynamic: import("typebox").TOptional<import("typebox").TBoolean>;
        }>>>;
    }>;
    CommandsListParams: import("typebox").TObject<{
        agentId: import("typebox").TOptional<import("typebox").TString>;
        provider: import("typebox").TOptional<import("typebox").TString>;
        scope: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"text">, import("typebox").TLiteral<"native">, import("typebox").TLiteral<"both">]>>;
        includeArgs: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    CommandsListResult: import("typebox").TObject<{
        commands: import("typebox").TArray<import("typebox").TObject<{
            name: import("typebox").TString;
            nativeName: import("typebox").TOptional<import("typebox").TString>;
            textAliases: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            description: import("typebox").TString;
            category: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"session">, import("typebox").TLiteral<"options">, import("typebox").TLiteral<"status">, import("typebox").TLiteral<"management">, import("typebox").TLiteral<"media">, import("typebox").TLiteral<"tools">, import("typebox").TLiteral<"docks">]>>;
            source: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"skill">, import("typebox").TLiteral<"plugin">]>;
            scope: import("typebox").TUnion<[import("typebox").TLiteral<"text">, import("typebox").TLiteral<"native">, import("typebox").TLiteral<"both">]>;
            acceptsArgs: import("typebox").TBoolean;
            args: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                name: import("typebox").TString;
                description: import("typebox").TString;
                type: import("typebox").TUnion<[import("typebox").TLiteral<"string">, import("typebox").TLiteral<"number">, import("typebox").TLiteral<"boolean">]>;
                required: import("typebox").TOptional<import("typebox").TBoolean>;
                choices: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    value: import("typebox").TString;
                    label: import("typebox").TString;
                }>>>;
                dynamic: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>>;
        }>>;
    }>;
    SkillsStatusParams: import("typebox").TObject<{
        agentId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ToolsCatalogParams: import("typebox").TObject<{
        agentId: import("typebox").TOptional<import("typebox").TString>;
        includePlugins: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    ToolCatalogProfile: import("typebox").TObject<{
        id: import("typebox").TUnion<[import("typebox").TLiteral<"minimal">, import("typebox").TLiteral<"coding">, import("typebox").TLiteral<"messaging">, import("typebox").TLiteral<"full">]>;
        label: import("typebox").TString;
    }>;
    ToolCatalogEntry: import("typebox").TObject<{
        id: import("typebox").TString;
        label: import("typebox").TString;
        description: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">]>;
        pluginId: import("typebox").TOptional<import("typebox").TString>;
        optional: import("typebox").TOptional<import("typebox").TBoolean>;
        risk: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"low">, import("typebox").TLiteral<"medium">, import("typebox").TLiteral<"high">]>>;
        tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        defaultProfiles: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"minimal">, import("typebox").TLiteral<"coding">, import("typebox").TLiteral<"messaging">, import("typebox").TLiteral<"full">]>>;
    }>;
    ToolCatalogGroup: import("typebox").TObject<{
        id: import("typebox").TString;
        label: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">]>;
        pluginId: import("typebox").TOptional<import("typebox").TString>;
        tools: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            label: import("typebox").TString;
            description: import("typebox").TString;
            source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">]>;
            pluginId: import("typebox").TOptional<import("typebox").TString>;
            optional: import("typebox").TOptional<import("typebox").TBoolean>;
            risk: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"low">, import("typebox").TLiteral<"medium">, import("typebox").TLiteral<"high">]>>;
            tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            defaultProfiles: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"minimal">, import("typebox").TLiteral<"coding">, import("typebox").TLiteral<"messaging">, import("typebox").TLiteral<"full">]>>;
        }>>;
    }>;
    ToolsCatalogResult: import("typebox").TObject<{
        agentId: import("typebox").TString;
        profiles: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TUnion<[import("typebox").TLiteral<"minimal">, import("typebox").TLiteral<"coding">, import("typebox").TLiteral<"messaging">, import("typebox").TLiteral<"full">]>;
            label: import("typebox").TString;
        }>>;
        groups: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            label: import("typebox").TString;
            source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">]>;
            pluginId: import("typebox").TOptional<import("typebox").TString>;
            tools: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                label: import("typebox").TString;
                description: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">]>;
                pluginId: import("typebox").TOptional<import("typebox").TString>;
                optional: import("typebox").TOptional<import("typebox").TBoolean>;
                risk: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"low">, import("typebox").TLiteral<"medium">, import("typebox").TLiteral<"high">]>>;
                tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                defaultProfiles: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"minimal">, import("typebox").TLiteral<"coding">, import("typebox").TLiteral<"messaging">, import("typebox").TLiteral<"full">]>>;
            }>>;
        }>>;
    }>;
    ToolsEffectiveParams: import("typebox").TObject<{
        agentId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TString;
    }>;
    ToolsEffectiveEntry: import("typebox").TObject<{
        id: import("typebox").TString;
        label: import("typebox").TString;
        description: import("typebox").TString;
        rawDescription: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"channel">]>;
        pluginId: import("typebox").TOptional<import("typebox").TString>;
        channelId: import("typebox").TOptional<import("typebox").TString>;
        risk: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"low">, import("typebox").TLiteral<"medium">, import("typebox").TLiteral<"high">]>>;
        tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    ToolsEffectiveGroup: import("typebox").TObject<{
        id: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"channel">]>;
        label: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"channel">]>;
        tools: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            label: import("typebox").TString;
            description: import("typebox").TString;
            rawDescription: import("typebox").TString;
            source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"channel">]>;
            pluginId: import("typebox").TOptional<import("typebox").TString>;
            channelId: import("typebox").TOptional<import("typebox").TString>;
            risk: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"low">, import("typebox").TLiteral<"medium">, import("typebox").TLiteral<"high">]>>;
            tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        }>>;
    }>;
    ToolsEffectiveResult: import("typebox").TObject<{
        agentId: import("typebox").TString;
        profile: import("typebox").TString;
        groups: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"channel">]>;
            label: import("typebox").TString;
            source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"channel">]>;
            tools: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                label: import("typebox").TString;
                description: import("typebox").TString;
                rawDescription: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"channel">]>;
                pluginId: import("typebox").TOptional<import("typebox").TString>;
                channelId: import("typebox").TOptional<import("typebox").TString>;
                risk: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"low">, import("typebox").TLiteral<"medium">, import("typebox").TLiteral<"high">]>>;
                tags: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            }>>;
        }>>;
    }>;
    ToolsInvokeParams: import("typebox").TObject<{
        name: import("typebox").TString;
        args: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TUnknown>>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        confirm: import("typebox").TOptional<import("typebox").TBoolean>;
        idempotencyKey: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ToolsInvokeError: import("typebox").TObject<{
        code: import("typebox").TString;
        message: import("typebox").TString;
        details: import("typebox").TOptional<import("typebox").TUnknown>;
    }>;
    ToolsInvokeResult: import("typebox").TObject<{
        ok: import("typebox").TBoolean;
        toolName: import("typebox").TString;
        output: import("typebox").TOptional<import("typebox").TUnknown>;
        requiresApproval: import("typebox").TOptional<import("typebox").TBoolean>;
        approvalId: import("typebox").TOptional<import("typebox").TString>;
        source: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"core">, import("typebox").TLiteral<"plugin">, import("typebox").TLiteral<"mcp">, import("typebox").TLiteral<"channel">, import("typebox").TString]>>;
        error: import("typebox").TOptional<import("typebox").TObject<{
            code: import("typebox").TString;
            message: import("typebox").TString;
            details: import("typebox").TOptional<import("typebox").TUnknown>;
        }>>;
    }>;
    SkillsBinsParams: import("typebox").TObject<{}>;
    SkillsBinsResult: import("typebox").TObject<{
        bins: import("typebox").TArray<import("typebox").TString>;
    }>;
    SkillsSearchParams: import("typebox").TObject<{
        query: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    SkillsSearchResult: import("typebox").TObject<{
        results: import("typebox").TArray<import("typebox").TObject<{
            score: import("typebox").TNumber;
            slug: import("typebox").TString;
            displayName: import("typebox").TString;
            summary: import("typebox").TOptional<import("typebox").TString>;
            version: import("typebox").TOptional<import("typebox").TString>;
            updatedAt: import("typebox").TOptional<import("typebox").TInteger>;
        }>>;
    }>;
    SkillsDetailParams: import("typebox").TObject<{
        slug: import("typebox").TString;
    }>;
    SkillsDetailResult: import("typebox").TObject<{
        skill: import("typebox").TUnion<[import("typebox").TObject<{
            slug: import("typebox").TString;
            displayName: import("typebox").TString;
            summary: import("typebox").TOptional<import("typebox").TString>;
            tags: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
            createdAt: import("typebox").TInteger;
            updatedAt: import("typebox").TInteger;
        }>, import("typebox").TNull]>;
        latestVersion: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
            version: import("typebox").TString;
            createdAt: import("typebox").TInteger;
            changelog: import("typebox").TOptional<import("typebox").TString>;
        }>, import("typebox").TNull]>>;
        metadata: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
            os: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TString>, import("typebox").TNull]>>;
            systems: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TString>, import("typebox").TNull]>>;
        }>, import("typebox").TNull]>>;
        owner: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
            handle: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
            displayName: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
            image: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        }>, import("typebox").TNull]>>;
    }>;
    SkillsUploadBeginParams: import("typebox").TObject<{
        kind: import("typebox").TLiteral<"skill-archive">;
        slug: import("typebox").TString;
        sizeBytes: import("typebox").TInteger;
        sha256: import("typebox").TOptional<import("typebox").TString>;
        force: import("typebox").TOptional<import("typebox").TBoolean>;
        idempotencyKey: import("typebox").TOptional<import("typebox").TString>;
    }>;
    SkillsUploadChunkParams: import("typebox").TObject<{
        uploadId: import("typebox").TString;
        offset: import("typebox").TInteger;
        dataBase64: import("typebox").TString;
    }>;
    SkillsUploadCommitParams: import("typebox").TObject<{
        uploadId: import("typebox").TString;
        sha256: import("typebox").TOptional<import("typebox").TString>;
    }>;
    SkillsInstallParams: import("typebox").TUnion<[import("typebox").TObject<{
        name: import("typebox").TString;
        installId: import("typebox").TString;
        dangerouslyForceUnsafeInstall: import("typebox").TOptional<import("typebox").TBoolean>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>, import("typebox").TObject<{
        source: import("typebox").TLiteral<"clawhub">;
        slug: import("typebox").TString;
        version: import("typebox").TOptional<import("typebox").TString>;
        force: import("typebox").TOptional<import("typebox").TBoolean>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>, import("typebox").TObject<{
        source: import("typebox").TLiteral<"upload">;
        uploadId: import("typebox").TString;
        slug: import("typebox").TString;
        force: import("typebox").TOptional<import("typebox").TBoolean>;
        sha256: import("typebox").TOptional<import("typebox").TString>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>]>;
    SkillsUpdateParams: import("typebox").TUnion<[import("typebox").TObject<{
        skillKey: import("typebox").TString;
        enabled: import("typebox").TOptional<import("typebox").TBoolean>;
        apiKey: import("typebox").TOptional<import("typebox").TString>;
        env: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    }>, import("typebox").TObject<{
        source: import("typebox").TLiteral<"clawhub">;
        slug: import("typebox").TOptional<import("typebox").TString>;
        all: import("typebox").TOptional<import("typebox").TBoolean>;
    }>]>;
    CronJob: import("typebox").TObject<{
        id: import("typebox").TString;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        name: import("typebox").TString;
        description: import("typebox").TOptional<import("typebox").TString>;
        enabled: import("typebox").TBoolean;
        deleteAfterRun: import("typebox").TOptional<import("typebox").TBoolean>;
        createdAtMs: import("typebox").TInteger;
        updatedAtMs: import("typebox").TInteger;
        schedule: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"at">;
            at: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"every">;
            everyMs: import("typebox").TInteger;
            anchorMs: import("typebox").TOptional<import("typebox").TInteger>;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"cron">;
            expr: import("typebox").TString;
            tz: import("typebox").TOptional<import("typebox").TString>;
            staggerMs: import("typebox").TOptional<import("typebox").TInteger>;
        }>]>;
        sessionTarget: import("typebox").TUnion<[import("typebox").TLiteral<"main">, import("typebox").TLiteral<"isolated">, import("typebox").TLiteral<"current">, import("typebox").TString]>;
        wakeMode: import("typebox").TUnion<[import("typebox").TLiteral<"next-heartbeat">, import("typebox").TLiteral<"now">]>;
        payload: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"systemEvent">;
            text: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"agentTurn">;
            message: TSchema;
            model: import("typebox").TOptional<import("typebox").TString>;
            fallbacks: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            thinking: import("typebox").TOptional<import("typebox").TString>;
            timeoutSeconds: import("typebox").TOptional<import("typebox").TNumber>;
            allowUnsafeExternalContent: import("typebox").TOptional<import("typebox").TBoolean>;
            lightContext: import("typebox").TOptional<import("typebox").TBoolean>;
            toolsAllow: import("typebox").TOptional<TSchema>;
        }>]>;
        delivery: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            bestEffort: import("typebox").TOptional<import("typebox").TBoolean>;
            failureDestination: import("typebox").TOptional<import("typebox").TObject<{
                channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
                to: import("typebox").TOptional<import("typebox").TString>;
                accountId: import("typebox").TOptional<import("typebox").TString>;
                mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("typebox").TLiteral<"none">;
            to: import("typebox").TOptional<import("typebox").TString>;
        }>, import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            bestEffort: import("typebox").TOptional<import("typebox").TBoolean>;
            failureDestination: import("typebox").TOptional<import("typebox").TObject<{
                channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
                to: import("typebox").TOptional<import("typebox").TString>;
                accountId: import("typebox").TOptional<import("typebox").TString>;
                mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("typebox").TLiteral<"announce">;
            to: import("typebox").TOptional<import("typebox").TString>;
        }>, import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            bestEffort: import("typebox").TOptional<import("typebox").TBoolean>;
            failureDestination: import("typebox").TOptional<import("typebox").TObject<{
                channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
                to: import("typebox").TOptional<import("typebox").TString>;
                accountId: import("typebox").TOptional<import("typebox").TString>;
                mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("typebox").TLiteral<"webhook">;
            to: import("typebox").TString;
        }>]>>;
        failureAlert: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<false>, import("typebox").TObject<{
            after: import("typebox").TOptional<import("typebox").TInteger>;
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            to: import("typebox").TOptional<import("typebox").TString>;
            cooldownMs: import("typebox").TOptional<import("typebox").TInteger>;
            includeSkipped: import("typebox").TOptional<import("typebox").TBoolean>;
            mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
        }>]>>;
        state: import("typebox").TObject<{
            nextRunAtMs: import("typebox").TOptional<import("typebox").TInteger>;
            runningAtMs: import("typebox").TOptional<import("typebox").TInteger>;
            lastRunAtMs: import("typebox").TOptional<import("typebox").TInteger>;
            lastRunStatus: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"ok">, import("typebox").TLiteral<"error">, import("typebox").TLiteral<"skipped">]>>;
            lastStatus: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"ok">, import("typebox").TLiteral<"error">, import("typebox").TLiteral<"skipped">]>>;
            lastError: import("typebox").TOptional<import("typebox").TString>;
            lastDiagnostics: import("typebox").TOptional<import("typebox").TObject<{
                summary: import("typebox").TOptional<import("typebox").TString>;
                entries: import("typebox").TArray<import("typebox").TObject<{
                    ts: import("typebox").TInteger;
                    source: import("typebox").TUnion<[import("typebox").TLiteral<"cron-preflight">, import("typebox").TLiteral<"cron-setup">, import("typebox").TLiteral<"model-preflight">, import("typebox").TLiteral<"agent-run">, import("typebox").TLiteral<"tool">, import("typebox").TLiteral<"exec">, import("typebox").TLiteral<"delivery">]>;
                    severity: import("typebox").TUnion<[import("typebox").TLiteral<"info">, import("typebox").TLiteral<"warn">, import("typebox").TLiteral<"error">]>;
                    message: import("typebox").TString;
                    toolName: import("typebox").TOptional<import("typebox").TString>;
                    exitCode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>>;
                    truncated: import("typebox").TOptional<import("typebox").TBoolean>;
                }>>;
            }>>;
            lastDiagnosticSummary: import("typebox").TOptional<import("typebox").TString>;
            lastErrorReason: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"auth">, import("typebox").TLiteral<"format">, import("typebox").TLiteral<"rate_limit">, import("typebox").TLiteral<"billing">, import("typebox").TLiteral<"server_error">, import("typebox").TLiteral<"timeout">, import("typebox").TLiteral<"model_not_found">, import("typebox").TLiteral<"empty_response">, import("typebox").TLiteral<"no_error_details">, import("typebox").TLiteral<"unclassified">, import("typebox").TLiteral<"unknown">]>>;
            lastDurationMs: import("typebox").TOptional<import("typebox").TInteger>;
            consecutiveErrors: import("typebox").TOptional<import("typebox").TInteger>;
            consecutiveSkipped: import("typebox").TOptional<import("typebox").TInteger>;
            lastDelivered: import("typebox").TOptional<import("typebox").TBoolean>;
            lastDeliveryStatus: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"delivered">, import("typebox").TLiteral<"not-delivered">, import("typebox").TLiteral<"unknown">, import("typebox").TLiteral<"not-requested">]>>;
            lastDeliveryError: import("typebox").TOptional<import("typebox").TString>;
            lastFailureNotificationDelivered: import("typebox").TOptional<import("typebox").TBoolean>;
            lastFailureNotificationDeliveryStatus: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"delivered">, import("typebox").TLiteral<"not-delivered">, import("typebox").TLiteral<"unknown">, import("typebox").TLiteral<"not-requested">]>>;
            lastFailureNotificationDeliveryError: import("typebox").TOptional<import("typebox").TString>;
            lastFailureAlertAtMs: import("typebox").TOptional<import("typebox").TInteger>;
        }>;
    }>;
    CronListParams: import("typebox").TObject<{
        includeDisabled: import("typebox").TOptional<import("typebox").TBoolean>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        offset: import("typebox").TOptional<import("typebox").TInteger>;
        query: import("typebox").TOptional<import("typebox").TString>;
        enabled: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"all">, import("typebox").TLiteral<"enabled">, import("typebox").TLiteral<"disabled">]>>;
        sortBy: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"nextRunAtMs">, import("typebox").TLiteral<"updatedAtMs">, import("typebox").TLiteral<"name">]>>;
        sortDir: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"asc">, import("typebox").TLiteral<"desc">]>>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    CronStatusParams: import("typebox").TObject<{}>;
    CronGetParams: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
    }>, import("typebox").TObject<{
        jobId: import("typebox").TString;
    }>]>;
    CronAddParams: import("typebox").TObject<{
        agentId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        sessionKey: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        description: import("typebox").TOptional<import("typebox").TString>;
        enabled: import("typebox").TOptional<import("typebox").TBoolean>;
        deleteAfterRun: import("typebox").TOptional<import("typebox").TBoolean>;
        name: import("typebox").TString;
        schedule: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"at">;
            at: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"every">;
            everyMs: import("typebox").TInteger;
            anchorMs: import("typebox").TOptional<import("typebox").TInteger>;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"cron">;
            expr: import("typebox").TString;
            tz: import("typebox").TOptional<import("typebox").TString>;
            staggerMs: import("typebox").TOptional<import("typebox").TInteger>;
        }>]>;
        sessionTarget: import("typebox").TUnion<[import("typebox").TLiteral<"main">, import("typebox").TLiteral<"isolated">, import("typebox").TLiteral<"current">, import("typebox").TString]>;
        wakeMode: import("typebox").TUnion<[import("typebox").TLiteral<"next-heartbeat">, import("typebox").TLiteral<"now">]>;
        payload: import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"systemEvent">;
            text: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"agentTurn">;
            message: TSchema;
            model: import("typebox").TOptional<import("typebox").TString>;
            fallbacks: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            thinking: import("typebox").TOptional<import("typebox").TString>;
            timeoutSeconds: import("typebox").TOptional<import("typebox").TNumber>;
            allowUnsafeExternalContent: import("typebox").TOptional<import("typebox").TBoolean>;
            lightContext: import("typebox").TOptional<import("typebox").TBoolean>;
            toolsAllow: import("typebox").TOptional<TSchema>;
        }>]>;
        delivery: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            bestEffort: import("typebox").TOptional<import("typebox").TBoolean>;
            failureDestination: import("typebox").TOptional<import("typebox").TObject<{
                channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
                to: import("typebox").TOptional<import("typebox").TString>;
                accountId: import("typebox").TOptional<import("typebox").TString>;
                mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("typebox").TLiteral<"none">;
            to: import("typebox").TOptional<import("typebox").TString>;
        }>, import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            bestEffort: import("typebox").TOptional<import("typebox").TBoolean>;
            failureDestination: import("typebox").TOptional<import("typebox").TObject<{
                channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
                to: import("typebox").TOptional<import("typebox").TString>;
                accountId: import("typebox").TOptional<import("typebox").TString>;
                mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("typebox").TLiteral<"announce">;
            to: import("typebox").TOptional<import("typebox").TString>;
        }>, import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            bestEffort: import("typebox").TOptional<import("typebox").TBoolean>;
            failureDestination: import("typebox").TOptional<import("typebox").TObject<{
                channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
                to: import("typebox").TOptional<import("typebox").TString>;
                accountId: import("typebox").TOptional<import("typebox").TString>;
                mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            }>>;
            mode: import("typebox").TLiteral<"webhook">;
            to: import("typebox").TString;
        }>]>>;
        failureAlert: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<false>, import("typebox").TObject<{
            after: import("typebox").TOptional<import("typebox").TInteger>;
            channel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"last">, import("typebox").TString]>>;
            to: import("typebox").TOptional<import("typebox").TString>;
            cooldownMs: import("typebox").TOptional<import("typebox").TInteger>;
            includeSkipped: import("typebox").TOptional<import("typebox").TBoolean>;
            mode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"announce">, import("typebox").TLiteral<"webhook">]>>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
        }>]>>;
    }>;
    CronUpdateParams: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
    }>, import("typebox").TObject<{
        jobId: import("typebox").TString;
    }>]>;
    CronRemoveParams: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
    }>, import("typebox").TObject<{
        jobId: import("typebox").TString;
    }>]>;
    CronRunParams: import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
    }>, import("typebox").TObject<{
        jobId: import("typebox").TString;
    }>]>;
    CronRunsParams: import("typebox").TObject<{
        scope: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"job">, import("typebox").TLiteral<"all">]>>;
        id: import("typebox").TOptional<import("typebox").TString>;
        jobId: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        offset: import("typebox").TOptional<import("typebox").TInteger>;
        statuses: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"ok">, import("typebox").TLiteral<"error">, import("typebox").TLiteral<"skipped">]>>>;
        status: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"all">, import("typebox").TLiteral<"ok">, import("typebox").TLiteral<"error">, import("typebox").TLiteral<"skipped">]>>;
        deliveryStatuses: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"delivered">, import("typebox").TLiteral<"not-delivered">, import("typebox").TLiteral<"unknown">, import("typebox").TLiteral<"not-requested">]>>>;
        deliveryStatus: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"delivered">, import("typebox").TLiteral<"not-delivered">, import("typebox").TLiteral<"unknown">, import("typebox").TLiteral<"not-requested">]>>;
        query: import("typebox").TOptional<import("typebox").TString>;
        sortDir: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"asc">, import("typebox").TLiteral<"desc">]>>;
    }>;
    CronRunLogEntry: import("typebox").TObject<{
        ts: import("typebox").TInteger;
        jobId: import("typebox").TString;
        action: import("typebox").TLiteral<"finished">;
        status: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"ok">, import("typebox").TLiteral<"error">, import("typebox").TLiteral<"skipped">]>>;
        error: import("typebox").TOptional<import("typebox").TString>;
        summary: import("typebox").TOptional<import("typebox").TString>;
        diagnostics: import("typebox").TOptional<import("typebox").TObject<{
            summary: import("typebox").TOptional<import("typebox").TString>;
            entries: import("typebox").TArray<import("typebox").TObject<{
                ts: import("typebox").TInteger;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"cron-preflight">, import("typebox").TLiteral<"cron-setup">, import("typebox").TLiteral<"model-preflight">, import("typebox").TLiteral<"agent-run">, import("typebox").TLiteral<"tool">, import("typebox").TLiteral<"exec">, import("typebox").TLiteral<"delivery">]>;
                severity: import("typebox").TUnion<[import("typebox").TLiteral<"info">, import("typebox").TLiteral<"warn">, import("typebox").TLiteral<"error">]>;
                message: import("typebox").TString;
                toolName: import("typebox").TOptional<import("typebox").TString>;
                exitCode: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>>;
                truncated: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>;
        }>>;
        delivered: import("typebox").TOptional<import("typebox").TBoolean>;
        deliveryStatus: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"delivered">, import("typebox").TLiteral<"not-delivered">, import("typebox").TLiteral<"unknown">, import("typebox").TLiteral<"not-requested">]>>;
        deliveryError: import("typebox").TOptional<import("typebox").TString>;
        failureNotificationDelivery: import("typebox").TOptional<import("typebox").TObject<{
            delivered: import("typebox").TOptional<import("typebox").TBoolean>;
            status: import("typebox").TUnion<[import("typebox").TLiteral<"delivered">, import("typebox").TLiteral<"not-delivered">, import("typebox").TLiteral<"unknown">, import("typebox").TLiteral<"not-requested">]>;
            error: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        sessionId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        runId: import("typebox").TOptional<import("typebox").TString>;
        runAtMs: import("typebox").TOptional<import("typebox").TInteger>;
        durationMs: import("typebox").TOptional<import("typebox").TInteger>;
        nextRunAtMs: import("typebox").TOptional<import("typebox").TInteger>;
        model: import("typebox").TOptional<import("typebox").TString>;
        provider: import("typebox").TOptional<import("typebox").TString>;
        usage: import("typebox").TOptional<import("typebox").TObject<{
            input_tokens: import("typebox").TOptional<import("typebox").TNumber>;
            output_tokens: import("typebox").TOptional<import("typebox").TNumber>;
            total_tokens: import("typebox").TOptional<import("typebox").TNumber>;
            cache_read_tokens: import("typebox").TOptional<import("typebox").TNumber>;
            cache_write_tokens: import("typebox").TOptional<import("typebox").TNumber>;
        }>>;
        jobName: import("typebox").TOptional<import("typebox").TString>;
    }>;
    LogsTailParams: import("typebox").TObject<{
        cursor: import("typebox").TOptional<import("typebox").TInteger>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        maxBytes: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    LogsTailResult: import("typebox").TObject<{
        file: import("typebox").TString;
        cursor: import("typebox").TInteger;
        size: import("typebox").TInteger;
        lines: import("typebox").TArray<import("typebox").TString>;
        truncated: import("typebox").TOptional<import("typebox").TBoolean>;
        reset: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    ExecApprovalsGetParams: import("typebox").TObject<{}>;
    ExecApprovalsSetParams: import("typebox").TObject<{
        file: import("typebox").TObject<{
            version: import("typebox").TLiteral<1>;
            socket: import("typebox").TOptional<import("typebox").TObject<{
                path: import("typebox").TOptional<import("typebox").TString>;
                token: import("typebox").TOptional<import("typebox").TString>;
            }>>;
            defaults: import("typebox").TOptional<import("typebox").TObject<{
                security: import("typebox").TOptional<import("typebox").TString>;
                ask: import("typebox").TOptional<import("typebox").TString>;
                askFallback: import("typebox").TOptional<import("typebox").TString>;
                autoAllowSkills: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>;
            agents: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                security: import("typebox").TOptional<import("typebox").TString>;
                ask: import("typebox").TOptional<import("typebox").TString>;
                askFallback: import("typebox").TOptional<import("typebox").TString>;
                autoAllowSkills: import("typebox").TOptional<import("typebox").TBoolean>;
                allowlist: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TOptional<import("typebox").TString>;
                    pattern: import("typebox").TString;
                    source: import("typebox").TOptional<import("typebox").TLiteral<"allow-always">>;
                    commandText: import("typebox").TOptional<import("typebox").TString>;
                    argPattern: import("typebox").TOptional<import("typebox").TString>;
                    lastUsedAt: import("typebox").TOptional<import("typebox").TInteger>;
                    lastUsedCommand: import("typebox").TOptional<import("typebox").TString>;
                    lastResolvedPath: import("typebox").TOptional<import("typebox").TString>;
                }>>>;
            }>>>;
        }>;
        baseHash: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ExecApprovalsNodeGetParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
    }>;
    ExecApprovalsNodeSetParams: import("typebox").TObject<{
        nodeId: import("typebox").TString;
        file: import("typebox").TObject<{
            version: import("typebox").TLiteral<1>;
            socket: import("typebox").TOptional<import("typebox").TObject<{
                path: import("typebox").TOptional<import("typebox").TString>;
                token: import("typebox").TOptional<import("typebox").TString>;
            }>>;
            defaults: import("typebox").TOptional<import("typebox").TObject<{
                security: import("typebox").TOptional<import("typebox").TString>;
                ask: import("typebox").TOptional<import("typebox").TString>;
                askFallback: import("typebox").TOptional<import("typebox").TString>;
                autoAllowSkills: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>;
            agents: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                security: import("typebox").TOptional<import("typebox").TString>;
                ask: import("typebox").TOptional<import("typebox").TString>;
                askFallback: import("typebox").TOptional<import("typebox").TString>;
                autoAllowSkills: import("typebox").TOptional<import("typebox").TBoolean>;
                allowlist: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TOptional<import("typebox").TString>;
                    pattern: import("typebox").TString;
                    source: import("typebox").TOptional<import("typebox").TLiteral<"allow-always">>;
                    commandText: import("typebox").TOptional<import("typebox").TString>;
                    argPattern: import("typebox").TOptional<import("typebox").TString>;
                    lastUsedAt: import("typebox").TOptional<import("typebox").TInteger>;
                    lastUsedCommand: import("typebox").TOptional<import("typebox").TString>;
                    lastResolvedPath: import("typebox").TOptional<import("typebox").TString>;
                }>>>;
            }>>>;
        }>;
        baseHash: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ExecApprovalsSnapshot: import("typebox").TObject<{
        path: import("typebox").TString;
        exists: import("typebox").TBoolean;
        hash: import("typebox").TString;
        file: import("typebox").TObject<{
            version: import("typebox").TLiteral<1>;
            socket: import("typebox").TOptional<import("typebox").TObject<{
                path: import("typebox").TOptional<import("typebox").TString>;
                token: import("typebox").TOptional<import("typebox").TString>;
            }>>;
            defaults: import("typebox").TOptional<import("typebox").TObject<{
                security: import("typebox").TOptional<import("typebox").TString>;
                ask: import("typebox").TOptional<import("typebox").TString>;
                askFallback: import("typebox").TOptional<import("typebox").TString>;
                autoAllowSkills: import("typebox").TOptional<import("typebox").TBoolean>;
            }>>;
            agents: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                security: import("typebox").TOptional<import("typebox").TString>;
                ask: import("typebox").TOptional<import("typebox").TString>;
                askFallback: import("typebox").TOptional<import("typebox").TString>;
                autoAllowSkills: import("typebox").TOptional<import("typebox").TBoolean>;
                allowlist: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TOptional<import("typebox").TString>;
                    pattern: import("typebox").TString;
                    source: import("typebox").TOptional<import("typebox").TLiteral<"allow-always">>;
                    commandText: import("typebox").TOptional<import("typebox").TString>;
                    argPattern: import("typebox").TOptional<import("typebox").TString>;
                    lastUsedAt: import("typebox").TOptional<import("typebox").TInteger>;
                    lastUsedCommand: import("typebox").TOptional<import("typebox").TString>;
                    lastResolvedPath: import("typebox").TOptional<import("typebox").TString>;
                }>>>;
            }>>>;
        }>;
    }>;
    ExecApprovalGetParams: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    ExecApprovalRequestParams: import("typebox").TObject<{
        id: import("typebox").TOptional<import("typebox").TString>;
        command: import("typebox").TOptional<import("typebox").TString>;
        commandArgv: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        systemRunPlan: import("typebox").TOptional<import("typebox").TObject<{
            argv: import("typebox").TArray<import("typebox").TString>;
            cwd: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            commandText: import("typebox").TString;
            commandPreview: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
            agentId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            sessionKey: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            mutableFileOperand: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                argvIndex: import("typebox").TInteger;
                path: import("typebox").TString;
                sha256: import("typebox").TString;
            }>, import("typebox").TNull]>>;
        }>>;
        env: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
        cwd: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        nodeId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        host: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        security: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        ask: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        warningText: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        commandSpans: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
            startIndex: import("typebox").TInteger;
            endIndex: import("typebox").TInteger;
        }>>>;
        agentId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        resolvedPath: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        sessionKey: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        turnSourceChannel: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        turnSourceTo: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        turnSourceAccountId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
        turnSourceThreadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber, import("typebox").TNull]>>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        twoPhase: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    ExecApprovalResolveParams: import("typebox").TObject<{
        id: import("typebox").TString;
        decision: import("typebox").TString;
    }>;
    PluginApprovalRequestParams: import("typebox").TObject<{
        pluginId: import("typebox").TOptional<import("typebox").TString>;
        title: import("typebox").TString;
        description: import("typebox").TString;
        severity: import("typebox").TOptional<import("typebox").TString>;
        toolName: import("typebox").TOptional<import("typebox").TString>;
        toolCallId: import("typebox").TOptional<import("typebox").TString>;
        allowedDecisions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        agentId: import("typebox").TOptional<import("typebox").TString>;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        turnSourceChannel: import("typebox").TOptional<import("typebox").TString>;
        turnSourceTo: import("typebox").TOptional<import("typebox").TString>;
        turnSourceAccountId: import("typebox").TOptional<import("typebox").TString>;
        turnSourceThreadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        twoPhase: import("typebox").TOptional<import("typebox").TBoolean>;
    }>;
    PluginApprovalResolveParams: import("typebox").TObject<{
        id: import("typebox").TString;
        decision: import("typebox").TString;
    }>;
    PluginControlUiDescriptor: import("typebox").TObject<{
        id: import("typebox").TString;
        pluginId: import("typebox").TString;
        pluginName: import("typebox").TOptional<import("typebox").TString>;
        surface: import("typebox").TUnion<[import("typebox").TLiteral<"session">, import("typebox").TLiteral<"tool">, import("typebox").TLiteral<"run">, import("typebox").TLiteral<"settings">]>;
        label: import("typebox").TString;
        description: import("typebox").TOptional<import("typebox").TString>;
        placement: import("typebox").TOptional<import("typebox").TString>;
        schema: import("typebox").TOptional<import("typebox").TUnknown>;
        requiredScopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    PluginsSessionActionFailureResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<false>;
        error: import("typebox").TString;
        code: import("typebox").TOptional<import("typebox").TString>;
        details: import("typebox").TOptional<import("typebox").TUnknown>;
    }>;
    PluginsSessionActionParams: import("typebox").TObject<{
        pluginId: import("typebox").TString;
        actionId: import("typebox").TString;
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        payload: import("typebox").TOptional<import("typebox").TUnknown>;
    }>;
    PluginsSessionActionResult: import("typebox").TUnion<[import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        result: import("typebox").TOptional<import("typebox").TUnknown>;
        continueAgent: import("typebox").TOptional<import("typebox").TBoolean>;
        reply: import("typebox").TOptional<import("typebox").TUnknown>;
    }>, import("typebox").TObject<{
        ok: import("typebox").TLiteral<false>;
        error: import("typebox").TString;
        code: import("typebox").TOptional<import("typebox").TString>;
        details: import("typebox").TOptional<import("typebox").TUnknown>;
    }>]>;
    PluginsSessionActionSuccessResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        result: import("typebox").TOptional<import("typebox").TUnknown>;
        continueAgent: import("typebox").TOptional<import("typebox").TBoolean>;
        reply: import("typebox").TOptional<import("typebox").TUnknown>;
    }>;
    PluginsUiDescriptorsParams: import("typebox").TObject<{}>;
    PluginsUiDescriptorsResult: import("typebox").TObject<{
        ok: import("typebox").TLiteral<true>;
        descriptors: import("typebox").TArray<import("typebox").TObject<{
            id: import("typebox").TString;
            pluginId: import("typebox").TString;
            pluginName: import("typebox").TOptional<import("typebox").TString>;
            surface: import("typebox").TUnion<[import("typebox").TLiteral<"session">, import("typebox").TLiteral<"tool">, import("typebox").TLiteral<"run">, import("typebox").TLiteral<"settings">]>;
            label: import("typebox").TString;
            description: import("typebox").TOptional<import("typebox").TString>;
            placement: import("typebox").TOptional<import("typebox").TString>;
            schema: import("typebox").TOptional<import("typebox").TUnknown>;
            requiredScopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        }>>;
    }>;
    DevicePairListParams: import("typebox").TObject<{}>;
    DevicePairApproveParams: import("typebox").TObject<{
        requestId: import("typebox").TString;
    }>;
    DevicePairRejectParams: import("typebox").TObject<{
        requestId: import("typebox").TString;
    }>;
    DevicePairRemoveParams: import("typebox").TObject<{
        deviceId: import("typebox").TString;
    }>;
    DeviceTokenRotateParams: import("typebox").TObject<{
        deviceId: import("typebox").TString;
        role: import("typebox").TString;
        scopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    }>;
    DeviceTokenRevokeParams: import("typebox").TObject<{
        deviceId: import("typebox").TString;
        role: import("typebox").TString;
    }>;
    DevicePairRequestedEvent: import("typebox").TObject<{
        requestId: import("typebox").TString;
        deviceId: import("typebox").TString;
        publicKey: import("typebox").TString;
        displayName: import("typebox").TOptional<import("typebox").TString>;
        platform: import("typebox").TOptional<import("typebox").TString>;
        deviceFamily: import("typebox").TOptional<import("typebox").TString>;
        clientId: import("typebox").TOptional<import("typebox").TString>;
        clientMode: import("typebox").TOptional<import("typebox").TString>;
        role: import("typebox").TOptional<import("typebox").TString>;
        roles: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        scopes: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        remoteIp: import("typebox").TOptional<import("typebox").TString>;
        silent: import("typebox").TOptional<import("typebox").TBoolean>;
        isRepair: import("typebox").TOptional<import("typebox").TBoolean>;
        ts: import("typebox").TInteger;
    }>;
    DevicePairResolvedEvent: import("typebox").TObject<{
        requestId: import("typebox").TString;
        deviceId: import("typebox").TString;
        decision: import("typebox").TString;
        ts: import("typebox").TInteger;
    }>;
    ChatHistoryParams: import("typebox").TObject<{
        sessionKey: import("typebox").TString;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        maxChars: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    ChatSendParams: import("typebox").TObject<{
        sessionKey: import("typebox").TString;
        sessionId: import("typebox").TOptional<import("typebox").TString>;
        message: import("typebox").TString;
        thinking: import("typebox").TOptional<import("typebox").TString>;
        fastMode: import("typebox").TOptional<import("typebox").TBoolean>;
        deliver: import("typebox").TOptional<import("typebox").TBoolean>;
        originatingChannel: import("typebox").TOptional<import("typebox").TString>;
        originatingTo: import("typebox").TOptional<import("typebox").TString>;
        originatingAccountId: import("typebox").TOptional<import("typebox").TString>;
        originatingThreadId: import("typebox").TOptional<import("typebox").TString>;
        attachments: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnknown>>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
        systemInputProvenance: import("typebox").TOptional<import("typebox").TObject<{
            kind: import("typebox").TString;
            originSessionId: import("typebox").TOptional<import("typebox").TString>;
            sourceSessionKey: import("typebox").TOptional<import("typebox").TString>;
            sourceChannel: import("typebox").TOptional<import("typebox").TString>;
            sourceTool: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        systemProvenanceReceipt: import("typebox").TOptional<import("typebox").TString>;
        idempotencyKey: import("typebox").TString;
    }>;
    ChatAbortParams: import("typebox").TObject<{
        sessionKey: import("typebox").TString;
        runId: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChatInjectParams: import("typebox").TObject<{
        sessionKey: import("typebox").TString;
        message: import("typebox").TString;
        label: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChatDeltaEvent: import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"delta">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        deltaText: import("typebox").TString;
        replace: import("typebox").TOptional<import("typebox").TBoolean>;
        usage: import("typebox").TOptional<import("typebox").TUnknown>;
    }>;
    ChatFinalEvent: import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"final">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        usage: import("typebox").TOptional<import("typebox").TUnknown>;
        stopReason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChatAbortedEvent: import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"aborted">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        stopReason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChatErrorEvent: import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"error">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        errorMessage: import("typebox").TOptional<import("typebox").TString>;
        errorKind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"refusal">, import("typebox").TLiteral<"timeout">, import("typebox").TLiteral<"rate_limit">, import("typebox").TLiteral<"context_length">, import("typebox").TLiteral<"unknown">]>>;
        usage: import("typebox").TOptional<import("typebox").TUnknown>;
        stopReason: import("typebox").TOptional<import("typebox").TString>;
    }>;
    ChatEvent: import("typebox").TUnion<[import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"delta">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        deltaText: import("typebox").TString;
        replace: import("typebox").TOptional<import("typebox").TBoolean>;
        usage: import("typebox").TOptional<import("typebox").TUnknown>;
    }>, import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"final">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        usage: import("typebox").TOptional<import("typebox").TUnknown>;
        stopReason: import("typebox").TOptional<import("typebox").TString>;
    }>, import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"aborted">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        stopReason: import("typebox").TOptional<import("typebox").TString>;
    }>, import("typebox").TObject<{
        runId: import("typebox").TString;
        sessionKey: import("typebox").TString;
        spawnedBy: import("typebox").TOptional<import("typebox").TString>;
        seq: import("typebox").TInteger;
        state: import("typebox").TLiteral<"error">;
        message: import("typebox").TOptional<import("typebox").TUnknown>;
        errorMessage: import("typebox").TOptional<import("typebox").TString>;
        errorKind: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"refusal">, import("typebox").TLiteral<"timeout">, import("typebox").TLiteral<"rate_limit">, import("typebox").TLiteral<"context_length">, import("typebox").TLiteral<"unknown">]>>;
        usage: import("typebox").TOptional<import("typebox").TUnknown>;
        stopReason: import("typebox").TOptional<import("typebox").TString>;
    }>]>;
    UpdateStatusParams: import("typebox").TObject<{}>;
    UpdateRunParams: import("typebox").TObject<{
        sessionKey: import("typebox").TOptional<import("typebox").TString>;
        deliveryContext: import("typebox").TOptional<import("typebox").TObject<{
            channel: import("typebox").TOptional<import("typebox").TString>;
            to: import("typebox").TOptional<import("typebox").TString>;
            accountId: import("typebox").TOptional<import("typebox").TString>;
            threadId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNumber]>>;
        }>>;
        note: import("typebox").TOptional<import("typebox").TString>;
        continuationMessage: import("typebox").TOptional<import("typebox").TString>;
        restartDelayMs: import("typebox").TOptional<import("typebox").TInteger>;
        timeoutMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
    TickEvent: import("typebox").TObject<{
        ts: import("typebox").TInteger;
    }>;
    ShutdownEvent: import("typebox").TObject<{
        reason: import("typebox").TString;
        restartExpectedMs: import("typebox").TOptional<import("typebox").TInteger>;
    }>;
};
export { MIN_CLIENT_PROTOCOL_VERSION, MIN_PROBE_PROTOCOL_VERSION, PROTOCOL_VERSION, } from "../version.js";
