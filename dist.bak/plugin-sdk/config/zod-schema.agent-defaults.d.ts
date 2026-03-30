import { z } from "zod";
export declare const AgentDefaultsSchema: z.ZodOptional<z.ZodObject<{
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
}, z.core.$strict>>;
