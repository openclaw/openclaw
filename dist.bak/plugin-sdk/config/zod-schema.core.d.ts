import { z } from "zod";
export declare const SecretRefSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strict>], "source">;
export declare const SecretInputSchema: z.ZodUnion<readonly [z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
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
export declare const SecretProviderSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
}, z.core.$strict>], "source">;
export declare const SecretsConfigSchema: z.ZodOptional<z.ZodObject<{
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
export declare const ModelApiSchema: z.ZodEnum<{
    "openai-completions": "openai-completions";
    "openai-responses": "openai-responses";
    "openai-codex-responses": "openai-codex-responses";
    "anthropic-messages": "anthropic-messages";
    "google-generative-ai": "google-generative-ai";
    "github-copilot": "github-copilot";
    "bedrock-converse-stream": "bedrock-converse-stream";
    ollama: "ollama";
}>;
export declare const ModelCompatSchema: z.ZodOptional<z.ZodObject<{
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
export declare const ModelDefinitionSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const ModelProviderSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const BedrockDiscoverySchema: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    region: z.ZodOptional<z.ZodString>;
    providerFilter: z.ZodOptional<z.ZodArray<z.ZodString>>;
    refreshInterval: z.ZodOptional<z.ZodNumber>;
    defaultContextWindow: z.ZodOptional<z.ZodNumber>;
    defaultMaxTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>>;
export declare const ModelsConfigSchema: z.ZodOptional<z.ZodObject<{
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
export declare const GroupChatSchema: z.ZodOptional<z.ZodObject<{
    mentionPatterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    historyLimit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>>;
export declare const DmConfigSchema: z.ZodObject<{
    historyLimit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const IdentitySchema: z.ZodOptional<z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    theme: z.ZodOptional<z.ZodString>;
    emoji: z.ZodOptional<z.ZodString>;
    avatar: z.ZodOptional<z.ZodString>;
}, z.core.$strict>>;
export declare const QueueModeSchema: z.ZodUnion<readonly [z.ZodLiteral<"steer">, z.ZodLiteral<"followup">, z.ZodLiteral<"collect">, z.ZodLiteral<"steer-backlog">, z.ZodLiteral<"steer+backlog">, z.ZodLiteral<"queue">, z.ZodLiteral<"interrupt">]>;
export declare const QueueDropSchema: z.ZodUnion<readonly [z.ZodLiteral<"old">, z.ZodLiteral<"new">, z.ZodLiteral<"summarize">]>;
export declare const ReplyToModeSchema: z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"first">, z.ZodLiteral<"all">]>;
export declare const TypingModeSchema: z.ZodUnion<readonly [z.ZodLiteral<"never">, z.ZodLiteral<"instant">, z.ZodLiteral<"thinking">, z.ZodLiteral<"message">]>;
export declare const GroupPolicySchema: z.ZodEnum<{
    allowlist: "allowlist";
    open: "open";
    disabled: "disabled";
}>;
export declare const DmPolicySchema: z.ZodEnum<{
    allowlist: "allowlist";
    open: "open";
    disabled: "disabled";
    pairing: "pairing";
}>;
export declare const BlockStreamingCoalesceSchema: z.ZodObject<{
    minChars: z.ZodOptional<z.ZodNumber>;
    maxChars: z.ZodOptional<z.ZodNumber>;
    idleMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const ReplyRuntimeConfigSchemaShape: {
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
    responsePrefix: z.ZodOptional<z.ZodString>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
};
export declare const BlockStreamingChunkSchema: z.ZodObject<{
    minChars: z.ZodOptional<z.ZodNumber>;
    maxChars: z.ZodOptional<z.ZodNumber>;
    breakPreference: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"paragraph">, z.ZodLiteral<"newline">, z.ZodLiteral<"sentence">]>>;
}, z.core.$strict>;
export declare const MarkdownTableModeSchema: z.ZodEnum<{
    off: "off";
    bullets: "bullets";
    code: "code";
}>;
export declare const MarkdownConfigSchema: z.ZodOptional<z.ZodObject<{
    tables: z.ZodOptional<z.ZodEnum<{
        off: "off";
        bullets: "bullets";
        code: "code";
    }>>;
}, z.core.$strict>>;
export declare const TtsProviderSchema: z.ZodEnum<{
    openai: "openai";
    elevenlabs: "elevenlabs";
    edge: "edge";
}>;
export declare const TtsModeSchema: z.ZodEnum<{
    all: "all";
    final: "final";
}>;
export declare const TtsAutoSchema: z.ZodEnum<{
    off: "off";
    always: "always";
    inbound: "inbound";
    tagged: "tagged";
}>;
export declare const TtsConfigSchema: z.ZodOptional<z.ZodObject<{
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
export declare const HumanDelaySchema: z.ZodObject<{
    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"natural">, z.ZodLiteral<"custom">]>>;
    minMs: z.ZodOptional<z.ZodNumber>;
    maxMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const CliBackendSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const normalizeAllowFrom: (values?: Array<string | number>) => string[];
export declare const requireOpenAllowFrom: (params: {
    policy?: string;
    allowFrom?: Array<string | number>;
    ctx: z.RefinementCtx;
    path: Array<string | number>;
    message: string;
}) => void;
/**
 * Validate that dmPolicy="allowlist" has a non-empty allowFrom array.
 * Without this, all DMs are silently dropped because the allowlist is empty
 * and no senders can match.
 */
export declare const requireAllowlistAllowFrom: (params: {
    policy?: string;
    allowFrom?: Array<string | number>;
    ctx: z.RefinementCtx;
    path: Array<string | number>;
    message: string;
}) => void;
export declare const MSTeamsReplyStyleSchema: z.ZodEnum<{
    thread: "thread";
    "top-level": "top-level";
}>;
export declare const RetryConfigSchema: z.ZodOptional<z.ZodObject<{
    attempts: z.ZodOptional<z.ZodNumber>;
    minDelayMs: z.ZodOptional<z.ZodNumber>;
    maxDelayMs: z.ZodOptional<z.ZodNumber>;
    jitter: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>>;
export declare const QueueModeBySurfaceSchema: z.ZodOptional<z.ZodObject<{
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
export declare const DebounceMsBySurfaceSchema: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
export declare const QueueSchema: z.ZodOptional<z.ZodObject<{
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
export declare const InboundDebounceSchema: z.ZodOptional<z.ZodObject<{
    debounceMs: z.ZodOptional<z.ZodNumber>;
    byChannel: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$strict>>;
export declare const TranscribeAudioSchema: z.ZodOptional<z.ZodObject<{
    command: z.ZodArray<z.ZodString>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>>;
export declare const HexColorSchema: z.ZodString;
export declare const ExecutableTokenSchema: z.ZodString;
export declare const MediaUnderstandingScopeSchema: z.ZodOptional<z.ZodObject<{
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
export declare const MediaUnderstandingCapabilitiesSchema: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"image">, z.ZodLiteral<"audio">, z.ZodLiteral<"video">]>>>;
export declare const MediaUnderstandingAttachmentsSchema: z.ZodOptional<z.ZodObject<{
    mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"all">]>>;
    maxAttachments: z.ZodOptional<z.ZodNumber>;
    prefer: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"last">, z.ZodLiteral<"path">, z.ZodLiteral<"url">]>>;
}, z.core.$strict>>;
export declare const MediaUnderstandingModelSchema: z.ZodOptional<z.ZodObject<{
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
}, z.core.$strict>>;
export declare const ToolsMediaUnderstandingSchema: z.ZodOptional<z.ZodObject<{
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
}, z.core.$strict>>;
export declare const ToolsMediaSchema: z.ZodOptional<z.ZodObject<{
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
export declare const LinkModelSchema: z.ZodObject<{
    type: z.ZodOptional<z.ZodLiteral<"cli">>;
    command: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const ToolsLinksSchema: z.ZodOptional<z.ZodObject<{
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
export declare const NativeCommandsSettingSchema: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>;
export declare const ProviderCommandsSchema: z.ZodOptional<z.ZodObject<{
    native: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
    nativeSkills: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>>;
}, z.core.$strict>>;
