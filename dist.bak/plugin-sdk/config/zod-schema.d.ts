import { z } from "zod";
export declare const OpenClawSchema: z.ZodObject<{
    $schema: z.ZodOptional<z.ZodString>;
    meta: z.ZodOptional<z.ZodObject<{
        lastTouchedVersion: z.ZodOptional<z.ZodString>;
        lastTouchedAt: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodPipe<z.ZodNumber, z.ZodTransform<string, number>>]>>;
    }, z.core.$strict>>;
    env: z.ZodOptional<z.ZodObject<{
        shellEnv: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        vars: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$catchall<z.ZodString>>>;
    wizard: z.ZodOptional<z.ZodObject<{
        lastRunAt: z.ZodOptional<z.ZodString>;
        lastRunVersion: z.ZodOptional<z.ZodString>;
        lastRunCommit: z.ZodOptional<z.ZodString>;
        lastRunCommand: z.ZodOptional<z.ZodString>;
        lastRunMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"local">, z.ZodLiteral<"remote">]>>;
    }, z.core.$strict>>;
    diagnostics: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        flags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        otel: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            endpoint: z.ZodOptional<z.ZodString>;
            protocol: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"http/protobuf">, z.ZodLiteral<"grpc">]>>;
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            serviceName: z.ZodOptional<z.ZodString>;
            traces: z.ZodOptional<z.ZodBoolean>;
            metrics: z.ZodOptional<z.ZodBoolean>;
            logs: z.ZodOptional<z.ZodBoolean>;
            sampleRate: z.ZodOptional<z.ZodNumber>;
            flushIntervalMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        cacheTrace: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            filePath: z.ZodOptional<z.ZodString>;
            includeMessages: z.ZodOptional<z.ZodBoolean>;
            includePrompt: z.ZodOptional<z.ZodBoolean>;
            includeSystem: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    logging: z.ZodOptional<z.ZodObject<{
        level: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"silent">, z.ZodLiteral<"fatal">, z.ZodLiteral<"error">, z.ZodLiteral<"warn">, z.ZodLiteral<"info">, z.ZodLiteral<"debug">, z.ZodLiteral<"trace">]>>;
        file: z.ZodOptional<z.ZodString>;
        maxFileBytes: z.ZodOptional<z.ZodNumber>;
        consoleLevel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"silent">, z.ZodLiteral<"fatal">, z.ZodLiteral<"error">, z.ZodLiteral<"warn">, z.ZodLiteral<"info">, z.ZodLiteral<"debug">, z.ZodLiteral<"trace">]>>;
        consoleStyle: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"pretty">, z.ZodLiteral<"compact">, z.ZodLiteral<"json">]>>;
        redactSensitive: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"tools">]>>;
        redactPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    update: z.ZodOptional<z.ZodObject<{
        channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"stable">, z.ZodLiteral<"beta">, z.ZodLiteral<"dev">]>>;
        checkOnStart: z.ZodOptional<z.ZodBoolean>;
        auto: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            stableDelayHours: z.ZodOptional<z.ZodNumber>;
            stableJitterHours: z.ZodOptional<z.ZodNumber>;
            betaCheckIntervalHours: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    browser: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        evaluateEnabled: z.ZodOptional<z.ZodBoolean>;
        cdpUrl: z.ZodOptional<z.ZodString>;
        remoteCdpTimeoutMs: z.ZodOptional<z.ZodNumber>;
        remoteCdpHandshakeTimeoutMs: z.ZodOptional<z.ZodNumber>;
        color: z.ZodOptional<z.ZodString>;
        executablePath: z.ZodOptional<z.ZodString>;
        headless: z.ZodOptional<z.ZodBoolean>;
        noSandbox: z.ZodOptional<z.ZodBoolean>;
        attachOnly: z.ZodOptional<z.ZodBoolean>;
        defaultProfile: z.ZodOptional<z.ZodString>;
        snapshotDefaults: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodLiteral<"efficient">>;
        }, z.core.$strict>>;
        ssrfPolicy: z.ZodOptional<z.ZodObject<{
            allowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
            dangerouslyAllowPrivateNetwork: z.ZodOptional<z.ZodBoolean>;
            allowedHostnames: z.ZodOptional<z.ZodArray<z.ZodString>>;
            hostnameAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        profiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            cdpPort: z.ZodOptional<z.ZodNumber>;
            cdpUrl: z.ZodOptional<z.ZodString>;
            driver: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"clawd">, z.ZodLiteral<"extension">]>>;
            color: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    ui: z.ZodOptional<z.ZodObject<{
        seamColor: z.ZodOptional<z.ZodString>;
        assistant: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            avatar: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    secrets: z.ZodOptional<z.ZodObject<{
        providers: z.ZodOptional<z.ZodObject<{}, z.core.$catchall<z.ZodDiscriminatedUnion<[z.ZodObject<{
            source: z.ZodLiteral<"env">;
            allowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"file">;
            path: z.ZodString;
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"singleValue">, z.ZodLiteral<"json">]>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
            maxBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>, z.ZodObject<{
            source: z.ZodLiteral<"exec">;
            command: z.ZodString;
            args: z.ZodOptional<z.ZodArray<z.ZodString>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
            noOutputTimeoutMs: z.ZodOptional<z.ZodNumber>;
            maxOutputBytes: z.ZodOptional<z.ZodNumber>;
            jsonOnly: z.ZodOptional<z.ZodBoolean>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            passEnv: z.ZodOptional<z.ZodArray<z.ZodString>>;
            trustedDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            allowInsecurePath: z.ZodOptional<z.ZodBoolean>;
            allowSymlinkCommand: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>], "source">>>>;
        defaults: z.ZodOptional<z.ZodObject<{
            env: z.ZodOptional<z.ZodString>;
            file: z.ZodOptional<z.ZodString>;
            exec: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        resolution: z.ZodOptional<z.ZodObject<{
            maxProviderConcurrency: z.ZodOptional<z.ZodNumber>;
            maxRefsPerProvider: z.ZodOptional<z.ZodNumber>;
            maxBatchBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    auth: z.ZodOptional<z.ZodObject<{
        profiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            provider: z.ZodString;
            mode: z.ZodUnion<readonly [z.ZodLiteral<"api_key">, z.ZodLiteral<"oauth">, z.ZodLiteral<"token">]>;
            email: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        order: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        cooldowns: z.ZodOptional<z.ZodObject<{
            billingBackoffHours: z.ZodOptional<z.ZodNumber>;
            billingBackoffHoursByProvider: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            billingMaxHours: z.ZodOptional<z.ZodNumber>;
            failureWindowHours: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    acp: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        dispatch: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        backend: z.ZodOptional<z.ZodString>;
        defaultAgent: z.ZodOptional<z.ZodString>;
        allowedAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
        maxConcurrentSessions: z.ZodOptional<z.ZodNumber>;
        stream: z.ZodOptional<z.ZodObject<{
            coalesceIdleMs: z.ZodOptional<z.ZodNumber>;
            maxChunkChars: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        runtime: z.ZodOptional<z.ZodObject<{
            ttlMinutes: z.ZodOptional<z.ZodNumber>;
            installCommand: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    models: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"merge">, z.ZodLiteral<"replace">]>>;
        providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            baseUrl: z.ZodString;
            apiKey: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                source: z.ZodLiteral<"env">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"file">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"exec">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>], "source">]>>;
            auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"api-key">, z.ZodLiteral<"aws-sdk">, z.ZodLiteral<"oauth">, z.ZodLiteral<"token">]>>;
            api: z.ZodOptional<z.ZodEnum<{
                "openai-completions": "openai-completions";
                "openai-responses": "openai-responses";
                "openai-codex-responses": "openai-codex-responses";
                "anthropic-messages": "anthropic-messages";
                "google-generative-ai": "google-generative-ai";
                "github-copilot": "github-copilot";
                "bedrock-converse-stream": "bedrock-converse-stream";
                ollama: "ollama";
            }>>;
            injectNumCtxForOpenAICompat: z.ZodOptional<z.ZodBoolean>;
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            authHeader: z.ZodOptional<z.ZodBoolean>;
            models: z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodString;
                api: z.ZodOptional<z.ZodEnum<{
                    "openai-completions": "openai-completions";
                    "openai-responses": "openai-responses";
                    "openai-codex-responses": "openai-codex-responses";
                    "anthropic-messages": "anthropic-messages";
                    "google-generative-ai": "google-generative-ai";
                    "github-copilot": "github-copilot";
                    "bedrock-converse-stream": "bedrock-converse-stream";
                    ollama: "ollama";
                }>>;
                reasoning: z.ZodOptional<z.ZodBoolean>;
                input: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"text">, z.ZodLiteral<"image">]>>>;
                cost: z.ZodOptional<z.ZodObject<{
                    input: z.ZodOptional<z.ZodNumber>;
                    output: z.ZodOptional<z.ZodNumber>;
                    cacheRead: z.ZodOptional<z.ZodNumber>;
                    cacheWrite: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                contextWindow: z.ZodOptional<z.ZodNumber>;
                maxTokens: z.ZodOptional<z.ZodNumber>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                compat: z.ZodOptional<z.ZodObject<{
                    supportsStore: z.ZodOptional<z.ZodBoolean>;
                    supportsDeveloperRole: z.ZodOptional<z.ZodBoolean>;
                    supportsReasoningEffort: z.ZodOptional<z.ZodBoolean>;
                    supportsUsageInStreaming: z.ZodOptional<z.ZodBoolean>;
                    supportsStrictMode: z.ZodOptional<z.ZodBoolean>;
                    maxTokensField: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"max_completion_tokens">, z.ZodLiteral<"max_tokens">]>>;
                    thinkingFormat: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"openai">, z.ZodLiteral<"zai">, z.ZodLiteral<"qwen">]>>;
                    requiresToolResultName: z.ZodOptional<z.ZodBoolean>;
                    requiresAssistantAfterToolResult: z.ZodOptional<z.ZodBoolean>;
                    requiresThinkingAsText: z.ZodOptional<z.ZodBoolean>;
                    requiresMistralToolIds: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>;
        bedrockDiscovery: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            region: z.ZodOptional<z.ZodString>;
            providerFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            refreshInterval: z.ZodOptional<z.ZodNumber>;
            defaultContextWindow: z.ZodOptional<z.ZodNumber>;
            defaultMaxTokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    nodeHost: z.ZodOptional<z.ZodObject<{
        browserProxy: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowProfiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    agents: z.ZodOptional<z.ZodObject<{
        defaults: z.ZodOptional<z.ZodLazy<z.ZodOptional<z.ZodObject<{
            model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>]>>;
            imageModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>]>>;
            models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                alias: z.ZodOptional<z.ZodString>;
                params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
                streaming: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>>;
            workspace: z.ZodOptional<z.ZodString>;
            repoRoot: z.ZodOptional<z.ZodString>;
            skipBootstrap: z.ZodOptional<z.ZodBoolean>;
            bootstrapMaxChars: z.ZodOptional<z.ZodNumber>;
            bootstrapTotalMaxChars: z.ZodOptional<z.ZodNumber>;
            userTimezone: z.ZodOptional<z.ZodString>;
            timeFormat: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"12">, z.ZodLiteral<"24">]>>;
            envelopeTimezone: z.ZodOptional<z.ZodString>;
            envelopeTimestamp: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
            envelopeElapsed: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
            contextTokens: z.ZodOptional<z.ZodNumber>;
            cliBackends: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                command: z.ZodString;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                output: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"json">, z.ZodLiteral<"text">, z.ZodLiteral<"jsonl">]>>;
                resumeOutput: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"json">, z.ZodLiteral<"text">, z.ZodLiteral<"jsonl">]>>;
                input: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"arg">, z.ZodLiteral<"stdin">]>>;
                maxPromptArgChars: z.ZodOptional<z.ZodNumber>;
                env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                clearEnv: z.ZodOptional<z.ZodArray<z.ZodString>>;
                modelArg: z.ZodOptional<z.ZodString>;
                modelAliases: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                sessionArg: z.ZodOptional<z.ZodString>;
                sessionArgs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                resumeArgs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                sessionMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"existing">, z.ZodLiteral<"none">]>>;
                sessionIdFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
                systemPromptArg: z.ZodOptional<z.ZodString>;
                systemPromptMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"append">, z.ZodLiteral<"replace">]>>;
                systemPromptWhen: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"always">, z.ZodLiteral<"never">]>>;
                imageArg: z.ZodOptional<z.ZodString>;
                imageMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"repeat">, z.ZodLiteral<"list">]>>;
                serialize: z.ZodOptional<z.ZodBoolean>;
                reliability: z.ZodOptional<z.ZodObject<{
                    watchdog: z.ZodOptional<z.ZodObject<{
                        fresh: z.ZodOptional<z.ZodObject<{
                            noOutputTimeoutMs: z.ZodOptional<z.ZodNumber>;
                            noOutputTimeoutRatio: z.ZodOptional<z.ZodNumber>;
                            minMs: z.ZodOptional<z.ZodNumber>;
                            maxMs: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        resume: z.ZodOptional<z.ZodObject<{
                            noOutputTimeoutMs: z.ZodOptional<z.ZodNumber>;
                            noOutputTimeoutRatio: z.ZodOptional<z.ZodNumber>;
                            minMs: z.ZodOptional<z.ZodNumber>;
                            maxMs: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
            }, z.core.$strict>>>;
            memorySearch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                sources: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"memory">, z.ZodLiteral<"sessions">]>>>;
                extraPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
                experimental: z.ZodOptional<z.ZodObject<{
                    sessionMemory: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"openai">, z.ZodLiteral<"local">, z.ZodLiteral<"gemini">, z.ZodLiteral<"voyage">, z.ZodLiteral<"mistral">]>>;
                remote: z.ZodOptional<z.ZodObject<{
                    baseUrl: z.ZodOptional<z.ZodString>;
                    apiKey: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    batch: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        wait: z.ZodOptional<z.ZodBoolean>;
                        concurrency: z.ZodOptional<z.ZodNumber>;
                        pollIntervalMs: z.ZodOptional<z.ZodNumber>;
                        timeoutMinutes: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                fallback: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"openai">, z.ZodLiteral<"gemini">, z.ZodLiteral<"local">, z.ZodLiteral<"voyage">, z.ZodLiteral<"mistral">, z.ZodLiteral<"none">]>>;
                model: z.ZodOptional<z.ZodString>;
                local: z.ZodOptional<z.ZodObject<{
                    modelPath: z.ZodOptional<z.ZodString>;
                    modelCacheDir: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                store: z.ZodOptional<z.ZodObject<{
                    driver: z.ZodOptional<z.ZodLiteral<"sqlite">>;
                    path: z.ZodOptional<z.ZodString>;
                    vector: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        extensionPath: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                chunking: z.ZodOptional<z.ZodObject<{
                    tokens: z.ZodOptional<z.ZodNumber>;
                    overlap: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                sync: z.ZodOptional<z.ZodObject<{
                    onSessionStart: z.ZodOptional<z.ZodBoolean>;
                    onSearch: z.ZodOptional<z.ZodBoolean>;
                    watch: z.ZodOptional<z.ZodBoolean>;
                    watchDebounceMs: z.ZodOptional<z.ZodNumber>;
                    intervalMinutes: z.ZodOptional<z.ZodNumber>;
                    sessions: z.ZodOptional<z.ZodObject<{
                        deltaBytes: z.ZodOptional<z.ZodNumber>;
                        deltaMessages: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                query: z.ZodOptional<z.ZodObject<{
                    maxResults: z.ZodOptional<z.ZodNumber>;
                    minScore: z.ZodOptional<z.ZodNumber>;
                    hybrid: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        vectorWeight: z.ZodOptional<z.ZodNumber>;
                        textWeight: z.ZodOptional<z.ZodNumber>;
                        candidateMultiplier: z.ZodOptional<z.ZodNumber>;
                        mmr: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            lambda: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        temporalDecay: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            halfLifeDays: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                cache: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxEntries: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            contextPruning: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"cache-ttl">]>>;
                ttl: z.ZodOptional<z.ZodString>;
                keepLastAssistants: z.ZodOptional<z.ZodNumber>;
                softTrimRatio: z.ZodOptional<z.ZodNumber>;
                hardClearRatio: z.ZodOptional<z.ZodNumber>;
                minPrunableToolChars: z.ZodOptional<z.ZodNumber>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                softTrim: z.ZodOptional<z.ZodObject<{
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    headChars: z.ZodOptional<z.ZodNumber>;
                    tailChars: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                hardClear: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    placeholder: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            compaction: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"default">, z.ZodLiteral<"safeguard">]>>;
                reserveTokens: z.ZodOptional<z.ZodNumber>;
                keepRecentTokens: z.ZodOptional<z.ZodNumber>;
                reserveTokensFloor: z.ZodOptional<z.ZodNumber>;
                maxHistoryShare: z.ZodOptional<z.ZodNumber>;
                identifierPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"strict">, z.ZodLiteral<"off">, z.ZodLiteral<"custom">]>>;
                identifierInstructions: z.ZodOptional<z.ZodString>;
                memoryFlush: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    softThresholdTokens: z.ZodOptional<z.ZodNumber>;
                    prompt: z.ZodOptional<z.ZodString>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            embeddedPi: z.ZodOptional<z.ZodObject<{
                projectSettingsPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"trusted">, z.ZodLiteral<"sanitize">, z.ZodLiteral<"ignore">]>>;
            }, z.core.$strict>>;
            thinkingDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"minimal">, z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">, z.ZodLiteral<"xhigh">]>>;
            verboseDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">, z.ZodLiteral<"full">]>>;
            elevatedDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">, z.ZodLiteral<"ask">, z.ZodLiteral<"full">]>>;
            blockStreamingDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">]>>;
            blockStreamingBreak: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"text_end">, z.ZodLiteral<"message_end">]>>;
            blockStreamingChunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            humanDelay: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"natural">, z.ZodLiteral<"custom">]>>;
                minMs: z.ZodOptional<z.ZodNumber>;
                maxMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            imageMaxDimensionPx: z.ZodOptional<z.ZodNumber>;
            typingIntervalSeconds: z.ZodOptional<z.ZodNumber>;
            typingMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"never">, z.ZodLiteral<"instant">, z.ZodLiteral<"thinking">, z.ZodLiteral<"message">]>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                every: z.ZodOptional<z.ZodString>;
                activeHours: z.ZodOptional<z.ZodObject<{
                    start: z.ZodOptional<z.ZodString>;
                    end: z.ZodOptional<z.ZodString>;
                    timezone: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                model: z.ZodOptional<z.ZodString>;
                session: z.ZodOptional<z.ZodString>;
                includeReasoning: z.ZodOptional<z.ZodBoolean>;
                target: z.ZodOptional<z.ZodString>;
                directPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"block">]>>;
                to: z.ZodOptional<z.ZodString>;
                accountId: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                ackMaxChars: z.ZodOptional<z.ZodNumber>;
                suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            maxConcurrent: z.ZodOptional<z.ZodNumber>;
            subagents: z.ZodOptional<z.ZodObject<{
                maxConcurrent: z.ZodOptional<z.ZodNumber>;
                maxSpawnDepth: z.ZodOptional<z.ZodNumber>;
                maxChildrenPerAgent: z.ZodOptional<z.ZodNumber>;
                archiveAfterMinutes: z.ZodOptional<z.ZodNumber>;
                model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                    primary: z.ZodOptional<z.ZodString>;
                    fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>]>>;
                thinking: z.ZodOptional<z.ZodString>;
                runTimeoutSeconds: z.ZodOptional<z.ZodNumber>;
                announceTimeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            sandbox: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"non-main">, z.ZodLiteral<"all">]>>;
                workspaceAccess: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"ro">, z.ZodLiteral<"rw">]>>;
                sessionToolsVisibility: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"spawned">, z.ZodLiteral<"all">]>>;
                scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"agent">, z.ZodLiteral<"shared">]>>;
                perSession: z.ZodOptional<z.ZodBoolean>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                docker: z.ZodOptional<z.ZodObject<{
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    workdir: z.ZodOptional<z.ZodString>;
                    readOnlyRoot: z.ZodOptional<z.ZodBoolean>;
                    tmpfs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    network: z.ZodOptional<z.ZodString>;
                    user: z.ZodOptional<z.ZodString>;
                    capDrop: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    setupCommand: z.ZodOptional<z.ZodString>;
                    pidsLimit: z.ZodOptional<z.ZodNumber>;
                    memory: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    memorySwap: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    cpus: z.ZodOptional<z.ZodNumber>;
                    ulimits: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodObject<{
                        soft: z.ZodOptional<z.ZodNumber>;
                        hard: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>]>>>;
                    seccompProfile: z.ZodOptional<z.ZodString>;
                    apparmorProfile: z.ZodOptional<z.ZodString>;
                    dns: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    extraHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    dangerouslyAllowReservedContainerTargets: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowExternalBindSources: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowContainerNamespaceJoin: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                browser: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    network: z.ZodOptional<z.ZodString>;
                    cdpPort: z.ZodOptional<z.ZodNumber>;
                    cdpSourceRange: z.ZodOptional<z.ZodString>;
                    vncPort: z.ZodOptional<z.ZodNumber>;
                    noVncPort: z.ZodOptional<z.ZodNumber>;
                    headless: z.ZodOptional<z.ZodBoolean>;
                    enableNoVnc: z.ZodOptional<z.ZodBoolean>;
                    allowHostControl: z.ZodOptional<z.ZodBoolean>;
                    autoStart: z.ZodOptional<z.ZodBoolean>;
                    autoStartTimeoutMs: z.ZodOptional<z.ZodNumber>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                prune: z.ZodOptional<z.ZodObject<{
                    idleHours: z.ZodOptional<z.ZodNumber>;
                    maxAgeDays: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        list: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            default: z.ZodOptional<z.ZodBoolean>;
            name: z.ZodOptional<z.ZodString>;
            workspace: z.ZodOptional<z.ZodString>;
            agentDir: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>]>>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
            memorySearch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                sources: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"memory">, z.ZodLiteral<"sessions">]>>>;
                extraPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
                experimental: z.ZodOptional<z.ZodObject<{
                    sessionMemory: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"openai">, z.ZodLiteral<"local">, z.ZodLiteral<"gemini">, z.ZodLiteral<"voyage">, z.ZodLiteral<"mistral">]>>;
                remote: z.ZodOptional<z.ZodObject<{
                    baseUrl: z.ZodOptional<z.ZodString>;
                    apiKey: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    batch: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        wait: z.ZodOptional<z.ZodBoolean>;
                        concurrency: z.ZodOptional<z.ZodNumber>;
                        pollIntervalMs: z.ZodOptional<z.ZodNumber>;
                        timeoutMinutes: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                fallback: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"openai">, z.ZodLiteral<"gemini">, z.ZodLiteral<"local">, z.ZodLiteral<"voyage">, z.ZodLiteral<"mistral">, z.ZodLiteral<"none">]>>;
                model: z.ZodOptional<z.ZodString>;
                local: z.ZodOptional<z.ZodObject<{
                    modelPath: z.ZodOptional<z.ZodString>;
                    modelCacheDir: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                store: z.ZodOptional<z.ZodObject<{
                    driver: z.ZodOptional<z.ZodLiteral<"sqlite">>;
                    path: z.ZodOptional<z.ZodString>;
                    vector: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        extensionPath: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                chunking: z.ZodOptional<z.ZodObject<{
                    tokens: z.ZodOptional<z.ZodNumber>;
                    overlap: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                sync: z.ZodOptional<z.ZodObject<{
                    onSessionStart: z.ZodOptional<z.ZodBoolean>;
                    onSearch: z.ZodOptional<z.ZodBoolean>;
                    watch: z.ZodOptional<z.ZodBoolean>;
                    watchDebounceMs: z.ZodOptional<z.ZodNumber>;
                    intervalMinutes: z.ZodOptional<z.ZodNumber>;
                    sessions: z.ZodOptional<z.ZodObject<{
                        deltaBytes: z.ZodOptional<z.ZodNumber>;
                        deltaMessages: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                query: z.ZodOptional<z.ZodObject<{
                    maxResults: z.ZodOptional<z.ZodNumber>;
                    minScore: z.ZodOptional<z.ZodNumber>;
                    hybrid: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        vectorWeight: z.ZodOptional<z.ZodNumber>;
                        textWeight: z.ZodOptional<z.ZodNumber>;
                        candidateMultiplier: z.ZodOptional<z.ZodNumber>;
                        mmr: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            lambda: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        temporalDecay: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            halfLifeDays: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                cache: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxEntries: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            humanDelay: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"natural">, z.ZodLiteral<"custom">]>>;
                minMs: z.ZodOptional<z.ZodNumber>;
                maxMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                every: z.ZodOptional<z.ZodString>;
                activeHours: z.ZodOptional<z.ZodObject<{
                    start: z.ZodOptional<z.ZodString>;
                    end: z.ZodOptional<z.ZodString>;
                    timezone: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                model: z.ZodOptional<z.ZodString>;
                session: z.ZodOptional<z.ZodString>;
                includeReasoning: z.ZodOptional<z.ZodBoolean>;
                target: z.ZodOptional<z.ZodString>;
                directPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"block">]>>;
                to: z.ZodOptional<z.ZodString>;
                accountId: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                ackMaxChars: z.ZodOptional<z.ZodNumber>;
                suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            identity: z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                theme: z.ZodOptional<z.ZodString>;
                emoji: z.ZodOptional<z.ZodString>;
                avatar: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            groupChat: z.ZodOptional<z.ZodObject<{
                mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            subagents: z.ZodOptional<z.ZodObject<{
                allowAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
                model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                    primary: z.ZodOptional<z.ZodString>;
                    fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>]>>;
                thinking: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            sandbox: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"non-main">, z.ZodLiteral<"all">]>>;
                workspaceAccess: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"ro">, z.ZodLiteral<"rw">]>>;
                sessionToolsVisibility: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"spawned">, z.ZodLiteral<"all">]>>;
                scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"agent">, z.ZodLiteral<"shared">]>>;
                perSession: z.ZodOptional<z.ZodBoolean>;
                workspaceRoot: z.ZodOptional<z.ZodString>;
                docker: z.ZodOptional<z.ZodObject<{
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    workdir: z.ZodOptional<z.ZodString>;
                    readOnlyRoot: z.ZodOptional<z.ZodBoolean>;
                    tmpfs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    network: z.ZodOptional<z.ZodString>;
                    user: z.ZodOptional<z.ZodString>;
                    capDrop: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    setupCommand: z.ZodOptional<z.ZodString>;
                    pidsLimit: z.ZodOptional<z.ZodNumber>;
                    memory: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    memorySwap: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                    cpus: z.ZodOptional<z.ZodNumber>;
                    ulimits: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodObject<{
                        soft: z.ZodOptional<z.ZodNumber>;
                        hard: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>]>>>;
                    seccompProfile: z.ZodOptional<z.ZodString>;
                    apparmorProfile: z.ZodOptional<z.ZodString>;
                    dns: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    extraHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    dangerouslyAllowReservedContainerTargets: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowExternalBindSources: z.ZodOptional<z.ZodBoolean>;
                    dangerouslyAllowContainerNamespaceJoin: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                browser: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    image: z.ZodOptional<z.ZodString>;
                    containerPrefix: z.ZodOptional<z.ZodString>;
                    network: z.ZodOptional<z.ZodString>;
                    cdpPort: z.ZodOptional<z.ZodNumber>;
                    cdpSourceRange: z.ZodOptional<z.ZodString>;
                    vncPort: z.ZodOptional<z.ZodNumber>;
                    noVncPort: z.ZodOptional<z.ZodNumber>;
                    headless: z.ZodOptional<z.ZodBoolean>;
                    enableNoVnc: z.ZodOptional<z.ZodBoolean>;
                    allowHostControl: z.ZodOptional<z.ZodBoolean>;
                    autoStart: z.ZodOptional<z.ZodBoolean>;
                    autoStartTimeoutMs: z.ZodOptional<z.ZodNumber>;
                    binds: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                prune: z.ZodOptional<z.ZodObject<{
                    idleHours: z.ZodOptional<z.ZodNumber>;
                    maxAgeDays: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            tools: z.ZodOptional<z.ZodObject<{
                elevated: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allowFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>;
                }, z.core.$strict>>;
                exec: z.ZodOptional<z.ZodObject<{
                    approvalRunningNoticeMs: z.ZodOptional<z.ZodNumber>;
                    host: z.ZodOptional<z.ZodEnum<{
                        sandbox: "sandbox";
                        gateway: "gateway";
                        node: "node";
                    }>>;
                    security: z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        deny: "deny";
                        full: "full";
                    }>>;
                    ask: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        "on-miss": "on-miss";
                        always: "always";
                    }>>;
                    node: z.ZodOptional<z.ZodString>;
                    pathPrepend: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    safeBins: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    safeBinTrustedDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    safeBinProfiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                        minPositional: z.ZodOptional<z.ZodNumber>;
                        maxPositional: z.ZodOptional<z.ZodNumber>;
                        allowedValueFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deniedFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>;
                    backgroundMs: z.ZodOptional<z.ZodNumber>;
                    timeoutSec: z.ZodOptional<z.ZodNumber>;
                    cleanupMs: z.ZodOptional<z.ZodNumber>;
                    notifyOnExit: z.ZodOptional<z.ZodBoolean>;
                    notifyOnExitEmptySuccess: z.ZodOptional<z.ZodBoolean>;
                    applyPatch: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        workspaceOnly: z.ZodOptional<z.ZodBoolean>;
                        allowModels: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                fs: z.ZodOptional<z.ZodObject<{
                    workspaceOnly: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                loopDetection: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    historySize: z.ZodOptional<z.ZodNumber>;
                    warningThreshold: z.ZodOptional<z.ZodNumber>;
                    criticalThreshold: z.ZodOptional<z.ZodNumber>;
                    globalCircuitBreakerThreshold: z.ZodOptional<z.ZodNumber>;
                    detectors: z.ZodOptional<z.ZodObject<{
                        genericRepeat: z.ZodOptional<z.ZodBoolean>;
                        knownPollNoProgress: z.ZodOptional<z.ZodBoolean>;
                        pingPong: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                sandbox: z.ZodOptional<z.ZodObject<{
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                byProvider: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    tools: z.ZodOptional<z.ZodObject<{
        web: z.ZodOptional<z.ZodObject<{
            search: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                provider: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"brave">, z.ZodLiteral<"perplexity">, z.ZodLiteral<"grok">, z.ZodLiteral<"gemini">, z.ZodLiteral<"kimi">]>>;
                apiKey: z.ZodOptional<z.ZodString>;
                maxResults: z.ZodOptional<z.ZodNumber>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
                perplexity: z.ZodOptional<z.ZodObject<{
                    apiKey: z.ZodOptional<z.ZodString>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                grok: z.ZodOptional<z.ZodObject<{
                    apiKey: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                    inlineCitations: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                gemini: z.ZodOptional<z.ZodObject<{
                    apiKey: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                kimi: z.ZodOptional<z.ZodObject<{
                    apiKey: z.ZodOptional<z.ZodString>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            fetch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                maxCharsCap: z.ZodOptional<z.ZodNumber>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
                maxRedirects: z.ZodOptional<z.ZodNumber>;
                userAgent: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        media: z.ZodOptional<z.ZodObject<{
            models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                profile: z.ZodOptional<z.ZodString>;
                preferredProfile: z.ZodOptional<z.ZodString>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                command: z.ZodOptional<z.ZodString>;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            concurrency: z.ZodOptional<z.ZodNumber>;
            image: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                attachments: z.ZodOptional<z.ZodObject<{
                    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    maxAttachments: z.ZodOptional<z.ZodNumber>;
                    prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
                }, z.core.$strict>>;
                models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                    profile: z.ZodOptional<z.ZodString>;
                    preferredProfile: z.ZodOptional<z.ZodString>;
                    prompt: z.ZodOptional<z.ZodString>;
                    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                    language: z.ZodOptional<z.ZodString>;
                    providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                    deepgram: z.ZodOptional<z.ZodObject<{
                        detectLanguage: z.ZodOptional<z.ZodBoolean>;
                        punctuate: z.ZodOptional<z.ZodBoolean>;
                        smartFormat: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    provider: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                    capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                    type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                    command: z.ZodOptional<z.ZodString>;
                    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    maxBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                scope: z.ZodOptional<z.ZodObject<{
                    default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                        match: z.ZodOptional<z.ZodObject<{
                            channel: z.ZodOptional<z.ZodString>;
                            chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                            keyPrefix: z.ZodOptional<z.ZodString>;
                            rawKeyPrefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
            audio: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                attachments: z.ZodOptional<z.ZodObject<{
                    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    maxAttachments: z.ZodOptional<z.ZodNumber>;
                    prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
                }, z.core.$strict>>;
                models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                    profile: z.ZodOptional<z.ZodString>;
                    preferredProfile: z.ZodOptional<z.ZodString>;
                    prompt: z.ZodOptional<z.ZodString>;
                    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                    language: z.ZodOptional<z.ZodString>;
                    providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                    deepgram: z.ZodOptional<z.ZodObject<{
                        detectLanguage: z.ZodOptional<z.ZodBoolean>;
                        punctuate: z.ZodOptional<z.ZodBoolean>;
                        smartFormat: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    provider: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                    capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                    type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                    command: z.ZodOptional<z.ZodString>;
                    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    maxBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                scope: z.ZodOptional<z.ZodObject<{
                    default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                        match: z.ZodOptional<z.ZodObject<{
                            channel: z.ZodOptional<z.ZodString>;
                            chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                            keyPrefix: z.ZodOptional<z.ZodString>;
                            rawKeyPrefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
            video: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                attachments: z.ZodOptional<z.ZodObject<{
                    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    maxAttachments: z.ZodOptional<z.ZodNumber>;
                    prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
                }, z.core.$strict>>;
                models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
                    profile: z.ZodOptional<z.ZodString>;
                    preferredProfile: z.ZodOptional<z.ZodString>;
                    prompt: z.ZodOptional<z.ZodString>;
                    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                    language: z.ZodOptional<z.ZodString>;
                    providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                    deepgram: z.ZodOptional<z.ZodObject<{
                        detectLanguage: z.ZodOptional<z.ZodBoolean>;
                        punctuate: z.ZodOptional<z.ZodBoolean>;
                        smartFormat: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                    baseUrl: z.ZodOptional<z.ZodString>;
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    provider: z.ZodOptional<z.ZodString>;
                    model: z.ZodOptional<z.ZodString>;
                    capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                    type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                    command: z.ZodOptional<z.ZodString>;
                    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    maxBytes: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                prompt: z.ZodOptional<z.ZodString>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                language: z.ZodOptional<z.ZodString>;
                providerOptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>>;
                deepgram: z.ZodOptional<z.ZodObject<{
                    detectLanguage: z.ZodOptional<z.ZodBoolean>;
                    punctuate: z.ZodOptional<z.ZodBoolean>;
                    smartFormat: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                baseUrl: z.ZodOptional<z.ZodString>;
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                scope: z.ZodOptional<z.ZodObject<{
                    default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                    rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                        match: z.ZodOptional<z.ZodObject<{
                            channel: z.ZodOptional<z.ZodString>;
                            chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                            keyPrefix: z.ZodOptional<z.ZodString>;
                            rawKeyPrefix: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        links: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            scope: z.ZodOptional<z.ZodObject<{
                default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                    match: z.ZodOptional<z.ZodObject<{
                        channel: z.ZodOptional<z.ZodString>;
                        chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                        keyPrefix: z.ZodOptional<z.ZodString>;
                        rawKeyPrefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>;
            maxLinks: z.ZodOptional<z.ZodNumber>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            models: z.ZodOptional<z.ZodArray<z.ZodObject<{
                type: z.ZodOptional<z.ZodLiteral<"cli">>;
                command: z.ZodString;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        sessions: z.ZodOptional<z.ZodObject<{
            visibility: z.ZodOptional<z.ZodEnum<{
                agent: "agent";
                all: "all";
                self: "self";
                tree: "tree";
            }>>;
        }, z.core.$strict>>;
        loopDetection: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            historySize: z.ZodOptional<z.ZodNumber>;
            warningThreshold: z.ZodOptional<z.ZodNumber>;
            criticalThreshold: z.ZodOptional<z.ZodNumber>;
            globalCircuitBreakerThreshold: z.ZodOptional<z.ZodNumber>;
            detectors: z.ZodOptional<z.ZodObject<{
                genericRepeat: z.ZodOptional<z.ZodBoolean>;
                knownPollNoProgress: z.ZodOptional<z.ZodBoolean>;
                pingPong: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        message: z.ZodOptional<z.ZodObject<{
            allowCrossContextSend: z.ZodOptional<z.ZodBoolean>;
            crossContext: z.ZodOptional<z.ZodObject<{
                allowWithinProvider: z.ZodOptional<z.ZodBoolean>;
                allowAcrossProviders: z.ZodOptional<z.ZodBoolean>;
                marker: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    prefix: z.ZodOptional<z.ZodString>;
                    suffix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            broadcast: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        agentToAgent: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        elevated: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>;
        }, z.core.$strict>>;
        exec: z.ZodOptional<z.ZodObject<{
            host: z.ZodOptional<z.ZodEnum<{
                sandbox: "sandbox";
                gateway: "gateway";
                node: "node";
            }>>;
            security: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                deny: "deny";
                full: "full";
            }>>;
            ask: z.ZodOptional<z.ZodEnum<{
                off: "off";
                "on-miss": "on-miss";
                always: "always";
            }>>;
            node: z.ZodOptional<z.ZodString>;
            pathPrepend: z.ZodOptional<z.ZodArray<z.ZodString>>;
            safeBins: z.ZodOptional<z.ZodArray<z.ZodString>>;
            safeBinTrustedDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            safeBinProfiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                minPositional: z.ZodOptional<z.ZodNumber>;
                maxPositional: z.ZodOptional<z.ZodNumber>;
                allowedValueFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deniedFlags: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>;
            backgroundMs: z.ZodOptional<z.ZodNumber>;
            timeoutSec: z.ZodOptional<z.ZodNumber>;
            cleanupMs: z.ZodOptional<z.ZodNumber>;
            notifyOnExit: z.ZodOptional<z.ZodBoolean>;
            notifyOnExitEmptySuccess: z.ZodOptional<z.ZodBoolean>;
            applyPatch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                workspaceOnly: z.ZodOptional<z.ZodBoolean>;
                allowModels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        fs: z.ZodOptional<z.ZodObject<{
            workspaceOnly: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        subagents: z.ZodOptional<z.ZodObject<{
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        sandbox: z.ZodOptional<z.ZodObject<{
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        byProvider: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    bindings: z.ZodOptional<z.ZodArray<z.ZodObject<{
        agentId: z.ZodString;
        comment: z.ZodOptional<z.ZodString>;
        match: z.ZodObject<{
            channel: z.ZodString;
            accountId: z.ZodOptional<z.ZodString>;
            peer: z.ZodOptional<z.ZodObject<{
                kind: z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>;
                id: z.ZodString;
            }, z.core.$strict>>;
            guildId: z.ZodOptional<z.ZodString>;
            teamId: z.ZodOptional<z.ZodString>;
            roles: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
    }, z.core.$strict>>>;
    broadcast: z.ZodOptional<z.ZodObject<{
        strategy: z.ZodOptional<z.ZodEnum<{
            parallel: "parallel";
            sequential: "sequential";
        }>>;
    }, z.core.$catchall<z.ZodArray<z.ZodString>>>>;
    audio: z.ZodOptional<z.ZodObject<{
        transcription: z.ZodOptional<z.ZodObject<{
            command: z.ZodArray<z.ZodString>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    media: z.ZodOptional<z.ZodObject<{
        preserveFilenames: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    messages: z.ZodOptional<z.ZodObject<{
        messagePrefix: z.ZodOptional<z.ZodString>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        groupChat: z.ZodOptional<z.ZodObject<{
            mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        queue: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
            byChannel: z.ZodOptional<z.ZodObject<{
                whatsapp: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                telegram: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                discord: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                irc: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                slack: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                mattermost: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                signal: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                imessage: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                msteams: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
                webchat: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>>;
            }, z.core.$strict>>;
            debounceMs: z.ZodOptional<z.ZodNumber>;
            debounceMsByChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            cap: z.ZodOptional<z.ZodNumber>;
            drop: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"old">, z.ZodLiteral<"new">, z.ZodLiteral<"summarize">]>>;
        }, z.core.$strict>>;
        inbound: z.ZodOptional<z.ZodObject<{
            debounceMs: z.ZodOptional<z.ZodNumber>;
            byChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        }, z.core.$strict>>;
        ackReaction: z.ZodOptional<z.ZodString>;
        ackReactionScope: z.ZodOptional<z.ZodEnum<{
            direct: "direct";
            all: "all";
            "group-mentions": "group-mentions";
            "group-all": "group-all";
        }>>;
        removeAckAfterReply: z.ZodOptional<z.ZodBoolean>;
        statusReactions: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            emojis: z.ZodOptional<z.ZodObject<{
                thinking: z.ZodOptional<z.ZodString>;
                tool: z.ZodOptional<z.ZodString>;
                coding: z.ZodOptional<z.ZodString>;
                web: z.ZodOptional<z.ZodString>;
                done: z.ZodOptional<z.ZodString>;
                error: z.ZodOptional<z.ZodString>;
                stallSoft: z.ZodOptional<z.ZodString>;
                stallHard: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            timing: z.ZodOptional<z.ZodObject<{
                debounceMs: z.ZodOptional<z.ZodNumber>;
                stallSoftMs: z.ZodOptional<z.ZodNumber>;
                stallHardMs: z.ZodOptional<z.ZodNumber>;
                doneHoldMs: z.ZodOptional<z.ZodNumber>;
                errorHoldMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        suppressToolErrors: z.ZodOptional<z.ZodBoolean>;
        tts: z.ZodOptional<z.ZodObject<{
            auto: z.ZodOptional<z.ZodEnum<{
                off: "off";
                always: "always";
                inbound: "inbound";
                tagged: "tagged";
            }>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodEnum<{
                all: "all";
                final: "final";
            }>>;
            provider: z.ZodOptional<z.ZodEnum<{
                openai: "openai";
                elevenlabs: "elevenlabs";
                edge: "edge";
            }>>;
            summaryModel: z.ZodOptional<z.ZodString>;
            modelOverrides: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                allowText: z.ZodOptional<z.ZodBoolean>;
                allowProvider: z.ZodOptional<z.ZodBoolean>;
                allowVoice: z.ZodOptional<z.ZodBoolean>;
                allowModelId: z.ZodOptional<z.ZodBoolean>;
                allowVoiceSettings: z.ZodOptional<z.ZodBoolean>;
                allowNormalization: z.ZodOptional<z.ZodBoolean>;
                allowSeed: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            elevenlabs: z.ZodOptional<z.ZodObject<{
                apiKey: z.ZodOptional<z.ZodString>;
                baseUrl: z.ZodOptional<z.ZodString>;
                voiceId: z.ZodOptional<z.ZodString>;
                modelId: z.ZodOptional<z.ZodString>;
                seed: z.ZodOptional<z.ZodNumber>;
                applyTextNormalization: z.ZodOptional<z.ZodEnum<{
                    auto: "auto";
                    off: "off";
                    on: "on";
                }>>;
                languageCode: z.ZodOptional<z.ZodString>;
                voiceSettings: z.ZodOptional<z.ZodObject<{
                    stability: z.ZodOptional<z.ZodNumber>;
                    similarityBoost: z.ZodOptional<z.ZodNumber>;
                    style: z.ZodOptional<z.ZodNumber>;
                    useSpeakerBoost: z.ZodOptional<z.ZodBoolean>;
                    speed: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            openai: z.ZodOptional<z.ZodObject<{
                apiKey: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                voice: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            edge: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                voice: z.ZodOptional<z.ZodString>;
                lang: z.ZodOptional<z.ZodString>;
                outputFormat: z.ZodOptional<z.ZodString>;
                pitch: z.ZodOptional<z.ZodString>;
                rate: z.ZodOptional<z.ZodString>;
                volume: z.ZodOptional<z.ZodString>;
                saveSubtitles: z.ZodOptional<z.ZodBoolean>;
                proxy: z.ZodOptional<z.ZodString>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            prefsPath: z.ZodOptional<z.ZodString>;
            maxTextLength: z.ZodOptional<z.ZodNumber>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    commands: z.ZodDefault<z.ZodOptional<z.ZodObject<{
        native: z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>>;
        nativeSkills: z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>>;
        text: z.ZodOptional<z.ZodBoolean>;
        bash: z.ZodOptional<z.ZodBoolean>;
        bashForegroundMs: z.ZodOptional<z.ZodNumber>;
        config: z.ZodOptional<z.ZodBoolean>;
        debug: z.ZodOptional<z.ZodBoolean>;
        restart: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
        useAccessGroups: z.ZodOptional<z.ZodBoolean>;
        ownerAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        ownerDisplay: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            raw: "raw";
            hash: "hash";
        }>>>;
        ownerDisplaySecret: z.ZodOptional<z.ZodString>;
        allowFrom: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>>;
    }, z.core.$strict>>>;
    approvals: z.ZodOptional<z.ZodObject<{
        exec: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"targets">, z.ZodLiteral<"both">]>>;
            agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
            targets: z.ZodOptional<z.ZodArray<z.ZodObject<{
                channel: z.ZodString;
                to: z.ZodString;
                accountId: z.ZodOptional<z.ZodString>;
                threadId: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    session: z.ZodOptional<z.ZodObject<{
        scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"per-sender">, z.ZodLiteral<"global">]>>;
        dmScope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"main">, z.ZodLiteral<"per-peer">, z.ZodLiteral<"per-channel-peer">, z.ZodLiteral<"per-account-channel-peer">]>>;
        identityLinks: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        resetTriggers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        idleMinutes: z.ZodOptional<z.ZodNumber>;
        reset: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
            atHour: z.ZodOptional<z.ZodNumber>;
            idleMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        resetByType: z.ZodOptional<z.ZodObject<{
            direct: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            dm: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            group: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            thread: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
                atHour: z.ZodOptional<z.ZodNumber>;
                idleMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        resetByChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"daily">, z.ZodLiteral<"idle">]>>;
            atHour: z.ZodOptional<z.ZodNumber>;
            idleMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
        store: z.ZodOptional<z.ZodString>;
        typingIntervalSeconds: z.ZodOptional<z.ZodNumber>;
        typingMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"never">, z.ZodLiteral<"instant">, z.ZodLiteral<"thinking">, z.ZodLiteral<"message">]>>;
        parentForkMaxTokens: z.ZodOptional<z.ZodNumber>;
        mainKey: z.ZodOptional<z.ZodString>;
        sendPolicy: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
            rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                match: z.ZodOptional<z.ZodObject<{
                    channel: z.ZodOptional<z.ZodString>;
                    chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                    keyPrefix: z.ZodOptional<z.ZodString>;
                    rawKeyPrefix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>>;
        agentToAgent: z.ZodOptional<z.ZodObject<{
            maxPingPongTurns: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        threadBindings: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            idleHours: z.ZodOptional<z.ZodNumber>;
            maxAgeHours: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        maintenance: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                enforce: "enforce";
                warn: "warn";
            }>>;
            pruneAfter: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            pruneDays: z.ZodOptional<z.ZodNumber>;
            maxEntries: z.ZodOptional<z.ZodNumber>;
            rotateBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            resetArchiveRetention: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodLiteral<false>]>>;
            maxDiskBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            highWaterBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    cron: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        store: z.ZodOptional<z.ZodString>;
        maxConcurrentRuns: z.ZodOptional<z.ZodNumber>;
        retry: z.ZodOptional<z.ZodObject<{
            maxAttempts: z.ZodOptional<z.ZodNumber>;
            backoffMs: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
            retryOn: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                timeout: "timeout";
                network: "network";
                rate_limit: "rate_limit";
                server_error: "server_error";
            }>>>;
        }, z.core.$strict>>;
        webhook: z.ZodOptional<z.ZodString>;
        webhookToken: z.ZodOptional<z.ZodString>;
        sessionRetention: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodLiteral<false>]>>;
        runLog: z.ZodOptional<z.ZodObject<{
            maxBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            keepLines: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    hooks: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        path: z.ZodOptional<z.ZodString>;
        token: z.ZodOptional<z.ZodString>;
        defaultSessionKey: z.ZodOptional<z.ZodString>;
        allowRequestSessionKey: z.ZodOptional<z.ZodBoolean>;
        allowedSessionKeyPrefixes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        allowedAgentIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        maxBodyBytes: z.ZodOptional<z.ZodNumber>;
        presets: z.ZodOptional<z.ZodArray<z.ZodString>>;
        transformsDir: z.ZodOptional<z.ZodString>;
        mappings: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
            match: z.ZodOptional<z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                source: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            action: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"wake">, z.ZodLiteral<"agent">]>>;
            wakeMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"now">, z.ZodLiteral<"next-heartbeat">]>>;
            name: z.ZodOptional<z.ZodString>;
            agentId: z.ZodOptional<z.ZodString>;
            sessionKey: z.ZodOptional<z.ZodString>;
            messageTemplate: z.ZodOptional<z.ZodString>;
            textTemplate: z.ZodOptional<z.ZodString>;
            deliver: z.ZodOptional<z.ZodBoolean>;
            allowUnsafeExternalContent: z.ZodOptional<z.ZodBoolean>;
            channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"last">, z.ZodLiteral<"whatsapp">, z.ZodLiteral<"telegram">, z.ZodLiteral<"discord">, z.ZodLiteral<"irc">, z.ZodLiteral<"slack">, z.ZodLiteral<"signal">, z.ZodLiteral<"imessage">, z.ZodLiteral<"msteams">]>>;
            to: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            thinking: z.ZodOptional<z.ZodString>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            transform: z.ZodOptional<z.ZodObject<{
                module: z.ZodString;
                export: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>>>;
        gmail: z.ZodOptional<z.ZodObject<{
            account: z.ZodOptional<z.ZodString>;
            label: z.ZodOptional<z.ZodString>;
            topic: z.ZodOptional<z.ZodString>;
            subscription: z.ZodOptional<z.ZodString>;
            pushToken: z.ZodOptional<z.ZodString>;
            hookUrl: z.ZodOptional<z.ZodString>;
            includeBody: z.ZodOptional<z.ZodBoolean>;
            maxBytes: z.ZodOptional<z.ZodNumber>;
            renewEveryMinutes: z.ZodOptional<z.ZodNumber>;
            allowUnsafeExternalContent: z.ZodOptional<z.ZodBoolean>;
            serve: z.ZodOptional<z.ZodObject<{
                bind: z.ZodOptional<z.ZodString>;
                port: z.ZodOptional<z.ZodNumber>;
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            tailscale: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"serve">, z.ZodLiteral<"funnel">]>>;
                path: z.ZodOptional<z.ZodString>;
                target: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            model: z.ZodOptional<z.ZodString>;
            thinking: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"minimal">, z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>;
        }, z.core.$strict>>;
        internal: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            handlers: z.ZodOptional<z.ZodArray<z.ZodObject<{
                event: z.ZodString;
                module: z.ZodString;
                export: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            entries: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            }, z.core.$loose>>>;
            load: z.ZodOptional<z.ZodObject<{
                extraDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            installs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                hooks: z.ZodOptional<z.ZodArray<z.ZodString>>;
                source: z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"archive">, z.ZodLiteral<"path">]>;
                spec: z.ZodOptional<z.ZodString>;
                sourcePath: z.ZodOptional<z.ZodString>;
                installPath: z.ZodOptional<z.ZodString>;
                version: z.ZodOptional<z.ZodString>;
                resolvedName: z.ZodOptional<z.ZodString>;
                resolvedVersion: z.ZodOptional<z.ZodString>;
                resolvedSpec: z.ZodOptional<z.ZodString>;
                integrity: z.ZodOptional<z.ZodString>;
                shasum: z.ZodOptional<z.ZodString>;
                resolvedAt: z.ZodOptional<z.ZodString>;
                installedAt: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    web: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        heartbeatSeconds: z.ZodOptional<z.ZodNumber>;
        reconnect: z.ZodOptional<z.ZodObject<{
            initialMs: z.ZodOptional<z.ZodNumber>;
            maxMs: z.ZodOptional<z.ZodNumber>;
            factor: z.ZodOptional<z.ZodNumber>;
            jitter: z.ZodOptional<z.ZodNumber>;
            maxAttempts: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    channels: z.ZodOptional<z.ZodObject<{
        defaults: z.ZodOptional<z.ZodObject<{
            groupPolicy: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        modelByChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>>>;
        whatsapp: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
            messagePrefix: z.ZodOptional<z.ZodString>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>>;
            selfChatMode: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
            }, z.core.$strict>>>>;
            ackReaction: z.ZodOptional<z.ZodObject<{
                emoji: z.ZodOptional<z.ZodString>;
                direct: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
                group: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    always: "always";
                    never: "never";
                    mentions: "mentions";
                }>>>;
            }, z.core.$strict>>;
            debounceMs: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
                messagePrefix: z.ZodOptional<z.ZodString>;
                responsePrefix: z.ZodOptional<z.ZodString>;
                dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>>;
                selfChatMode: z.ZodOptional<z.ZodBoolean>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
                defaultTo: z.ZodOptional<z.ZodString>;
                groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                }, z.core.$strict>>>>;
                ackReaction: z.ZodOptional<z.ZodObject<{
                    emoji: z.ZodOptional<z.ZodString>;
                    direct: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
                    group: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        always: "always";
                        never: "never";
                        mentions: "mentions";
                    }>>>;
                }, z.core.$strict>>;
                debounceMs: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                name: z.ZodOptional<z.ZodString>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                authDir: z.ZodOptional<z.ZodString>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            mediaMaxMb: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
            actions: z.ZodOptional<z.ZodObject<{
                reactions: z.ZodOptional<z.ZodBoolean>;
                sendMessage: z.ZodOptional<z.ZodBoolean>;
                polls: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        telegram: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
                inlineButtons: z.ZodOptional<z.ZodEnum<{
                    group: "group";
                    dm: "dm";
                    allowlist: "allowlist";
                    off: "off";
                    all: "all";
                }>>;
            }, z.core.$strict>]>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            commands: z.ZodOptional<z.ZodObject<{
                native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
            }, z.core.$strict>>;
            customCommands: z.ZodOptional<z.ZodArray<z.ZodObject<{
                command: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
                description: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
            }, z.core.$strict>>>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>>;
            botToken: z.ZodOptional<z.ZodString>;
            tokenFile: z.ZodOptional<z.ZodString>;
            replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
            groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                groupPolicy: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
                skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                systemPrompt: z.ZodOptional<z.ZodString>;
                topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    groupPolicy: z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        open: "open";
                        disabled: "disabled";
                    }>>;
                    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>>>;
            }, z.core.$strict>>>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            defaultTo: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            streaming: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
                progress: "progress";
            }>]>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            draftChunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            streamMode: z.ZodOptional<z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
            }>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodOptional<z.ZodNumber>;
                minDelayMs: z.ZodOptional<z.ZodNumber>;
                maxDelayMs: z.ZodOptional<z.ZodNumber>;
                jitter: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            network: z.ZodOptional<z.ZodObject<{
                autoSelectFamily: z.ZodOptional<z.ZodBoolean>;
                dnsResultOrder: z.ZodOptional<z.ZodEnum<{
                    ipv4first: "ipv4first";
                    verbatim: "verbatim";
                }>>;
            }, z.core.$strict>>;
            proxy: z.ZodOptional<z.ZodString>;
            webhookUrl: z.ZodOptional<z.ZodString>;
            webhookSecret: z.ZodOptional<z.ZodString>;
            webhookPath: z.ZodOptional<z.ZodString>;
            webhookHost: z.ZodOptional<z.ZodString>;
            webhookPort: z.ZodOptional<z.ZodNumber>;
            actions: z.ZodOptional<z.ZodObject<{
                reactions: z.ZodOptional<z.ZodBoolean>;
                sendMessage: z.ZodOptional<z.ZodBoolean>;
                deleteMessage: z.ZodOptional<z.ZodBoolean>;
                sticker: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            reactionNotifications: z.ZodOptional<z.ZodEnum<{
                off: "off";
                all: "all";
                own: "own";
            }>>;
            reactionLevel: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                ack: "ack";
                extensive: "extensive";
            }>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            linkPreview: z.ZodOptional<z.ZodBoolean>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            ackReaction: z.ZodOptional<z.ZodString>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodObject<{
                    inlineButtons: z.ZodOptional<z.ZodEnum<{
                        group: "group";
                        dm: "dm";
                        allowlist: "allowlist";
                        off: "off";
                        all: "all";
                    }>>;
                }, z.core.$strict>]>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                commands: z.ZodOptional<z.ZodObject<{
                    native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                    nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                }, z.core.$strict>>;
                customCommands: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    command: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
                    description: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
                }, z.core.$strict>>>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>>;
                botToken: z.ZodOptional<z.ZodString>;
                tokenFile: z.ZodOptional<z.ZodString>;
                replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    groupPolicy: z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        open: "open";
                        disabled: "disabled";
                    }>>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                    topics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        requireMention: z.ZodOptional<z.ZodBoolean>;
                        groupPolicy: z.ZodOptional<z.ZodEnum<{
                            allowlist: "allowlist";
                            open: "open";
                            disabled: "disabled";
                        }>>;
                        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                        systemPrompt: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>>>;
                }, z.core.$strict>>>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                defaultTo: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
                groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                streaming: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
                    off: "off";
                    partial: "partial";
                    block: "block";
                    progress: "progress";
                }>]>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                draftChunk: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
                }, z.core.$strict>>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                streamMode: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    partial: "partial";
                    block: "block";
                }>>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
                retry: z.ZodOptional<z.ZodObject<{
                    attempts: z.ZodOptional<z.ZodNumber>;
                    minDelayMs: z.ZodOptional<z.ZodNumber>;
                    maxDelayMs: z.ZodOptional<z.ZodNumber>;
                    jitter: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                network: z.ZodOptional<z.ZodObject<{
                    autoSelectFamily: z.ZodOptional<z.ZodBoolean>;
                    dnsResultOrder: z.ZodOptional<z.ZodEnum<{
                        ipv4first: "ipv4first";
                        verbatim: "verbatim";
                    }>>;
                }, z.core.$strict>>;
                proxy: z.ZodOptional<z.ZodString>;
                webhookUrl: z.ZodOptional<z.ZodString>;
                webhookSecret: z.ZodOptional<z.ZodString>;
                webhookPath: z.ZodOptional<z.ZodString>;
                webhookHost: z.ZodOptional<z.ZodString>;
                webhookPort: z.ZodOptional<z.ZodNumber>;
                actions: z.ZodOptional<z.ZodObject<{
                    reactions: z.ZodOptional<z.ZodBoolean>;
                    sendMessage: z.ZodOptional<z.ZodBoolean>;
                    deleteMessage: z.ZodOptional<z.ZodBoolean>;
                    sticker: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                reactionNotifications: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    all: "all";
                    own: "own";
                }>>;
                reactionLevel: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    ack: "ack";
                    extensive: "extensive";
                }>>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                linkPreview: z.ZodOptional<z.ZodBoolean>;
                responsePrefix: z.ZodOptional<z.ZodString>;
                ackReaction: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>;
        discord: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            commands: z.ZodOptional<z.ZodObject<{
                native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
            }, z.core.$strict>>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            token: z.ZodOptional<z.ZodString>;
            proxy: z.ZodOptional<z.ZodString>;
            allowBots: z.ZodOptional<z.ZodBoolean>;
            dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            streaming: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
                progress: "progress";
            }>]>>;
            streamMode: z.ZodOptional<z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
            }>>;
            draftChunk: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
            }, z.core.$strict>>;
            maxLinesPerMessage: z.ZodOptional<z.ZodNumber>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            retry: z.ZodOptional<z.ZodObject<{
                attempts: z.ZodOptional<z.ZodNumber>;
                minDelayMs: z.ZodOptional<z.ZodNumber>;
                maxDelayMs: z.ZodOptional<z.ZodNumber>;
                jitter: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            actions: z.ZodOptional<z.ZodObject<{
                reactions: z.ZodOptional<z.ZodBoolean>;
                stickers: z.ZodOptional<z.ZodBoolean>;
                emojiUploads: z.ZodOptional<z.ZodBoolean>;
                stickerUploads: z.ZodOptional<z.ZodBoolean>;
                polls: z.ZodOptional<z.ZodBoolean>;
                permissions: z.ZodOptional<z.ZodBoolean>;
                messages: z.ZodOptional<z.ZodBoolean>;
                threads: z.ZodOptional<z.ZodBoolean>;
                pins: z.ZodOptional<z.ZodBoolean>;
                search: z.ZodOptional<z.ZodBoolean>;
                memberInfo: z.ZodOptional<z.ZodBoolean>;
                roleInfo: z.ZodOptional<z.ZodBoolean>;
                roles: z.ZodOptional<z.ZodBoolean>;
                channelInfo: z.ZodOptional<z.ZodBoolean>;
                voiceStatus: z.ZodOptional<z.ZodBoolean>;
                events: z.ZodOptional<z.ZodBoolean>;
                moderation: z.ZodOptional<z.ZodBoolean>;
                channels: z.ZodOptional<z.ZodBoolean>;
                presence: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
            dmPolicy: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            dm: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                policy: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                groupEnabled: z.ZodOptional<z.ZodBoolean>;
                groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
            }, z.core.$strict>>;
            guilds: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                slug: z.ZodOptional<z.ZodString>;
                requireMention: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
                reactionNotifications: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    off: "off";
                    all: "all";
                    own: "own";
                }>>;
                users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                roles: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodBoolean>;
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                    roles: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                    includeThreadStarter: z.ZodOptional<z.ZodBoolean>;
                    autoThread: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>>>;
            }, z.core.$strict>>>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            execApprovals: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
                sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
                cleanupAfterResolve: z.ZodOptional<z.ZodBoolean>;
                target: z.ZodOptional<z.ZodEnum<{
                    channel: "channel";
                    dm: "dm";
                    both: "both";
                }>>;
            }, z.core.$strict>>;
            ui: z.ZodOptional<z.ZodObject<{
                components: z.ZodOptional<z.ZodObject<{
                    accentColor: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            slashCommand: z.ZodOptional<z.ZodObject<{
                ephemeral: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            threadBindings: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                idleHours: z.ZodOptional<z.ZodNumber>;
                maxAgeHours: z.ZodOptional<z.ZodNumber>;
                spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
                spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            intents: z.ZodOptional<z.ZodObject<{
                presence: z.ZodOptional<z.ZodBoolean>;
                guildMembers: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            voice: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                autoJoin: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    guildId: z.ZodString;
                    channelId: z.ZodString;
                }, z.core.$strict>>>;
                daveEncryption: z.ZodOptional<z.ZodBoolean>;
                decryptionFailureTolerance: z.ZodOptional<z.ZodNumber>;
                tts: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                    auto: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        always: "always";
                        inbound: "inbound";
                        tagged: "tagged";
                    }>>;
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    mode: z.ZodOptional<z.ZodEnum<{
                        all: "all";
                        final: "final";
                    }>>;
                    provider: z.ZodOptional<z.ZodEnum<{
                        openai: "openai";
                        elevenlabs: "elevenlabs";
                        edge: "edge";
                    }>>;
                    summaryModel: z.ZodOptional<z.ZodString>;
                    modelOverrides: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        allowText: z.ZodOptional<z.ZodBoolean>;
                        allowProvider: z.ZodOptional<z.ZodBoolean>;
                        allowVoice: z.ZodOptional<z.ZodBoolean>;
                        allowModelId: z.ZodOptional<z.ZodBoolean>;
                        allowVoiceSettings: z.ZodOptional<z.ZodBoolean>;
                        allowNormalization: z.ZodOptional<z.ZodBoolean>;
                        allowSeed: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                    elevenlabs: z.ZodOptional<z.ZodObject<{
                        apiKey: z.ZodOptional<z.ZodString>;
                        baseUrl: z.ZodOptional<z.ZodString>;
                        voiceId: z.ZodOptional<z.ZodString>;
                        modelId: z.ZodOptional<z.ZodString>;
                        seed: z.ZodOptional<z.ZodNumber>;
                        applyTextNormalization: z.ZodOptional<z.ZodEnum<{
                            auto: "auto";
                            off: "off";
                            on: "on";
                        }>>;
                        languageCode: z.ZodOptional<z.ZodString>;
                        voiceSettings: z.ZodOptional<z.ZodObject<{
                            stability: z.ZodOptional<z.ZodNumber>;
                            similarityBoost: z.ZodOptional<z.ZodNumber>;
                            style: z.ZodOptional<z.ZodNumber>;
                            useSpeakerBoost: z.ZodOptional<z.ZodBoolean>;
                            speed: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                    openai: z.ZodOptional<z.ZodObject<{
                        apiKey: z.ZodOptional<z.ZodString>;
                        model: z.ZodOptional<z.ZodString>;
                        voice: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                    edge: z.ZodOptional<z.ZodObject<{
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        voice: z.ZodOptional<z.ZodString>;
                        lang: z.ZodOptional<z.ZodString>;
                        outputFormat: z.ZodOptional<z.ZodString>;
                        pitch: z.ZodOptional<z.ZodString>;
                        rate: z.ZodOptional<z.ZodString>;
                        volume: z.ZodOptional<z.ZodString>;
                        saveSubtitles: z.ZodOptional<z.ZodBoolean>;
                        proxy: z.ZodOptional<z.ZodString>;
                        timeoutMs: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    prefsPath: z.ZodOptional<z.ZodString>;
                    maxTextLength: z.ZodOptional<z.ZodNumber>;
                    timeoutMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>;
            pluralkit: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                token: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            ackReaction: z.ZodOptional<z.ZodString>;
            activity: z.ZodOptional<z.ZodString>;
            status: z.ZodOptional<z.ZodEnum<{
                idle: "idle";
                online: "online";
                dnd: "dnd";
                invisible: "invisible";
            }>>;
            activityType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>, z.ZodLiteral<4>, z.ZodLiteral<5>]>>;
            activityUrl: z.ZodOptional<z.ZodString>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                commands: z.ZodOptional<z.ZodObject<{
                    native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                    nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                }, z.core.$strict>>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                token: z.ZodOptional<z.ZodString>;
                proxy: z.ZodOptional<z.ZodString>;
                allowBots: z.ZodOptional<z.ZodBoolean>;
                dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                streaming: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
                    off: "off";
                    partial: "partial";
                    block: "block";
                    progress: "progress";
                }>]>>;
                streamMode: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    partial: "partial";
                    block: "block";
                }>>;
                draftChunk: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
                }, z.core.$strict>>;
                maxLinesPerMessage: z.ZodOptional<z.ZodNumber>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                retry: z.ZodOptional<z.ZodObject<{
                    attempts: z.ZodOptional<z.ZodNumber>;
                    minDelayMs: z.ZodOptional<z.ZodNumber>;
                    maxDelayMs: z.ZodOptional<z.ZodNumber>;
                    jitter: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                actions: z.ZodOptional<z.ZodObject<{
                    reactions: z.ZodOptional<z.ZodBoolean>;
                    stickers: z.ZodOptional<z.ZodBoolean>;
                    emojiUploads: z.ZodOptional<z.ZodBoolean>;
                    stickerUploads: z.ZodOptional<z.ZodBoolean>;
                    polls: z.ZodOptional<z.ZodBoolean>;
                    permissions: z.ZodOptional<z.ZodBoolean>;
                    messages: z.ZodOptional<z.ZodBoolean>;
                    threads: z.ZodOptional<z.ZodBoolean>;
                    pins: z.ZodOptional<z.ZodBoolean>;
                    search: z.ZodOptional<z.ZodBoolean>;
                    memberInfo: z.ZodOptional<z.ZodBoolean>;
                    roleInfo: z.ZodOptional<z.ZodBoolean>;
                    roles: z.ZodOptional<z.ZodBoolean>;
                    channelInfo: z.ZodOptional<z.ZodBoolean>;
                    voiceStatus: z.ZodOptional<z.ZodBoolean>;
                    events: z.ZodOptional<z.ZodBoolean>;
                    moderation: z.ZodOptional<z.ZodBoolean>;
                    channels: z.ZodOptional<z.ZodBoolean>;
                    presence: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                dmPolicy: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                defaultTo: z.ZodOptional<z.ZodString>;
                dm: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    policy: z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        open: "open";
                        disabled: "disabled";
                        pairing: "pairing";
                    }>>;
                    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                    groupEnabled: z.ZodOptional<z.ZodBoolean>;
                    groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                }, z.core.$strict>>;
                guilds: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    slug: z.ZodOptional<z.ZodString>;
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                    reactionNotifications: z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        off: "off";
                        all: "all";
                        own: "own";
                    }>>;
                    users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                    roles: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                    channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodBoolean>;
                        requireMention: z.ZodOptional<z.ZodBoolean>;
                        tools: z.ZodOptional<z.ZodObject<{
                            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        }, z.core.$strict>>;
                        toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                            alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        }, z.core.$strict>>>>;
                        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                        roles: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                        systemPrompt: z.ZodOptional<z.ZodString>;
                        includeThreadStarter: z.ZodOptional<z.ZodBoolean>;
                        autoThread: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>>>;
                }, z.core.$strict>>>>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                execApprovals: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    approvers: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]> & z.ZodType<string, string | number, z.core.$ZodTypeInternals<string, string | number>>>>;
                    agentFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    sessionFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    cleanupAfterResolve: z.ZodOptional<z.ZodBoolean>;
                    target: z.ZodOptional<z.ZodEnum<{
                        channel: "channel";
                        dm: "dm";
                        both: "both";
                    }>>;
                }, z.core.$strict>>;
                ui: z.ZodOptional<z.ZodObject<{
                    components: z.ZodOptional<z.ZodObject<{
                        accentColor: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                slashCommand: z.ZodOptional<z.ZodObject<{
                    ephemeral: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                threadBindings: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    idleHours: z.ZodOptional<z.ZodNumber>;
                    maxAgeHours: z.ZodOptional<z.ZodNumber>;
                    spawnSubagentSessions: z.ZodOptional<z.ZodBoolean>;
                    spawnAcpSessions: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                intents: z.ZodOptional<z.ZodObject<{
                    presence: z.ZodOptional<z.ZodBoolean>;
                    guildMembers: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                voice: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    autoJoin: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        guildId: z.ZodString;
                        channelId: z.ZodString;
                    }, z.core.$strict>>>;
                    daveEncryption: z.ZodOptional<z.ZodBoolean>;
                    decryptionFailureTolerance: z.ZodOptional<z.ZodNumber>;
                    tts: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                        auto: z.ZodOptional<z.ZodEnum<{
                            off: "off";
                            always: "always";
                            inbound: "inbound";
                            tagged: "tagged";
                        }>>;
                        enabled: z.ZodOptional<z.ZodBoolean>;
                        mode: z.ZodOptional<z.ZodEnum<{
                            all: "all";
                            final: "final";
                        }>>;
                        provider: z.ZodOptional<z.ZodEnum<{
                            openai: "openai";
                            elevenlabs: "elevenlabs";
                            edge: "edge";
                        }>>;
                        summaryModel: z.ZodOptional<z.ZodString>;
                        modelOverrides: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            allowText: z.ZodOptional<z.ZodBoolean>;
                            allowProvider: z.ZodOptional<z.ZodBoolean>;
                            allowVoice: z.ZodOptional<z.ZodBoolean>;
                            allowModelId: z.ZodOptional<z.ZodBoolean>;
                            allowVoiceSettings: z.ZodOptional<z.ZodBoolean>;
                            allowNormalization: z.ZodOptional<z.ZodBoolean>;
                            allowSeed: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                        elevenlabs: z.ZodOptional<z.ZodObject<{
                            apiKey: z.ZodOptional<z.ZodString>;
                            baseUrl: z.ZodOptional<z.ZodString>;
                            voiceId: z.ZodOptional<z.ZodString>;
                            modelId: z.ZodOptional<z.ZodString>;
                            seed: z.ZodOptional<z.ZodNumber>;
                            applyTextNormalization: z.ZodOptional<z.ZodEnum<{
                                auto: "auto";
                                off: "off";
                                on: "on";
                            }>>;
                            languageCode: z.ZodOptional<z.ZodString>;
                            voiceSettings: z.ZodOptional<z.ZodObject<{
                                stability: z.ZodOptional<z.ZodNumber>;
                                similarityBoost: z.ZodOptional<z.ZodNumber>;
                                style: z.ZodOptional<z.ZodNumber>;
                                useSpeakerBoost: z.ZodOptional<z.ZodBoolean>;
                                speed: z.ZodOptional<z.ZodNumber>;
                            }, z.core.$strict>>;
                        }, z.core.$strict>>;
                        openai: z.ZodOptional<z.ZodObject<{
                            apiKey: z.ZodOptional<z.ZodString>;
                            model: z.ZodOptional<z.ZodString>;
                            voice: z.ZodOptional<z.ZodString>;
                        }, z.core.$strict>>;
                        edge: z.ZodOptional<z.ZodObject<{
                            enabled: z.ZodOptional<z.ZodBoolean>;
                            voice: z.ZodOptional<z.ZodString>;
                            lang: z.ZodOptional<z.ZodString>;
                            outputFormat: z.ZodOptional<z.ZodString>;
                            pitch: z.ZodOptional<z.ZodString>;
                            rate: z.ZodOptional<z.ZodString>;
                            volume: z.ZodOptional<z.ZodString>;
                            saveSubtitles: z.ZodOptional<z.ZodBoolean>;
                            proxy: z.ZodOptional<z.ZodString>;
                            timeoutMs: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        prefsPath: z.ZodOptional<z.ZodString>;
                        maxTextLength: z.ZodOptional<z.ZodNumber>;
                        timeoutMs: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>>;
                }, z.core.$strict>>;
                pluralkit: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    token: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                responsePrefix: z.ZodOptional<z.ZodString>;
                ackReaction: z.ZodOptional<z.ZodString>;
                activity: z.ZodOptional<z.ZodString>;
                status: z.ZodOptional<z.ZodEnum<{
                    idle: "idle";
                    online: "online";
                    dnd: "dnd";
                    invisible: "invisible";
                }>>;
                activityType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>, z.ZodLiteral<4>, z.ZodLiteral<5>]>>;
                activityUrl: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>;
        irc: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            host: z.ZodOptional<z.ZodString>;
            port: z.ZodOptional<z.ZodNumber>;
            tls: z.ZodOptional<z.ZodBoolean>;
            nick: z.ZodOptional<z.ZodString>;
            username: z.ZodOptional<z.ZodString>;
            realname: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodString>;
            passwordFile: z.ZodOptional<z.ZodString>;
            nickserv: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                service: z.ZodOptional<z.ZodString>;
                password: z.ZodOptional<z.ZodString>;
                passwordFile: z.ZodOptional<z.ZodString>;
                register: z.ZodOptional<z.ZodBoolean>;
                registerEmail: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
                skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                systemPrompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                host: z.ZodOptional<z.ZodString>;
                port: z.ZodOptional<z.ZodNumber>;
                tls: z.ZodOptional<z.ZodBoolean>;
                nick: z.ZodOptional<z.ZodString>;
                username: z.ZodOptional<z.ZodString>;
                realname: z.ZodOptional<z.ZodString>;
                password: z.ZodOptional<z.ZodString>;
                passwordFile: z.ZodOptional<z.ZodString>;
                nickserv: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    service: z.ZodOptional<z.ZodString>;
                    password: z.ZodOptional<z.ZodString>;
                    passwordFile: z.ZodOptional<z.ZodString>;
                    register: z.ZodOptional<z.ZodBoolean>;
                    registerEmail: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
                dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                defaultTo: z.ZodOptional<z.ZodString>;
                groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>>>;
                mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                responsePrefix: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>;
        googlechat: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            allowBots: z.ZodOptional<z.ZodBoolean>;
            dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
            requireMention: z.ZodOptional<z.ZodBoolean>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                allow: z.ZodOptional<z.ZodBoolean>;
                requireMention: z.ZodOptional<z.ZodBoolean>;
                users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                systemPrompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            serviceAccount: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodDiscriminatedUnion<[z.ZodObject<{
                source: z.ZodLiteral<"env">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"file">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"exec">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>], "source">]>>;
            serviceAccountRef: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                source: z.ZodLiteral<"env">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"file">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"exec">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>], "source">>;
            serviceAccountFile: z.ZodOptional<z.ZodString>;
            audienceType: z.ZodOptional<z.ZodEnum<{
                "app-url": "app-url";
                "project-number": "project-number";
            }>>;
            audience: z.ZodOptional<z.ZodString>;
            webhookPath: z.ZodOptional<z.ZodString>;
            webhookUrl: z.ZodOptional<z.ZodString>;
            botUser: z.ZodOptional<z.ZodString>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            streamMode: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                replace: "replace";
                status_final: "status_final";
                append: "append";
            }>>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
            actions: z.ZodOptional<z.ZodObject<{
                reactions: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            dm: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                policy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            }, z.core.$strict>>;
            typingIndicator: z.ZodOptional<z.ZodEnum<{
                message: "message";
                none: "none";
                reaction: "reaction";
            }>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                allowBots: z.ZodOptional<z.ZodBoolean>;
                dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
                requireMention: z.ZodOptional<z.ZodBoolean>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allow: z.ZodOptional<z.ZodBoolean>;
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>>>;
                defaultTo: z.ZodOptional<z.ZodString>;
                serviceAccount: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>, z.ZodDiscriminatedUnion<[z.ZodObject<{
                    source: z.ZodLiteral<"env">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"file">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"exec">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>], "source">]>>;
                serviceAccountRef: z.ZodOptional<z.ZodDiscriminatedUnion<[z.ZodObject<{
                    source: z.ZodLiteral<"env">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"file">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    source: z.ZodLiteral<"exec">;
                    provider: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>], "source">>;
                serviceAccountFile: z.ZodOptional<z.ZodString>;
                audienceType: z.ZodOptional<z.ZodEnum<{
                    "app-url": "app-url";
                    "project-number": "project-number";
                }>>;
                audience: z.ZodOptional<z.ZodString>;
                webhookPath: z.ZodOptional<z.ZodString>;
                webhookUrl: z.ZodOptional<z.ZodString>;
                botUser: z.ZodOptional<z.ZodString>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                streamMode: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    replace: "replace";
                    status_final: "status_final";
                    append: "append";
                }>>>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                actions: z.ZodOptional<z.ZodObject<{
                    reactions: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                dm: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    policy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        open: "open";
                        disabled: "disabled";
                        pairing: "pairing";
                    }>>>;
                    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                }, z.core.$strict>>;
                typingIndicator: z.ZodOptional<z.ZodEnum<{
                    message: "message";
                    none: "none";
                    reaction: "reaction";
                }>>;
                responsePrefix: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            defaultAccount: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        slack: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            commands: z.ZodOptional<z.ZodObject<{
                native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
            }, z.core.$strict>>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            botToken: z.ZodOptional<z.ZodString>;
            appToken: z.ZodOptional<z.ZodString>;
            userToken: z.ZodOptional<z.ZodString>;
            userTokenReadOnly: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
            allowBots: z.ZodOptional<z.ZodBoolean>;
            dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
            requireMention: z.ZodOptional<z.ZodBoolean>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            streaming: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
                off: "off";
                partial: "partial";
                block: "block";
                progress: "progress";
            }>]>>;
            nativeStreaming: z.ZodOptional<z.ZodBoolean>;
            streamMode: z.ZodOptional<z.ZodEnum<{
                replace: "replace";
                status_final: "status_final";
                append: "append";
            }>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            reactionNotifications: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                off: "off";
                all: "all";
                own: "own";
            }>>;
            reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
            replyToModeByChatType: z.ZodOptional<z.ZodObject<{
                direct: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
            }, z.core.$strict>>;
            thread: z.ZodOptional<z.ZodObject<{
                historyScope: z.ZodOptional<z.ZodEnum<{
                    channel: "channel";
                    thread: "thread";
                }>>;
                inheritParent: z.ZodOptional<z.ZodBoolean>;
                initialHistoryLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            actions: z.ZodOptional<z.ZodObject<{
                reactions: z.ZodOptional<z.ZodBoolean>;
                messages: z.ZodOptional<z.ZodBoolean>;
                pins: z.ZodOptional<z.ZodBoolean>;
                search: z.ZodOptional<z.ZodBoolean>;
                permissions: z.ZodOptional<z.ZodBoolean>;
                memberInfo: z.ZodOptional<z.ZodBoolean>;
                channelInfo: z.ZodOptional<z.ZodBoolean>;
                emojiList: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            slashCommand: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                name: z.ZodOptional<z.ZodString>;
                sessionPrefix: z.ZodOptional<z.ZodString>;
                ephemeral: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            dmPolicy: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            dm: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                policy: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groupEnabled: z.ZodOptional<z.ZodBoolean>;
                groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
            }, z.core.$strict>>;
            channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                allow: z.ZodOptional<z.ZodBoolean>;
                requireMention: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
                allowBots: z.ZodOptional<z.ZodBoolean>;
                users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                systemPrompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            ackReaction: z.ZodOptional<z.ZodString>;
            mode: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                socket: "socket";
                http: "http";
            }>>>;
            signingSecret: z.ZodOptional<z.ZodString>;
            webhookPath: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                mode: z.ZodOptional<z.ZodEnum<{
                    socket: "socket";
                    http: "http";
                }>>;
                signingSecret: z.ZodOptional<z.ZodString>;
                webhookPath: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                commands: z.ZodOptional<z.ZodObject<{
                    native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                    nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
                }, z.core.$strict>>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                botToken: z.ZodOptional<z.ZodString>;
                appToken: z.ZodOptional<z.ZodString>;
                userToken: z.ZodOptional<z.ZodString>;
                userTokenReadOnly: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
                allowBots: z.ZodOptional<z.ZodBoolean>;
                dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
                requireMention: z.ZodOptional<z.ZodBoolean>;
                groupPolicy: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                streaming: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
                    off: "off";
                    partial: "partial";
                    block: "block";
                    progress: "progress";
                }>]>>;
                nativeStreaming: z.ZodOptional<z.ZodBoolean>;
                streamMode: z.ZodOptional<z.ZodEnum<{
                    replace: "replace";
                    status_final: "status_final";
                    append: "append";
                }>>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                reactionNotifications: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    off: "off";
                    all: "all";
                    own: "own";
                }>>;
                reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                replyToModeByChatType: z.ZodOptional<z.ZodObject<{
                    direct: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                    channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                }, z.core.$strict>>;
                thread: z.ZodOptional<z.ZodObject<{
                    historyScope: z.ZodOptional<z.ZodEnum<{
                        channel: "channel";
                        thread: "thread";
                    }>>;
                    inheritParent: z.ZodOptional<z.ZodBoolean>;
                    initialHistoryLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                actions: z.ZodOptional<z.ZodObject<{
                    reactions: z.ZodOptional<z.ZodBoolean>;
                    messages: z.ZodOptional<z.ZodBoolean>;
                    pins: z.ZodOptional<z.ZodBoolean>;
                    search: z.ZodOptional<z.ZodBoolean>;
                    permissions: z.ZodOptional<z.ZodBoolean>;
                    memberInfo: z.ZodOptional<z.ZodBoolean>;
                    channelInfo: z.ZodOptional<z.ZodBoolean>;
                    emojiList: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                slashCommand: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    name: z.ZodOptional<z.ZodString>;
                    sessionPrefix: z.ZodOptional<z.ZodString>;
                    ephemeral: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                dmPolicy: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                defaultTo: z.ZodOptional<z.ZodString>;
                dm: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    policy: z.ZodOptional<z.ZodEnum<{
                        allowlist: "allowlist";
                        open: "open";
                        disabled: "disabled";
                        pairing: "pairing";
                    }>>;
                    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                    groupEnabled: z.ZodOptional<z.ZodBoolean>;
                    groupChannels: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                    replyToMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                }, z.core.$strict>>;
                channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    allow: z.ZodOptional<z.ZodBoolean>;
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                    allowBots: z.ZodOptional<z.ZodBoolean>;
                    users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    systemPrompt: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>>>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                responsePrefix: z.ZodOptional<z.ZodString>;
                ackReaction: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>;
        signal: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            account: z.ZodOptional<z.ZodString>;
            httpUrl: z.ZodOptional<z.ZodString>;
            httpHost: z.ZodOptional<z.ZodString>;
            httpPort: z.ZodOptional<z.ZodNumber>;
            cliPath: z.ZodOptional<z.ZodString>;
            autoStart: z.ZodOptional<z.ZodBoolean>;
            startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
            receiveMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on-start">, z.ZodLiteral<"manual">]>>;
            ignoreAttachments: z.ZodOptional<z.ZodBoolean>;
            ignoreStories: z.ZodOptional<z.ZodBoolean>;
            sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
            dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            reactionNotifications: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                off: "off";
                all: "all";
                own: "own";
            }>>;
            reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            actions: z.ZodOptional<z.ZodObject<{
                reactions: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            reactionLevel: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                ack: "ack";
                extensive: "extensive";
            }>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                account: z.ZodOptional<z.ZodString>;
                httpUrl: z.ZodOptional<z.ZodString>;
                httpHost: z.ZodOptional<z.ZodString>;
                httpPort: z.ZodOptional<z.ZodNumber>;
                cliPath: z.ZodOptional<z.ZodString>;
                autoStart: z.ZodOptional<z.ZodBoolean>;
                startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
                receiveMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"on-start">, z.ZodLiteral<"manual">]>>;
                ignoreAttachments: z.ZodOptional<z.ZodBoolean>;
                ignoreStories: z.ZodOptional<z.ZodBoolean>;
                sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
                dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                defaultTo: z.ZodOptional<z.ZodString>;
                groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                reactionNotifications: z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    off: "off";
                    all: "all";
                    own: "own";
                }>>;
                reactionAllowlist: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                actions: z.ZodOptional<z.ZodObject<{
                    reactions: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                reactionLevel: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    ack: "ack";
                    extensive: "extensive";
                }>>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                responsePrefix: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>;
        imessage: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            cliPath: z.ZodOptional<z.ZodString>;
            dbPath: z.ZodOptional<z.ZodString>;
            remoteHost: z.ZodOptional<z.ZodString>;
            service: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"imessage">, z.ZodLiteral<"sms">, z.ZodLiteral<"auto">]>>;
            region: z.ZodOptional<z.ZodString>;
            dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            includeAttachments: z.ZodOptional<z.ZodBoolean>;
            attachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            remoteAttachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
            }, z.core.$strict>>>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                cliPath: z.ZodOptional<z.ZodString>;
                dbPath: z.ZodOptional<z.ZodString>;
                remoteHost: z.ZodOptional<z.ZodString>;
                service: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"imessage">, z.ZodLiteral<"sms">, z.ZodLiteral<"auto">]>>;
                region: z.ZodOptional<z.ZodString>;
                dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                defaultTo: z.ZodOptional<z.ZodString>;
                groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                includeAttachments: z.ZodOptional<z.ZodBoolean>;
                attachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                remoteAttachmentRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                }, z.core.$strict>>>>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                responsePrefix: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
        }, z.core.$strict>>;
        bluebubbles: z.ZodOptional<z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            enabled: z.ZodOptional<z.ZodBoolean>;
            serverUrl: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodString>;
            webhookPath: z.ZodOptional<z.ZodString>;
            dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            mediaLocalRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
            sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
            blockStreaming: z.ZodOptional<z.ZodBoolean>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
            }, z.core.$strict>>>>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
            accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                name: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
                markdown: z.ZodOptional<z.ZodObject<{
                    tables: z.ZodOptional<z.ZodEnum<{
                        off: "off";
                        bullets: "bullets";
                        code: "code";
                    }>>;
                }, z.core.$strict>>;
                configWrites: z.ZodOptional<z.ZodBoolean>;
                enabled: z.ZodOptional<z.ZodBoolean>;
                serverUrl: z.ZodOptional<z.ZodString>;
                password: z.ZodOptional<z.ZodString>;
                webhookPath: z.ZodOptional<z.ZodString>;
                dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                    pairing: "pairing";
                }>>>;
                allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
                groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                    allowlist: "allowlist";
                    open: "open";
                    disabled: "disabled";
                }>>>;
                historyLimit: z.ZodOptional<z.ZodNumber>;
                dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
                dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    historyLimit: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>>>;
                textChunkLimit: z.ZodOptional<z.ZodNumber>;
                chunkMode: z.ZodOptional<z.ZodEnum<{
                    length: "length";
                    newline: "newline";
                }>>;
                mediaMaxMb: z.ZodOptional<z.ZodNumber>;
                mediaLocalRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
                sendReadReceipts: z.ZodOptional<z.ZodBoolean>;
                blockStreaming: z.ZodOptional<z.ZodBoolean>;
                blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                    minChars: z.ZodOptional<z.ZodNumber>;
                    maxChars: z.ZodOptional<z.ZodNumber>;
                    idleMs: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
                groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                }, z.core.$strict>>>>;
                heartbeat: z.ZodOptional<z.ZodObject<{
                    showOk: z.ZodOptional<z.ZodBoolean>;
                    showAlerts: z.ZodOptional<z.ZodBoolean>;
                    useIndicator: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                responsePrefix: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            actions: z.ZodOptional<z.ZodObject<{
                reactions: z.ZodOptional<z.ZodBoolean>;
                edit: z.ZodOptional<z.ZodBoolean>;
                unsend: z.ZodOptional<z.ZodBoolean>;
                reply: z.ZodOptional<z.ZodBoolean>;
                sendWithEffect: z.ZodOptional<z.ZodBoolean>;
                renameGroup: z.ZodOptional<z.ZodBoolean>;
                setGroupIcon: z.ZodOptional<z.ZodBoolean>;
                addParticipant: z.ZodOptional<z.ZodBoolean>;
                removeParticipant: z.ZodOptional<z.ZodBoolean>;
                leaveGroup: z.ZodOptional<z.ZodBoolean>;
                sendAttachment: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        msteams: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
            dangerouslyAllowNameMatching: z.ZodOptional<z.ZodBoolean>;
            markdown: z.ZodOptional<z.ZodObject<{
                tables: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    bullets: "bullets";
                    code: "code";
                }>>;
            }, z.core.$strict>>;
            configWrites: z.ZodOptional<z.ZodBoolean>;
            appId: z.ZodOptional<z.ZodString>;
            appPassword: z.ZodOptional<z.ZodString>;
            tenantId: z.ZodOptional<z.ZodString>;
            webhook: z.ZodOptional<z.ZodObject<{
                port: z.ZodOptional<z.ZodNumber>;
                path: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
                pairing: "pairing";
            }>>>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
            defaultTo: z.ZodOptional<z.ZodString>;
            groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodString>>;
            groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                open: "open";
                disabled: "disabled";
            }>>>;
            textChunkLimit: z.ZodOptional<z.ZodNumber>;
            chunkMode: z.ZodOptional<z.ZodEnum<{
                length: "length";
                newline: "newline";
            }>>;
            blockStreamingCoalesce: z.ZodOptional<z.ZodObject<{
                minChars: z.ZodOptional<z.ZodNumber>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                idleMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            mediaAllowHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
            mediaAuthAllowHosts: z.ZodOptional<z.ZodArray<z.ZodString>>;
            requireMention: z.ZodOptional<z.ZodBoolean>;
            historyLimit: z.ZodOptional<z.ZodNumber>;
            dmHistoryLimit: z.ZodOptional<z.ZodNumber>;
            dms: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                historyLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>>;
            replyStyle: z.ZodOptional<z.ZodEnum<{
                thread: "thread";
                "top-level": "top-level";
            }>>;
            teams: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                requireMention: z.ZodOptional<z.ZodBoolean>;
                tools: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>>>;
                replyStyle: z.ZodOptional<z.ZodEnum<{
                    thread: "thread";
                    "top-level": "top-level";
                }>>;
                channels: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                    requireMention: z.ZodOptional<z.ZodBoolean>;
                    tools: z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>;
                    toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    }, z.core.$strict>>>>;
                    replyStyle: z.ZodOptional<z.ZodEnum<{
                        thread: "thread";
                        "top-level": "top-level";
                    }>>;
                }, z.core.$strict>>>>;
            }, z.core.$strict>>>>;
            mediaMaxMb: z.ZodOptional<z.ZodNumber>;
            sharePointSiteId: z.ZodOptional<z.ZodString>;
            heartbeat: z.ZodOptional<z.ZodObject<{
                showOk: z.ZodOptional<z.ZodBoolean>;
                showAlerts: z.ZodOptional<z.ZodBoolean>;
                useIndicator: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            responsePrefix: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$loose>>;
    discovery: z.ZodOptional<z.ZodObject<{
        wideArea: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        mdns: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodEnum<{
                full: "full";
                off: "off";
                minimal: "minimal";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    canvasHost: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        root: z.ZodOptional<z.ZodString>;
        port: z.ZodOptional<z.ZodNumber>;
        liveReload: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    talk: z.ZodOptional<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            voiceId: z.ZodOptional<z.ZodString>;
            voiceAliases: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            modelId: z.ZodOptional<z.ZodString>;
            outputFormat: z.ZodOptional<z.ZodString>;
            apiKey: z.ZodOptional<z.ZodString>;
        }, z.core.$catchall<z.ZodUnknown>>>>;
        voiceId: z.ZodOptional<z.ZodString>;
        voiceAliases: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        modelId: z.ZodOptional<z.ZodString>;
        outputFormat: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodString>;
        interruptOnSpeech: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    gateway: z.ZodOptional<z.ZodObject<{
        port: z.ZodOptional<z.ZodNumber>;
        mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"local">, z.ZodLiteral<"remote">]>>;
        bind: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"lan">, z.ZodLiteral<"loopback">, z.ZodLiteral<"custom">, z.ZodLiteral<"tailnet">]>>;
        customBindHost: z.ZodOptional<z.ZodString>;
        controlUi: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            basePath: z.ZodOptional<z.ZodString>;
            root: z.ZodOptional<z.ZodString>;
            allowedOrigins: z.ZodOptional<z.ZodArray<z.ZodString>>;
            dangerouslyAllowHostHeaderOriginFallback: z.ZodOptional<z.ZodBoolean>;
            allowInsecureAuth: z.ZodOptional<z.ZodBoolean>;
            dangerouslyDisableDeviceAuth: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        auth: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"token">, z.ZodLiteral<"password">, z.ZodLiteral<"trusted-proxy">]>>;
            token: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodString>;
            allowTailscale: z.ZodOptional<z.ZodBoolean>;
            rateLimit: z.ZodOptional<z.ZodObject<{
                maxAttempts: z.ZodOptional<z.ZodNumber>;
                windowMs: z.ZodOptional<z.ZodNumber>;
                lockoutMs: z.ZodOptional<z.ZodNumber>;
                exemptLoopback: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            trustedProxy: z.ZodOptional<z.ZodObject<{
                userHeader: z.ZodString;
                requiredHeaders: z.ZodOptional<z.ZodArray<z.ZodString>>;
                allowUsers: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        trustedProxies: z.ZodOptional<z.ZodArray<z.ZodString>>;
        allowRealIpFallback: z.ZodOptional<z.ZodBoolean>;
        tools: z.ZodOptional<z.ZodObject<{
            deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        channelHealthCheckMinutes: z.ZodOptional<z.ZodNumber>;
        tailscale: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"serve">, z.ZodLiteral<"funnel">]>>;
            resetOnExit: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        remote: z.ZodOptional<z.ZodObject<{
            url: z.ZodOptional<z.ZodString>;
            transport: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"ssh">, z.ZodLiteral<"direct">]>>;
            token: z.ZodOptional<z.ZodString>;
            password: z.ZodOptional<z.ZodString>;
            tlsFingerprint: z.ZodOptional<z.ZodString>;
            sshTarget: z.ZodOptional<z.ZodString>;
            sshIdentity: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        reload: z.ZodOptional<z.ZodObject<{
            mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"restart">, z.ZodLiteral<"hot">, z.ZodLiteral<"hybrid">]>>;
            debounceMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        tls: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            autoGenerate: z.ZodOptional<z.ZodBoolean>;
            certPath: z.ZodOptional<z.ZodString>;
            keyPath: z.ZodOptional<z.ZodString>;
            caPath: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        http: z.ZodOptional<z.ZodObject<{
            endpoints: z.ZodOptional<z.ZodObject<{
                chatCompletions: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
                responses: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
                    maxBodyBytes: z.ZodOptional<z.ZodNumber>;
                    maxUrlParts: z.ZodOptional<z.ZodNumber>;
                    files: z.ZodOptional<z.ZodObject<{
                        allowUrl: z.ZodOptional<z.ZodBoolean>;
                        urlAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        allowedMimes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        maxBytes: z.ZodOptional<z.ZodNumber>;
                        maxChars: z.ZodOptional<z.ZodNumber>;
                        maxRedirects: z.ZodOptional<z.ZodNumber>;
                        timeoutMs: z.ZodOptional<z.ZodNumber>;
                        pdf: z.ZodOptional<z.ZodObject<{
                            maxPages: z.ZodOptional<z.ZodNumber>;
                            maxPixels: z.ZodOptional<z.ZodNumber>;
                            minTextChars: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>>;
                    images: z.ZodOptional<z.ZodObject<{
                        allowUrl: z.ZodOptional<z.ZodBoolean>;
                        urlAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        allowedMimes: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        maxBytes: z.ZodOptional<z.ZodNumber>;
                        maxRedirects: z.ZodOptional<z.ZodNumber>;
                        timeoutMs: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            securityHeaders: z.ZodOptional<z.ZodObject<{
                strictTransportSecurity: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodLiteral<false>]>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        nodes: z.ZodOptional<z.ZodObject<{
            browser: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"manual">, z.ZodLiteral<"off">]>>;
                node: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            allowCommands: z.ZodOptional<z.ZodArray<z.ZodString>>;
            denyCommands: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    memory: z.ZodOptional<z.ZodObject<{
        backend: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"builtin">, z.ZodLiteral<"qmd">]>>;
        citations: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"auto">, z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
        qmd: z.ZodOptional<z.ZodObject<{
            command: z.ZodOptional<z.ZodString>;
            mcporter: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                serverName: z.ZodOptional<z.ZodString>;
                startDaemon: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            searchMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"query">, z.ZodLiteral<"search">, z.ZodLiteral<"vsearch">]>>;
            includeDefaultMemory: z.ZodOptional<z.ZodBoolean>;
            paths: z.ZodOptional<z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                pattern: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            sessions: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                exportDir: z.ZodOptional<z.ZodString>;
                retentionDays: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            update: z.ZodOptional<z.ZodObject<{
                interval: z.ZodOptional<z.ZodString>;
                debounceMs: z.ZodOptional<z.ZodNumber>;
                onBoot: z.ZodOptional<z.ZodBoolean>;
                waitForBootSync: z.ZodOptional<z.ZodBoolean>;
                embedInterval: z.ZodOptional<z.ZodString>;
                commandTimeoutMs: z.ZodOptional<z.ZodNumber>;
                updateTimeoutMs: z.ZodOptional<z.ZodNumber>;
                embedTimeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            limits: z.ZodOptional<z.ZodObject<{
                maxResults: z.ZodOptional<z.ZodNumber>;
                maxSnippetChars: z.ZodOptional<z.ZodNumber>;
                maxInjectedChars: z.ZodOptional<z.ZodNumber>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            scope: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                default: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>>;
                rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    action: z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"deny">]>;
                    match: z.ZodOptional<z.ZodObject<{
                        channel: z.ZodOptional<z.ZodString>;
                        chatType: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"direct">, z.ZodLiteral<"group">, z.ZodLiteral<"channel">, z.ZodLiteral<"dm">]>>;
                        keyPrefix: z.ZodOptional<z.ZodString>;
                        rawKeyPrefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    skills: z.ZodOptional<z.ZodObject<{
        allowBundled: z.ZodOptional<z.ZodArray<z.ZodString>>;
        load: z.ZodOptional<z.ZodObject<{
            extraDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            watch: z.ZodOptional<z.ZodBoolean>;
            watchDebounceMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        install: z.ZodOptional<z.ZodObject<{
            preferBrew: z.ZodOptional<z.ZodBoolean>;
            nodeManager: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"pnpm">, z.ZodLiteral<"yarn">, z.ZodLiteral<"bun">]>>;
        }, z.core.$strict>>;
        limits: z.ZodOptional<z.ZodObject<{
            maxCandidatesPerRoot: z.ZodOptional<z.ZodNumber>;
            maxSkillsLoadedPerSource: z.ZodOptional<z.ZodNumber>;
            maxSkillsInPrompt: z.ZodOptional<z.ZodNumber>;
            maxSkillsPromptChars: z.ZodOptional<z.ZodNumber>;
            maxSkillFileBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        entries: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            apiKey: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
                source: z.ZodLiteral<"env">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"file">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                source: z.ZodLiteral<"exec">;
                provider: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>], "source">]>>;
            env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    plugins: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
        deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
        load: z.ZodOptional<z.ZodObject<{
            paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        slots: z.ZodOptional<z.ZodObject<{
            memory: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        entries: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strict>>>;
        installs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            source: z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"archive">, z.ZodLiteral<"path">]>;
            spec: z.ZodOptional<z.ZodString>;
            sourcePath: z.ZodOptional<z.ZodString>;
            installPath: z.ZodOptional<z.ZodString>;
            version: z.ZodOptional<z.ZodString>;
            resolvedName: z.ZodOptional<z.ZodString>;
            resolvedVersion: z.ZodOptional<z.ZodString>;
            resolvedSpec: z.ZodOptional<z.ZodString>;
            integrity: z.ZodOptional<z.ZodString>;
            shasum: z.ZodOptional<z.ZodString>;
            resolvedAt: z.ZodOptional<z.ZodString>;
            installedAt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
