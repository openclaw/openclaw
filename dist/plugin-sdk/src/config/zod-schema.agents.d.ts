import { z } from "zod";
export declare const AgentsSchema: z.ZodOptional<z.ZodObject<{
    defaults: z.ZodOptional<z.ZodLazy<z.ZodOptional<z.ZodObject<{
        params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        agentRuntime: z.ZodOptional<z.ZodObject<{
            id: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        embeddedHarness: z.ZodOptional<z.ZodObject<{
            runtime: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>]>>;
        imageModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>]>>;
        imageGenerationModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>]>>;
        videoGenerationModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>]>>;
        musicGenerationModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>]>>;
        mediaGenerationAutoProviderFallback: z.ZodOptional<z.ZodBoolean>;
        pdfModel: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
            primary: z.ZodOptional<z.ZodString>;
            fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            timeoutMs: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>]>>;
        pdfMaxBytesMb: z.ZodOptional<z.ZodNumber>;
        pdfMaxPages: z.ZodOptional<z.ZodNumber>;
        models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            alias: z.ZodOptional<z.ZodString>;
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            agentRuntime: z.ZodOptional<z.ZodObject<{
                id: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            streaming: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>>;
        workspace: z.ZodOptional<z.ZodString>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        silentReply: z.ZodOptional<z.ZodObject<{
            group: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
            internal: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"allow">, z.ZodLiteral<"disallow">]>>;
        }, z.core.$strict>>;
        repoRoot: z.ZodOptional<z.ZodString>;
        systemPromptOverride: z.ZodOptional<z.ZodString>;
        promptOverlays: z.ZodOptional<z.ZodObject<{
            gpt5: z.ZodOptional<z.ZodObject<{
                personality: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"friendly">, z.ZodLiteral<"on">, z.ZodLiteral<"off">]>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        skipBootstrap: z.ZodOptional<z.ZodBoolean>;
        skipOptionalBootstrapFiles: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            "HEARTBEAT.md": "HEARTBEAT.md";
            "IDENTITY.md": "IDENTITY.md";
            "SOUL.md": "SOUL.md";
            "USER.md": "USER.md";
        }>>>;
        contextInjection: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"continuation-skip">, z.ZodLiteral<"never">]>>;
        bootstrapMaxChars: z.ZodOptional<z.ZodNumber>;
        bootstrapTotalMaxChars: z.ZodOptional<z.ZodNumber>;
        experimental: z.ZodOptional<z.ZodObject<{
            localModelLean: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        bootstrapPromptTruncationWarning: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"once">, z.ZodLiteral<"always">]>>;
        userTimezone: z.ZodOptional<z.ZodString>;
        startupContext: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            applyOn: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<"new">, z.ZodLiteral<"reset">]>>>;
            dailyMemoryDays: z.ZodOptional<z.ZodNumber>;
            maxFileBytes: z.ZodOptional<z.ZodNumber>;
            maxFileChars: z.ZodOptional<z.ZodNumber>;
            maxTotalChars: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        contextLimits: z.ZodOptional<z.ZodObject<{
            memoryGetMaxChars: z.ZodOptional<z.ZodNumber>;
            memoryGetDefaultLines: z.ZodOptional<z.ZodNumber>;
            toolResultMaxChars: z.ZodOptional<z.ZodNumber>;
            postCompactionMaxChars: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
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
            jsonlDialect: z.ZodOptional<z.ZodLiteral<"claude-stream-json">>;
            liveSession: z.ZodOptional<z.ZodLiteral<"claude-stdio">>;
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
            systemPromptFileArg: z.ZodOptional<z.ZodString>;
            systemPromptFileConfigArg: z.ZodOptional<z.ZodString>;
            systemPromptFileConfigKey: z.ZodOptional<z.ZodString>;
            systemPromptMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"append">, z.ZodLiteral<"replace">]>>;
            systemPromptWhen: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"first">, z.ZodLiteral<"always">, z.ZodLiteral<"never">]>>;
            imageArg: z.ZodOptional<z.ZodString>;
            imageMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"repeat">, z.ZodLiteral<"list">]>>;
            imagePathScope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"temp">, z.ZodLiteral<"workspace">]>>;
            serialize: z.ZodOptional<z.ZodBoolean>;
            reseedFromRawTranscriptWhenUncompacted: z.ZodOptional<z.ZodBoolean>;
            reliability: z.ZodOptional<z.ZodObject<{
                outputLimits: z.ZodOptional<z.ZodObject<{
                    maxTurnRawChars: z.ZodOptional<z.ZodNumber>;
                    maxTurnLines: z.ZodOptional<z.ZodNumber>;
                }, z.core.$strict>>;
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
            provider: z.ZodOptional<z.ZodString>;
            reserveTokens: z.ZodOptional<z.ZodNumber>;
            keepRecentTokens: z.ZodOptional<z.ZodNumber>;
            reserveTokensFloor: z.ZodOptional<z.ZodNumber>;
            maxHistoryShare: z.ZodOptional<z.ZodNumber>;
            customInstructions: z.ZodOptional<z.ZodString>;
            identifierPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"strict">, z.ZodLiteral<"off">, z.ZodLiteral<"custom">]>>;
            identifierInstructions: z.ZodOptional<z.ZodString>;
            recentTurnsPreserve: z.ZodOptional<z.ZodNumber>;
            qualityGuard: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                maxRetries: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            midTurnPrecheck: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            postIndexSync: z.ZodOptional<z.ZodEnum<{
                async: "async";
                await: "await";
                off: "off";
            }>>;
            postCompactionSections: z.ZodOptional<z.ZodArray<z.ZodString>>;
            model: z.ZodOptional<z.ZodString>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            memoryFlush: z.ZodOptional<z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                model: z.ZodOptional<z.ZodString>;
                softThresholdTokens: z.ZodOptional<z.ZodNumber>;
                forceFlushTranscriptBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
                prompt: z.ZodOptional<z.ZodString>;
                systemPrompt: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            truncateAfterCompaction: z.ZodOptional<z.ZodBoolean>;
            maxActiveTranscriptBytes: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            notifyUser: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        runRetries: z.ZodOptional<z.ZodObject<{
            base: z.ZodOptional<z.ZodNumber>;
            perProfile: z.ZodOptional<z.ZodNumber>;
            min: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        embeddedPi: z.ZodOptional<z.ZodObject<{
            projectSettingsPolicy: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"trusted">, z.ZodLiteral<"sanitize">, z.ZodLiteral<"ignore">]>>;
            executionContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"default">, z.ZodLiteral<"strict-agentic">]>>;
        }, z.core.$strict>>;
        thinkingDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"minimal">, z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">, z.ZodLiteral<"xhigh">, z.ZodLiteral<"adaptive">, z.ZodLiteral<"max">]>>;
        verboseDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">, z.ZodLiteral<"full">]>>;
        toolProgressDetail: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"explain">, z.ZodLiteral<"raw">]>>;
        reasoningDefault: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"on">, z.ZodLiteral<"stream">]>>;
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
            includeSystemPromptSection: z.ZodOptional<z.ZodBoolean>;
            ackMaxChars: z.ZodOptional<z.ZodNumber>;
            suppressToolErrorWarnings: z.ZodOptional<z.ZodBoolean>;
            timeoutSeconds: z.ZodOptional<z.ZodNumber>;
            lightContext: z.ZodOptional<z.ZodBoolean>;
            isolatedSession: z.ZodOptional<z.ZodBoolean>;
            skipWhenBusy: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        maxConcurrent: z.ZodOptional<z.ZodNumber>;
        subagents: z.ZodOptional<z.ZodObject<{
            delegationMode: z.ZodOptional<z.ZodEnum<{
                prefer: "prefer";
                suggest: "suggest";
            }>>;
            allowAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
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
            requireAgentId: z.ZodOptional<z.ZodBoolean>;
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
    }, z.core.$strict>>>>;
    list: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        default: z.ZodOptional<z.ZodBoolean>;
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
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
        }, z.core.$strict>]>>;
        models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            alias: z.ZodOptional<z.ZodString>;
            params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            agentRuntime: z.ZodOptional<z.ZodObject<{
                id: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            streaming: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>>;
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
        contextInjection: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"always">, z.ZodLiteral<"continuation-skip">, z.ZodLiteral<"never">]>>;
        bootstrapMaxChars: z.ZodOptional<z.ZodNumber>;
        bootstrapTotalMaxChars: z.ZodOptional<z.ZodNumber>;
        experimental: z.ZodOptional<z.ZodObject<{
            localModelLean: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
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
            unmentionedInbound: z.ZodOptional<z.ZodEnum<{
                room_event: "room_event";
                user_request: "user_request";
            }>>;
            visibleReplies: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                automatic: "automatic";
                message_tool: "message_tool";
            }>, z.ZodBoolean]>>;
        }, z.core.$strict>>;
        subagents: z.ZodOptional<z.ZodObject<{
            delegationMode: z.ZodOptional<z.ZodEnum<{
                prefer: "prefer";
                suggest: "suggest";
            }>>;
            allowAgents: z.ZodOptional<z.ZodArray<z.ZodString>>;
            model: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
                primary: z.ZodOptional<z.ZodString>;
                fallbacks: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>]>>;
            thinking: z.ZodOptional<z.ZodString>;
            requireAgentId: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        runRetries: z.ZodOptional<z.ZodObject<{
            base: z.ZodOptional<z.ZodNumber>;
            perProfile: z.ZodOptional<z.ZodNumber>;
            min: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
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
            toolsBySender: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
                allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                alsoAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                deny: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>>;
            codeMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, z.ZodObject<{
                enabled: z.ZodOptional<z.ZodBoolean>;
                runtime: z.ZodOptional<z.ZodLiteral<"quickjs-wasi">>;
                mode: z.ZodOptional<z.ZodLiteral<"only">>;
                languages: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                    javascript: "javascript";
                    typescript: "typescript";
                }>>>;
                timeoutMs: z.ZodOptional<z.ZodNumber>;
                memoryLimitBytes: z.ZodOptional<z.ZodNumber>;
                maxOutputBytes: z.ZodOptional<z.ZodNumber>;
                maxSnapshotBytes: z.ZodOptional<z.ZodNumber>;
                maxPendingToolCalls: z.ZodOptional<z.ZodNumber>;
                snapshotTtlSeconds: z.ZodOptional<z.ZodNumber>;
                searchDefaultLimit: z.ZodOptional<z.ZodNumber>;
                maxSearchLimit: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>]>>;
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
                commandHighlighting: z.ZodOptional<z.ZodBoolean>;
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
                actions: z.ZodOptional<z.ZodObject<{
                    allow: z.ZodOptional<z.ZodArray<z.ZodString>>;
                }, z.core.$strict>>;
                broadcast: z.ZodOptional<z.ZodObject<{
                    enabled: z.ZodOptional<z.ZodBoolean>;
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
    }, z.core.$strict>>>;
}, z.core.$strict>>;
export declare const BindingsSchema: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodOptional<z.ZodLiteral<"route">>;
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
    session: z.ZodOptional<z.ZodObject<{
        dmScope: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"main">, z.ZodLiteral<"per-peer">, z.ZodLiteral<"per-channel-peer">, z.ZodLiteral<"per-account-channel-peer">]>>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"acp">;
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
    acp: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodEnum<{
            oneshot: "oneshot";
            persistent: "persistent";
        }>>;
        label: z.ZodOptional<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
        backend: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>]>>>;
export declare const BroadcastStrategySchema: z.ZodEnum<{
    parallel: "parallel";
    sequential: "sequential";
}>;
export declare const BroadcastSchema: z.ZodOptional<z.ZodObject<{
    strategy: z.ZodOptional<z.ZodEnum<{
        parallel: "parallel";
        sequential: "sequential";
    }>>;
}, z.core.$catchall<z.ZodArray<z.ZodString>>>>;
export declare const AudioSchema: z.ZodOptional<z.ZodObject<{
    transcription: z.ZodOptional<z.ZodObject<{
        command: z.ZodArray<z.ZodString>;
        timeoutSeconds: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>>;
