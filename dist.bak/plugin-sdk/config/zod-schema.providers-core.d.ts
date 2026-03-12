import { z } from "zod";
export declare const TelegramTopicSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const TelegramGroupSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const TelegramAccountSchemaBase: z.ZodObject<{
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
}, z.core.$strict>;
export declare const TelegramAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const TelegramConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const DiscordDmSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const DiscordGuildChannelSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const DiscordGuildSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const DiscordAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const DiscordConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const GoogleChatDmSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    policy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        allowlist: "allowlist";
        open: "open";
        disabled: "disabled";
        pairing: "pairing";
    }>>>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
}, z.core.$strict>;
export declare const GoogleChatGroupSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    allow: z.ZodOptional<z.ZodBoolean>;
    requireMention: z.ZodOptional<z.ZodBoolean>;
    users: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const GoogleChatAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const GoogleChatConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const SlackDmSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const SlackChannelSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const SlackThreadSchema: z.ZodObject<{
    historyScope: z.ZodOptional<z.ZodEnum<{
        channel: "channel";
        thread: "thread";
    }>>;
    inheritParent: z.ZodOptional<z.ZodBoolean>;
    initialHistoryLimit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const SlackAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const SlackConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const SignalAccountSchemaBase: z.ZodObject<{
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
}, z.core.$strict>;
export declare const SignalAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const SignalConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const IrcGroupSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const IrcNickServSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    service: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodString>;
    passwordFile: z.ZodOptional<z.ZodString>;
    register: z.ZodOptional<z.ZodBoolean>;
    registerEmail: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const IrcAccountSchemaBase: z.ZodObject<{
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
}, z.core.$strict>;
export declare const IrcAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const IrcConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const IMessageAccountSchemaBase: z.ZodObject<{
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
}, z.core.$strict>;
export declare const IMessageAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const IMessageConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const BlueBubblesAccountSchemaBase: z.ZodObject<{
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
}, z.core.$strict>;
export declare const BlueBubblesAccountSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const BlueBubblesConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const MSTeamsChannelSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const MSTeamsTeamSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const MSTeamsConfigSchema: z.ZodObject<{
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
}, z.core.$strict>;
