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
    ackMaxChars: z.ZodOptional<z.ZodNumber>;
    suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>>;
export declare const SandboxDockerSchema: z.ZodOptional<z.ZodObject<{
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
export declare const SandboxBrowserSchema: z.ZodOptional<z.ZodObject<{
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
export declare const SandboxPruneSchema: z.ZodOptional<z.ZodObject<{
    idleHours: z.ZodOptional<z.ZodNumber>;
    maxAgeDays: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>>;
export declare const ToolPolicySchema: z.ZodOptional<z.ZodObject<{
    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>>;
export declare const ToolsWebSearchSchema: z.ZodOptional<z.ZodObject<{
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
export declare const ToolsWebFetchSchema: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    maxChars: z.ZodOptional<z.ZodNumber>;
    maxCharsCap: z.ZodOptional<z.ZodNumber>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
    cacheTtlMinutes: z.ZodOptional<z.ZodNumber>;
    maxRedirects: z.ZodOptional<z.ZodNumber>;
    userAgent: z.ZodOptional<z.ZodString>;
}, z.core.$strict>>;
export declare const ToolsWebSchema: z.ZodOptional<z.ZodObject<{
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
export declare const ToolProfileSchema: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
export declare const ToolPolicyWithProfileSchema: z.ZodObject<{
    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
    profile: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"minimal">, z.ZodLiteral<"coding">, z.ZodLiteral<"messaging">, z.ZodLiteral<"full">]>>;
}, z.core.$strict>;
export declare const ElevatedAllowFromSchema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>>;
export declare const AgentSandboxSchema: z.ZodOptional<z.ZodObject<{
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
export declare const AgentToolsSchema: z.ZodOptional<z.ZodObject<{
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
export declare const MemorySearchSchema: z.ZodOptional<z.ZodObject<{
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
export { AgentModelSchema };
export declare const AgentEntrySchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const ToolsSchema: z.ZodOptional<z.ZodObject<{
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
