import { z } from "zod";
export declare const SessionSendPolicySchema: z.ZodOptional<z.ZodObject<{
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
export declare const SessionSchema: z.ZodOptional<z.ZodObject<{
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
export declare const MessagesSchema: z.ZodOptional<z.ZodObject<{
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
        off: "off";
        all: "all";
        none: "none";
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
            compacting: z.ZodOptional<z.ZodString>;
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
            model: z.ZodOptional<z.ZodString>;
            voice: z.ZodOptional<z.ZodString>;
            speed: z.ZodOptional<z.ZodNumber>;
            instructions: z.ZodOptional<z.ZodString>;
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
export declare const CommandsSchema: z.ZodDefault<z.ZodOptional<z.ZodObject<{
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
