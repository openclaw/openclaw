export declare const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA: readonly [{
    readonly pluginId: "bluebubbles";
    readonly channelId: "bluebubbles";
    readonly label: "BlueBubbles";
    readonly description: "iMessage via the BlueBubbles mac app + REST API.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly edit: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly unsend: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly reply: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly sendWithEffect: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly renameGroup: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly setGroupIcon: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly addParticipant: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly removeParticipant: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly leaveGroup: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly sendAttachment: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                };
                readonly required: readonly ["reactions", "edit", "unsend", "reply", "sendWithEffect", "renameGroup", "setGroupIcon", "addParticipant", "removeParticipant", "leaveGroup", "sendAttachment"];
                readonly additionalProperties: false;
            };
            readonly serverUrl: {
                readonly type: "string";
            };
            readonly password: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly webhookPath: {
                readonly type: "string";
            };
            readonly dmPolicy: {
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly enrichGroupParticipantsFromContacts: {
                readonly default: true;
                readonly type: "boolean";
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly sendTimeoutMs: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly mediaMaxMb: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly mediaLocalRoots: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly sendReadReceipts: {
                readonly type: "boolean";
            };
            readonly network: {
                readonly type: "object";
                readonly properties: {
                    readonly dangerouslyAllowPrivateNetwork: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly catchup: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly maxAgeMinutes: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly perRunLimit: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly firstRunLookbackMinutes: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxFailureRetries: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly replyContextApiFallback: {
                readonly type: "boolean";
            };
            readonly groups: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly coalesceSameSenderDms: {
                readonly type: "boolean";
            };
            readonly accounts: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly edit: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly unsend: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly reply: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly sendWithEffect: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly renameGroup: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly setGroupIcon: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly addParticipant: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly removeParticipant: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly leaveGroup: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly sendAttachment: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                            };
                            readonly required: readonly ["reactions", "edit", "unsend", "reply", "sendWithEffect", "renameGroup", "setGroupIcon", "addParticipant", "removeParticipant", "leaveGroup", "sendAttachment"];
                            readonly additionalProperties: false;
                        };
                        readonly serverUrl: {
                            readonly type: "string";
                        };
                        readonly password: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly webhookPath: {
                            readonly type: "string";
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly enrichGroupParticipantsFromContacts: {
                            readonly default: true;
                            readonly type: "boolean";
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly sendTimeoutMs: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly mediaMaxMb: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly mediaLocalRoots: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly sendReadReceipts: {
                            readonly type: "boolean";
                        };
                        readonly network: {
                            readonly type: "object";
                            readonly properties: {
                                readonly dangerouslyAllowPrivateNetwork: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly catchup: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly maxAgeMinutes: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly perRunLimit: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly firstRunLookbackMinutes: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxFailureRetries: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly replyContextApiFallback: {
                            readonly type: "boolean";
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly properties: {};
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly coalesceSameSenderDms: {
                            readonly type: "boolean";
                        };
                    };
                    readonly required: readonly ["enrichGroupParticipantsFromContacts"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["enrichGroupParticipantsFromContacts"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "BlueBubbles";
            readonly help: "BlueBubbles channel provider configuration used for Apple messaging bridge integrations. Keep DM policy aligned with your trusted sender model in shared deployments.";
        };
        readonly dmPolicy: {
            readonly label: "BlueBubbles DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].';
        };
    };
}, {
    readonly pluginId: "discord";
    readonly channelId: "discord";
    readonly label: "Discord";
    readonly description: "very well supported right now.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly commands: {
                readonly type: "object";
                readonly properties: {
                    readonly native: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                    readonly nativeSkills: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly token: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly applicationId: {
                readonly type: "string";
            };
            readonly proxy: {
                readonly type: "string";
            };
            readonly gatewayInfoTimeoutMs: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 120000;
            };
            readonly gatewayReadyTimeoutMs: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 120000;
            };
            readonly gatewayRuntimeReadyTimeoutMs: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 120000;
            };
            readonly allowBots: {
                readonly anyOf: readonly [{
                    readonly type: "boolean";
                }, {
                    readonly type: "string";
                    readonly const: "mentions";
                }];
            };
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly mentionAliases: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "string";
                    readonly pattern: "^\\d+$";
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly streaming: {
                readonly type: "object";
                readonly properties: {
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "partial", "block", "progress"];
                    };
                    readonly chunkMode: {
                        readonly type: "string";
                        readonly enum: readonly ["length", "newline"];
                    };
                    readonly preview: {
                        readonly type: "object";
                        readonly properties: {
                            readonly chunk: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly breakPreference: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                            readonly const: "paragraph";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "newline";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "sentence";
                                        }];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly progress: {
                        readonly type: "object";
                        readonly properties: {
                            readonly label: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "boolean";
                                    readonly const: false;
                                }];
                            };
                            readonly labels: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                            readonly maxLines: {
                                readonly type: "integer";
                                readonly exclusiveMinimum: 0;
                                readonly maximum: 9007199254740991;
                            };
                            readonly render: {
                                readonly type: "string";
                                readonly enum: readonly ["text", "rich"];
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly block: {
                        readonly type: "object";
                        readonly properties: {
                            readonly enabled: {
                                readonly type: "boolean";
                            };
                            readonly coalesce: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly idleMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly additionalProperties: false;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly maxLinesPerMessage: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly retry: {
                readonly type: "object";
                readonly properties: {
                    readonly attempts: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 9007199254740991;
                    };
                    readonly minDelayMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxDelayMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly jitter: {
                        readonly type: "number";
                        readonly minimum: 0;
                        readonly maximum: 1;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                    readonly stickers: {
                        readonly type: "boolean";
                    };
                    readonly emojiUploads: {
                        readonly type: "boolean";
                    };
                    readonly stickerUploads: {
                        readonly type: "boolean";
                    };
                    readonly polls: {
                        readonly type: "boolean";
                    };
                    readonly permissions: {
                        readonly type: "boolean";
                    };
                    readonly messages: {
                        readonly type: "boolean";
                    };
                    readonly threads: {
                        readonly type: "boolean";
                    };
                    readonly pins: {
                        readonly type: "boolean";
                    };
                    readonly search: {
                        readonly type: "boolean";
                    };
                    readonly memberInfo: {
                        readonly type: "boolean";
                    };
                    readonly roleInfo: {
                        readonly type: "boolean";
                    };
                    readonly roles: {
                        readonly type: "boolean";
                    };
                    readonly channelInfo: {
                        readonly type: "boolean";
                    };
                    readonly voiceStatus: {
                        readonly type: "boolean";
                    };
                    readonly events: {
                        readonly type: "boolean";
                    };
                    readonly moderation: {
                        readonly type: "boolean";
                    };
                    readonly channels: {
                        readonly type: "boolean";
                    };
                    readonly presence: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly replyToMode: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly const: "off";
                }, {
                    readonly type: "string";
                    readonly const: "first";
                }, {
                    readonly type: "string";
                    readonly const: "all";
                }, {
                    readonly type: "string";
                    readonly const: "batched";
                }];
            };
            readonly thread: {
                readonly type: "object";
                readonly properties: {
                    readonly inheritParent: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly dmPolicy: {
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly dm: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly policy: {
                        readonly type: "string";
                        readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                    };
                    readonly allowFrom: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly groupEnabled: {
                        readonly type: "boolean";
                    };
                    readonly groupChannels: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly guilds: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly slug: {
                            readonly type: "string";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly ignoreOtherMentions: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly reactionNotifications: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "own", "all", "allowlist"];
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly roles: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly channels: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly ignoreOtherMentions: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly users: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly roles: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                    readonly includeThreadStarter: {
                                        readonly type: "boolean";
                                    };
                                    readonly autoThread: {
                                        readonly type: "boolean";
                                    };
                                    readonly autoThreadName: {
                                        readonly type: "string";
                                        readonly enum: readonly ["message", "generated"];
                                    };
                                    readonly autoArchiveDuration: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                            readonly enum: readonly ["60", "1440", "4320", "10080"];
                                        }, {
                                            readonly type: "number";
                                            readonly const: 60;
                                        }, {
                                            readonly type: "number";
                                            readonly const: 1440;
                                        }, {
                                            readonly type: "number";
                                            readonly const: 4320;
                                        }, {
                                            readonly type: "number";
                                            readonly const: 10080;
                                        }];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly showOk: {
                        readonly type: "boolean";
                    };
                    readonly showAlerts: {
                        readonly type: "boolean";
                    };
                    readonly useIndicator: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly execApprovals: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly approvers: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly agentFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly sessionFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly cleanupAfterResolve: {
                        readonly type: "boolean";
                    };
                    readonly target: {
                        readonly type: "string";
                        readonly enum: readonly ["dm", "channel", "both"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly agentComponents: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly ui: {
                readonly type: "object";
                readonly properties: {
                    readonly components: {
                        readonly type: "object";
                        readonly properties: {
                            readonly accentColor: {
                                readonly type: "string";
                                readonly pattern: "^#?[0-9a-fA-F]{6}$";
                            };
                        };
                        readonly additionalProperties: false;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly slashCommand: {
                readonly type: "object";
                readonly properties: {
                    readonly ephemeral: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly threadBindings: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly idleHours: {
                        readonly type: "number";
                        readonly minimum: 0;
                    };
                    readonly maxAgeHours: {
                        readonly type: "number";
                        readonly minimum: 0;
                    };
                    readonly spawnSessions: {
                        readonly type: "boolean";
                    };
                    readonly defaultSpawnContext: {
                        readonly type: "string";
                        readonly enum: readonly ["isolated", "fork"];
                    };
                    readonly spawnSubagentSessions: {
                        readonly type: "boolean";
                    };
                    readonly spawnAcpSessions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly intents: {
                readonly type: "object";
                readonly properties: {
                    readonly presence: {
                        readonly type: "boolean";
                    };
                    readonly guildMembers: {
                        readonly type: "boolean";
                    };
                    readonly voiceStates: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly voice: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly model: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly autoJoin: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly guildId: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly channelId: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                            };
                            readonly required: readonly ["guildId", "channelId"];
                            readonly additionalProperties: false;
                        };
                    };
                    readonly daveEncryption: {
                        readonly type: "boolean";
                    };
                    readonly decryptionFailureTolerance: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly connectTimeoutMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 120000;
                    };
                    readonly reconnectGraceMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 120000;
                    };
                    readonly captureSilenceGraceMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 30000;
                    };
                    readonly tts: {
                        readonly type: "object";
                        readonly properties: {
                            readonly auto: {
                                readonly type: "string";
                                readonly enum: readonly ["off", "always", "inbound", "tagged"];
                            };
                            readonly enabled: {
                                readonly type: "boolean";
                            };
                            readonly mode: {
                                readonly type: "string";
                                readonly enum: readonly ["final", "all"];
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly persona: {
                                readonly type: "string";
                            };
                            readonly personas: {
                                readonly type: "object";
                                readonly propertyNames: {
                                    readonly type: "string";
                                };
                                readonly additionalProperties: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly label: {
                                            readonly type: "string";
                                        };
                                        readonly description: {
                                            readonly type: "string";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly minLength: 1;
                                        };
                                        readonly fallbackPolicy: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                                readonly const: "preserve-persona";
                                            }, {
                                                readonly type: "string";
                                                readonly const: "provider-defaults";
                                            }, {
                                                readonly type: "string";
                                                readonly const: "fail";
                                            }];
                                        };
                                        readonly prompt: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly profile: {
                                                    readonly type: "string";
                                                };
                                                readonly scene: {
                                                    readonly type: "string";
                                                };
                                                readonly sampleContext: {
                                                    readonly type: "string";
                                                };
                                                readonly style: {
                                                    readonly type: "string";
                                                };
                                                readonly accent: {
                                                    readonly type: "string";
                                                };
                                                readonly pacing: {
                                                    readonly type: "string";
                                                };
                                                readonly constraints: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                        readonly providers: {
                                            readonly type: "object";
                                            readonly propertyNames: {
                                                readonly type: "string";
                                            };
                                            readonly additionalProperties: {
                                                readonly type: "object";
                                                readonly properties: {
                                                    readonly apiKey: {
                                                        readonly anyOf: readonly [{
                                                            readonly type: "string";
                                                        }, {
                                                            readonly oneOf: readonly [{
                                                                readonly type: "object";
                                                                readonly properties: {
                                                                    readonly source: {
                                                                        readonly type: "string";
                                                                        readonly const: "env";
                                                                    };
                                                                    readonly provider: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                    };
                                                                    readonly id: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                                                    };
                                                                };
                                                                readonly required: readonly ["source", "provider", "id"];
                                                                readonly additionalProperties: false;
                                                            }, {
                                                                readonly type: "object";
                                                                readonly properties: {
                                                                    readonly source: {
                                                                        readonly type: "string";
                                                                        readonly const: "file";
                                                                    };
                                                                    readonly provider: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                    };
                                                                    readonly id: {
                                                                        readonly type: "string";
                                                                    };
                                                                };
                                                                readonly required: readonly ["source", "provider", "id"];
                                                                readonly additionalProperties: false;
                                                            }, {
                                                                readonly type: "object";
                                                                readonly properties: {
                                                                    readonly source: {
                                                                        readonly type: "string";
                                                                        readonly const: "exec";
                                                                    };
                                                                    readonly provider: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                    };
                                                                    readonly id: {
                                                                        readonly type: "string";
                                                                    };
                                                                };
                                                                readonly required: readonly ["source", "provider", "id"];
                                                                readonly additionalProperties: false;
                                                            }];
                                                        }];
                                                    };
                                                };
                                                readonly additionalProperties: {
                                                    readonly anyOf: readonly [{
                                                        readonly type: "string";
                                                    }, {
                                                        readonly type: "number";
                                                    }, {
                                                        readonly type: "boolean";
                                                    }, {
                                                        readonly type: "null";
                                                    }, {
                                                        readonly type: "array";
                                                        readonly items: {};
                                                    }, {
                                                        readonly type: "object";
                                                        readonly propertyNames: {
                                                            readonly type: "string";
                                                        };
                                                        readonly additionalProperties: {};
                                                    }];
                                                };
                                            };
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                            };
                            readonly summaryModel: {
                                readonly type: "string";
                            };
                            readonly modelOverrides: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowText: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowProvider: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowVoice: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowModelId: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowVoiceSettings: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowNormalization: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowSeed: {
                                        readonly type: "boolean";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                            readonly providers: {
                                readonly type: "object";
                                readonly propertyNames: {
                                    readonly type: "string";
                                };
                                readonly additionalProperties: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly apiKey: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly oneOf: readonly [{
                                                    readonly type: "object";
                                                    readonly properties: {
                                                        readonly source: {
                                                            readonly type: "string";
                                                            readonly const: "env";
                                                        };
                                                        readonly provider: {
                                                            readonly type: "string";
                                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                        };
                                                        readonly id: {
                                                            readonly type: "string";
                                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                                        };
                                                    };
                                                    readonly required: readonly ["source", "provider", "id"];
                                                    readonly additionalProperties: false;
                                                }, {
                                                    readonly type: "object";
                                                    readonly properties: {
                                                        readonly source: {
                                                            readonly type: "string";
                                                            readonly const: "file";
                                                        };
                                                        readonly provider: {
                                                            readonly type: "string";
                                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                        };
                                                        readonly id: {
                                                            readonly type: "string";
                                                        };
                                                    };
                                                    readonly required: readonly ["source", "provider", "id"];
                                                    readonly additionalProperties: false;
                                                }, {
                                                    readonly type: "object";
                                                    readonly properties: {
                                                        readonly source: {
                                                            readonly type: "string";
                                                            readonly const: "exec";
                                                        };
                                                        readonly provider: {
                                                            readonly type: "string";
                                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                        };
                                                        readonly id: {
                                                            readonly type: "string";
                                                        };
                                                    };
                                                    readonly required: readonly ["source", "provider", "id"];
                                                    readonly additionalProperties: false;
                                                }];
                                            }];
                                        };
                                    };
                                    readonly additionalProperties: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                        }, {
                                            readonly type: "number";
                                        }, {
                                            readonly type: "boolean";
                                        }, {
                                            readonly type: "null";
                                        }, {
                                            readonly type: "array";
                                            readonly items: {};
                                        }, {
                                            readonly type: "object";
                                            readonly propertyNames: {
                                                readonly type: "string";
                                            };
                                            readonly additionalProperties: {};
                                        }];
                                    };
                                };
                            };
                            readonly prefsPath: {
                                readonly type: "string";
                            };
                            readonly maxTextLength: {
                                readonly type: "integer";
                                readonly minimum: 1;
                                readonly maximum: 9007199254740991;
                            };
                            readonly timeoutMs: {
                                readonly type: "integer";
                                readonly minimum: 1000;
                                readonly maximum: 120000;
                            };
                        };
                        readonly additionalProperties: false;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly pluralkit: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly token: {
                        readonly anyOf: readonly [{
                            readonly type: "string";
                        }, {
                            readonly oneOf: readonly [{
                                readonly type: "object";
                                readonly properties: {
                                    readonly source: {
                                        readonly type: "string";
                                        readonly const: "env";
                                    };
                                    readonly provider: {
                                        readonly type: "string";
                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                    };
                                    readonly id: {
                                        readonly type: "string";
                                        readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                    };
                                };
                                readonly required: readonly ["source", "provider", "id"];
                                readonly additionalProperties: false;
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly source: {
                                        readonly type: "string";
                                        readonly const: "file";
                                    };
                                    readonly provider: {
                                        readonly type: "string";
                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                    };
                                    readonly id: {
                                        readonly type: "string";
                                    };
                                };
                                readonly required: readonly ["source", "provider", "id"];
                                readonly additionalProperties: false;
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly source: {
                                        readonly type: "string";
                                        readonly const: "exec";
                                    };
                                    readonly provider: {
                                        readonly type: "string";
                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                    };
                                    readonly id: {
                                        readonly type: "string";
                                    };
                                };
                                readonly required: readonly ["source", "provider", "id"];
                                readonly additionalProperties: false;
                            }];
                        }];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly ackReaction: {
                readonly type: "string";
            };
            readonly ackReactionScope: {
                readonly type: "string";
                readonly enum: readonly ["group-mentions", "group-all", "direct", "all", "off", "none"];
            };
            readonly activity: {
                readonly type: "string";
            };
            readonly status: {
                readonly type: "string";
                readonly enum: readonly ["online", "dnd", "idle", "invisible"];
            };
            readonly autoPresence: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly intervalMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly minUpdateIntervalMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly healthyText: {
                        readonly type: "string";
                    };
                    readonly degradedText: {
                        readonly type: "string";
                    };
                    readonly exhaustedText: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly activityType: {
                readonly anyOf: readonly [{
                    readonly type: "number";
                    readonly const: 0;
                }, {
                    readonly type: "number";
                    readonly const: 1;
                }, {
                    readonly type: "number";
                    readonly const: 2;
                }, {
                    readonly type: "number";
                    readonly const: 3;
                }, {
                    readonly type: "number";
                    readonly const: 4;
                }, {
                    readonly type: "number";
                    readonly const: 5;
                }];
            };
            readonly activityUrl: {
                readonly type: "string";
                readonly format: "uri";
            };
            readonly inboundWorker: {
                readonly type: "object";
                readonly properties: {
                    readonly runTimeoutMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly eventQueue: {
                readonly type: "object";
                readonly properties: {
                    readonly listenerTimeout: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxQueueSize: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxConcurrency: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly capabilities: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly commands: {
                            readonly type: "object";
                            readonly properties: {
                                readonly native: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                                readonly nativeSkills: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly token: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly applicationId: {
                            readonly type: "string";
                        };
                        readonly proxy: {
                            readonly type: "string";
                        };
                        readonly gatewayInfoTimeoutMs: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 120000;
                        };
                        readonly gatewayReadyTimeoutMs: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 120000;
                        };
                        readonly gatewayRuntimeReadyTimeoutMs: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 120000;
                        };
                        readonly allowBots: {
                            readonly anyOf: readonly [{
                                readonly type: "boolean";
                            }, {
                                readonly type: "string";
                                readonly const: "mentions";
                            }];
                        };
                        readonly dangerouslyAllowNameMatching: {
                            readonly type: "boolean";
                        };
                        readonly mentionAliases: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "string";
                                readonly pattern: "^\\d+$";
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly streaming: {
                            readonly type: "object";
                            readonly properties: {
                                readonly mode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "partial", "block", "progress"];
                                };
                                readonly chunkMode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["length", "newline"];
                                };
                                readonly preview: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly chunk: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly minChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly maxChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly breakPreference: {
                                                    readonly anyOf: readonly [{
                                                        readonly type: "string";
                                                        readonly const: "paragraph";
                                                    }, {
                                                        readonly type: "string";
                                                        readonly const: "newline";
                                                    }, {
                                                        readonly type: "string";
                                                        readonly const: "sentence";
                                                    }];
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                        readonly toolProgress: {
                                            readonly type: "boolean";
                                        };
                                        readonly commandText: {
                                            readonly type: "string";
                                            readonly enum: readonly ["raw", "status"];
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                                readonly progress: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly label: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "boolean";
                                                readonly const: false;
                                            }];
                                        };
                                        readonly labels: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "string";
                                            };
                                        };
                                        readonly maxLines: {
                                            readonly type: "integer";
                                            readonly exclusiveMinimum: 0;
                                            readonly maximum: 9007199254740991;
                                        };
                                        readonly render: {
                                            readonly type: "string";
                                            readonly enum: readonly ["text", "rich"];
                                        };
                                        readonly toolProgress: {
                                            readonly type: "boolean";
                                        };
                                        readonly commandText: {
                                            readonly type: "string";
                                            readonly enum: readonly ["raw", "status"];
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                                readonly block: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly enabled: {
                                            readonly type: "boolean";
                                        };
                                        readonly coalesce: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly minChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly maxChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly idleMs: {
                                                    readonly type: "integer";
                                                    readonly minimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly maxLinesPerMessage: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                            readonly exclusiveMinimum: 0;
                        };
                        readonly retry: {
                            readonly type: "object";
                            readonly properties: {
                                readonly attempts: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly minDelayMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxDelayMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly jitter: {
                                    readonly type: "number";
                                    readonly minimum: 0;
                                    readonly maximum: 1;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                                readonly stickers: {
                                    readonly type: "boolean";
                                };
                                readonly emojiUploads: {
                                    readonly type: "boolean";
                                };
                                readonly stickerUploads: {
                                    readonly type: "boolean";
                                };
                                readonly polls: {
                                    readonly type: "boolean";
                                };
                                readonly permissions: {
                                    readonly type: "boolean";
                                };
                                readonly messages: {
                                    readonly type: "boolean";
                                };
                                readonly threads: {
                                    readonly type: "boolean";
                                };
                                readonly pins: {
                                    readonly type: "boolean";
                                };
                                readonly search: {
                                    readonly type: "boolean";
                                };
                                readonly memberInfo: {
                                    readonly type: "boolean";
                                };
                                readonly roleInfo: {
                                    readonly type: "boolean";
                                };
                                readonly roles: {
                                    readonly type: "boolean";
                                };
                                readonly channelInfo: {
                                    readonly type: "boolean";
                                };
                                readonly voiceStatus: {
                                    readonly type: "boolean";
                                };
                                readonly events: {
                                    readonly type: "boolean";
                                };
                                readonly moderation: {
                                    readonly type: "boolean";
                                };
                                readonly channels: {
                                    readonly type: "boolean";
                                };
                                readonly presence: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly replyToMode: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly const: "off";
                            }, {
                                readonly type: "string";
                                readonly const: "first";
                            }, {
                                readonly type: "string";
                                readonly const: "all";
                            }, {
                                readonly type: "string";
                                readonly const: "batched";
                            }];
                        };
                        readonly thread: {
                            readonly type: "object";
                            readonly properties: {
                                readonly inheritParent: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly defaultTo: {
                            readonly type: "string";
                        };
                        readonly dm: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly policy: {
                                    readonly type: "string";
                                    readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                                };
                                readonly allowFrom: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly groupEnabled: {
                                    readonly type: "boolean";
                                };
                                readonly groupChannels: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly guilds: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly slug: {
                                        readonly type: "string";
                                    };
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly ignoreOtherMentions: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly reactionNotifications: {
                                        readonly type: "string";
                                        readonly enum: readonly ["off", "own", "all", "allowlist"];
                                    };
                                    readonly users: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly roles: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly channels: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly requireMention: {
                                                    readonly type: "boolean";
                                                };
                                                readonly ignoreOtherMentions: {
                                                    readonly type: "boolean";
                                                };
                                                readonly tools: {
                                                    readonly type: "object";
                                                    readonly properties: {
                                                        readonly allow: {
                                                            readonly type: "array";
                                                            readonly items: {
                                                                readonly type: "string";
                                                            };
                                                        };
                                                        readonly alsoAllow: {
                                                            readonly type: "array";
                                                            readonly items: {
                                                                readonly type: "string";
                                                            };
                                                        };
                                                        readonly deny: {
                                                            readonly type: "array";
                                                            readonly items: {
                                                                readonly type: "string";
                                                            };
                                                        };
                                                    };
                                                    readonly additionalProperties: false;
                                                };
                                                readonly toolsBySender: {
                                                    readonly type: "object";
                                                    readonly propertyNames: {
                                                        readonly type: "string";
                                                    };
                                                    readonly additionalProperties: {
                                                        readonly type: "object";
                                                        readonly properties: {
                                                            readonly allow: {
                                                                readonly type: "array";
                                                                readonly items: {
                                                                    readonly type: "string";
                                                                };
                                                            };
                                                            readonly alsoAllow: {
                                                                readonly type: "array";
                                                                readonly items: {
                                                                    readonly type: "string";
                                                                };
                                                            };
                                                            readonly deny: {
                                                                readonly type: "array";
                                                                readonly items: {
                                                                    readonly type: "string";
                                                                };
                                                            };
                                                        };
                                                        readonly additionalProperties: false;
                                                    };
                                                };
                                                readonly skills: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly enabled: {
                                                    readonly type: "boolean";
                                                };
                                                readonly users: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly roles: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly systemPrompt: {
                                                    readonly type: "string";
                                                };
                                                readonly includeThreadStarter: {
                                                    readonly type: "boolean";
                                                };
                                                readonly autoThread: {
                                                    readonly type: "boolean";
                                                };
                                                readonly autoThreadName: {
                                                    readonly type: "string";
                                                    readonly enum: readonly ["message", "generated"];
                                                };
                                                readonly autoArchiveDuration: {
                                                    readonly anyOf: readonly [{
                                                        readonly type: "string";
                                                        readonly enum: readonly ["60", "1440", "4320", "10080"];
                                                    }, {
                                                        readonly type: "number";
                                                        readonly const: 60;
                                                    }, {
                                                        readonly type: "number";
                                                        readonly const: 1440;
                                                    }, {
                                                        readonly type: "number";
                                                        readonly const: 4320;
                                                    }, {
                                                        readonly type: "number";
                                                        readonly const: 10080;
                                                    }];
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly showOk: {
                                    readonly type: "boolean";
                                };
                                readonly showAlerts: {
                                    readonly type: "boolean";
                                };
                                readonly useIndicator: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly healthMonitor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly execApprovals: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly approvers: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly agentFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly sessionFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly cleanupAfterResolve: {
                                    readonly type: "boolean";
                                };
                                readonly target: {
                                    readonly type: "string";
                                    readonly enum: readonly ["dm", "channel", "both"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly agentComponents: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly ui: {
                            readonly type: "object";
                            readonly properties: {
                                readonly components: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly accentColor: {
                                            readonly type: "string";
                                            readonly pattern: "^#?[0-9a-fA-F]{6}$";
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly slashCommand: {
                            readonly type: "object";
                            readonly properties: {
                                readonly ephemeral: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly threadBindings: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly idleHours: {
                                    readonly type: "number";
                                    readonly minimum: 0;
                                };
                                readonly maxAgeHours: {
                                    readonly type: "number";
                                    readonly minimum: 0;
                                };
                                readonly spawnSessions: {
                                    readonly type: "boolean";
                                };
                                readonly defaultSpawnContext: {
                                    readonly type: "string";
                                    readonly enum: readonly ["isolated", "fork"];
                                };
                                readonly spawnSubagentSessions: {
                                    readonly type: "boolean";
                                };
                                readonly spawnAcpSessions: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly intents: {
                            readonly type: "object";
                            readonly properties: {
                                readonly presence: {
                                    readonly type: "boolean";
                                };
                                readonly guildMembers: {
                                    readonly type: "boolean";
                                };
                                readonly voiceStates: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly voice: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly model: {
                                    readonly type: "string";
                                    readonly minLength: 1;
                                };
                                readonly autoJoin: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly guildId: {
                                                readonly type: "string";
                                                readonly minLength: 1;
                                            };
                                            readonly channelId: {
                                                readonly type: "string";
                                                readonly minLength: 1;
                                            };
                                        };
                                        readonly required: readonly ["guildId", "channelId"];
                                        readonly additionalProperties: false;
                                    };
                                };
                                readonly daveEncryption: {
                                    readonly type: "boolean";
                                };
                                readonly decryptionFailureTolerance: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly connectTimeoutMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 120000;
                                };
                                readonly reconnectGraceMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 120000;
                                };
                                readonly captureSilenceGraceMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 30000;
                                };
                                readonly tts: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly auto: {
                                            readonly type: "string";
                                            readonly enum: readonly ["off", "always", "inbound", "tagged"];
                                        };
                                        readonly enabled: {
                                            readonly type: "boolean";
                                        };
                                        readonly mode: {
                                            readonly type: "string";
                                            readonly enum: readonly ["final", "all"];
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly minLength: 1;
                                        };
                                        readonly persona: {
                                            readonly type: "string";
                                        };
                                        readonly personas: {
                                            readonly type: "object";
                                            readonly propertyNames: {
                                                readonly type: "string";
                                            };
                                            readonly additionalProperties: {
                                                readonly type: "object";
                                                readonly properties: {
                                                    readonly label: {
                                                        readonly type: "string";
                                                    };
                                                    readonly description: {
                                                        readonly type: "string";
                                                    };
                                                    readonly provider: {
                                                        readonly type: "string";
                                                        readonly minLength: 1;
                                                    };
                                                    readonly fallbackPolicy: {
                                                        readonly anyOf: readonly [{
                                                            readonly type: "string";
                                                            readonly const: "preserve-persona";
                                                        }, {
                                                            readonly type: "string";
                                                            readonly const: "provider-defaults";
                                                        }, {
                                                            readonly type: "string";
                                                            readonly const: "fail";
                                                        }];
                                                    };
                                                    readonly prompt: {
                                                        readonly type: "object";
                                                        readonly properties: {
                                                            readonly profile: {
                                                                readonly type: "string";
                                                            };
                                                            readonly scene: {
                                                                readonly type: "string";
                                                            };
                                                            readonly sampleContext: {
                                                                readonly type: "string";
                                                            };
                                                            readonly style: {
                                                                readonly type: "string";
                                                            };
                                                            readonly accent: {
                                                                readonly type: "string";
                                                            };
                                                            readonly pacing: {
                                                                readonly type: "string";
                                                            };
                                                            readonly constraints: {
                                                                readonly type: "array";
                                                                readonly items: {
                                                                    readonly type: "string";
                                                                };
                                                            };
                                                        };
                                                        readonly additionalProperties: false;
                                                    };
                                                    readonly providers: {
                                                        readonly type: "object";
                                                        readonly propertyNames: {
                                                            readonly type: "string";
                                                        };
                                                        readonly additionalProperties: {
                                                            readonly type: "object";
                                                            readonly properties: {
                                                                readonly apiKey: {
                                                                    readonly anyOf: readonly [{
                                                                        readonly type: "string";
                                                                    }, {
                                                                        readonly oneOf: readonly [{
                                                                            readonly type: "object";
                                                                            readonly properties: {
                                                                                readonly source: {
                                                                                    readonly type: "string";
                                                                                    readonly const: "env";
                                                                                };
                                                                                readonly provider: {
                                                                                    readonly type: "string";
                                                                                    readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                                };
                                                                                readonly id: {
                                                                                    readonly type: "string";
                                                                                    readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                                                                };
                                                                            };
                                                                            readonly required: readonly ["source", "provider", "id"];
                                                                            readonly additionalProperties: false;
                                                                        }, {
                                                                            readonly type: "object";
                                                                            readonly properties: {
                                                                                readonly source: {
                                                                                    readonly type: "string";
                                                                                    readonly const: "file";
                                                                                };
                                                                                readonly provider: {
                                                                                    readonly type: "string";
                                                                                    readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                                };
                                                                                readonly id: {
                                                                                    readonly type: "string";
                                                                                };
                                                                            };
                                                                            readonly required: readonly ["source", "provider", "id"];
                                                                            readonly additionalProperties: false;
                                                                        }, {
                                                                            readonly type: "object";
                                                                            readonly properties: {
                                                                                readonly source: {
                                                                                    readonly type: "string";
                                                                                    readonly const: "exec";
                                                                                };
                                                                                readonly provider: {
                                                                                    readonly type: "string";
                                                                                    readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                                };
                                                                                readonly id: {
                                                                                    readonly type: "string";
                                                                                };
                                                                            };
                                                                            readonly required: readonly ["source", "provider", "id"];
                                                                            readonly additionalProperties: false;
                                                                        }];
                                                                    }];
                                                                };
                                                            };
                                                            readonly additionalProperties: {
                                                                readonly anyOf: readonly [{
                                                                    readonly type: "string";
                                                                }, {
                                                                    readonly type: "number";
                                                                }, {
                                                                    readonly type: "boolean";
                                                                }, {
                                                                    readonly type: "null";
                                                                }, {
                                                                    readonly type: "array";
                                                                    readonly items: {};
                                                                }, {
                                                                    readonly type: "object";
                                                                    readonly propertyNames: {
                                                                        readonly type: "string";
                                                                    };
                                                                    readonly additionalProperties: {};
                                                                }];
                                                            };
                                                        };
                                                    };
                                                };
                                                readonly additionalProperties: false;
                                            };
                                        };
                                        readonly summaryModel: {
                                            readonly type: "string";
                                        };
                                        readonly modelOverrides: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly enabled: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowText: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowProvider: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowVoice: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowModelId: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowVoiceSettings: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowNormalization: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowSeed: {
                                                    readonly type: "boolean";
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                        readonly providers: {
                                            readonly type: "object";
                                            readonly propertyNames: {
                                                readonly type: "string";
                                            };
                                            readonly additionalProperties: {
                                                readonly type: "object";
                                                readonly properties: {
                                                    readonly apiKey: {
                                                        readonly anyOf: readonly [{
                                                            readonly type: "string";
                                                        }, {
                                                            readonly oneOf: readonly [{
                                                                readonly type: "object";
                                                                readonly properties: {
                                                                    readonly source: {
                                                                        readonly type: "string";
                                                                        readonly const: "env";
                                                                    };
                                                                    readonly provider: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                    };
                                                                    readonly id: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                                                    };
                                                                };
                                                                readonly required: readonly ["source", "provider", "id"];
                                                                readonly additionalProperties: false;
                                                            }, {
                                                                readonly type: "object";
                                                                readonly properties: {
                                                                    readonly source: {
                                                                        readonly type: "string";
                                                                        readonly const: "file";
                                                                    };
                                                                    readonly provider: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                    };
                                                                    readonly id: {
                                                                        readonly type: "string";
                                                                    };
                                                                };
                                                                readonly required: readonly ["source", "provider", "id"];
                                                                readonly additionalProperties: false;
                                                            }, {
                                                                readonly type: "object";
                                                                readonly properties: {
                                                                    readonly source: {
                                                                        readonly type: "string";
                                                                        readonly const: "exec";
                                                                    };
                                                                    readonly provider: {
                                                                        readonly type: "string";
                                                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                                    };
                                                                    readonly id: {
                                                                        readonly type: "string";
                                                                    };
                                                                };
                                                                readonly required: readonly ["source", "provider", "id"];
                                                                readonly additionalProperties: false;
                                                            }];
                                                        }];
                                                    };
                                                };
                                                readonly additionalProperties: {
                                                    readonly anyOf: readonly [{
                                                        readonly type: "string";
                                                    }, {
                                                        readonly type: "number";
                                                    }, {
                                                        readonly type: "boolean";
                                                    }, {
                                                        readonly type: "null";
                                                    }, {
                                                        readonly type: "array";
                                                        readonly items: {};
                                                    }, {
                                                        readonly type: "object";
                                                        readonly propertyNames: {
                                                            readonly type: "string";
                                                        };
                                                        readonly additionalProperties: {};
                                                    }];
                                                };
                                            };
                                        };
                                        readonly prefsPath: {
                                            readonly type: "string";
                                        };
                                        readonly maxTextLength: {
                                            readonly type: "integer";
                                            readonly minimum: 1;
                                            readonly maximum: 9007199254740991;
                                        };
                                        readonly timeoutMs: {
                                            readonly type: "integer";
                                            readonly minimum: 1000;
                                            readonly maximum: 120000;
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly pluralkit: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly token: {
                                    readonly anyOf: readonly [{
                                        readonly type: "string";
                                    }, {
                                        readonly oneOf: readonly [{
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly source: {
                                                    readonly type: "string";
                                                    readonly const: "env";
                                                };
                                                readonly provider: {
                                                    readonly type: "string";
                                                    readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                };
                                                readonly id: {
                                                    readonly type: "string";
                                                    readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                                };
                                            };
                                            readonly required: readonly ["source", "provider", "id"];
                                            readonly additionalProperties: false;
                                        }, {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly source: {
                                                    readonly type: "string";
                                                    readonly const: "file";
                                                };
                                                readonly provider: {
                                                    readonly type: "string";
                                                    readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                };
                                                readonly id: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly required: readonly ["source", "provider", "id"];
                                            readonly additionalProperties: false;
                                        }, {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly source: {
                                                    readonly type: "string";
                                                    readonly const: "exec";
                                                };
                                                readonly provider: {
                                                    readonly type: "string";
                                                    readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                                };
                                                readonly id: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly required: readonly ["source", "provider", "id"];
                                            readonly additionalProperties: false;
                                        }];
                                    }];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly ackReaction: {
                            readonly type: "string";
                        };
                        readonly ackReactionScope: {
                            readonly type: "string";
                            readonly enum: readonly ["group-mentions", "group-all", "direct", "all", "off", "none"];
                        };
                        readonly activity: {
                            readonly type: "string";
                        };
                        readonly status: {
                            readonly type: "string";
                            readonly enum: readonly ["online", "dnd", "idle", "invisible"];
                        };
                        readonly autoPresence: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly intervalMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly minUpdateIntervalMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly healthyText: {
                                    readonly type: "string";
                                };
                                readonly degradedText: {
                                    readonly type: "string";
                                };
                                readonly exhaustedText: {
                                    readonly type: "string";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly activityType: {
                            readonly anyOf: readonly [{
                                readonly type: "number";
                                readonly const: 0;
                            }, {
                                readonly type: "number";
                                readonly const: 1;
                            }, {
                                readonly type: "number";
                                readonly const: 2;
                            }, {
                                readonly type: "number";
                                readonly const: 3;
                            }, {
                                readonly type: "number";
                                readonly const: 4;
                            }, {
                                readonly type: "number";
                                readonly const: 5;
                            }];
                        };
                        readonly activityUrl: {
                            readonly type: "string";
                            readonly format: "uri";
                        };
                        readonly inboundWorker: {
                            readonly type: "object";
                            readonly properties: {
                                readonly runTimeoutMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly eventQueue: {
                            readonly type: "object";
                            readonly properties: {
                                readonly listenerTimeout: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxQueueSize: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxConcurrency: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ["groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "Discord";
            readonly help: "Discord channel provider configuration for bot auth, retry policy, streaming, thread bindings, and optional voice capabilities. Keep privileged intents and advanced features disabled unless needed.";
        };
        readonly dmPolicy: {
            readonly label: "Discord DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"].';
        };
        readonly "dm.policy": {
            readonly label: "Discord DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"] (legacy: channels.discord.dm.allowFrom).';
        };
        readonly configWrites: {
            readonly label: "Discord Config Writes";
            readonly help: "Allow Discord to write config in response to channel events/commands (default: true).";
        };
        readonly proxy: {
            readonly label: "Discord Proxy URL";
            readonly help: "Proxy URL for Discord gateway + API requests (app-id lookup and allowlist resolution). Set per account via channels.discord.accounts.<id>.proxy.";
        };
        readonly "commands.native": {
            readonly label: "Discord Native Commands";
            readonly help: 'Override native commands for Discord (bool or "auto").';
        };
        readonly "commands.nativeSkills": {
            readonly label: "Discord Native Skill Commands";
            readonly help: 'Override native skill commands for Discord (bool or "auto").';
        };
        readonly streaming: {
            readonly label: "Discord Streaming Mode";
            readonly help: 'Unified Discord stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery. Legacy boolean/streamMode keys are auto-mapped.';
        };
        readonly "streaming.mode": {
            readonly label: "Discord Streaming Mode";
            readonly help: 'Canonical Discord preview mode: "off" | "partial" | "block" | "progress".';
        };
        readonly "streaming.chunkMode": {
            readonly label: "Discord Chunk Mode";
            readonly help: 'Chunking mode for outbound Discord text delivery: "length" (default) or "newline".';
        };
        readonly "streaming.block.enabled": {
            readonly label: "Discord Block Streaming Enabled";
            readonly help: 'Enable chunked block-style Discord preview delivery when channels.discord.streaming.mode="block".';
        };
        readonly "streaming.block.coalesce": {
            readonly label: "Discord Block Streaming Coalesce";
            readonly help: "Merge streamed Discord block replies before final delivery.";
        };
        readonly "streaming.preview.chunk.minChars": {
            readonly label: "Discord Draft Chunk Min Chars";
            readonly help: 'Minimum chars before emitting a Discord stream preview update when channels.discord.streaming.mode="block" (default: 200).';
        };
        readonly "streaming.preview.chunk.maxChars": {
            readonly label: "Discord Draft Chunk Max Chars";
            readonly help: 'Target max size for a Discord stream preview chunk when channels.discord.streaming.mode="block" (default: 800; clamped to channels.discord.textChunkLimit).';
        };
        readonly "streaming.preview.chunk.breakPreference": {
            readonly label: "Discord Draft Chunk Break Preference";
            readonly help: "Preferred breakpoints for Discord draft chunks (paragraph | newline | sentence). Default: paragraph.";
        };
        readonly "streaming.preview.toolProgress": {
            readonly label: "Discord Draft Tool Progress";
            readonly help: "Show tool/progress activity in the live draft preview message (default: true). Set false to hide interim tool updates while the draft preview stays active.";
        };
        readonly "streaming.preview.commandText": {
            readonly label: "Discord Draft Command Text";
            readonly help: 'Command/exec detail in preview tool-progress lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "streaming.progress.label": {
            readonly label: "Discord Progress Label";
            readonly help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.';
        };
        readonly "streaming.progress.labels": {
            readonly label: "Discord Progress Label Pool";
            readonly help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.';
        };
        readonly "streaming.progress.maxLines": {
            readonly label: "Discord Progress Max Lines";
            readonly help: "Maximum number of compact progress lines to keep below the draft label (default: 8).";
        };
        readonly "streaming.progress.toolProgress": {
            readonly label: "Discord Progress Tool Lines";
            readonly help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.";
        };
        readonly "streaming.progress.commandText": {
            readonly label: "Discord Progress Command Text";
            readonly help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "retry.attempts": {
            readonly label: "Discord Retry Attempts";
            readonly help: "Max retry attempts for outbound Discord API calls (default: 3).";
        };
        readonly "retry.minDelayMs": {
            readonly label: "Discord Retry Min Delay (ms)";
            readonly help: "Minimum retry delay in ms for Discord outbound calls.";
        };
        readonly "retry.maxDelayMs": {
            readonly label: "Discord Retry Max Delay (ms)";
            readonly help: "Maximum retry delay cap in ms for Discord outbound calls.";
        };
        readonly "retry.jitter": {
            readonly label: "Discord Retry Jitter";
            readonly help: "Jitter factor (0-1) applied to Discord retry delays.";
        };
        readonly maxLinesPerMessage: {
            readonly label: "Discord Max Lines Per Message";
            readonly help: "Soft max line count per Discord message (default: 17).";
        };
        readonly "thread.inheritParent": {
            readonly label: "Discord Thread Parent Inheritance";
            readonly help: "If true, Discord thread sessions inherit the parent channel transcript (default: false).";
        };
        readonly "eventQueue.listenerTimeout": {
            readonly label: "Discord EventQueue Listener Timeout (ms)";
            readonly help: "Canonical Discord listener timeout control in ms for gateway normalization/enqueue handlers. Default is 120000 in OpenClaw; set per account via channels.discord.accounts.<id>.eventQueue.listenerTimeout.";
        };
        readonly "eventQueue.maxQueueSize": {
            readonly label: "Discord EventQueue Max Queue Size";
            readonly help: "Optional Discord EventQueue capacity override (max queued events before backpressure). Set per account via channels.discord.accounts.<id>.eventQueue.maxQueueSize.";
        };
        readonly "eventQueue.maxConcurrency": {
            readonly label: "Discord EventQueue Max Concurrency";
            readonly help: "Optional Discord EventQueue concurrency override (max concurrent handler executions). Set per account via channels.discord.accounts.<id>.eventQueue.maxConcurrency.";
        };
        readonly "threadBindings.enabled": {
            readonly label: "Discord Thread Binding Enabled";
            readonly help: "Enable Discord thread binding features (/focus, bound-thread routing/delivery, and thread-bound subagent sessions). Overrides session.threadBindings.enabled when set.";
        };
        readonly "threadBindings.idleHours": {
            readonly label: "Discord Thread Binding Idle Timeout (hours)";
            readonly help: "Inactivity window in hours for Discord thread-bound sessions (/focus and spawned thread sessions). Set 0 to disable idle auto-unfocus (default: 24). Overrides session.threadBindings.idleHours when set.";
        };
        readonly "threadBindings.maxAgeHours": {
            readonly label: "Discord Thread Binding Max Age (hours)";
            readonly help: "Optional hard max age in hours for Discord thread-bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set.";
        };
        readonly "threadBindings.spawnSessions": {
            readonly label: "Discord Thread-Bound Session Spawn";
            readonly help: "Allow sessions_spawn(thread=true) and ACP thread spawns to auto-create and bind Discord threads (default: true). Set false to disable for this account/channel.";
        };
        readonly "threadBindings.defaultSpawnContext": {
            readonly label: "Discord Thread Spawn Context";
            readonly help: 'Default native subagent context for thread-bound spawns. "fork" starts from the requester transcript; "isolated" starts clean. Default: "fork".';
        };
        readonly "ui.components.accentColor": {
            readonly label: "Discord Component Accent Color";
            readonly help: "Accent color for Discord component containers (hex). Set per account via channels.discord.accounts.<id>.ui.components.accentColor.";
        };
        readonly "intents.presence": {
            readonly label: "Discord Presence Intent";
            readonly help: "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.";
        };
        readonly "intents.guildMembers": {
            readonly label: "Discord Guild Members Intent";
            readonly help: "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.";
        };
        readonly "intents.voiceStates": {
            readonly label: "Discord Voice States Intent";
            readonly help: "Enable the Guild Voice States intent. Defaults to the effective Discord voice setting; set true only for Discord voice channel conversations.";
        };
        readonly gatewayInfoTimeoutMs: {
            readonly label: "Discord Gateway Metadata Timeout (ms)";
            readonly help: "Timeout for Discord /gateway/bot metadata lookup before falling back to the default gateway URL. Default is 30000; OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS can override when config is unset.";
        };
        readonly gatewayReadyTimeoutMs: {
            readonly label: "Discord Gateway READY Timeout (ms)";
            readonly help: "Startup wait for the Discord gateway READY event before restarting the socket. Default is 15000; OPENCLAW_DISCORD_READY_TIMEOUT_MS can override when config is unset.";
        };
        readonly gatewayRuntimeReadyTimeoutMs: {
            readonly label: "Discord Gateway Runtime READY Timeout (ms)";
            readonly help: "Runtime reconnect wait for the Discord gateway READY event before force-stopping the lifecycle. Default is 30000; OPENCLAW_DISCORD_RUNTIME_READY_TIMEOUT_MS can override when config is unset.";
        };
        readonly "voice.enabled": {
            readonly label: "Discord Voice Enabled";
            readonly help: "Enable Discord voice channel conversations. Text-only Discord configs leave voice off by default; set true to enable /vc commands and the Guild Voice States intent.";
        };
        readonly "voice.model": {
            readonly label: "Discord Voice Model";
            readonly help: "Optional LLM model override for Discord voice channel responses (for example openai/gpt-5.4-mini). Leave unset to inherit the routed agent model.";
        };
        readonly "voice.autoJoin": {
            readonly label: "Discord Voice Auto-Join";
            readonly help: "Voice channels to auto-join on startup (list of guildId/channelId entries).";
        };
        readonly "voice.daveEncryption": {
            readonly label: "Discord Voice DAVE Encryption";
            readonly help: "Toggle DAVE end-to-end encryption for Discord voice joins (default: true in @discordjs/voice; Discord may require this).";
        };
        readonly "voice.decryptionFailureTolerance": {
            readonly label: "Discord Voice Decrypt Failure Tolerance";
            readonly help: "Consecutive decrypt failures before DAVE attempts session recovery (passed to @discordjs/voice; default: 24).";
        };
        readonly "voice.connectTimeoutMs": {
            readonly label: "Discord Voice Connect Timeout (ms)";
            readonly help: "Initial @discordjs/voice Ready wait before a join is treated as failed. Default: 30000.";
        };
        readonly "voice.reconnectGraceMs": {
            readonly label: "Discord Voice Reconnect Grace (ms)";
            readonly help: "Grace period for a disconnected Discord voice session to enter Signalling or Connecting before OpenClaw destroys it. Default: 15000.";
        };
        readonly "voice.captureSilenceGraceMs": {
            readonly label: "Discord Voice Capture Silence Grace (ms)";
            readonly help: "Silence window after Discord reports a speaker ended before OpenClaw finalizes the audio segment for transcription. Default: 2500.";
        };
        readonly "voice.tts": {
            readonly label: "Discord Voice Text-to-Speech";
            readonly help: "Optional TTS overrides for Discord voice playback (merged with messages.tts).";
        };
        readonly "pluralkit.enabled": {
            readonly label: "Discord PluralKit Enabled";
            readonly help: "Resolve PluralKit proxied messages and treat system members as distinct senders.";
        };
        readonly "pluralkit.token": {
            readonly label: "Discord PluralKit Token";
            readonly help: "Optional PluralKit token for resolving private systems or members.";
        };
        readonly activity: {
            readonly label: "Discord Presence Activity";
            readonly help: "Discord presence activity text (defaults to custom status).";
        };
        readonly status: {
            readonly label: "Discord Presence Status";
            readonly help: "Discord presence status (online, dnd, idle, invisible).";
        };
        readonly "autoPresence.enabled": {
            readonly label: "Discord Auto Presence Enabled";
            readonly help: "Enable automatic Discord bot presence updates based on runtime/model availability signals. When enabled: healthy=>online, degraded/unknown=>idle, exhausted/unavailable=>dnd.";
        };
        readonly "autoPresence.intervalMs": {
            readonly label: "Discord Auto Presence Check Interval (ms)";
            readonly help: "How often to evaluate Discord auto-presence state in milliseconds (default: 30000).";
        };
        readonly "autoPresence.minUpdateIntervalMs": {
            readonly label: "Discord Auto Presence Min Update Interval (ms)";
            readonly help: "Minimum time between actual Discord presence update calls in milliseconds (default: 15000). Prevents status spam on noisy state changes.";
        };
        readonly "autoPresence.healthyText": {
            readonly label: "Discord Auto Presence Healthy Text";
            readonly help: "Optional custom status text while runtime is healthy (online). If omitted, falls back to static channels.discord.activity when set.";
        };
        readonly "autoPresence.degradedText": {
            readonly label: "Discord Auto Presence Degraded Text";
            readonly help: "Optional custom status text while runtime/model availability is degraded or unknown (idle).";
        };
        readonly "autoPresence.exhaustedText": {
            readonly label: "Discord Auto Presence Exhausted Text";
            readonly help: "Optional custom status text while runtime detects exhausted/unavailable model quota (dnd). Supports {reason} template placeholder.";
        };
        readonly activityType: {
            readonly label: "Discord Presence Activity Type";
            readonly help: "Discord presence activity type (0=Playing,1=Streaming,2=Listening,3=Watching,4=Custom,5=Competing).";
        };
        readonly activityUrl: {
            readonly label: "Discord Presence Activity URL";
            readonly help: "Discord presence streaming URL (required for activityType=1).";
        };
        readonly allowBots: {
            readonly label: "Discord Allow Bot Messages";
            readonly help: 'Allow bot-authored messages to trigger Discord replies (default: false). Set "mentions" to only accept bot messages that mention the bot.';
        };
        readonly mentionAliases: {
            readonly label: "Discord Mention Aliases";
            readonly help: "Map outbound @handle text to stable Discord user IDs before sending. Set per account via channels.discord.accounts.<id>.mentionAliases.";
        };
        readonly token: {
            readonly label: "Discord Bot Token";
            readonly help: "Discord bot token used for gateway and REST API authentication for this provider account. Keep this secret out of committed config and rotate immediately after any leak.";
            readonly sensitive: true;
        };
        readonly applicationId: {
            readonly label: "Discord Application ID";
            readonly help: "Optional Discord application/client ID. Set this when hosted environments cannot reach Discord's application lookup endpoint during startup.";
        };
    };
    readonly unsupportedSecretRefSurfacePatterns: readonly ["channels.discord.accounts.*.threadBindings.webhookToken", "channels.discord.threadBindings.webhookToken"];
}, {
    readonly pluginId: "feishu";
    readonly channelId: "feishu";
    readonly label: "Feishu";
    readonly description: "\u98DE\u4E66/Lark enterprise messaging with doc/wiki/drive tools.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
            readonly appId: {
                readonly type: "string";
            };
            readonly appSecret: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly encryptKey: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly verificationToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly domain: {
                readonly default: "feishu";
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly enum: readonly ["feishu", "lark"];
                }, {
                    readonly type: "string";
                    readonly format: "uri";
                    readonly pattern: "^https:\\/\\/.*";
                }];
            };
            readonly connectionMode: {
                readonly default: "websocket";
                readonly type: "string";
                readonly enum: readonly ["websocket", "webhook"];
            };
            readonly webhookPath: {
                readonly default: "/feishu/events";
                readonly type: "string";
            };
            readonly webhookHost: {
                readonly type: "string";
            };
            readonly webhookPort: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["native", "escape", "strip"];
                    };
                    readonly tableMode: {
                        readonly type: "string";
                        readonly enum: readonly ["native", "ascii", "simple"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["open", "pairing", "allowlist"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly enum: readonly ["open", "allowlist", "disabled"];
                }, {}];
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupSenderAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly requireMention: {
                readonly type: "boolean";
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                        readonly groupSessionScope: {
                            readonly type: "string";
                            readonly enum: readonly ["group", "group_sender", "group_topic", "group_topic_sender"];
                        };
                        readonly topicSessionMode: {
                            readonly type: "string";
                            readonly enum: readonly ["disabled", "enabled"];
                        };
                        readonly replyInThread: {
                            readonly type: "string";
                            readonly enum: readonly ["disabled", "enabled"];
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly minDelayMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxDelayMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly httpTimeoutMs: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 300000;
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly visibility: {
                        readonly type: "string";
                        readonly enum: readonly ["visible", "hidden"];
                    };
                    readonly intervalMs: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly renderMode: {
                readonly type: "string";
                readonly enum: readonly ["auto", "raw", "card"];
            };
            readonly streaming: {
                readonly type: "boolean";
            };
            readonly tools: {
                readonly type: "object";
                readonly properties: {
                    readonly doc: {
                        readonly type: "boolean";
                    };
                    readonly chat: {
                        readonly type: "boolean";
                    };
                    readonly wiki: {
                        readonly type: "boolean";
                    };
                    readonly drive: {
                        readonly type: "boolean";
                    };
                    readonly perm: {
                        readonly type: "boolean";
                    };
                    readonly scopes: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly replyInThread: {
                readonly type: "string";
                readonly enum: readonly ["disabled", "enabled"];
            };
            readonly reactionNotifications: {
                readonly default: "own";
                readonly type: "string";
                readonly enum: readonly ["off", "own", "all"];
            };
            readonly typingIndicator: {
                readonly default: true;
                readonly type: "boolean";
            };
            readonly resolveSenderNames: {
                readonly default: true;
                readonly type: "boolean";
            };
            readonly tts: {
                readonly type: "object";
                readonly properties: {
                    readonly auto: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "always", "inbound", "tagged"];
                    };
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["final", "all"];
                    };
                    readonly provider: {
                        readonly type: "string";
                    };
                    readonly persona: {
                        readonly type: "string";
                    };
                    readonly personas: {
                        readonly type: "object";
                        readonly propertyNames: {
                            readonly type: "string";
                        };
                        readonly additionalProperties: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {};
                        };
                    };
                    readonly summaryModel: {
                        readonly type: "string";
                    };
                    readonly modelOverrides: {
                        readonly type: "object";
                        readonly propertyNames: {
                            readonly type: "string";
                        };
                        readonly additionalProperties: {};
                    };
                    readonly providers: {
                        readonly type: "object";
                        readonly propertyNames: {
                            readonly type: "string";
                        };
                        readonly additionalProperties: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {};
                        };
                    };
                    readonly prefsPath: {
                        readonly type: "string";
                    };
                    readonly maxTextLength: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 9007199254740991;
                    };
                    readonly timeoutMs: {
                        readonly type: "integer";
                        readonly minimum: 1000;
                        readonly maximum: 120000;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly groupSessionScope: {
                readonly type: "string";
                readonly enum: readonly ["group", "group_sender", "group_topic", "group_topic_sender"];
            };
            readonly topicSessionMode: {
                readonly type: "string";
                readonly enum: readonly ["disabled", "enabled"];
            };
            readonly dynamicAgentCreation: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly workspaceTemplate: {
                        readonly type: "string";
                    };
                    readonly agentDirTemplate: {
                        readonly type: "string";
                    };
                    readonly maxAgents: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly appId: {
                            readonly type: "string";
                        };
                        readonly appSecret: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly encryptKey: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly verificationToken: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly domain: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly enum: readonly ["feishu", "lark"];
                            }, {
                                readonly type: "string";
                                readonly format: "uri";
                                readonly pattern: "^https:\\/\\/.*";
                            }];
                        };
                        readonly connectionMode: {
                            readonly type: "string";
                            readonly enum: readonly ["websocket", "webhook"];
                        };
                        readonly webhookPath: {
                            readonly type: "string";
                        };
                        readonly webhookHost: {
                            readonly type: "string";
                        };
                        readonly webhookPort: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly capabilities: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly mode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["native", "escape", "strip"];
                                };
                                readonly tableMode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["native", "ascii", "simple"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "pairing", "allowlist"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly enum: readonly ["open", "allowlist", "disabled"];
                            }, {}];
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupSenderAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                    readonly groupSessionScope: {
                                        readonly type: "string";
                                        readonly enum: readonly ["group", "group_sender", "group_topic", "group_topic_sender"];
                                    };
                                    readonly topicSessionMode: {
                                        readonly type: "string";
                                        readonly enum: readonly ["disabled", "enabled"];
                                    };
                                    readonly replyInThread: {
                                        readonly type: "string";
                                        readonly enum: readonly ["disabled", "enabled"];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly minDelayMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxDelayMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                            readonly exclusiveMinimum: 0;
                        };
                        readonly httpTimeoutMs: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 300000;
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly visibility: {
                                    readonly type: "string";
                                    readonly enum: readonly ["visible", "hidden"];
                                };
                                readonly intervalMs: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly renderMode: {
                            readonly type: "string";
                            readonly enum: readonly ["auto", "raw", "card"];
                        };
                        readonly streaming: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly doc: {
                                    readonly type: "boolean";
                                };
                                readonly chat: {
                                    readonly type: "boolean";
                                };
                                readonly wiki: {
                                    readonly type: "boolean";
                                };
                                readonly drive: {
                                    readonly type: "boolean";
                                };
                                readonly perm: {
                                    readonly type: "boolean";
                                };
                                readonly scopes: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly replyInThread: {
                            readonly type: "string";
                            readonly enum: readonly ["disabled", "enabled"];
                        };
                        readonly reactionNotifications: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "own", "all"];
                        };
                        readonly typingIndicator: {
                            readonly type: "boolean";
                        };
                        readonly resolveSenderNames: {
                            readonly type: "boolean";
                        };
                        readonly tts: {
                            readonly type: "object";
                            readonly properties: {
                                readonly auto: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "always", "inbound", "tagged"];
                                };
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly mode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["final", "all"];
                                };
                                readonly provider: {
                                    readonly type: "string";
                                };
                                readonly persona: {
                                    readonly type: "string";
                                };
                                readonly personas: {
                                    readonly type: "object";
                                    readonly propertyNames: {
                                        readonly type: "string";
                                    };
                                    readonly additionalProperties: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {};
                                    };
                                };
                                readonly summaryModel: {
                                    readonly type: "string";
                                };
                                readonly modelOverrides: {
                                    readonly type: "object";
                                    readonly propertyNames: {
                                        readonly type: "string";
                                    };
                                    readonly additionalProperties: {};
                                };
                                readonly providers: {
                                    readonly type: "object";
                                    readonly propertyNames: {
                                        readonly type: "string";
                                    };
                                    readonly additionalProperties: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {};
                                    };
                                };
                                readonly prefsPath: {
                                    readonly type: "string";
                                };
                                readonly maxTextLength: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly timeoutMs: {
                                    readonly type: "integer";
                                    readonly minimum: 1000;
                                    readonly maximum: 120000;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly groupSessionScope: {
                            readonly type: "string";
                            readonly enum: readonly ["group", "group_sender", "group_topic", "group_topic_sender"];
                        };
                        readonly topicSessionMode: {
                            readonly type: "string";
                            readonly enum: readonly ["disabled", "enabled"];
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
        };
        readonly required: readonly ["domain", "connectionMode", "webhookPath", "dmPolicy", "groupPolicy", "reactionNotifications", "typingIndicator", "resolveSenderNames"];
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "googlechat";
    readonly channelId: "googlechat";
    readonly label: "Google Chat";
    readonly description: "Google Workspace Chat app with HTTP webhook.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly allowBots: {
                readonly type: "boolean";
            };
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly requireMention: {
                readonly type: "boolean";
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly serviceAccount: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly type: "object";
                    readonly propertyNames: {
                        readonly type: "string";
                    };
                    readonly additionalProperties: {};
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly serviceAccountRef: {
                readonly oneOf: readonly [{
                    readonly type: "object";
                    readonly properties: {
                        readonly source: {
                            readonly type: "string";
                            readonly const: "env";
                        };
                        readonly provider: {
                            readonly type: "string";
                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                        };
                        readonly id: {
                            readonly type: "string";
                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                        };
                    };
                    readonly required: readonly ["source", "provider", "id"];
                    readonly additionalProperties: false;
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly source: {
                            readonly type: "string";
                            readonly const: "file";
                        };
                        readonly provider: {
                            readonly type: "string";
                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                        };
                        readonly id: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["source", "provider", "id"];
                    readonly additionalProperties: false;
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly source: {
                            readonly type: "string";
                            readonly const: "exec";
                        };
                        readonly provider: {
                            readonly type: "string";
                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                        };
                        readonly id: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["source", "provider", "id"];
                    readonly additionalProperties: false;
                }];
            };
            readonly serviceAccountFile: {
                readonly type: "string";
            };
            readonly audienceType: {
                readonly type: "string";
                readonly enum: readonly ["app-url", "project-number"];
            };
            readonly audience: {
                readonly type: "string";
            };
            readonly appPrincipal: {
                readonly type: "string";
            };
            readonly webhookPath: {
                readonly type: "string";
            };
            readonly webhookUrl: {
                readonly type: "string";
            };
            readonly botUser: {
                readonly type: "string";
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly replyToMode: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly const: "off";
                }, {
                    readonly type: "string";
                    readonly const: "first";
                }, {
                    readonly type: "string";
                    readonly const: "all";
                }, {
                    readonly type: "string";
                    readonly const: "batched";
                }];
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly dm: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly policy: {
                        readonly default: "pairing";
                        readonly type: "string";
                        readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                    };
                    readonly allowFrom: {
                        readonly type: "array";
                        readonly items: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                    };
                };
                readonly required: readonly ["policy"];
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly typingIndicator: {
                readonly type: "string";
                readonly enum: readonly ["none", "message", "reaction"];
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly capabilities: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly allowBots: {
                            readonly type: "boolean";
                        };
                        readonly dangerouslyAllowNameMatching: {
                            readonly type: "boolean";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly users: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly defaultTo: {
                            readonly type: "string";
                        };
                        readonly serviceAccount: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "object";
                                readonly propertyNames: {
                                    readonly type: "string";
                                };
                                readonly additionalProperties: {};
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly serviceAccountRef: {
                            readonly oneOf: readonly [{
                                readonly type: "object";
                                readonly properties: {
                                    readonly source: {
                                        readonly type: "string";
                                        readonly const: "env";
                                    };
                                    readonly provider: {
                                        readonly type: "string";
                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                    };
                                    readonly id: {
                                        readonly type: "string";
                                        readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                    };
                                };
                                readonly required: readonly ["source", "provider", "id"];
                                readonly additionalProperties: false;
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly source: {
                                        readonly type: "string";
                                        readonly const: "file";
                                    };
                                    readonly provider: {
                                        readonly type: "string";
                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                    };
                                    readonly id: {
                                        readonly type: "string";
                                    };
                                };
                                readonly required: readonly ["source", "provider", "id"];
                                readonly additionalProperties: false;
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly source: {
                                        readonly type: "string";
                                        readonly const: "exec";
                                    };
                                    readonly provider: {
                                        readonly type: "string";
                                        readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                    };
                                    readonly id: {
                                        readonly type: "string";
                                    };
                                };
                                readonly required: readonly ["source", "provider", "id"];
                                readonly additionalProperties: false;
                            }];
                        };
                        readonly serviceAccountFile: {
                            readonly type: "string";
                        };
                        readonly audienceType: {
                            readonly type: "string";
                            readonly enum: readonly ["app-url", "project-number"];
                        };
                        readonly audience: {
                            readonly type: "string";
                        };
                        readonly appPrincipal: {
                            readonly type: "string";
                        };
                        readonly webhookPath: {
                            readonly type: "string";
                        };
                        readonly webhookUrl: {
                            readonly type: "string";
                        };
                        readonly botUser: {
                            readonly type: "string";
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly minChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly idleMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                            readonly exclusiveMinimum: 0;
                        };
                        readonly replyToMode: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly const: "off";
                            }, {
                                readonly type: "string";
                                readonly const: "first";
                            }, {
                                readonly type: "string";
                                readonly const: "all";
                            }, {
                                readonly type: "string";
                                readonly const: "batched";
                            }];
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly dm: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly policy: {
                                    readonly default: "pairing";
                                    readonly type: "string";
                                    readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                                };
                                readonly allowFrom: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                        }, {
                                            readonly type: "number";
                                        }];
                                    };
                                };
                            };
                            readonly required: readonly ["policy"];
                            readonly additionalProperties: false;
                        };
                        readonly healthMonitor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly typingIndicator: {
                            readonly type: "string";
                            readonly enum: readonly ["none", "message", "reaction"];
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["groupPolicy"];
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "imessage";
    readonly channelId: "imessage";
    readonly label: "iMessage";
    readonly description: "this is still a work in progress.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly cliPath: {
                readonly type: "string";
            };
            readonly dbPath: {
                readonly type: "string";
            };
            readonly remoteHost: {
                readonly type: "string";
            };
            readonly service: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly const: "imessage";
                }, {
                    readonly type: "string";
                    readonly const: "sms";
                }, {
                    readonly type: "string";
                    readonly const: "auto";
                }];
            };
            readonly region: {
                readonly type: "string";
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly includeAttachments: {
                readonly type: "boolean";
            };
            readonly attachmentRoots: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly remoteAttachmentRoots: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly mediaMaxMb: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly showOk: {
                        readonly type: "boolean";
                    };
                    readonly showAlerts: {
                        readonly type: "boolean";
                    };
                    readonly useIndicator: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly capabilities: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly cliPath: {
                            readonly type: "string";
                        };
                        readonly dbPath: {
                            readonly type: "string";
                        };
                        readonly remoteHost: {
                            readonly type: "string";
                        };
                        readonly service: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly const: "imessage";
                            }, {
                                readonly type: "string";
                                readonly const: "sms";
                            }, {
                                readonly type: "string";
                                readonly const: "auto";
                            }];
                        };
                        readonly region: {
                            readonly type: "string";
                        };
                        readonly dmPolicy: {
                            readonly default: "pairing";
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly defaultTo: {
                            readonly type: "string";
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly includeAttachments: {
                            readonly type: "boolean";
                        };
                        readonly attachmentRoots: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly remoteAttachmentRoots: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly mediaMaxMb: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly minChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly idleMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly showOk: {
                                    readonly type: "boolean";
                                };
                                readonly showAlerts: {
                                    readonly type: "boolean";
                                };
                                readonly useIndicator: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly healthMonitor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["dmPolicy", "groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "iMessage";
            readonly help: "iMessage channel provider configuration for CLI integration and DM access policy handling. Use explicit CLI paths when runtime environments have non-standard binary locations.";
        };
        readonly dmPolicy: {
            readonly label: "iMessage DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.imessage.allowFrom=["*"].';
        };
        readonly configWrites: {
            readonly label: "iMessage Config Writes";
            readonly help: "Allow iMessage to write config in response to channel events/commands (default: true).";
        };
        readonly cliPath: {
            readonly label: "iMessage CLI Path";
            readonly help: "Filesystem path to the iMessage bridge CLI binary used for send/receive operations. Set explicitly when the binary is not on PATH in service runtime environments.";
        };
    };
}, {
    readonly pluginId: "irc";
    readonly channelId: "irc";
    readonly label: "IRC";
    readonly description: "classic IRC networks with DM/channel routing and pairing controls.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly host: {
                readonly type: "string";
            };
            readonly port: {
                readonly type: "integer";
                readonly minimum: 1;
                readonly maximum: 65535;
            };
            readonly tls: {
                readonly type: "boolean";
            };
            readonly nick: {
                readonly type: "string";
            };
            readonly username: {
                readonly type: "string";
            };
            readonly realname: {
                readonly type: "string";
            };
            readonly password: {
                readonly type: "string";
            };
            readonly passwordFile: {
                readonly type: "string";
            };
            readonly nickserv: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly service: {
                        readonly type: "string";
                    };
                    readonly password: {
                        readonly type: "string";
                    };
                    readonly passwordFile: {
                        readonly type: "string";
                    };
                    readonly register: {
                        readonly type: "boolean";
                    };
                    readonly registerEmail: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly channels: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly mentionPatterns: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly dangerouslyAllowNameMatching: {
                            readonly type: "boolean";
                        };
                        readonly host: {
                            readonly type: "string";
                        };
                        readonly port: {
                            readonly type: "integer";
                            readonly minimum: 1;
                            readonly maximum: 65535;
                        };
                        readonly tls: {
                            readonly type: "boolean";
                        };
                        readonly nick: {
                            readonly type: "string";
                        };
                        readonly username: {
                            readonly type: "string";
                        };
                        readonly realname: {
                            readonly type: "string";
                        };
                        readonly password: {
                            readonly type: "string";
                        };
                        readonly passwordFile: {
                            readonly type: "string";
                        };
                        readonly nickserv: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly service: {
                                    readonly type: "string";
                                };
                                readonly password: {
                                    readonly type: "string";
                                };
                                readonly passwordFile: {
                                    readonly type: "string";
                                };
                                readonly register: {
                                    readonly type: "boolean";
                                };
                                readonly registerEmail: {
                                    readonly type: "string";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly dmPolicy: {
                            readonly default: "pairing";
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly channels: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly mentionPatterns: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly minChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly idleMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                            readonly exclusiveMinimum: 0;
                        };
                    };
                    readonly required: readonly ["dmPolicy", "groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "IRC";
            readonly help: "IRC channel provider configuration and compatibility settings for classic IRC transport workflows. Use this section when bridging legacy chat infrastructure into OpenClaw.";
        };
        readonly dmPolicy: {
            readonly label: "IRC DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.irc.allowFrom=["*"].';
        };
        readonly "nickserv.enabled": {
            readonly label: "IRC NickServ Enabled";
            readonly help: "Enable NickServ identify/register after connect (defaults to enabled when password is configured).";
        };
        readonly "nickserv.service": {
            readonly label: "IRC NickServ Service";
            readonly help: "NickServ service nick (default: NickServ).";
        };
        readonly "nickserv.password": {
            readonly label: "IRC NickServ Password";
            readonly help: "NickServ password used for IDENTIFY/REGISTER (sensitive).";
        };
        readonly "nickserv.passwordFile": {
            readonly label: "IRC NickServ Password File";
            readonly help: "Optional file path containing NickServ password.";
        };
        readonly "nickserv.register": {
            readonly label: "IRC NickServ Register";
            readonly help: "If true, send NickServ REGISTER on every connect. Use once for initial registration, then disable.";
        };
        readonly "nickserv.registerEmail": {
            readonly label: "IRC NickServ Register Email";
            readonly help: "Email used with NickServ REGISTER (required when register=true).";
        };
        readonly configWrites: {
            readonly label: "IRC Config Writes";
            readonly help: "Allow IRC to write config in response to channel events/commands (default: true).";
        };
    };
}, {
    readonly pluginId: "line";
    readonly channelId: "line";
    readonly label: "LINE";
    readonly description: "LINE Messaging API webhook bot.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly channelAccessToken: {
                readonly type: "string";
            };
            readonly channelSecret: {
                readonly type: "string";
            };
            readonly tokenFile: {
                readonly type: "string";
            };
            readonly secretFile: {
                readonly type: "string";
            };
            readonly name: {
                readonly type: "string";
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["open", "allowlist", "pairing", "disabled"];
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "allowlist", "disabled"];
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly mediaMaxMb: {
                readonly type: "number";
            };
            readonly webhookPath: {
                readonly type: "string";
            };
            readonly threadBindings: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly idleHours: {
                        readonly type: "number";
                    };
                    readonly maxAgeHours: {
                        readonly type: "number";
                    };
                    readonly spawnSessions: {
                        readonly type: "boolean";
                    };
                    readonly defaultSpawnContext: {
                        readonly type: "string";
                        readonly enum: readonly ["isolated", "fork"];
                    };
                    readonly spawnSubagentSessions: {
                        readonly type: "boolean";
                    };
                    readonly spawnAcpSessions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly channelAccessToken: {
                            readonly type: "string";
                        };
                        readonly channelSecret: {
                            readonly type: "string";
                        };
                        readonly tokenFile: {
                            readonly type: "string";
                        };
                        readonly secretFile: {
                            readonly type: "string";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly dmPolicy: {
                            readonly default: "pairing";
                            readonly type: "string";
                            readonly enum: readonly ["open", "allowlist", "pairing", "disabled"];
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "allowlist", "disabled"];
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                        };
                        readonly webhookPath: {
                            readonly type: "string";
                        };
                        readonly threadBindings: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly idleHours: {
                                    readonly type: "number";
                                };
                                readonly maxAgeHours: {
                                    readonly type: "number";
                                };
                                readonly spawnSessions: {
                                    readonly type: "boolean";
                                };
                                readonly defaultSpawnContext: {
                                    readonly type: "string";
                                    readonly enum: readonly ["isolated", "fork"];
                                };
                                readonly spawnSubagentSessions: {
                                    readonly type: "boolean";
                                };
                                readonly spawnAcpSessions: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                    };
                    readonly required: readonly ["dmPolicy", "groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "matrix";
    readonly channelId: "matrix";
    readonly label: "Matrix";
    readonly description: "open protocol; install the plugin to enable.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {};
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly homeserver: {
                readonly type: "string";
            };
            readonly network: {
                readonly type: "object";
                readonly properties: {
                    readonly dangerouslyAllowPrivateNetwork: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly proxy: {
                readonly type: "string";
            };
            readonly userId: {
                readonly type: "string";
            };
            readonly accessToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly password: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly deviceId: {
                readonly type: "string";
            };
            readonly deviceName: {
                readonly type: "string";
            };
            readonly avatarUrl: {
                readonly type: "string";
            };
            readonly initialSyncLimit: {
                readonly type: "number";
            };
            readonly encryption: {
                readonly type: "boolean";
            };
            readonly allowlistOnly: {
                readonly type: "boolean";
            };
            readonly allowBots: {
                readonly anyOf: readonly [{
                    readonly type: "boolean";
                }, {
                    readonly type: "string";
                    readonly const: "mentions";
                }];
            };
            readonly groupPolicy: {
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly streaming: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly enum: readonly ["partial", "quiet", "progress", "off"];
                }, {
                    readonly type: "boolean";
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly mode: {
                            readonly type: "string";
                            readonly enum: readonly ["partial", "quiet", "progress", "off"];
                        };
                        readonly progress: {
                            readonly type: "object";
                            readonly properties: {
                                readonly label: {
                                    readonly anyOf: readonly [{
                                        readonly type: "string";
                                    }, {
                                        readonly type: "boolean";
                                        readonly const: false;
                                    }];
                                };
                                readonly labels: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly maxLines: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly toolProgress: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly preview: {
                            readonly type: "object";
                            readonly properties: {
                                readonly toolProgress: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                    readonly additionalProperties: false;
                }];
            };
            readonly replyToMode: {
                readonly type: "string";
                readonly enum: readonly ["off", "first", "all", "batched"];
            };
            readonly threadReplies: {
                readonly type: "string";
                readonly enum: readonly ["off", "inbound", "always"];
            };
            readonly textChunkLimit: {
                readonly type: "number";
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly ackReaction: {
                readonly type: "string";
            };
            readonly ackReactionScope: {
                readonly type: "string";
                readonly enum: readonly ["group-mentions", "group-all", "direct", "all", "none", "off"];
            };
            readonly reactionNotifications: {
                readonly type: "string";
                readonly enum: readonly ["off", "own"];
            };
            readonly threadBindings: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly idleHours: {
                        readonly type: "number";
                        readonly minimum: 0;
                    };
                    readonly maxAgeHours: {
                        readonly type: "number";
                        readonly minimum: 0;
                    };
                    readonly spawnSessions: {
                        readonly type: "boolean";
                    };
                    readonly defaultSpawnContext: {
                        readonly type: "string";
                        readonly enum: readonly ["isolated", "fork"];
                    };
                    readonly spawnSubagentSessions: {
                        readonly type: "boolean";
                    };
                    readonly spawnAcpSessions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly startupVerification: {
                readonly type: "string";
                readonly enum: readonly ["off", "if-unverified"];
            };
            readonly startupVerificationCooldownHours: {
                readonly type: "number";
            };
            readonly mediaMaxMb: {
                readonly type: "number";
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly autoJoin: {
                readonly type: "string";
                readonly enum: readonly ["always", "allowlist", "off"];
            };
            readonly autoJoinAllowlist: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly dm: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly policy: {
                        readonly type: "string";
                        readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                    };
                    readonly allowFrom: {
                        readonly type: "array";
                        readonly items: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                    };
                    readonly sessionScope: {
                        readonly type: "string";
                        readonly enum: readonly ["per-user", "per-room"];
                    };
                    readonly threadReplies: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "inbound", "always"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly execApprovals: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly approvers: {
                        readonly type: "array";
                        readonly items: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                    };
                    readonly agentFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly sessionFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly target: {
                        readonly type: "string";
                        readonly enum: readonly ["dm", "channel", "both"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly groups: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly account: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly allowBots: {
                            readonly anyOf: readonly [{
                                readonly type: "boolean";
                            }, {
                                readonly type: "string";
                                readonly const: "mentions";
                            }];
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly autoReply: {
                            readonly type: "boolean";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly rooms: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly account: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly allowBots: {
                            readonly anyOf: readonly [{
                                readonly type: "boolean";
                            }, {
                                readonly type: "string";
                                readonly const: "mentions";
                            }];
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly autoReply: {
                            readonly type: "boolean";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                    readonly messages: {
                        readonly type: "boolean";
                    };
                    readonly pins: {
                        readonly type: "boolean";
                    };
                    readonly profile: {
                        readonly type: "boolean";
                    };
                    readonly memberInfo: {
                        readonly type: "boolean";
                    };
                    readonly channelInfo: {
                        readonly type: "boolean";
                    };
                    readonly verification: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
        };
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "streaming.progress.label": {
            readonly label: "Matrix Progress Label";
            readonly help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.';
        };
        readonly "streaming.progress.labels": {
            readonly label: "Matrix Progress Label Pool";
            readonly help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.';
        };
        readonly "streaming.progress.maxLines": {
            readonly label: "Matrix Progress Max Lines";
            readonly help: "Maximum number of compact progress lines to keep below the draft label (default: 8).";
        };
        readonly "streaming.progress.toolProgress": {
            readonly label: "Matrix Progress Tool Lines";
            readonly help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.";
        };
        readonly "streaming.progress.commandText": {
            readonly label: "Matrix Progress Command Text";
            readonly help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
    };
}, {
    readonly pluginId: "mattermost";
    readonly channelId: "mattermost";
    readonly label: "Mattermost";
    readonly description: "self-hosted Slack-style chat; install the plugin to enable.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly botToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly baseUrl: {
                readonly type: "string";
            };
            readonly chatmode: {
                readonly type: "string";
                readonly enum: readonly ["oncall", "onmessage", "onchar"];
            };
            readonly oncharPrefixes: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly requireMention: {
                readonly type: "boolean";
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly streaming: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly enum: readonly ["off", "partial", "block", "progress"];
                }, {
                    readonly type: "boolean";
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly mode: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "partial", "block", "progress"];
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly preview: {
                            readonly type: "object";
                            readonly properties: {
                                readonly toolProgress: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly progress: {
                            readonly type: "object";
                            readonly properties: {
                                readonly label: {
                                    readonly anyOf: readonly [{
                                        readonly type: "string";
                                    }, {
                                        readonly type: "boolean";
                                        readonly const: false;
                                    }];
                                };
                                readonly labels: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly maxLines: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly toolProgress: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly block: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly coalesce: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly minChars: {
                                            readonly type: "integer";
                                            readonly exclusiveMinimum: 0;
                                            readonly maximum: 9007199254740991;
                                        };
                                        readonly maxChars: {
                                            readonly type: "integer";
                                            readonly exclusiveMinimum: 0;
                                            readonly maximum: 9007199254740991;
                                        };
                                        readonly idleMs: {
                                            readonly type: "integer";
                                            readonly minimum: 0;
                                            readonly maximum: 9007199254740991;
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                    readonly additionalProperties: false;
                }];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly replyToMode: {
                readonly type: "string";
                readonly enum: readonly ["off", "first", "all", "batched"];
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly commands: {
                readonly type: "object";
                readonly properties: {
                    readonly native: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                    readonly nativeSkills: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                    readonly callbackPath: {
                        readonly type: "string";
                    };
                    readonly callbackUrl: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly interactions: {
                readonly type: "object";
                readonly properties: {
                    readonly callbackBaseUrl: {
                        readonly type: "string";
                    };
                    readonly allowedSourceIps: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly network: {
                readonly type: "object";
                readonly properties: {
                    readonly dangerouslyAllowPrivateNetwork: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly dmChannelRetry: {
                readonly type: "object";
                readonly properties: {
                    readonly maxRetries: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 10;
                    };
                    readonly initialDelayMs: {
                        readonly type: "integer";
                        readonly minimum: 100;
                        readonly maximum: 60000;
                    };
                    readonly maxDelayMs: {
                        readonly type: "integer";
                        readonly minimum: 1000;
                        readonly maximum: 60000;
                    };
                    readonly timeoutMs: {
                        readonly type: "integer";
                        readonly minimum: 5000;
                        readonly maximum: 120000;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly capabilities: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly dangerouslyAllowNameMatching: {
                            readonly type: "boolean";
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly botToken: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly baseUrl: {
                            readonly type: "string";
                        };
                        readonly chatmode: {
                            readonly type: "string";
                            readonly enum: readonly ["oncall", "onmessage", "onchar"];
                        };
                        readonly oncharPrefixes: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly dmPolicy: {
                            readonly default: "pairing";
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly streaming: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly enum: readonly ["off", "partial", "block", "progress"];
                            }, {
                                readonly type: "boolean";
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly mode: {
                                        readonly type: "string";
                                        readonly enum: readonly ["off", "partial", "block", "progress"];
                                    };
                                    readonly chunkMode: {
                                        readonly type: "string";
                                        readonly enum: readonly ["length", "newline"];
                                    };
                                    readonly preview: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly toolProgress: {
                                                readonly type: "boolean";
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly progress: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly label: {
                                                readonly anyOf: readonly [{
                                                    readonly type: "string";
                                                }, {
                                                    readonly type: "boolean";
                                                    readonly const: false;
                                                }];
                                            };
                                            readonly labels: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly maxLines: {
                                                readonly type: "integer";
                                                readonly exclusiveMinimum: 0;
                                                readonly maximum: 9007199254740991;
                                            };
                                            readonly toolProgress: {
                                                readonly type: "boolean";
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly block: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly enabled: {
                                                readonly type: "boolean";
                                            };
                                            readonly coalesce: {
                                                readonly type: "object";
                                                readonly properties: {
                                                    readonly minChars: {
                                                        readonly type: "integer";
                                                        readonly exclusiveMinimum: 0;
                                                        readonly maximum: 9007199254740991;
                                                    };
                                                    readonly maxChars: {
                                                        readonly type: "integer";
                                                        readonly exclusiveMinimum: 0;
                                                        readonly maximum: 9007199254740991;
                                                    };
                                                    readonly idleMs: {
                                                        readonly type: "integer";
                                                        readonly minimum: 0;
                                                        readonly maximum: 9007199254740991;
                                                    };
                                                };
                                                readonly additionalProperties: false;
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                };
                                readonly additionalProperties: false;
                            }];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly minChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly idleMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly replyToMode: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "first", "all", "batched"];
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly commands: {
                            readonly type: "object";
                            readonly properties: {
                                readonly native: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                                readonly nativeSkills: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                                readonly callbackPath: {
                                    readonly type: "string";
                                };
                                readonly callbackUrl: {
                                    readonly type: "string";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly interactions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly callbackBaseUrl: {
                                    readonly type: "string";
                                };
                                readonly allowedSourceIps: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly network: {
                            readonly type: "object";
                            readonly properties: {
                                readonly dangerouslyAllowPrivateNetwork: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly dmChannelRetry: {
                            readonly type: "object";
                            readonly properties: {
                                readonly maxRetries: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 10;
                                };
                                readonly initialDelayMs: {
                                    readonly type: "integer";
                                    readonly minimum: 100;
                                    readonly maximum: 60000;
                                };
                                readonly maxDelayMs: {
                                    readonly type: "integer";
                                    readonly minimum: 1000;
                                    readonly maximum: 60000;
                                };
                                readonly timeoutMs: {
                                    readonly type: "integer";
                                    readonly minimum: 5000;
                                    readonly maximum: 120000;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                    readonly required: readonly ["dmPolicy", "groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "Mattermost";
            readonly help: "Mattermost channel provider configuration for bot auth, access policy, slash commands, and preview streaming.";
        };
        readonly dmPolicy: {
            readonly label: "Mattermost DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.mattermost.allowFrom=["*"].';
        };
        readonly streaming: {
            readonly label: "Mattermost Streaming Mode";
            readonly help: 'Unified Mattermost stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery.';
        };
        readonly "streaming.mode": {
            readonly label: "Mattermost Streaming Mode";
            readonly help: 'Canonical Mattermost preview mode: "off" | "partial" | "block" | "progress".';
        };
        readonly "streaming.progress.label": {
            readonly label: "Mattermost Progress Label";
            readonly help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.';
        };
        readonly "streaming.progress.labels": {
            readonly label: "Mattermost Progress Label Pool";
            readonly help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.';
        };
        readonly "streaming.progress.maxLines": {
            readonly label: "Mattermost Progress Max Lines";
            readonly help: "Maximum number of compact progress lines to keep below the draft label (default: 8).";
        };
        readonly "streaming.progress.toolProgress": {
            readonly label: "Mattermost Progress Tool Lines";
            readonly help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.";
        };
        readonly "streaming.progress.commandText": {
            readonly label: "Mattermost Progress Command Text";
            readonly help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "streaming.preview.toolProgress": {
            readonly label: "Mattermost Draft Tool Progress";
            readonly help: "Show tool/progress activity in the live draft preview post (default: true). Set false to hide interim tool updates while the draft preview stays active.";
        };
        readonly "streaming.preview.commandText": {
            readonly label: "Mattermost Draft Command Text";
            readonly help: 'Command/exec detail in preview tool-progress lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "streaming.block.enabled": {
            readonly label: "Mattermost Block Streaming Enabled";
            readonly help: 'Enable chunked block-style Mattermost preview delivery when channels.mattermost.streaming.mode="block".';
        };
        readonly "streaming.block.coalesce": {
            readonly label: "Mattermost Block Streaming Coalesce";
            readonly help: "Merge streamed Mattermost block replies before final delivery.";
        };
    };
}, {
    readonly pluginId: "msteams";
    readonly channelId: "msteams";
    readonly label: "Microsoft Teams";
    readonly description: "Teams SDK; enterprise support.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly appId: {
                readonly type: "string";
            };
            readonly appPassword: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly tenantId: {
                readonly type: "string";
            };
            readonly authType: {
                readonly type: "string";
                readonly enum: readonly ["secret", "federated"];
            };
            readonly certificatePath: {
                readonly type: "string";
            };
            readonly certificateThumbprint: {
                readonly type: "string";
            };
            readonly useManagedIdentity: {
                readonly type: "boolean";
            };
            readonly managedIdentityClientId: {
                readonly type: "string";
            };
            readonly webhook: {
                readonly type: "object";
                readonly properties: {
                    readonly port: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly path: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly streaming: {
                readonly type: "object";
                readonly properties: {
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "partial", "block", "progress"];
                    };
                    readonly chunkMode: {
                        readonly type: "string";
                        readonly enum: readonly ["length", "newline"];
                    };
                    readonly preview: {
                        readonly type: "object";
                        readonly properties: {
                            readonly chunk: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly breakPreference: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                            readonly const: "paragraph";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "newline";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "sentence";
                                        }];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly progress: {
                        readonly type: "object";
                        readonly properties: {
                            readonly label: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "boolean";
                                    readonly const: false;
                                }];
                            };
                            readonly labels: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                            readonly maxLines: {
                                readonly type: "integer";
                                readonly exclusiveMinimum: 0;
                                readonly maximum: 9007199254740991;
                            };
                            readonly render: {
                                readonly type: "string";
                                readonly enum: readonly ["text", "rich"];
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly block: {
                        readonly type: "object";
                        readonly properties: {
                            readonly enabled: {
                                readonly type: "boolean";
                            };
                            readonly coalesce: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly idleMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly additionalProperties: false;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly typingIndicator: {
                readonly type: "boolean";
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly mediaAllowHosts: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly mediaAuthAllowHosts: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly requireMention: {
                readonly type: "boolean";
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly replyStyle: {
                readonly type: "string";
                readonly enum: readonly ["thread", "top-level"];
            };
            readonly teams: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly replyStyle: {
                            readonly type: "string";
                            readonly enum: readonly ["thread", "top-level"];
                        };
                        readonly channels: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly replyStyle: {
                                        readonly type: "string";
                                        readonly enum: readonly ["thread", "top-level"];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly sharePointSiteId: {
                readonly type: "string";
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly showOk: {
                        readonly type: "boolean";
                    };
                    readonly showAlerts: {
                        readonly type: "boolean";
                    };
                    readonly useIndicator: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly welcomeCard: {
                readonly type: "boolean";
            };
            readonly promptStarters: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly groupWelcomeCard: {
                readonly type: "boolean";
            };
            readonly feedbackEnabled: {
                readonly type: "boolean";
            };
            readonly feedbackReflection: {
                readonly type: "boolean";
            };
            readonly feedbackReflectionCooldownMs: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly delegatedAuth: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly scopes: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly sso: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly connectionName: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "MS Teams";
            readonly help: "Microsoft Teams channel provider configuration and provider-specific policy toggles. Use this section to isolate Teams behavior from other enterprise chat providers.";
        };
        readonly configWrites: {
            readonly label: "MS Teams Config Writes";
            readonly help: "Allow Microsoft Teams to write config in response to channel events/commands (default: true).";
        };
        readonly streaming: {
            readonly label: "MS Teams Streaming";
            readonly help: 'Microsoft Teams preview/progress streaming mode: "off" | "partial" | "block" | "progress". Personal chats use Teams native streaminfo progress when available.';
        };
        readonly "streaming.progress.label": {
            readonly label: "MS Teams Progress Label";
            readonly help: 'Initial progress title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.';
        };
        readonly "streaming.progress.labels": {
            readonly label: "MS Teams Progress Label Pool";
            readonly help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.';
        };
        readonly "streaming.progress.maxLines": {
            readonly label: "MS Teams Progress Max Lines";
            readonly help: "Maximum number of compact progress lines to keep below the progress title (default: 8).";
        };
        readonly "streaming.progress.toolProgress": {
            readonly label: "MS Teams Progress Tool Lines";
            readonly help: "Show compact tool/progress lines in progress mode (default: true). Set false to keep only the title until final delivery.";
        };
        readonly "streaming.progress.commandText": {
            readonly label: "MS Teams Progress Command Text";
            readonly help: 'Command/exec detail in progress lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
    };
}, {
    readonly pluginId: "nextcloud-talk";
    readonly channelId: "nextcloud-talk";
    readonly label: "Nextcloud Talk";
    readonly description: "Self-hosted chat via Nextcloud Talk webhook bots.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly baseUrl: {
                readonly type: "string";
            };
            readonly botSecret: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly botSecretFile: {
                readonly type: "string";
            };
            readonly apiUser: {
                readonly type: "string";
            };
            readonly apiPassword: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly apiPasswordFile: {
                readonly type: "string";
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly webhookPort: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly webhookHost: {
                readonly type: "string";
            };
            readonly webhookPath: {
                readonly type: "string";
            };
            readonly webhookPublicUrl: {
                readonly type: "string";
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly rooms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly network: {
                readonly type: "object";
                readonly properties: {
                    readonly dangerouslyAllowPrivateNetwork: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly baseUrl: {
                            readonly type: "string";
                        };
                        readonly botSecret: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly botSecretFile: {
                            readonly type: "string";
                        };
                        readonly apiUser: {
                            readonly type: "string";
                        };
                        readonly apiPassword: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly apiPasswordFile: {
                            readonly type: "string";
                        };
                        readonly dmPolicy: {
                            readonly default: "pairing";
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly webhookPort: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly webhookHost: {
                            readonly type: "string";
                        };
                        readonly webhookPath: {
                            readonly type: "string";
                        };
                        readonly webhookPublicUrl: {
                            readonly type: "string";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly rooms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly network: {
                            readonly type: "object";
                            readonly properties: {
                                readonly dangerouslyAllowPrivateNetwork: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly minChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly idleMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                            readonly exclusiveMinimum: 0;
                        };
                    };
                    readonly required: readonly ["dmPolicy", "groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "nostr";
    readonly channelId: "nostr";
    readonly label: "Nostr";
    readonly description: "Decentralized protocol; encrypted DMs via NIP-04.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly privateKey: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly relays: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly dmPolicy: {
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly profile: {
                readonly type: "object";
                readonly properties: {
                    readonly name: {
                        readonly type: "string";
                        readonly maxLength: 256;
                    };
                    readonly displayName: {
                        readonly type: "string";
                        readonly maxLength: 256;
                    };
                    readonly about: {
                        readonly type: "string";
                        readonly maxLength: 2000;
                    };
                    readonly picture: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly banner: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly website: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly nip05: {
                        readonly type: "string";
                    };
                    readonly lud16: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "qa-channel";
    readonly channelId: "qa-channel";
    readonly label: "QA Channel";
    readonly description: "Synthetic Slack-class transport for automated OpenClaw QA scenarios.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly baseUrl: {
                readonly type: "string";
                readonly format: "uri";
            };
            readonly botUserId: {
                readonly type: "string";
            };
            readonly botDisplayName: {
                readonly type: "string";
            };
            readonly pollTimeoutMs: {
                readonly type: "integer";
                readonly minimum: 100;
                readonly maximum: 30000;
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly type: "string";
                readonly enum: readonly ["open", "allowlist", "disabled"];
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly messages: {
                        readonly type: "boolean";
                    };
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                    readonly search: {
                        readonly type: "boolean";
                    };
                    readonly threads: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly baseUrl: {
                            readonly type: "string";
                            readonly format: "uri";
                        };
                        readonly botUserId: {
                            readonly type: "string";
                        };
                        readonly botDisplayName: {
                            readonly type: "string";
                        };
                        readonly pollTimeoutMs: {
                            readonly type: "integer";
                            readonly minimum: 100;
                            readonly maximum: 30000;
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "allowlist", "disabled"];
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly defaultTo: {
                            readonly type: "string";
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly messages: {
                                    readonly type: "boolean";
                                };
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                                readonly search: {
                                    readonly type: "boolean";
                                };
                                readonly threads: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "qqbot";
    readonly channelId: "qqbot";
    readonly label: "QQ Bot";
    readonly description: "connect to QQ via official QQ Bot API with group chat and direct message support.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly name: {
                readonly type: "string";
            };
            readonly appId: {
                readonly type: "string";
            };
            readonly clientSecret: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly clientSecretFile: {
                readonly type: "string";
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly dmPolicy: {
                readonly type: "string";
                readonly enum: readonly ["open", "allowlist", "disabled"];
            };
            readonly groupPolicy: {
                readonly type: "string";
                readonly enum: readonly ["open", "allowlist", "disabled"];
            };
            readonly systemPrompt: {
                readonly type: "string";
            };
            readonly markdownSupport: {
                readonly type: "boolean";
            };
            readonly voiceDirectUploadFormats: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly audioFormatPolicy: {
                readonly type: "object";
                readonly properties: {
                    readonly sttDirectFormats: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly uploadDirectFormats: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly transcodeEnabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly urlDirectUpload: {
                readonly type: "boolean";
            };
            readonly upgradeUrl: {
                readonly type: "string";
            };
            readonly upgradeMode: {
                readonly type: "string";
                readonly enum: readonly ["doc", "hot-reload"];
            };
            readonly streaming: {
                readonly anyOf: readonly [{
                    readonly type: "boolean";
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly mode: {
                            readonly default: "partial";
                            readonly type: "string";
                            readonly enum: readonly ["off", "partial"];
                        };
                        readonly c2cStreamApi: {
                            readonly type: "boolean";
                        };
                    };
                    readonly required: readonly ["mode"];
                    readonly additionalProperties: {};
                }];
            };
            readonly execApprovals: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                    readonly approvers: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly agentFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly sessionFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly target: {
                        readonly type: "string";
                        readonly enum: readonly ["dm", "channel", "both"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly stt: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly provider: {
                        readonly type: "string";
                    };
                    readonly baseUrl: {
                        readonly type: "string";
                    };
                    readonly apiKey: {
                        readonly type: "string";
                    };
                    readonly model: {
                        readonly type: "string";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly accounts: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly appId: {
                            readonly type: "string";
                        };
                        readonly clientSecret: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly clientSecretFile: {
                            readonly type: "string";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "allowlist", "disabled"];
                        };
                        readonly groupPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "allowlist", "disabled"];
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                        readonly markdownSupport: {
                            readonly type: "boolean";
                        };
                        readonly voiceDirectUploadFormats: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly audioFormatPolicy: {
                            readonly type: "object";
                            readonly properties: {
                                readonly sttDirectFormats: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly uploadDirectFormats: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly transcodeEnabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly urlDirectUpload: {
                            readonly type: "boolean";
                        };
                        readonly upgradeUrl: {
                            readonly type: "string";
                        };
                        readonly upgradeMode: {
                            readonly type: "string";
                            readonly enum: readonly ["doc", "hot-reload"];
                        };
                        readonly streaming: {
                            readonly anyOf: readonly [{
                                readonly type: "boolean";
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly mode: {
                                        readonly default: "partial";
                                        readonly type: "string";
                                        readonly enum: readonly ["off", "partial"];
                                    };
                                    readonly c2cStreamApi: {
                                        readonly type: "boolean";
                                    };
                                };
                                readonly required: readonly ["mode"];
                                readonly additionalProperties: {};
                            }];
                        };
                        readonly execApprovals: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                                readonly approvers: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly agentFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly sessionFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly target: {
                                    readonly type: "string";
                                    readonly enum: readonly ["dm", "channel", "both"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                    readonly additionalProperties: {};
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly additionalProperties: {};
    };
}, {
    readonly pluginId: "signal";
    readonly channelId: "signal";
    readonly label: "Signal";
    readonly description: 'signal-cli linked device; more setup (David Reagans: "Hop on Discord.").';
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly account: {
                readonly type: "string";
            };
            readonly accountUuid: {
                readonly type: "string";
            };
            readonly httpUrl: {
                readonly type: "string";
            };
            readonly httpHost: {
                readonly type: "string";
            };
            readonly httpPort: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly cliPath: {
                readonly type: "string";
            };
            readonly autoStart: {
                readonly type: "boolean";
            };
            readonly startupTimeoutMs: {
                readonly type: "integer";
                readonly minimum: 1000;
                readonly maximum: 120000;
            };
            readonly receiveMode: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly const: "on-start";
                }, {
                    readonly type: "string";
                    readonly const: "manual";
                }];
            };
            readonly ignoreAttachments: {
                readonly type: "boolean";
            };
            readonly ignoreStories: {
                readonly type: "boolean";
            };
            readonly sendReadReceipts: {
                readonly type: "boolean";
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly ingest: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly mediaMaxMb: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly reactionNotifications: {
                readonly type: "string";
                readonly enum: readonly ["off", "own", "all", "allowlist"];
            };
            readonly reactionAllowlist: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly reactionLevel: {
                readonly type: "string";
                readonly enum: readonly ["off", "ack", "minimal", "extensive"];
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly showOk: {
                        readonly type: "boolean";
                    };
                    readonly showAlerts: {
                        readonly type: "boolean";
                    };
                    readonly useIndicator: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly capabilities: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly account: {
                            readonly type: "string";
                        };
                        readonly accountUuid: {
                            readonly type: "string";
                        };
                        readonly httpUrl: {
                            readonly type: "string";
                        };
                        readonly httpHost: {
                            readonly type: "string";
                        };
                        readonly httpPort: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly cliPath: {
                            readonly type: "string";
                        };
                        readonly autoStart: {
                            readonly type: "boolean";
                        };
                        readonly startupTimeoutMs: {
                            readonly type: "integer";
                            readonly minimum: 1000;
                            readonly maximum: 120000;
                        };
                        readonly receiveMode: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly const: "on-start";
                            }, {
                                readonly type: "string";
                                readonly const: "manual";
                            }];
                        };
                        readonly ignoreAttachments: {
                            readonly type: "boolean";
                        };
                        readonly ignoreStories: {
                            readonly type: "boolean";
                        };
                        readonly sendReadReceipts: {
                            readonly type: "boolean";
                        };
                        readonly dmPolicy: {
                            readonly default: "pairing";
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly defaultTo: {
                            readonly type: "string";
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly ingest: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly minChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly idleMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly mediaMaxMb: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly reactionNotifications: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "own", "all", "allowlist"];
                        };
                        readonly reactionAllowlist: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly reactionLevel: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "ack", "minimal", "extensive"];
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly showOk: {
                                    readonly type: "boolean";
                                };
                                readonly showAlerts: {
                                    readonly type: "boolean";
                                };
                                readonly useIndicator: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly healthMonitor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["dmPolicy", "groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "Signal";
            readonly help: "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.";
        };
        readonly dmPolicy: {
            readonly label: "Signal DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].';
        };
        readonly configWrites: {
            readonly label: "Signal Config Writes";
            readonly help: "Allow Signal to write config in response to channel events/commands (default: true).";
        };
        readonly account: {
            readonly label: "Signal Account";
            readonly help: "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.";
        };
    };
}, {
    readonly pluginId: "slack";
    readonly channelId: "slack";
    readonly label: "Slack";
    readonly description: "supported (Socket Mode).";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly mode: {
                readonly default: "socket";
                readonly type: "string";
                readonly enum: readonly ["socket", "http"];
            };
            readonly socketMode: {
                readonly type: "object";
                readonly properties: {
                    readonly clientPingTimeout: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly serverPingTimeout: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly pingPongLoggingEnabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly signingSecret: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly webhookPath: {
                readonly default: "/slack/events";
                readonly type: "string";
            };
            readonly capabilities: {
                readonly anyOf: readonly [{
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly interactiveReplies: {
                            readonly type: "boolean";
                        };
                    };
                    readonly additionalProperties: false;
                }];
            };
            readonly execApprovals: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly approvers: {
                        readonly type: "array";
                        readonly items: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                    };
                    readonly agentFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly sessionFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly target: {
                        readonly type: "string";
                        readonly enum: readonly ["dm", "channel", "both"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly commands: {
                readonly type: "object";
                readonly properties: {
                    readonly native: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                    readonly nativeSkills: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly botToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly appToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly userToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly userTokenReadOnly: {
                readonly default: true;
                readonly type: "boolean";
            };
            readonly allowBots: {
                readonly type: "boolean";
            };
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly requireMention: {
                readonly type: "boolean";
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly streaming: {
                readonly type: "object";
                readonly properties: {
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "partial", "block", "progress"];
                    };
                    readonly chunkMode: {
                        readonly type: "string";
                        readonly enum: readonly ["length", "newline"];
                    };
                    readonly preview: {
                        readonly type: "object";
                        readonly properties: {
                            readonly chunk: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly breakPreference: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                            readonly const: "paragraph";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "newline";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "sentence";
                                        }];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly progress: {
                        readonly type: "object";
                        readonly properties: {
                            readonly label: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "boolean";
                                    readonly const: false;
                                }];
                            };
                            readonly labels: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                            readonly maxLines: {
                                readonly type: "integer";
                                readonly exclusiveMinimum: 0;
                                readonly maximum: 9007199254740991;
                            };
                            readonly render: {
                                readonly type: "string";
                                readonly enum: readonly ["text", "rich"];
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly block: {
                        readonly type: "object";
                        readonly properties: {
                            readonly enabled: {
                                readonly type: "boolean";
                            };
                            readonly coalesce: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly idleMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly nativeTransport: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly reactionNotifications: {
                readonly type: "string";
                readonly enum: readonly ["off", "own", "all", "allowlist"];
            };
            readonly reactionAllowlist: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly replyToMode: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly const: "off";
                }, {
                    readonly type: "string";
                    readonly const: "first";
                }, {
                    readonly type: "string";
                    readonly const: "all";
                }, {
                    readonly type: "string";
                    readonly const: "batched";
                }];
            };
            readonly replyToModeByChatType: {
                readonly type: "object";
                readonly properties: {
                    readonly direct: {
                        readonly anyOf: readonly [{
                            readonly type: "string";
                            readonly const: "off";
                        }, {
                            readonly type: "string";
                            readonly const: "first";
                        }, {
                            readonly type: "string";
                            readonly const: "all";
                        }, {
                            readonly type: "string";
                            readonly const: "batched";
                        }];
                    };
                    readonly group: {
                        readonly anyOf: readonly [{
                            readonly type: "string";
                            readonly const: "off";
                        }, {
                            readonly type: "string";
                            readonly const: "first";
                        }, {
                            readonly type: "string";
                            readonly const: "all";
                        }, {
                            readonly type: "string";
                            readonly const: "batched";
                        }];
                    };
                    readonly channel: {
                        readonly anyOf: readonly [{
                            readonly type: "string";
                            readonly const: "off";
                        }, {
                            readonly type: "string";
                            readonly const: "first";
                        }, {
                            readonly type: "string";
                            readonly const: "all";
                        }, {
                            readonly type: "string";
                            readonly const: "batched";
                        }];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly thread: {
                readonly type: "object";
                readonly properties: {
                    readonly historyScope: {
                        readonly type: "string";
                        readonly enum: readonly ["thread", "channel"];
                    };
                    readonly inheritParent: {
                        readonly type: "boolean";
                    };
                    readonly initialHistoryLimit: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly requireExplicitMention: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                    readonly messages: {
                        readonly type: "boolean";
                    };
                    readonly pins: {
                        readonly type: "boolean";
                    };
                    readonly search: {
                        readonly type: "boolean";
                    };
                    readonly permissions: {
                        readonly type: "boolean";
                    };
                    readonly memberInfo: {
                        readonly type: "boolean";
                    };
                    readonly channelInfo: {
                        readonly type: "boolean";
                    };
                    readonly emojiList: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly slashCommand: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly name: {
                        readonly type: "string";
                    };
                    readonly sessionPrefix: {
                        readonly type: "string";
                    };
                    readonly ephemeral: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly dmPolicy: {
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly dm: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly policy: {
                        readonly type: "string";
                        readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                    };
                    readonly allowFrom: {
                        readonly type: "array";
                        readonly items: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                    };
                    readonly groupEnabled: {
                        readonly type: "boolean";
                    };
                    readonly groupChannels: {
                        readonly type: "array";
                        readonly items: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                    };
                    readonly replyToMode: {
                        readonly anyOf: readonly [{
                            readonly type: "string";
                            readonly const: "off";
                        }, {
                            readonly type: "string";
                            readonly const: "first";
                        }, {
                            readonly type: "string";
                            readonly const: "all";
                        }, {
                            readonly type: "string";
                            readonly const: "batched";
                        }];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly channels: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly allowBots: {
                            readonly type: "boolean";
                        };
                        readonly users: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly showOk: {
                        readonly type: "boolean";
                    };
                    readonly showAlerts: {
                        readonly type: "boolean";
                    };
                    readonly useIndicator: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly ackReaction: {
                readonly type: "string";
            };
            readonly typingReaction: {
                readonly type: "string";
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly mode: {
                            readonly type: "string";
                            readonly enum: readonly ["socket", "http"];
                        };
                        readonly socketMode: {
                            readonly type: "object";
                            readonly properties: {
                                readonly clientPingTimeout: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly serverPingTimeout: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly pingPongLoggingEnabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly signingSecret: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly webhookPath: {
                            readonly type: "string";
                        };
                        readonly capabilities: {
                            readonly anyOf: readonly [{
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly interactiveReplies: {
                                        readonly type: "boolean";
                                    };
                                };
                                readonly additionalProperties: false;
                            }];
                        };
                        readonly execApprovals: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly approvers: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                        }, {
                                            readonly type: "number";
                                        }];
                                    };
                                };
                                readonly agentFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly sessionFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly target: {
                                    readonly type: "string";
                                    readonly enum: readonly ["dm", "channel", "both"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly commands: {
                            readonly type: "object";
                            readonly properties: {
                                readonly native: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                                readonly nativeSkills: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly botToken: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly appToken: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly userToken: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly userTokenReadOnly: {
                            readonly default: true;
                            readonly type: "boolean";
                        };
                        readonly allowBots: {
                            readonly type: "boolean";
                        };
                        readonly dangerouslyAllowNameMatching: {
                            readonly type: "boolean";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly groupPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly streaming: {
                            readonly type: "object";
                            readonly properties: {
                                readonly mode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "partial", "block", "progress"];
                                };
                                readonly chunkMode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["length", "newline"];
                                };
                                readonly preview: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly chunk: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly minChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly maxChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly breakPreference: {
                                                    readonly anyOf: readonly [{
                                                        readonly type: "string";
                                                        readonly const: "paragraph";
                                                    }, {
                                                        readonly type: "string";
                                                        readonly const: "newline";
                                                    }, {
                                                        readonly type: "string";
                                                        readonly const: "sentence";
                                                    }];
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                        readonly toolProgress: {
                                            readonly type: "boolean";
                                        };
                                        readonly commandText: {
                                            readonly type: "string";
                                            readonly enum: readonly ["raw", "status"];
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                                readonly progress: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly label: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "boolean";
                                                readonly const: false;
                                            }];
                                        };
                                        readonly labels: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "string";
                                            };
                                        };
                                        readonly maxLines: {
                                            readonly type: "integer";
                                            readonly exclusiveMinimum: 0;
                                            readonly maximum: 9007199254740991;
                                        };
                                        readonly render: {
                                            readonly type: "string";
                                            readonly enum: readonly ["text", "rich"];
                                        };
                                        readonly toolProgress: {
                                            readonly type: "boolean";
                                        };
                                        readonly commandText: {
                                            readonly type: "string";
                                            readonly enum: readonly ["raw", "status"];
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                                readonly block: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly enabled: {
                                            readonly type: "boolean";
                                        };
                                        readonly coalesce: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly minChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly maxChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly idleMs: {
                                                    readonly type: "integer";
                                                    readonly minimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                                readonly nativeTransport: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                            readonly exclusiveMinimum: 0;
                        };
                        readonly reactionNotifications: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "own", "all", "allowlist"];
                        };
                        readonly reactionAllowlist: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly replyToMode: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly const: "off";
                            }, {
                                readonly type: "string";
                                readonly const: "first";
                            }, {
                                readonly type: "string";
                                readonly const: "all";
                            }, {
                                readonly type: "string";
                                readonly const: "batched";
                            }];
                        };
                        readonly replyToModeByChatType: {
                            readonly type: "object";
                            readonly properties: {
                                readonly direct: {
                                    readonly anyOf: readonly [{
                                        readonly type: "string";
                                        readonly const: "off";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "first";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "all";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "batched";
                                    }];
                                };
                                readonly group: {
                                    readonly anyOf: readonly [{
                                        readonly type: "string";
                                        readonly const: "off";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "first";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "all";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "batched";
                                    }];
                                };
                                readonly channel: {
                                    readonly anyOf: readonly [{
                                        readonly type: "string";
                                        readonly const: "off";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "first";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "all";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "batched";
                                    }];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly thread: {
                            readonly type: "object";
                            readonly properties: {
                                readonly historyScope: {
                                    readonly type: "string";
                                    readonly enum: readonly ["thread", "channel"];
                                };
                                readonly inheritParent: {
                                    readonly type: "boolean";
                                };
                                readonly initialHistoryLimit: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly requireExplicitMention: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                                readonly messages: {
                                    readonly type: "boolean";
                                };
                                readonly pins: {
                                    readonly type: "boolean";
                                };
                                readonly search: {
                                    readonly type: "boolean";
                                };
                                readonly permissions: {
                                    readonly type: "boolean";
                                };
                                readonly memberInfo: {
                                    readonly type: "boolean";
                                };
                                readonly channelInfo: {
                                    readonly type: "boolean";
                                };
                                readonly emojiList: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly slashCommand: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly name: {
                                    readonly type: "string";
                                };
                                readonly sessionPrefix: {
                                    readonly type: "string";
                                };
                                readonly ephemeral: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly defaultTo: {
                            readonly type: "string";
                        };
                        readonly dm: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly policy: {
                                    readonly type: "string";
                                    readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                                };
                                readonly allowFrom: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                        }, {
                                            readonly type: "number";
                                        }];
                                    };
                                };
                                readonly groupEnabled: {
                                    readonly type: "boolean";
                                };
                                readonly groupChannels: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                        }, {
                                            readonly type: "number";
                                        }];
                                    };
                                };
                                readonly replyToMode: {
                                    readonly anyOf: readonly [{
                                        readonly type: "string";
                                        readonly const: "off";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "first";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "all";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "batched";
                                    }];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly channels: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly allowBots: {
                                        readonly type: "boolean";
                                    };
                                    readonly users: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly showOk: {
                                    readonly type: "boolean";
                                };
                                readonly showAlerts: {
                                    readonly type: "boolean";
                                };
                                readonly useIndicator: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly healthMonitor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly ackReaction: {
                            readonly type: "string";
                        };
                        readonly typingReaction: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["userTokenReadOnly"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["mode", "webhookPath", "userTokenReadOnly", "groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "Slack";
            readonly help: "Slack channel provider configuration for bot/app tokens, streaming behavior, and DM policy controls. Keep token handling and thread behavior explicit to avoid noisy workspace interactions.";
        };
        readonly "dm.policy": {
            readonly label: "Slack DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"] (legacy: channels.slack.dm.allowFrom).';
        };
        readonly dmPolicy: {
            readonly label: "Slack DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"].';
        };
        readonly configWrites: {
            readonly label: "Slack Config Writes";
            readonly help: "Allow Slack to write config in response to channel events/commands (default: true).";
        };
        readonly "commands.native": {
            readonly label: "Slack Native Commands";
            readonly help: 'Override native commands for Slack (bool or "auto").';
        };
        readonly "commands.nativeSkills": {
            readonly label: "Slack Native Skill Commands";
            readonly help: 'Override native skill commands for Slack (bool or "auto").';
        };
        readonly allowBots: {
            readonly label: "Slack Allow Bot Messages";
            readonly help: "Allow bot-authored messages to trigger Slack replies (default: false).";
        };
        readonly socketMode: {
            readonly label: "Slack Socket Mode Transport";
            readonly help: "Slack Socket Mode transport tuning passed to the Slack SDK. Use only when investigating ping/pong timeout or stale websocket behavior.";
        };
        readonly "socketMode.clientPingTimeout": {
            readonly label: "Slack Socket Mode Pong Timeout";
            readonly help: "Milliseconds the Slack SDK waits for a pong after its client ping before treating the websocket as stale (OpenClaw default: 15000). Increase on hosts with event-loop starvation or slow network scheduling.";
        };
        readonly "socketMode.serverPingTimeout": {
            readonly label: "Slack Socket Mode Server Ping Timeout";
            readonly help: "Milliseconds the Slack SDK waits for Slack server pings before treating the websocket as stale.";
        };
        readonly "socketMode.pingPongLoggingEnabled": {
            readonly label: "Slack Socket Mode Ping/Pong Logging";
            readonly help: "Enable Slack SDK ping/pong transport logs while debugging Socket Mode websocket health.";
        };
        readonly botToken: {
            readonly label: "Slack Bot Token";
            readonly help: "Slack bot token used for standard chat actions in the configured workspace. Keep this credential scoped and rotate if workspace app permissions change.";
        };
        readonly appToken: {
            readonly label: "Slack App Token";
            readonly help: "Slack app-level token used for Socket Mode connections and event transport when enabled. Use least-privilege app scopes and store this token as a secret.";
        };
        readonly userToken: {
            readonly label: "Slack User Token";
            readonly help: "Optional Slack user token for workflows requiring user-context API access beyond bot permissions. Use sparingly and audit scopes because this token can carry broader authority.";
        };
        readonly userTokenReadOnly: {
            readonly label: "Slack User Token Read Only";
            readonly help: "When true, treat configured Slack user token usage as read-only helper behavior where possible. Keep enabled if you only need supplemental reads without user-context writes.";
        };
        readonly "capabilities.interactiveReplies": {
            readonly label: "Slack Interactive Replies";
            readonly help: "Enable agent-authored Slack interactive reply directives (`[[slack_buttons: ...]]`, `[[slack_select: ...]]`). Default: false.";
        };
        readonly execApprovals: {
            readonly label: "Slack Exec Approvals";
            readonly help: "Slack-native exec approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for this workspace account.";
        };
        readonly "execApprovals.enabled": {
            readonly label: "Slack Exec Approvals Enabled";
            readonly help: 'Controls Slack native exec approvals for this account: unset or "auto" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them.';
        };
        readonly "execApprovals.approvers": {
            readonly label: "Slack Exec Approval Approvers";
            readonly help: "Slack user IDs allowed to approve exec requests for this workspace account. Use Slack user IDs or user targets such as `U123`, `user:U123`, or `<@U123>`. If you leave this unset, OpenClaw falls back to commands.ownerAllowFrom when possible.";
        };
        readonly "execApprovals.agentFilter": {
            readonly label: "Slack Exec Approval Agent Filter";
            readonly help: 'Optional allowlist of agent IDs eligible for Slack exec approvals, for example `["main", "ops-agent"]`. Use this to keep approval prompts scoped to the agents you actually operate from Slack.';
        };
        readonly "execApprovals.sessionFilter": {
            readonly label: "Slack Exec Approval Session Filter";
            readonly help: "Optional session-key filters matched as substring or regex-style patterns before Slack approval routing is used. Use narrow patterns so Slack approvals only appear for intended sessions.";
        };
        readonly "execApprovals.target": {
            readonly label: "Slack Exec Approval Target";
            readonly help: 'Controls where Slack approval prompts are sent: "dm" sends to approver DMs (default), "channel" sends to the originating Slack chat/thread, and "both" sends to both. Channel delivery exposes the command text to the chat, so only use it in trusted channels.';
        };
        readonly streaming: {
            readonly label: "Slack Streaming Mode";
            readonly help: 'Unified Slack stream preview mode: "off" | "partial" | "block" | "progress". Legacy boolean/streamMode keys are auto-mapped.';
        };
        readonly "streaming.mode": {
            readonly label: "Slack Streaming Mode";
            readonly help: 'Canonical Slack preview mode: "off" | "partial" | "block" | "progress".';
        };
        readonly "streaming.chunkMode": {
            readonly label: "Slack Chunk Mode";
            readonly help: 'Chunking mode for outbound Slack text delivery: "length" (default) or "newline".';
        };
        readonly "streaming.block.enabled": {
            readonly label: "Slack Block Streaming Enabled";
            readonly help: 'Enable chunked block-style Slack preview delivery when channels.slack.streaming.mode="block".';
        };
        readonly "streaming.block.coalesce": {
            readonly label: "Slack Block Streaming Coalesce";
            readonly help: "Merge streamed Slack block replies before final delivery.";
        };
        readonly "streaming.nativeTransport": {
            readonly label: "Slack Native Streaming";
            readonly help: "Enable native Slack text streaming (chat.startStream/chat.appendStream/chat.stopStream) when channels.slack.streaming.mode is partial (default: true). Native streaming and Slack assistant thread status require a reply thread target; top-level DMs can still use draft post-and-edit preview streaming.";
        };
        readonly "streaming.preview.toolProgress": {
            readonly label: "Slack Draft Tool Progress";
            readonly help: "Show tool/progress activity in the live draft preview message (default: true). Set false to hide interim tool updates while the draft preview stays active.";
        };
        readonly "streaming.preview.commandText": {
            readonly label: "Slack Draft Command Text";
            readonly help: 'Command/exec detail in preview tool-progress lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "streaming.progress.label": {
            readonly label: "Slack Progress Label";
            readonly help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.';
        };
        readonly "streaming.progress.labels": {
            readonly label: "Slack Progress Label Pool";
            readonly help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.';
        };
        readonly "streaming.progress.maxLines": {
            readonly label: "Slack Progress Max Lines";
            readonly help: "Maximum number of compact progress lines to keep below the draft label (default: 8).";
        };
        readonly "streaming.progress.render": {
            readonly label: "Slack Progress Renderer";
            readonly help: 'Progress draft renderer: "text" uses one portable text body; "rich" renders structured Slack Block Kit fields with the same text fallback.';
        };
        readonly "streaming.progress.toolProgress": {
            readonly label: "Slack Progress Tool Lines";
            readonly help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.";
        };
        readonly "streaming.progress.commandText": {
            readonly label: "Slack Progress Command Text";
            readonly help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "thread.historyScope": {
            readonly label: "Slack Thread History Scope";
            readonly help: 'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).';
        };
        readonly "thread.inheritParent": {
            readonly label: "Slack Thread Parent Inheritance";
            readonly help: "If true, Slack thread sessions inherit the parent channel transcript (default: false).";
        };
        readonly "thread.initialHistoryLimit": {
            readonly label: "Slack Thread Initial History Limit";
            readonly help: "Maximum number of existing Slack thread messages to fetch when starting a new thread session (default: 20, set to 0 to disable).";
        };
        readonly "thread.requireExplicitMention": {
            readonly label: "Slack Thread Require Explicit Mention";
            readonly help: "If true, require an explicit @mention even inside threads where the bot has participated. Suppresses implicit thread mention behavior so the bot only responds to explicit @bot mentions in threads (default: false).";
        };
    };
}, {
    readonly pluginId: "synology-chat";
    readonly channelId: "synology-chat";
    readonly label: "Synology Chat";
    readonly description: "Connect your Synology NAS Chat to OpenClaw with full agent capabilities.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly dangerouslyAllowInheritedWebhookPath: {
                readonly type: "boolean";
            };
        };
        readonly additionalProperties: {};
    };
}, {
    readonly pluginId: "telegram";
    readonly channelId: "telegram";
    readonly label: "Telegram";
    readonly description: "simplest way to get started \u2014 register a bot with @BotFather and get going.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly capabilities: {
                readonly anyOf: readonly [{
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly inlineButtons: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "dm", "group", "all", "allowlist"];
                        };
                    };
                    readonly additionalProperties: false;
                }];
            };
            readonly execApprovals: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly approvers: {
                        readonly type: "array";
                        readonly items: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                    };
                    readonly agentFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly sessionFilter: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly target: {
                        readonly type: "string";
                        readonly enum: readonly ["dm", "channel", "both"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly commands: {
                readonly type: "object";
                readonly properties: {
                    readonly native: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                    readonly nativeSkills: {
                        readonly anyOf: readonly [{
                            readonly type: "boolean";
                        }, {
                            readonly type: "string";
                            readonly const: "auto";
                        }];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly customCommands: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly properties: {
                        readonly command: {
                            readonly type: "string";
                        };
                        readonly description: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["command", "description"];
                    readonly additionalProperties: false;
                };
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly botToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly tokenFile: {
                readonly type: "string";
            };
            readonly replyToMode: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly const: "off";
                }, {
                    readonly type: "string";
                    readonly const: "first";
                }, {
                    readonly type: "string";
                    readonly const: "all";
                }, {
                    readonly type: "string";
                    readonly const: "batched";
                }];
            };
            readonly dm: {
                readonly type: "object";
                readonly properties: {
                    readonly threadReplies: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "inbound", "always"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly ingest: {
                            readonly type: "boolean";
                        };
                        readonly disableAudioPreflight: {
                            readonly type: "boolean";
                        };
                        readonly groupPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                        readonly topics: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly ingest: {
                                        readonly type: "boolean";
                                    };
                                    readonly disableAudioPreflight: {
                                        readonly type: "boolean";
                                    };
                                    readonly groupPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["open", "disabled", "allowlist"];
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                    readonly agentId: {
                                        readonly type: "string";
                                    };
                                    readonly errorPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["always", "once", "silent"];
                                    };
                                    readonly errorCooldownMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly errorPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["always", "once", "silent"];
                        };
                        readonly errorCooldownMs: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly defaultTo: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly type: "number";
                }];
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly direct: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly threadReplies: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "inbound", "always"];
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly skills: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                        readonly topics: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly ingest: {
                                        readonly type: "boolean";
                                    };
                                    readonly disableAudioPreflight: {
                                        readonly type: "boolean";
                                    };
                                    readonly groupPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["open", "disabled", "allowlist"];
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                    readonly agentId: {
                                        readonly type: "string";
                                    };
                                    readonly errorPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["always", "once", "silent"];
                                    };
                                    readonly errorCooldownMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly errorPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["always", "once", "silent"];
                        };
                        readonly errorCooldownMs: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly requireTopic: {
                            readonly type: "boolean";
                        };
                        readonly autoTopicLabel: {
                            readonly anyOf: readonly [{
                                readonly type: "boolean";
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly prompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            }];
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly streaming: {
                readonly type: "object";
                readonly properties: {
                    readonly mode: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "partial", "block", "progress"];
                    };
                    readonly chunkMode: {
                        readonly type: "string";
                        readonly enum: readonly ["length", "newline"];
                    };
                    readonly preview: {
                        readonly type: "object";
                        readonly properties: {
                            readonly chunk: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly breakPreference: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                            readonly const: "paragraph";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "newline";
                                        }, {
                                            readonly type: "string";
                                            readonly const: "sentence";
                                        }];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly progress: {
                        readonly type: "object";
                        readonly properties: {
                            readonly label: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "boolean";
                                    readonly const: false;
                                }];
                            };
                            readonly labels: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                            readonly maxLines: {
                                readonly type: "integer";
                                readonly exclusiveMinimum: 0;
                                readonly maximum: 9007199254740991;
                            };
                            readonly render: {
                                readonly type: "string";
                                readonly enum: readonly ["text", "rich"];
                            };
                            readonly toolProgress: {
                                readonly type: "boolean";
                            };
                            readonly commandText: {
                                readonly type: "string";
                                readonly enum: readonly ["raw", "status"];
                            };
                        };
                        readonly additionalProperties: false;
                    };
                    readonly block: {
                        readonly type: "object";
                        readonly properties: {
                            readonly enabled: {
                                readonly type: "boolean";
                            };
                            readonly coalesce: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly minChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly maxChars: {
                                        readonly type: "integer";
                                        readonly exclusiveMinimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly idleMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly additionalProperties: false;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly mediaMaxMb: {
                readonly type: "number";
                readonly exclusiveMinimum: 0;
            };
            readonly timeoutSeconds: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly mediaGroupFlushMs: {
                readonly description: "Buffer window in milliseconds for Telegram media groups/albums before dispatching them as one inbound message. Default: 500.";
                readonly type: "integer";
                readonly minimum: 10;
                readonly maximum: 60000;
            };
            readonly pollingStallThresholdMs: {
                readonly type: "integer";
                readonly minimum: 30000;
                readonly maximum: 600000;
            };
            readonly retry: {
                readonly type: "object";
                readonly properties: {
                    readonly attempts: {
                        readonly type: "integer";
                        readonly minimum: 1;
                        readonly maximum: 9007199254740991;
                    };
                    readonly minDelayMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxDelayMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly jitter: {
                        readonly type: "number";
                        readonly minimum: 0;
                        readonly maximum: 1;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly network: {
                readonly type: "object";
                readonly properties: {
                    readonly autoSelectFamily: {
                        readonly type: "boolean";
                    };
                    readonly dnsResultOrder: {
                        readonly type: "string";
                        readonly enum: readonly ["ipv4first", "verbatim"];
                    };
                    readonly dangerouslyAllowPrivateNetwork: {
                        readonly description: "Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.";
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly proxy: {
                readonly type: "string";
            };
            readonly webhookUrl: {
                readonly description: "Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret.";
                readonly type: "string";
            };
            readonly webhookSecret: {
                readonly description: "Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.";
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly webhookPath: {
                readonly description: "Local webhook route path served by the gateway listener. Defaults to /telegram-webhook.";
                readonly type: "string";
            };
            readonly webhookHost: {
                readonly description: "Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress.";
                readonly type: "string";
            };
            readonly webhookPort: {
                readonly description: "Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port.";
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly webhookCertPath: {
                readonly description: "Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain).";
                readonly type: "string";
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                    readonly sendMessage: {
                        readonly type: "boolean";
                    };
                    readonly poll: {
                        readonly type: "boolean";
                    };
                    readonly deleteMessage: {
                        readonly type: "boolean";
                    };
                    readonly editMessage: {
                        readonly type: "boolean";
                    };
                    readonly sticker: {
                        readonly type: "boolean";
                    };
                    readonly createForumTopic: {
                        readonly type: "boolean";
                    };
                    readonly editForumTopic: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly threadBindings: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly idleHours: {
                        readonly type: "number";
                        readonly minimum: 0;
                    };
                    readonly maxAgeHours: {
                        readonly type: "number";
                        readonly minimum: 0;
                    };
                    readonly spawnSessions: {
                        readonly type: "boolean";
                    };
                    readonly defaultSpawnContext: {
                        readonly type: "string";
                        readonly enum: readonly ["isolated", "fork"];
                    };
                    readonly spawnSubagentSessions: {
                        readonly type: "boolean";
                    };
                    readonly spawnAcpSessions: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly reactionNotifications: {
                readonly type: "string";
                readonly enum: readonly ["off", "own", "all"];
            };
            readonly reactionLevel: {
                readonly type: "string";
                readonly enum: readonly ["off", "ack", "minimal", "extensive"];
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly showOk: {
                        readonly type: "boolean";
                    };
                    readonly showAlerts: {
                        readonly type: "boolean";
                    };
                    readonly useIndicator: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly linkPreview: {
                readonly type: "boolean";
            };
            readonly silentErrorReplies: {
                readonly type: "boolean";
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly ackReaction: {
                readonly type: "string";
            };
            readonly errorPolicy: {
                readonly type: "string";
                readonly enum: readonly ["always", "once", "silent"];
            };
            readonly errorCooldownMs: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly apiRoot: {
                readonly type: "string";
                readonly format: "uri";
            };
            readonly trustedLocalFileRoots: {
                readonly description: "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected.";
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly autoTopicLabel: {
                readonly anyOf: readonly [{
                    readonly type: "boolean";
                }, {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly prompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                }];
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly capabilities: {
                            readonly anyOf: readonly [{
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly inlineButtons: {
                                        readonly type: "string";
                                        readonly enum: readonly ["off", "dm", "group", "all", "allowlist"];
                                    };
                                };
                                readonly additionalProperties: false;
                            }];
                        };
                        readonly execApprovals: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly approvers: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly anyOf: readonly [{
                                            readonly type: "string";
                                        }, {
                                            readonly type: "number";
                                        }];
                                    };
                                };
                                readonly agentFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly sessionFilter: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly target: {
                                    readonly type: "string";
                                    readonly enum: readonly ["dm", "channel", "both"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly commands: {
                            readonly type: "object";
                            readonly properties: {
                                readonly native: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                                readonly nativeSkills: {
                                    readonly anyOf: readonly [{
                                        readonly type: "boolean";
                                    }, {
                                        readonly type: "string";
                                        readonly const: "auto";
                                    }];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly customCommands: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly command: {
                                        readonly type: "string";
                                    };
                                    readonly description: {
                                        readonly type: "string";
                                    };
                                };
                                readonly required: readonly ["command", "description"];
                                readonly additionalProperties: false;
                            };
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly dmPolicy: {
                            readonly default: "pairing";
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly botToken: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly tokenFile: {
                            readonly type: "string";
                        };
                        readonly replyToMode: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly const: "off";
                            }, {
                                readonly type: "string";
                                readonly const: "first";
                            }, {
                                readonly type: "string";
                                readonly const: "all";
                            }, {
                                readonly type: "string";
                                readonly const: "batched";
                            }];
                        };
                        readonly dm: {
                            readonly type: "object";
                            readonly properties: {
                                readonly threadReplies: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "inbound", "always"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly ingest: {
                                        readonly type: "boolean";
                                    };
                                    readonly disableAudioPreflight: {
                                        readonly type: "boolean";
                                    };
                                    readonly groupPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["open", "disabled", "allowlist"];
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                    readonly topics: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly requireMention: {
                                                    readonly type: "boolean";
                                                };
                                                readonly ingest: {
                                                    readonly type: "boolean";
                                                };
                                                readonly disableAudioPreflight: {
                                                    readonly type: "boolean";
                                                };
                                                readonly groupPolicy: {
                                                    readonly type: "string";
                                                    readonly enum: readonly ["open", "disabled", "allowlist"];
                                                };
                                                readonly skills: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly enabled: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowFrom: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly anyOf: readonly [{
                                                            readonly type: "string";
                                                        }, {
                                                            readonly type: "number";
                                                        }];
                                                    };
                                                };
                                                readonly systemPrompt: {
                                                    readonly type: "string";
                                                };
                                                readonly agentId: {
                                                    readonly type: "string";
                                                };
                                                readonly errorPolicy: {
                                                    readonly type: "string";
                                                    readonly enum: readonly ["always", "once", "silent"];
                                                };
                                                readonly errorCooldownMs: {
                                                    readonly type: "integer";
                                                    readonly minimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly errorPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["always", "once", "silent"];
                                    };
                                    readonly errorCooldownMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly defaultTo: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly type: "number";
                            }];
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly direct: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly dmPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                                    };
                                    readonly threadReplies: {
                                        readonly type: "string";
                                        readonly enum: readonly ["off", "inbound", "always"];
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly skills: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly allowFrom: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "number";
                                            }];
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                    readonly topics: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly requireMention: {
                                                    readonly type: "boolean";
                                                };
                                                readonly ingest: {
                                                    readonly type: "boolean";
                                                };
                                                readonly disableAudioPreflight: {
                                                    readonly type: "boolean";
                                                };
                                                readonly groupPolicy: {
                                                    readonly type: "string";
                                                    readonly enum: readonly ["open", "disabled", "allowlist"];
                                                };
                                                readonly skills: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly enabled: {
                                                    readonly type: "boolean";
                                                };
                                                readonly allowFrom: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly anyOf: readonly [{
                                                            readonly type: "string";
                                                        }, {
                                                            readonly type: "number";
                                                        }];
                                                    };
                                                };
                                                readonly systemPrompt: {
                                                    readonly type: "string";
                                                };
                                                readonly agentId: {
                                                    readonly type: "string";
                                                };
                                                readonly errorPolicy: {
                                                    readonly type: "string";
                                                    readonly enum: readonly ["always", "once", "silent"];
                                                };
                                                readonly errorCooldownMs: {
                                                    readonly type: "integer";
                                                    readonly minimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly errorPolicy: {
                                        readonly type: "string";
                                        readonly enum: readonly ["always", "once", "silent"];
                                    };
                                    readonly errorCooldownMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                    readonly requireTopic: {
                                        readonly type: "boolean";
                                    };
                                    readonly autoTopicLabel: {
                                        readonly anyOf: readonly [{
                                            readonly type: "boolean";
                                        }, {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly enabled: {
                                                    readonly type: "boolean";
                                                };
                                                readonly prompt: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        }];
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly streaming: {
                            readonly type: "object";
                            readonly properties: {
                                readonly mode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "partial", "block", "progress"];
                                };
                                readonly chunkMode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["length", "newline"];
                                };
                                readonly preview: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly chunk: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly minChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly maxChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly breakPreference: {
                                                    readonly anyOf: readonly [{
                                                        readonly type: "string";
                                                        readonly const: "paragraph";
                                                    }, {
                                                        readonly type: "string";
                                                        readonly const: "newline";
                                                    }, {
                                                        readonly type: "string";
                                                        readonly const: "sentence";
                                                    }];
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                        readonly toolProgress: {
                                            readonly type: "boolean";
                                        };
                                        readonly commandText: {
                                            readonly type: "string";
                                            readonly enum: readonly ["raw", "status"];
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                                readonly progress: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly label: {
                                            readonly anyOf: readonly [{
                                                readonly type: "string";
                                            }, {
                                                readonly type: "boolean";
                                                readonly const: false;
                                            }];
                                        };
                                        readonly labels: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "string";
                                            };
                                        };
                                        readonly maxLines: {
                                            readonly type: "integer";
                                            readonly exclusiveMinimum: 0;
                                            readonly maximum: 9007199254740991;
                                        };
                                        readonly render: {
                                            readonly type: "string";
                                            readonly enum: readonly ["text", "rich"];
                                        };
                                        readonly toolProgress: {
                                            readonly type: "boolean";
                                        };
                                        readonly commandText: {
                                            readonly type: "string";
                                            readonly enum: readonly ["raw", "status"];
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                                readonly block: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly enabled: {
                                            readonly type: "boolean";
                                        };
                                        readonly coalesce: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly minChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly maxChars: {
                                                    readonly type: "integer";
                                                    readonly exclusiveMinimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                                readonly idleMs: {
                                                    readonly type: "integer";
                                                    readonly minimum: 0;
                                                    readonly maximum: 9007199254740991;
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly additionalProperties: false;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                            readonly exclusiveMinimum: 0;
                        };
                        readonly timeoutSeconds: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly mediaGroupFlushMs: {
                            readonly description: "Buffer window in milliseconds for Telegram media groups/albums before dispatching them as one inbound message. Default: 500.";
                            readonly type: "integer";
                            readonly minimum: 10;
                            readonly maximum: 60000;
                        };
                        readonly pollingStallThresholdMs: {
                            readonly type: "integer";
                            readonly minimum: 30000;
                            readonly maximum: 600000;
                        };
                        readonly retry: {
                            readonly type: "object";
                            readonly properties: {
                                readonly attempts: {
                                    readonly type: "integer";
                                    readonly minimum: 1;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly minDelayMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxDelayMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly jitter: {
                                    readonly type: "number";
                                    readonly minimum: 0;
                                    readonly maximum: 1;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly network: {
                            readonly type: "object";
                            readonly properties: {
                                readonly autoSelectFamily: {
                                    readonly type: "boolean";
                                };
                                readonly dnsResultOrder: {
                                    readonly type: "string";
                                    readonly enum: readonly ["ipv4first", "verbatim"];
                                };
                                readonly dangerouslyAllowPrivateNetwork: {
                                    readonly description: "Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.";
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly proxy: {
                            readonly type: "string";
                        };
                        readonly webhookUrl: {
                            readonly description: "Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret.";
                            readonly type: "string";
                        };
                        readonly webhookSecret: {
                            readonly description: "Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.";
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly webhookPath: {
                            readonly description: "Local webhook route path served by the gateway listener. Defaults to /telegram-webhook.";
                            readonly type: "string";
                        };
                        readonly webhookHost: {
                            readonly description: "Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress.";
                            readonly type: "string";
                        };
                        readonly webhookPort: {
                            readonly description: "Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port.";
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly webhookCertPath: {
                            readonly description: "Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain).";
                            readonly type: "string";
                        };
                        readonly actions: {
                            readonly type: "object";
                            readonly properties: {
                                readonly reactions: {
                                    readonly type: "boolean";
                                };
                                readonly sendMessage: {
                                    readonly type: "boolean";
                                };
                                readonly poll: {
                                    readonly type: "boolean";
                                };
                                readonly deleteMessage: {
                                    readonly type: "boolean";
                                };
                                readonly editMessage: {
                                    readonly type: "boolean";
                                };
                                readonly sticker: {
                                    readonly type: "boolean";
                                };
                                readonly createForumTopic: {
                                    readonly type: "boolean";
                                };
                                readonly editForumTopic: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly threadBindings: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly idleHours: {
                                    readonly type: "number";
                                    readonly minimum: 0;
                                };
                                readonly maxAgeHours: {
                                    readonly type: "number";
                                    readonly minimum: 0;
                                };
                                readonly spawnSessions: {
                                    readonly type: "boolean";
                                };
                                readonly defaultSpawnContext: {
                                    readonly type: "string";
                                    readonly enum: readonly ["isolated", "fork"];
                                };
                                readonly spawnSubagentSessions: {
                                    readonly type: "boolean";
                                };
                                readonly spawnAcpSessions: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly reactionNotifications: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "own", "all"];
                        };
                        readonly reactionLevel: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "ack", "minimal", "extensive"];
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly showOk: {
                                    readonly type: "boolean";
                                };
                                readonly showAlerts: {
                                    readonly type: "boolean";
                                };
                                readonly useIndicator: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly healthMonitor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly linkPreview: {
                            readonly type: "boolean";
                        };
                        readonly silentErrorReplies: {
                            readonly type: "boolean";
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly ackReaction: {
                            readonly type: "string";
                        };
                        readonly errorPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["always", "once", "silent"];
                        };
                        readonly errorCooldownMs: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly apiRoot: {
                            readonly type: "string";
                            readonly format: "uri";
                        };
                        readonly trustedLocalFileRoots: {
                            readonly description: "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected.";
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly autoTopicLabel: {
                            readonly anyOf: readonly [{
                                readonly type: "boolean";
                            }, {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly prompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            }];
                        };
                    };
                    readonly required: readonly ["dmPolicy", "groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "Telegram";
            readonly help: "Telegram channel provider configuration including auth tokens, retry behavior, and message rendering controls. Use this section to tune bot behavior for Telegram-specific API semantics.";
        };
        readonly customCommands: {
            readonly label: "Telegram Custom Commands";
            readonly help: "Additional Telegram bot menu commands (merged with native; conflicts ignored).";
        };
        readonly botToken: {
            readonly label: "Telegram Bot Token";
            readonly help: "Telegram bot token used to authenticate Bot API requests for this account/provider config. Use secret/env substitution and rotate tokens if exposure is suspected.";
        };
        readonly dmPolicy: {
            readonly label: "Telegram DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].';
        };
        readonly "dm.threadReplies": {
            readonly label: "Telegram DM Thread Replies";
            readonly help: 'Controls whether Telegram DMs with message_thread_id use flat sessions ("off", default) or thread-scoped sessions ("inbound" or "always"). Thread IDs are still preserved for replies when sessions stay flat.';
        };
        readonly "direct.*.threadReplies": {
            readonly label: "Telegram Per-DM Thread Replies";
            readonly help: 'Per-DM override for message_thread_id session threading. Use "inbound" only when a specific direct chat intentionally uses Telegram DM topics as separate sessions.';
        };
        readonly configWrites: {
            readonly label: "Telegram Config Writes";
            readonly help: "Allow Telegram to write config in response to channel events/commands (default: true).";
        };
        readonly "commands.native": {
            readonly label: "Telegram Native Commands";
            readonly help: 'Override native commands for Telegram (bool or "auto").';
        };
        readonly "commands.nativeSkills": {
            readonly label: "Telegram Native Skill Commands";
            readonly help: 'Override native skill commands for Telegram (bool or "auto").';
        };
        readonly streaming: {
            readonly label: "Telegram Streaming Mode";
            readonly help: 'Unified Telegram stream preview mode: "off" | "partial" | "block" | "progress" (default: "partial"). "progress" keeps a single editable progress draft until final delivery. Legacy boolean/streamMode keys are detected; run doctor --fix to migrate.';
        };
        readonly "streaming.mode": {
            readonly label: "Telegram Streaming Mode";
            readonly help: 'Canonical Telegram preview mode: "off" | "partial" | "block" | "progress" (default: "partial").';
        };
        readonly "streaming.chunkMode": {
            readonly label: "Telegram Chunk Mode";
            readonly help: 'Chunking mode for outbound Telegram text delivery: "length" (default) or "newline".';
        };
        readonly "streaming.block.enabled": {
            readonly label: "Telegram Block Streaming Enabled";
            readonly help: 'Enable chunked block-style Telegram preview delivery when channels.telegram.streaming.mode="block".';
        };
        readonly "streaming.block.coalesce": {
            readonly label: "Telegram Block Streaming Coalesce";
            readonly help: "Merge streamed Telegram block replies before sending final delivery.";
        };
        readonly "streaming.preview.chunk.minChars": {
            readonly label: "Telegram Draft Chunk Min Chars";
            readonly help: 'Minimum chars before emitting a Telegram block preview chunk when channels.telegram.streaming.mode="block".';
        };
        readonly "streaming.preview.chunk.maxChars": {
            readonly label: "Telegram Draft Chunk Max Chars";
            readonly help: 'Target max size for a Telegram block preview chunk when channels.telegram.streaming.mode="block".';
        };
        readonly "streaming.preview.chunk.breakPreference": {
            readonly label: "Telegram Draft Chunk Break Preference";
            readonly help: "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence).";
        };
        readonly "streaming.preview.toolProgress": {
            readonly label: "Telegram Draft Tool Progress";
            readonly help: "Show tool/progress activity in the live draft preview message (default: true when preview streaming is active). Set false to keep tool updates out of the edited Telegram preview.";
        };
        readonly "streaming.preview.commandText": {
            readonly label: "Telegram Draft Command Text";
            readonly help: 'Command/exec detail in preview tool-progress lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "streaming.progress.label": {
            readonly label: "Telegram Progress Label";
            readonly help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.';
        };
        readonly "streaming.progress.labels": {
            readonly label: "Telegram Progress Label Pool";
            readonly help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.';
        };
        readonly "streaming.progress.maxLines": {
            readonly label: "Telegram Progress Max Lines";
            readonly help: "Maximum number of compact progress lines to keep below the draft label (default: 8).";
        };
        readonly "streaming.progress.toolProgress": {
            readonly label: "Telegram Progress Tool Lines";
            readonly help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.";
        };
        readonly "streaming.progress.commandText": {
            readonly label: "Telegram Progress Command Text";
            readonly help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.';
        };
        readonly "retry.attempts": {
            readonly label: "Telegram Retry Attempts";
            readonly help: "Max retry attempts for outbound Telegram API calls (default: 3).";
        };
        readonly "retry.minDelayMs": {
            readonly label: "Telegram Retry Min Delay (ms)";
            readonly help: "Minimum retry delay in ms for Telegram outbound calls.";
        };
        readonly "retry.maxDelayMs": {
            readonly label: "Telegram Retry Max Delay (ms)";
            readonly help: "Maximum retry delay cap in ms for Telegram outbound calls.";
        };
        readonly "retry.jitter": {
            readonly label: "Telegram Retry Jitter";
            readonly help: "Jitter factor (0-1) applied to Telegram retry delays.";
        };
        readonly "network.autoSelectFamily": {
            readonly label: "Telegram autoSelectFamily";
            readonly help: "Override Node autoSelectFamily for Telegram (true=enable, false=disable).";
        };
        readonly "network.dangerouslyAllowPrivateNetwork": {
            readonly label: "Telegram Dangerously Allow Private Network";
            readonly help: "Dangerous opt-in for trusted fake-IP or transparent-proxy environments where Telegram media downloads resolve api.telegram.org to private/internal/special-use addresses.";
        };
        readonly timeoutSeconds: {
            readonly label: "Telegram API Timeout (seconds)";
            readonly help: "Max seconds before Telegram API requests are aborted (default: 500 per grammY).";
        };
        readonly mediaGroupFlushMs: {
            readonly label: "Telegram Media Group Flush (ms)";
            readonly help: "Milliseconds to buffer Telegram albums/media groups before dispatching them as one inbound message. Default: 500.";
        };
        readonly pollingStallThresholdMs: {
            readonly label: "Telegram Polling Stall Threshold (ms)";
            readonly help: "Milliseconds without completed Telegram getUpdates liveness before the polling watchdog restarts the polling runner. Default: 120000.";
        };
        readonly silentErrorReplies: {
            readonly label: "Telegram Silent Error Replies";
            readonly help: "When true, Telegram bot replies marked as errors are sent silently (no notification sound). Default: false.";
        };
        readonly apiRoot: {
            readonly label: "Telegram API Root URL";
            readonly help: "Custom Telegram Bot API root URL. Use the API root only (for example https://api.telegram.org), not a full /bot<TOKEN> endpoint. Use for self-hosted Bot API servers (https://github.com/tdlib/telegram-bot-api) or reverse proxies in regions where api.telegram.org is blocked.";
        };
        readonly trustedLocalFileRoots: {
            readonly label: "Telegram Trusted Local File Roots";
            readonly help: "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths inside these roots are read directly; all other absolute paths are rejected.";
        };
        readonly autoTopicLabel: {
            readonly label: "Telegram Auto Topic Label";
            readonly help: "Auto-rename DM forum topics on first message using LLM. Default: true. Set to false to disable, or use object form { enabled: true, prompt: '...' } for custom prompt.";
        };
        readonly "autoTopicLabel.enabled": {
            readonly label: "Telegram Auto Topic Label Enabled";
            readonly help: "Whether auto topic labeling is enabled. Default: true.";
        };
        readonly "autoTopicLabel.prompt": {
            readonly label: "Telegram Auto Topic Label Prompt";
            readonly help: "Custom prompt for LLM-based topic naming. The user message is appended after the prompt.";
        };
        readonly "capabilities.inlineButtons": {
            readonly label: "Telegram Inline Buttons";
            readonly help: "Enable Telegram inline button components for supported command and interaction surfaces. Disable if your deployment needs plain-text-only compatibility behavior.";
        };
        readonly execApprovals: {
            readonly label: "Telegram Exec Approvals";
            readonly help: "Telegram-native exec approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for the selected bot account.";
        };
        readonly "execApprovals.enabled": {
            readonly label: "Telegram Exec Approvals Enabled";
            readonly help: 'Controls Telegram native exec approvals for this account: unset or "auto" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them.';
        };
        readonly "execApprovals.approvers": {
            readonly label: "Telegram Exec Approval Approvers";
            readonly help: "Telegram user IDs allowed to approve exec requests for this bot account. Use numeric Telegram user IDs. If you leave this unset, OpenClaw falls back to numeric owner IDs inferred from commands.ownerAllowFrom when possible.";
        };
        readonly "execApprovals.agentFilter": {
            readonly label: "Telegram Exec Approval Agent Filter";
            readonly help: 'Optional allowlist of agent IDs eligible for Telegram exec approvals, for example `["main", "ops-agent"]`. Use this to keep approval prompts scoped to the agents you actually operate from Telegram.';
        };
        readonly "execApprovals.sessionFilter": {
            readonly label: "Telegram Exec Approval Session Filter";
            readonly help: "Optional session-key filters matched as substring or regex-style patterns before Telegram approval routing is used. Use narrow patterns so Telegram approvals only appear for intended sessions.";
        };
        readonly "execApprovals.target": {
            readonly label: "Telegram Exec Approval Target";
            readonly help: 'Controls where Telegram approval prompts are sent: "dm" sends to approver DMs (default), "channel" sends to the originating Telegram chat/topic, and "both" sends to both. Channel delivery exposes the command text to the chat, so only use it in trusted groups/topics.';
        };
        readonly "threadBindings.enabled": {
            readonly label: "Telegram Thread Binding Enabled";
            readonly help: "Enable Telegram conversation binding features (/focus, /unfocus, /agents, and /session idle|max-age). Overrides session.threadBindings.enabled when set.";
        };
        readonly "threadBindings.idleHours": {
            readonly label: "Telegram Thread Binding Idle Timeout (hours)";
            readonly help: "Inactivity window in hours for Telegram bound sessions. Set 0 to disable idle auto-unfocus (default: 24). Overrides session.threadBindings.idleHours when set.";
        };
        readonly "threadBindings.maxAgeHours": {
            readonly label: "Telegram Thread Binding Max Age (hours)";
            readonly help: "Optional hard max age in hours for Telegram bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set.";
        };
        readonly "threadBindings.spawnSessions": {
            readonly label: "Telegram Thread-Bound Session Spawn";
            readonly help: "Allow sessions_spawn(thread=true) and ACP thread spawns to auto-bind Telegram current conversations when supported.";
        };
        readonly "threadBindings.defaultSpawnContext": {
            readonly label: "Telegram Thread Spawn Context";
            readonly help: 'Default native subagent context for thread-bound spawns. "fork" starts from the requester transcript; "isolated" starts clean. Default: "fork".';
        };
    };
}, {
    readonly pluginId: "tlon";
    readonly channelId: "tlon";
    readonly label: "Tlon";
    readonly description: "decentralized messaging on Urbit; install the plugin to enable.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly ship: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly url: {
                readonly type: "string";
            };
            readonly code: {
                readonly type: "string";
            };
            readonly network: {
                readonly type: "object";
                readonly properties: {
                    readonly dangerouslyAllowPrivateNetwork: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly groupChannels: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
            readonly dmAllowlist: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
            readonly groupInviteAllowlist: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
            readonly autoDiscoverChannels: {
                readonly type: "boolean";
            };
            readonly showModelSignature: {
                readonly type: "boolean";
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly autoAcceptDmInvites: {
                readonly type: "boolean";
            };
            readonly autoAcceptGroupInvites: {
                readonly type: "boolean";
            };
            readonly ownerShip: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly authorization: {
                readonly type: "object";
                readonly properties: {
                    readonly channelRules: {
                        readonly type: "object";
                        readonly propertyNames: {
                            readonly type: "string";
                        };
                        readonly additionalProperties: {
                            readonly type: "object";
                            readonly properties: {
                                readonly mode: {
                                    readonly type: "string";
                                    readonly enum: readonly ["restricted", "open"];
                                };
                                readonly allowedShips: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                        readonly minLength: 1;
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                };
                readonly additionalProperties: false;
            };
            readonly defaultAuthorizedShips: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly ship: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly url: {
                            readonly type: "string";
                        };
                        readonly code: {
                            readonly type: "string";
                        };
                        readonly network: {
                            readonly type: "object";
                            readonly properties: {
                                readonly dangerouslyAllowPrivateNetwork: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly groupChannels: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                        readonly dmAllowlist: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                        readonly groupInviteAllowlist: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                        };
                        readonly autoDiscoverChannels: {
                            readonly type: "boolean";
                        };
                        readonly showModelSignature: {
                            readonly type: "boolean";
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly autoAcceptDmInvites: {
                            readonly type: "boolean";
                        };
                        readonly autoAcceptGroupInvites: {
                            readonly type: "boolean";
                        };
                        readonly ownerShip: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "twitch";
    readonly channelId: "twitch";
    readonly label: "Twitch";
    readonly description: "Twitch chat integration";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly anyOf: readonly [{
            readonly type: "object";
            readonly properties: {
                readonly name: {
                    readonly type: "string";
                };
                readonly enabled: {
                    readonly type: "boolean";
                };
                readonly markdown: {
                    readonly type: "object";
                    readonly properties: {
                        readonly tables: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "bullets", "code", "block"];
                        };
                    };
                    readonly additionalProperties: false;
                };
                readonly defaultAccount: {
                    readonly type: "string";
                };
                readonly username: {
                    readonly type: "string";
                };
                readonly accessToken: {
                    readonly type: "string";
                };
                readonly clientId: {
                    readonly type: "string";
                };
                readonly channel: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly allowFrom: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                };
                readonly allowedRoles: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                        readonly enum: readonly ["moderator", "owner", "vip", "subscriber", "all"];
                    };
                };
                readonly requireMention: {
                    readonly type: "boolean";
                };
                readonly responsePrefix: {
                    readonly type: "string";
                };
                readonly clientSecret: {
                    readonly type: "string";
                };
                readonly refreshToken: {
                    readonly type: "string";
                };
                readonly expiresIn: {
                    readonly anyOf: readonly [{
                        readonly type: "number";
                    }, {
                        readonly type: "null";
                    }];
                };
                readonly obtainmentTimestamp: {
                    readonly type: "number";
                };
            };
            readonly required: readonly ["username", "accessToken", "channel"];
            readonly additionalProperties: false;
        }, {
            readonly type: "object";
            readonly properties: {
                readonly name: {
                    readonly type: "string";
                };
                readonly enabled: {
                    readonly type: "boolean";
                };
                readonly markdown: {
                    readonly type: "object";
                    readonly properties: {
                        readonly tables: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "bullets", "code", "block"];
                        };
                    };
                    readonly additionalProperties: false;
                };
                readonly defaultAccount: {
                    readonly type: "string";
                };
                readonly accounts: {
                    readonly type: "object";
                    readonly propertyNames: {
                        readonly type: "string";
                    };
                    readonly additionalProperties: {
                        readonly type: "object";
                        readonly properties: {
                            readonly username: {
                                readonly type: "string";
                            };
                            readonly accessToken: {
                                readonly type: "string";
                            };
                            readonly clientId: {
                                readonly type: "string";
                            };
                            readonly channel: {
                                readonly type: "string";
                                readonly minLength: 1;
                            };
                            readonly enabled: {
                                readonly type: "boolean";
                            };
                            readonly allowFrom: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                            };
                            readonly allowedRoles: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                    readonly enum: readonly ["moderator", "owner", "vip", "subscriber", "all"];
                                };
                            };
                            readonly requireMention: {
                                readonly type: "boolean";
                            };
                            readonly responsePrefix: {
                                readonly type: "string";
                            };
                            readonly clientSecret: {
                                readonly type: "string";
                            };
                            readonly refreshToken: {
                                readonly type: "string";
                            };
                            readonly expiresIn: {
                                readonly anyOf: readonly [{
                                    readonly type: "number";
                                }, {
                                    readonly type: "null";
                                }];
                            };
                            readonly obtainmentTimestamp: {
                                readonly type: "number";
                            };
                        };
                        readonly required: readonly ["username", "accessToken", "channel"];
                        readonly additionalProperties: false;
                    };
                };
            };
            readonly required: readonly ["accounts"];
            readonly additionalProperties: false;
        }];
    };
}, {
    readonly pluginId: "whatsapp";
    readonly channelId: "whatsapp";
    readonly label: "WhatsApp";
    readonly description: "works with your own number; recommend a separate phone + eSIM.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly capabilities: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly configWrites: {
                readonly type: "boolean";
            };
            readonly sendReadReceipts: {
                readonly type: "boolean";
            };
            readonly messagePrefix: {
                readonly type: "string";
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly dmPolicy: {
                readonly default: "pairing";
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly selfChatMode: {
                readonly type: "boolean";
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly defaultTo: {
                readonly type: "string";
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly contextVisibility: {
                readonly type: "string";
                readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dmHistoryLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly dms: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly textChunkLimit: {
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly chunkMode: {
                readonly type: "string";
                readonly enum: readonly ["length", "newline"];
            };
            readonly blockStreaming: {
                readonly type: "boolean";
            };
            readonly blockStreamingCoalesce: {
                readonly type: "object";
                readonly properties: {
                    readonly minChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly maxChars: {
                        readonly type: "integer";
                        readonly exclusiveMinimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                    readonly idleMs: {
                        readonly type: "integer";
                        readonly minimum: 0;
                        readonly maximum: 9007199254740991;
                    };
                };
                readonly additionalProperties: false;
            };
            readonly groups: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly toolsBySender: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly allow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly alsoAllow: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly deny: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly direct: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly systemPrompt: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly ackReaction: {
                readonly type: "object";
                readonly properties: {
                    readonly emoji: {
                        readonly type: "string";
                    };
                    readonly direct: {
                        readonly default: true;
                        readonly type: "boolean";
                    };
                    readonly group: {
                        readonly default: "mentions";
                        readonly type: "string";
                        readonly enum: readonly ["always", "mentions", "never"];
                    };
                };
                readonly required: readonly ["direct", "group"];
                readonly additionalProperties: false;
            };
            readonly reactionLevel: {
                readonly type: "string";
                readonly enum: readonly ["off", "ack", "minimal", "extensive"];
            };
            readonly debounceMs: {
                readonly default: 0;
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly replyToMode: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                    readonly const: "off";
                }, {
                    readonly type: "string";
                    readonly const: "first";
                }, {
                    readonly type: "string";
                    readonly const: "all";
                }, {
                    readonly type: "string";
                    readonly const: "batched";
                }];
            };
            readonly heartbeat: {
                readonly type: "object";
                readonly properties: {
                    readonly showOk: {
                        readonly type: "boolean";
                    };
                    readonly showAlerts: {
                        readonly type: "boolean";
                    };
                    readonly useIndicator: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly healthMonitor: {
                readonly type: "object";
                readonly properties: {
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
            readonly accounts: {
                readonly type: "object";
                readonly propertyNames: {
                    readonly type: "string";
                };
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly capabilities: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly configWrites: {
                            readonly type: "boolean";
                        };
                        readonly sendReadReceipts: {
                            readonly type: "boolean";
                        };
                        readonly messagePrefix: {
                            readonly type: "string";
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly selfChatMode: {
                            readonly type: "boolean";
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly defaultTo: {
                            readonly type: "string";
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly groupPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly contextVisibility: {
                            readonly type: "string";
                            readonly enum: readonly ["all", "allowlist", "allowlist_quote"];
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dmHistoryLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly dms: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly historyLimit: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                        readonly maximum: 9007199254740991;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly textChunkLimit: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly chunkMode: {
                            readonly type: "string";
                            readonly enum: readonly ["length", "newline"];
                        };
                        readonly blockStreaming: {
                            readonly type: "boolean";
                        };
                        readonly blockStreamingCoalesce: {
                            readonly type: "object";
                            readonly properties: {
                                readonly minChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly maxChars: {
                                    readonly type: "integer";
                                    readonly exclusiveMinimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                                readonly idleMs: {
                                    readonly type: "integer";
                                    readonly minimum: 0;
                                    readonly maximum: 9007199254740991;
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                    readonly toolsBySender: {
                                        readonly type: "object";
                                        readonly propertyNames: {
                                            readonly type: "string";
                                        };
                                        readonly additionalProperties: {
                                            readonly type: "object";
                                            readonly properties: {
                                                readonly allow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly alsoAllow: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                                readonly deny: {
                                                    readonly type: "array";
                                                    readonly items: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                            readonly additionalProperties: false;
                                        };
                                    };
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly direct: {
                            readonly type: "object";
                            readonly propertyNames: {
                                readonly type: "string";
                            };
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly systemPrompt: {
                                        readonly type: "string";
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly ackReaction: {
                            readonly type: "object";
                            readonly properties: {
                                readonly emoji: {
                                    readonly type: "string";
                                };
                                readonly direct: {
                                    readonly default: true;
                                    readonly type: "boolean";
                                };
                                readonly group: {
                                    readonly default: "mentions";
                                    readonly type: "string";
                                    readonly enum: readonly ["always", "mentions", "never"];
                                };
                            };
                            readonly required: readonly ["direct", "group"];
                            readonly additionalProperties: false;
                        };
                        readonly reactionLevel: {
                            readonly type: "string";
                            readonly enum: readonly ["off", "ack", "minimal", "extensive"];
                        };
                        readonly debounceMs: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly replyToMode: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                                readonly const: "off";
                            }, {
                                readonly type: "string";
                                readonly const: "first";
                            }, {
                                readonly type: "string";
                                readonly const: "all";
                            }, {
                                readonly type: "string";
                                readonly const: "batched";
                            }];
                        };
                        readonly heartbeat: {
                            readonly type: "object";
                            readonly properties: {
                                readonly showOk: {
                                    readonly type: "boolean";
                                };
                                readonly showAlerts: {
                                    readonly type: "boolean";
                                };
                                readonly useIndicator: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly healthMonitor: {
                            readonly type: "object";
                            readonly properties: {
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly authDir: {
                            readonly type: "string";
                        };
                        readonly mediaMaxMb: {
                            readonly type: "integer";
                            readonly exclusiveMinimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
            readonly mediaMaxMb: {
                readonly default: 50;
                readonly type: "integer";
                readonly exclusiveMinimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly actions: {
                readonly type: "object";
                readonly properties: {
                    readonly reactions: {
                        readonly type: "boolean";
                    };
                    readonly sendMessage: {
                        readonly type: "boolean";
                    };
                    readonly polls: {
                        readonly type: "boolean";
                    };
                };
                readonly additionalProperties: false;
            };
        };
        readonly required: readonly ["dmPolicy", "groupPolicy", "debounceMs", "mediaMaxMb"];
        readonly additionalProperties: false;
    };
    readonly uiHints: {
        readonly "": {
            readonly label: "WhatsApp";
            readonly help: "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats.";
        };
        readonly dmPolicy: {
            readonly label: "WhatsApp DM Policy";
            readonly help: 'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].';
        };
        readonly selfChatMode: {
            readonly label: "WhatsApp Self-Phone Mode";
            readonly help: "Same-phone setup (bot uses your personal WhatsApp number).";
        };
        readonly debounceMs: {
            readonly label: "WhatsApp Message Debounce (ms)";
            readonly help: "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).";
        };
        readonly configWrites: {
            readonly label: "WhatsApp Config Writes";
            readonly help: "Allow WhatsApp to write config in response to channel events/commands (default: true).";
        };
    };
    readonly unsupportedSecretRefSurfacePatterns: readonly ["channels.whatsapp.accounts.*.creds.json", "channels.whatsapp.creds.json"];
}, {
    readonly pluginId: "zalo";
    readonly channelId: "zalo";
    readonly label: "Zalo";
    readonly description: "Vietnam-focused messaging platform with Bot API.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly botToken: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly tokenFile: {
                readonly type: "string";
            };
            readonly webhookUrl: {
                readonly type: "string";
            };
            readonly webhookSecret: {
                readonly anyOf: readonly [{
                    readonly type: "string";
                }, {
                    readonly oneOf: readonly [{
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "env";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                                readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "file";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }, {
                        readonly type: "object";
                        readonly properties: {
                            readonly source: {
                                readonly type: "string";
                                readonly const: "exec";
                            };
                            readonly provider: {
                                readonly type: "string";
                                readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                        };
                        readonly required: readonly ["source", "provider", "id"];
                        readonly additionalProperties: false;
                    }];
                }];
            };
            readonly webhookPath: {
                readonly type: "string";
            };
            readonly dmPolicy: {
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly mediaMaxMb: {
                readonly type: "number";
            };
            readonly proxy: {
                readonly type: "string";
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly accounts: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly botToken: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly tokenFile: {
                            readonly type: "string";
                        };
                        readonly webhookUrl: {
                            readonly type: "string";
                        };
                        readonly webhookSecret: {
                            readonly anyOf: readonly [{
                                readonly type: "string";
                            }, {
                                readonly oneOf: readonly [{
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "env";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                            readonly pattern: "^[A-Z][A-Z0-9_]{0,127}$";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "file";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly source: {
                                            readonly type: "string";
                                            readonly const: "exec";
                                        };
                                        readonly provider: {
                                            readonly type: "string";
                                            readonly pattern: "^[a-z][a-z0-9_-]{0,63}$";
                                        };
                                        readonly id: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly required: readonly ["source", "provider", "id"];
                                    readonly additionalProperties: false;
                                }];
                            }];
                        };
                        readonly webhookPath: {
                            readonly type: "string";
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly mediaMaxMb: {
                            readonly type: "number";
                        };
                        readonly proxy: {
                            readonly type: "string";
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly additionalProperties: false;
    };
}, {
    readonly pluginId: "zalouser";
    readonly channelId: "zalouser";
    readonly label: "Zalo Personal";
    readonly description: "Zalo personal account via QR code login.";
    readonly schema: {
        readonly $schema: "http://json-schema.org/draft-07/schema#";
        readonly type: "object";
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly enabled: {
                readonly type: "boolean";
            };
            readonly markdown: {
                readonly type: "object";
                readonly properties: {
                    readonly tables: {
                        readonly type: "string";
                        readonly enum: readonly ["off", "bullets", "code", "block"];
                    };
                };
                readonly additionalProperties: false;
            };
            readonly profile: {
                readonly type: "string";
            };
            readonly dangerouslyAllowNameMatching: {
                readonly type: "boolean";
            };
            readonly dmPolicy: {
                readonly type: "string";
                readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
            };
            readonly allowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly historyLimit: {
                readonly type: "integer";
                readonly minimum: 0;
                readonly maximum: 9007199254740991;
            };
            readonly groupAllowFrom: {
                readonly type: "array";
                readonly items: {
                    readonly anyOf: readonly [{
                        readonly type: "string";
                    }, {
                        readonly type: "number";
                    }];
                };
            };
            readonly groupPolicy: {
                readonly default: "allowlist";
                readonly type: "string";
                readonly enum: readonly ["open", "disabled", "allowlist"];
            };
            readonly groups: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly requireMention: {
                            readonly type: "boolean";
                        };
                        readonly tools: {
                            readonly type: "object";
                            readonly properties: {
                                readonly allow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly alsoAllow: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly deny: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly additionalProperties: false;
                        };
                    };
                    readonly additionalProperties: false;
                };
            };
            readonly messagePrefix: {
                readonly type: "string";
            };
            readonly responsePrefix: {
                readonly type: "string";
            };
            readonly accounts: {
                readonly type: "object";
                readonly properties: {};
                readonly additionalProperties: {
                    readonly type: "object";
                    readonly properties: {
                        readonly name: {
                            readonly type: "string";
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly markdown: {
                            readonly type: "object";
                            readonly properties: {
                                readonly tables: {
                                    readonly type: "string";
                                    readonly enum: readonly ["off", "bullets", "code", "block"];
                                };
                            };
                            readonly additionalProperties: false;
                        };
                        readonly profile: {
                            readonly type: "string";
                        };
                        readonly dangerouslyAllowNameMatching: {
                            readonly type: "boolean";
                        };
                        readonly dmPolicy: {
                            readonly type: "string";
                            readonly enum: readonly ["pairing", "allowlist", "open", "disabled"];
                        };
                        readonly allowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly historyLimit: {
                            readonly type: "integer";
                            readonly minimum: 0;
                            readonly maximum: 9007199254740991;
                        };
                        readonly groupAllowFrom: {
                            readonly type: "array";
                            readonly items: {
                                readonly anyOf: readonly [{
                                    readonly type: "string";
                                }, {
                                    readonly type: "number";
                                }];
                            };
                        };
                        readonly groupPolicy: {
                            readonly default: "allowlist";
                            readonly type: "string";
                            readonly enum: readonly ["open", "disabled", "allowlist"];
                        };
                        readonly groups: {
                            readonly type: "object";
                            readonly properties: {};
                            readonly additionalProperties: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly requireMention: {
                                        readonly type: "boolean";
                                    };
                                    readonly tools: {
                                        readonly type: "object";
                                        readonly properties: {
                                            readonly allow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly alsoAllow: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                            readonly deny: {
                                                readonly type: "array";
                                                readonly items: {
                                                    readonly type: "string";
                                                };
                                            };
                                        };
                                        readonly additionalProperties: false;
                                    };
                                };
                                readonly additionalProperties: false;
                            };
                        };
                        readonly messagePrefix: {
                            readonly type: "string";
                        };
                        readonly responsePrefix: {
                            readonly type: "string";
                        };
                    };
                    readonly required: readonly ["groupPolicy"];
                    readonly additionalProperties: false;
                };
            };
            readonly defaultAccount: {
                readonly type: "string";
            };
        };
        readonly required: readonly ["groupPolicy"];
        readonly additionalProperties: false;
    };
}];
