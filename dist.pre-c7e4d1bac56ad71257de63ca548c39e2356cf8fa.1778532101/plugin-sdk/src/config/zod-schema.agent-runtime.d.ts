import { z } from "zod";
import { AgentModelSchema } from "./zod-schema.agent-model.js";
export declare const HeartbeatSchema: z.ZodOptional<z.ZodObject<{
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
    includeSystemPromptSection: z.ZodOptional<z.ZodBoolean>;
    ackMaxChars: z.ZodOptional<z.ZodNumber>;
    suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
    lightContext: z.ZodOptional<z.ZodBoolean>;
    isolatedSession: z.ZodOptional<z.ZodBoolean>;
    skipWhenBusy: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>>;
export declare const AgentContextLimitsSchema: z.ZodOptional<z.ZodObject<{
    memoryGetMaxChars: z.ZodOptional<z.ZodNumber>;
    memoryGetDefaultLines: z.ZodOptional<z.ZodNumber>;
    toolResultMaxChars: z.ZodOptional<z.ZodNumber>;
    postCompactionMaxChars: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>>;
export declare const ToolPolicySchema: z.ZodOptional<z.ZodObject<{
    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>>;
export declare const ElevatedAllowFromSchema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>;
export declare const AgentSandboxSchema: z.ZodOptional<z.ZodObject<{
    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"non-main">, z.ZodLiteral<"all">]>>;
    backend: z.ZodOptional<z.ZodString>;
    workspaceAccess: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"ro">, z.ZodLiteral<"rw">]>>;
    sessionToolsVisibility: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"spawned">, z.ZodLiteral<"all">]>>;
    scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"agent">, z.ZodLiteral<"shared">]>>;
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
        setupCommand: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>, z.ZodTransform<string, string | string[]>>>;
        pidsLimit: z.ZodOptional<z.ZodNumber>;
        memory: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        memorySwap: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
        cpus: z.ZodOptional<z.ZodNumber>;
        gpus: z.ZodOptional<z.ZodString>;
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
    ssh: z.ZodOptional<z.ZodObject<{
        target: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
        workspaceRoot: z.ZodOptional<z.ZodString>;
        strictHostKeyChecking: z.ZodOptional<z.ZodBoolean>;
        updateHostKeys: z.ZodOptional<z.ZodBoolean>;
        identityFile: z.ZodOptional<z.ZodString>;
        certificateFile: z.ZodOptional<z.ZodString>;
        knownHostsFile: z.ZodOptional<z.ZodString>;
        identityData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        certificateData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
        knownHostsData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
export declare const MemorySearchSchema: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    sources: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"memory">, z.ZodLiteral<"sessions">]>>>;
    extraPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    qmd: z.ZodOptional<z.ZodObject<{
        extraCollections: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            pattern: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    multimodal: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        modalities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"all">]>>>;
        maxFileBytes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    experimental: z.ZodOptional<z.ZodObject<{
        sessionMemory: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    provider: z.ZodOptional<z.ZodString>;
    remote: z.ZodOptional<z.ZodObject<{
        baseUrl: z.ZodOptional<z.ZodString>;
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
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        nonBatchConcurrency: z.ZodOptional<z.ZodNumber>;
        batch: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            wait: z.ZodOptional<z.ZodBoolean>;
            concurrency: z.ZodOptional<z.ZodNumber>;
            pollIntervalMs: z.ZodOptional<z.ZodNumber>;
            timeoutMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    fallback: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    inputType: z.ZodOptional<z.ZodString>;
    queryInputType: z.ZodOptional<z.ZodString>;
    documentInputType: z.ZodOptional<z.ZodString>;
    outputDimensionality: z.ZodOptional<z.ZodNumber>;
    local: z.ZodOptional<z.ZodObject<{
        modelPath: z.ZodOptional<z.ZodString>;
        modelCacheDir: z.ZodOptional<z.ZodString>;
        contextSize: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodLiteral<"auto">]>>;
    }, z.core.$strict>>;
    store: z.ZodOptional<z.ZodObject<{
        driver: z.ZodOptional<z.ZodLiteral<"sqlite">>;
        path: z.ZodOptional<z.ZodString>;
        fts: z.ZodOptional<z.ZodObject<{
            tokenizer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"unicode61">, z.ZodLiteral<"trigram">]>>;
        }, z.core.$strict>>;
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
        embeddingBatchTimeoutSeconds: z.ZodOptional<z.ZodNumber>;
        sessions: z.ZodOptional<z.ZodObject<{
            deltaBytes: z.ZodOptional<z.ZodNumber>;
            deltaMessages: z.ZodOptional<z.ZodNumber>;
            postCompactionForce: z.ZodOptional<z.ZodBoolean>;
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
export { AgentModelSchema };
export declare const AgentEmbeddedHarnessSchema: z.ZodOptional<z.ZodObject<{
    runtime: z.ZodOptional<z.ZodString>;
}, z.core.$strict>>;
export declare const AgentRuntimePolicySchema: z.ZodOptional<z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
}, z.core.$strict>>;
export declare const AgentEntrySchema: z.ZodObject<{
    id: z.ZodString;
    default: z.ZodOptional<z.ZodBoolean>;
    name: z.ZodOptional<z.ZodString>;
    workspace: z.ZodOptional<z.ZodString>;
    agentDir: z.ZodOptional<z.ZodString>;
    systemPromptOverride: z.ZodOptional<z.ZodString>;
    agentRuntime: z.ZodOptional<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    embeddedHarness: z.ZodOptional<z.ZodObject<{
        runtime: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        primary: z.ZodOptional<z.ZodString>;
        fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>]>>;
    thinkingDefault: z.ZodOptional<z.ZodEnum<{
        adaptive: "adaptive";
        high: "high";
        low: "low";
        max: "max";
        medium: "medium";
        minimal: "minimal";
        off: "off";
        xhigh: "xhigh";
    }>>;
    verboseDefault: z.ZodOptional<z.ZodEnum<{
        full: "full";
        off: "off";
        on: "on";
    }>>;
    toolProgressDetail: z.ZodOptional<z.ZodEnum<{
        explain: "explain";
        raw: "raw";
    }>>;
    reasoningDefault: z.ZodOptional<z.ZodEnum<{
        off: "off";
        on: "on";
        stream: "stream";
    }>>;
    fastModeDefault: z.ZodOptional<z.ZodBoolean>;
    skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    memorySearch: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        sources: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"memory">, z.ZodLiteral<"sessions">]>>>;
        extraPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        qmd: z.ZodOptional<z.ZodObject<{
            extraCollections: z.ZodOptional<z.ZodArray<z.ZodObject<{
                path: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
                pattern: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        multimodal: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            modalities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"all">]>>>;
            maxFileBytes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        experimental: z.ZodOptional<z.ZodObject<{
            sessionMemory: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        provider: z.ZodOptional<z.ZodString>;
        remote: z.ZodOptional<z.ZodObject<{
            baseUrl: z.ZodOptional<z.ZodString>;
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
            headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            nonBatchConcurrency: z.ZodOptional<z.ZodNumber>;
            batch: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                wait: z.ZodOptional<z.ZodBoolean>;
                concurrency: z.ZodOptional<z.ZodNumber>;
                pollIntervalMs: z.ZodOptional<z.ZodNumber>;
                timeoutMinutes: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        fallback: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        inputType: z.ZodOptional<z.ZodString>;
        queryInputType: z.ZodOptional<z.ZodString>;
        documentInputType: z.ZodOptional<z.ZodString>;
        outputDimensionality: z.ZodOptional<z.ZodNumber>;
        local: z.ZodOptional<z.ZodObject<{
            modelPath: z.ZodOptional<z.ZodString>;
            modelCacheDir: z.ZodOptional<z.ZodString>;
            contextSize: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodLiteral<"auto">]>>;
        }, z.core.$strict>>;
        store: z.ZodOptional<z.ZodObject<{
            driver: z.ZodOptional<z.ZodLiteral<"sqlite">>;
            path: z.ZodOptional<z.ZodString>;
            fts: z.ZodOptional<z.ZodObject<{
                tokenizer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"unicode61">, z.ZodLiteral<"trigram">]>>;
            }, z.core.$strict>>;
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
            embeddingBatchTimeoutSeconds: z.ZodOptional<z.ZodNumber>;
            sessions: z.ZodOptional<z.ZodObject<{
                deltaBytes: z.ZodOptional<z.ZodNumber>;
                deltaMessages: z.ZodOptional<z.ZodNumber>;
                postCompactionForce: z.ZodOptional<z.ZodBoolean>;
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
    tts: z.ZodOptional<z.ZodObject<{
        auto: z.ZodOptional<z.ZodEnum<{
            always: "always";
            inbound: "inbound";
            off: "off";
            tagged: "tagged";
        }>>;
        enabled: z.ZodOptional<z.ZodBoolean>;
        mode: z.ZodOptional<z.ZodEnum<{
            all: "all";
            final: "final";
        }>>;
        provider: z.ZodOptional<z.ZodString>;
        persona: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            label: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            provider: z.ZodOptional<z.ZodString>;
            fallbackPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"preserve-persona">, z.ZodLiteral<"provider-defaults">, z.ZodLiteral<"fail">]>>;
            prompt: z.ZodOptional<z.ZodObject<{
                profile: z.ZodOptional<z.ZodString>;
                scene: z.ZodOptional<z.ZodString>;
                sampleContext: z.ZodOptional<z.ZodString>;
                style: z.ZodOptional<z.ZodString>;
                accent: z.ZodOptional<z.ZodString>;
                pacing: z.ZodOptional<z.ZodString>;
                constraints: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
            providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
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
            }, z.core.$catchall<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull, z.ZodArray<z.ZodUnknown>, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>>>>;
        }, z.core.$strict>>>;
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
        providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
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
        }, z.core.$catchall<z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull, z.ZodArray<z.ZodUnknown>, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>>>>;
        prefsPath: z.ZodOptional<z.ZodString>;
        maxTextLength: z.ZodOptional<z.ZodNumber>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    skillsLimits: z.ZodOptional<z.ZodObject<{
        maxSkillsPromptChars: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    contextLimits: z.ZodOptional<z.ZodObject<{
        memoryGetMaxChars: z.ZodOptional<z.ZodNumber>;
        memoryGetDefaultLines: z.ZodOptional<z.ZodNumber>;
        toolResultMaxChars: z.ZodOptional<z.ZodNumber>;
        postCompactionMaxChars: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    contextTokens: z.ZodOptional<z.ZodNumber>;
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
        includeSystemPromptSection: z.ZodOptional<z.ZodBoolean>;
        ackMaxChars: z.ZodOptional<z.ZodNumber>;
        suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
        timeoutSeconds: z.ZodOptional<z.ZodNumber>;
        lightContext: z.ZodOptional<z.ZodBoolean>;
        isolatedSession: z.ZodOptional<z.ZodBoolean>;
        skipWhenBusy: z.ZodOptional<z.ZodBoolean>;
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
        visibleReplies: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            automatic: "automatic";
            message_tool: "message_tool";
        }>, z.ZodBoolean]>>;
    }, z.core.$strict>>;
    subagents: z.ZodOptional<z.ZodObject<{
        allowAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
        model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>]>>;
        thinking: z.ZodOptional<z.ZodString>;
        requireAgentId: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    embeddedPi: z.ZodOptional<z.ZodObject<{
        executionContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"default">, z.ZodLiteral<"strict-agentic">]>>;
    }, z.core.$strict>>;
    sandbox: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"non-main">, z.ZodLiteral<"all">]>>;
        backend: z.ZodOptional<z.ZodString>;
        workspaceAccess: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"none">, z.ZodLiteral<"ro">, z.ZodLiteral<"rw">]>>;
        sessionToolsVisibility: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"spawned">, z.ZodLiteral<"all">]>>;
        scope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"session">, z.ZodLiteral<"agent">, z.ZodLiteral<"shared">]>>;
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
            setupCommand: z.ZodOptional<z.ZodPipe<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>, z.ZodTransform<string, string | string[]>>>;
            pidsLimit: z.ZodOptional<z.ZodNumber>;
            memory: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            memorySwap: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
            cpus: z.ZodOptional<z.ZodNumber>;
            gpus: z.ZodOptional<z.ZodString>;
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
        ssh: z.ZodOptional<z.ZodObject<{
            target: z.ZodOptional<z.ZodString>;
            command: z.ZodOptional<z.ZodString>;
            workspaceRoot: z.ZodOptional<z.ZodString>;
            strictHostKeyChecking: z.ZodOptional<z.ZodBoolean>;
            updateHostKeys: z.ZodOptional<z.ZodBoolean>;
            identityFile: z.ZodOptional<z.ZodString>;
            certificateFile: z.ZodOptional<z.ZodString>;
            knownHostsFile: z.ZodOptional<z.ZodString>;
            identityData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
            certificateData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
            knownHostsData: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    tools: z.ZodOptional<z.ZodObject<{
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
        elevated: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>;
        }, z.core.$strict>>;
        exec: z.ZodOptional<z.ZodObject<{
            host: z.ZodOptional<z.ZodEnum<{
                auto: "auto";
                gateway: "gateway";
                node: "node";
                sandbox: "sandbox";
            }>>;
            security: z.ZodOptional<z.ZodEnum<{
                allowlist: "allowlist";
                deny: "deny";
                full: "full";
            }>>;
            ask: z.ZodOptional<z.ZodEnum<{
                always: "always";
                off: "off";
                "on-miss": "on-miss";
            }>>;
            node: z.ZodOptional<z.ZodString>;
            pathPrepend: z.ZodOptional<z.ZodArray<z.ZodString>>;
            safeBins: z.ZodOptional<z.ZodArray<z.ZodString>>;
            strictInlineEval: z.ZodOptional<z.ZodBoolean>;
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
            approvalRunningNoticeMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        fs: z.ZodOptional<z.ZodObject<{
            workspaceOnly: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        loopDetection: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            historySize: z.ZodOptional<z.ZodNumber>;
            warningThreshold: z.ZodOptional<z.ZodNumber>;
            unknownToolThreshold: z.ZodOptional<z.ZodNumber>;
            criticalThreshold: z.ZodOptional<z.ZodNumber>;
            globalCircuitBreakerThreshold: z.ZodOptional<z.ZodNumber>;
            detectors: z.ZodOptional<z.ZodObject<{
                genericRepeat: z.ZodOptional<z.ZodBoolean>;
                knownPollNoProgress: z.ZodOptional<z.ZodBoolean>;
                pingPong: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            postCompactionGuard: z.ZodOptional<z.ZodObject<{
                windowSize: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        sandbox: z.ZodOptional<z.ZodObject<{
            tools: z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    runtime: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"embedded">;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"acp">;
        acp: z.ZodOptional<z.ZodObject<{
            agent: z.ZodOptional<z.ZodString>;
            backend: z.ZodOptional<z.ZodString>;
            mode: z.ZodOptional<z.ZodEnum<{
                oneshot: "oneshot";
                persistent: "persistent";
            }>>;
            cwd: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
export declare const ToolsSchema: z.ZodOptional<z.ZodObject<{
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
    web: z.ZodOptional<z.ZodObject<{
        search: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            provider: z.ZodOptional<z.ZodString>;
            maxResults: z.ZodOptional<z.ZodNumber>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
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
            openaiCodex: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"cached">, z.ZodLiteral<"live">]>>;
                allowedDomains: z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodString>, z.ZodTransform<string[] | undefined, string[]>>>;
                contextSize: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>;
                userLocation: z.ZodOptional<z.ZodPipe<z.ZodObject<{
                    country: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string | undefined, string>>>;
                    region: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string | undefined, string>>>;
                    city: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string | undefined, string>>>;
                    timezone: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string | undefined, string>>>;
                }, z.core.$strict>, z.ZodTransform<{
                    country?: string | undefined;
                    region?: string | undefined;
                    city?: string | undefined;
                    timezone?: string | undefined;
                } | undefined, {
                    country?: string | undefined;
                    region?: string | undefined;
                    city?: string | undefined;
                    timezone?: string | undefined;
                }>>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        fetch: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            provider: z.ZodOptional<z.ZodString>;
            maxChars: z.ZodOptional<z.ZodNumber>;
            maxCharsCap: z.ZodOptional<z.ZodNumber>;
            maxResponseBytes: z.ZodOptional<z.ZodNumber>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
            maxRedirects: z.ZodOptional<z.ZodNumber>;
            userAgent: z.ZodOptional<z.ZodString>;
            readability: z.ZodOptional<z.ZodBoolean>;
            useTrustedEnvProxy: z.ZodOptional<z.ZodBoolean>;
            ssrfPolicy: z.ZodOptional<z.ZodObject<{
                allowRfc2544BenchmarkRange: z.ZodOptional<z.ZodBoolean>;
                allowIpv6UniqueLocalRange: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            firecrawl: z.ZodOptional<z.ZodObject<{
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
                baseUrl: z.ZodOptional<z.ZodString>;
                onlyMainContent: z.ZodOptional<z.ZodBoolean>;
                maxAgeMs: z.ZodOptional<z.ZodNumber>;
                timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        x_search: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            model: z.ZodOptional<z.ZodString>;
            inlineCitations: z.ZodOptional<z.ZodBoolean>;
            maxTurns: z.ZodOptional<z.ZodNumber>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    media: z.ZodOptional<z.ZodObject<{
        models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
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
            request: z.ZodOptional<z.ZodObject<{
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                }, z.core.$strict>], "source">]>>>;
                auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"provider-default">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"authorization-bearer">;
                    token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"header">;
                    headerName: z.ZodString;
                    value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                    prefix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>]>>;
                proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"env-proxy">;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"explicit-proxy">;
                    url: z.ZodString;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>>;
                tls: z.ZodOptional<z.ZodObject<{
                    ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    serverName: z.ZodOptional<z.ZodString>;
                    insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
            type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
            command: z.ZodOptional<z.ZodString>;
            args: z.ZodOptional<z.ZodArray<z.ZodString>>;
            maxChars: z.ZodOptional<z.ZodNumber>;
            maxBytes: z.ZodOptional<z.ZodNumber>;
            profile: z.ZodOptional<z.ZodString>;
            preferredProfile: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>>;
        concurrency: z.ZodOptional<z.ZodNumber>;
        asyncCompletion: z.ZodOptional<z.ZodObject<{
            directSend: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        image: z.ZodOptional<z.ZodOptional<z.ZodObject<{
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
            request: z.ZodOptional<z.ZodObject<{
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                }, z.core.$strict>], "source">]>>>;
                auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"provider-default">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"authorization-bearer">;
                    token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"header">;
                    headerName: z.ZodString;
                    value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                    prefix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>]>>;
                proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"env-proxy">;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"explicit-proxy">;
                    url: z.ZodString;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>>;
                tls: z.ZodOptional<z.ZodObject<{
                    ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    serverName: z.ZodOptional<z.ZodString>;
                    insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
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
            attachments: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                maxAttachments: z.ZodOptional<z.ZodNumber>;
                prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
            }, z.core.$strict>>;
            models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
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
                request: z.ZodOptional<z.ZodObject<{
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>>>;
                    auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"provider-default">;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"authorization-bearer">;
                        token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"header">;
                        headerName: z.ZodString;
                        value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                        prefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>]>>;
                    proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"env-proxy">;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"explicit-proxy">;
                        url: z.ZodString;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>>;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                command: z.ZodOptional<z.ZodString>;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                profile: z.ZodOptional<z.ZodString>;
                preferredProfile: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            echoTranscript: z.ZodOptional<z.ZodBoolean>;
            echoFormat: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        audio: z.ZodOptional<z.ZodOptional<z.ZodObject<{
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
            request: z.ZodOptional<z.ZodObject<{
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                }, z.core.$strict>], "source">]>>>;
                auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"provider-default">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"authorization-bearer">;
                    token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"header">;
                    headerName: z.ZodString;
                    value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                    prefix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>]>>;
                proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"env-proxy">;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"explicit-proxy">;
                    url: z.ZodString;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>>;
                tls: z.ZodOptional<z.ZodObject<{
                    ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    serverName: z.ZodOptional<z.ZodString>;
                    insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
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
            attachments: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                maxAttachments: z.ZodOptional<z.ZodNumber>;
                prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
            }, z.core.$strict>>;
            models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
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
                request: z.ZodOptional<z.ZodObject<{
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>>>;
                    auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"provider-default">;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"authorization-bearer">;
                        token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"header">;
                        headerName: z.ZodString;
                        value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                        prefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>]>>;
                    proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"env-proxy">;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"explicit-proxy">;
                        url: z.ZodString;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>>;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                command: z.ZodOptional<z.ZodString>;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                profile: z.ZodOptional<z.ZodString>;
                preferredProfile: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            echoTranscript: z.ZodOptional<z.ZodBoolean>;
            echoFormat: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        video: z.ZodOptional<z.ZodOptional<z.ZodObject<{
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
            request: z.ZodOptional<z.ZodObject<{
                headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                }, z.core.$strict>], "source">]>>>;
                auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"provider-default">;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"authorization-bearer">;
                    token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"header">;
                    headerName: z.ZodString;
                    value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>;
                    prefix: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>]>>;
                proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                    mode: z.ZodLiteral<"env-proxy">;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>, z.ZodObject<{
                    mode: z.ZodLiteral<"explicit-proxy">;
                    url: z.ZodString;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>]>>;
                tls: z.ZodOptional<z.ZodObject<{
                    ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    serverName: z.ZodOptional<z.ZodString>;
                    insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
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
            attachments: z.ZodOptional<z.ZodObject<{
                mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
                maxAttachments: z.ZodOptional<z.ZodNumber>;
                prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
            }, z.core.$strict>>;
            models: z.ZodOptional<z.ZodArray<z.ZodOptional<z.ZodObject<{
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
                request: z.ZodOptional<z.ZodObject<{
                    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                    }, z.core.$strict>], "source">]>>>;
                    auth: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"provider-default">;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"authorization-bearer">;
                        token: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"header">;
                        headerName: z.ZodString;
                        value: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        }, z.core.$strict>], "source">]>;
                        prefix: z.ZodOptional<z.ZodString>;
                    }, z.core.$strict>]>>;
                    proxy: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
                        mode: z.ZodLiteral<"env-proxy">;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>, z.ZodObject<{
                        mode: z.ZodLiteral<"explicit-proxy">;
                        url: z.ZodString;
                        tls: z.ZodOptional<z.ZodObject<{
                            ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                            serverName: z.ZodOptional<z.ZodString>;
                            insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$strict>>;
                    }, z.core.$strict>]>>;
                    tls: z.ZodOptional<z.ZodObject<{
                        ca: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        cert: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        key: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        passphrase: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
                        serverName: z.ZodOptional<z.ZodString>;
                        insecureSkipVerify: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$strict>>;
                }, z.core.$strict>>;
                provider: z.ZodOptional<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                capabilities: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
                type: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"provider">, z.ZodLiteral<"cli">]>>;
                command: z.ZodOptional<z.ZodString>;
                args: z.ZodOptional<z.ZodArray<z.ZodString>>;
                maxChars: z.ZodOptional<z.ZodNumber>;
                maxBytes: z.ZodOptional<z.ZodNumber>;
                profile: z.ZodOptional<z.ZodString>;
                preferredProfile: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>>;
            echoTranscript: z.ZodOptional<z.ZodBoolean>;
            echoFormat: z.ZodOptional<z.ZodString>;
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
        unknownToolThreshold: z.ZodOptional<z.ZodNumber>;
        criticalThreshold: z.ZodOptional<z.ZodNumber>;
        globalCircuitBreakerThreshold: z.ZodOptional<z.ZodNumber>;
        detectors: z.ZodOptional<z.ZodObject<{
            genericRepeat: z.ZodOptional<z.ZodBoolean>;
            knownPollNoProgress: z.ZodOptional<z.ZodBoolean>;
            pingPong: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        postCompactionGuard: z.ZodOptional<z.ZodObject<{
            windowSize: z.ZodOptional<z.ZodNumber>;
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
            auto: "auto";
            gateway: "gateway";
            node: "node";
            sandbox: "sandbox";
        }>>;
        security: z.ZodOptional<z.ZodEnum<{
            allowlist: "allowlist";
            deny: "deny";
            full: "full";
        }>>;
        ask: z.ZodOptional<z.ZodEnum<{
            always: "always";
            off: "off";
            "on-miss": "on-miss";
        }>>;
        node: z.ZodOptional<z.ZodString>;
        pathPrepend: z.ZodOptional<z.ZodArray<z.ZodString>>;
        safeBins: z.ZodOptional<z.ZodArray<z.ZodString>>;
        strictInlineEval: z.ZodOptional<z.ZodBoolean>;
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
    sessions_spawn: z.ZodOptional<z.ZodObject<{
        attachments: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            maxTotalBytes: z.ZodOptional<z.ZodNumber>;
            maxFiles: z.ZodOptional<z.ZodNumber>;
            maxFileBytes: z.ZodOptional<z.ZodNumber>;
            retainOnSessionKeep: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    experimental: z.ZodOptional<z.ZodObject<{
        planTool: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>>;
