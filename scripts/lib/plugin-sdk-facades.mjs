import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const GENERATED_PLUGIN_SDK_FACADES = [
  {
    subpath: "anthropic-vertex",
    source: "../../extensions/anthropic-vertex/api.js",
    exports: [
      "ANTHROPIC_VERTEX_DEFAULT_MODEL_ID",
      "buildAnthropicVertexProvider",
      "resolveAnthropicVertexRegion",
    ],
  },
  {
    subpath: "discord-account",
    source: "../../extensions/discord/api.js",
    exports: ["resolveDiscordAccount", "ResolvedDiscordAccount"],
    typeExports: ["ResolvedDiscordAccount"],
  },
  {
    subpath: "discord-runtime-surface",
    source: "../../extensions/discord/runtime-api.js",
    exports: [
      "addRoleDiscord",
      "auditDiscordChannelPermissions",
      "banMemberDiscord",
      "collectDiscordAuditChannelIds",
      "createChannelDiscord",
      "createScheduledEventDiscord",
      "createThreadDiscord",
      "deleteChannelDiscord",
      "deleteMessageDiscord",
      "discordMessageActions",
      "editChannelDiscord",
      "editDiscordComponentMessage",
      "editMessageDiscord",
      "fetchChannelInfoDiscord",
      "fetchChannelPermissionsDiscord",
      "fetchMemberInfoDiscord",
      "fetchMessageDiscord",
      "fetchReactionsDiscord",
      "fetchRoleInfoDiscord",
      "fetchVoiceStatusDiscord",
      "getGateway",
      "getPresence",
      "hasAnyGuildPermissionDiscord",
      "kickMemberDiscord",
      "listDiscordDirectoryGroupsLive",
      "listDiscordDirectoryPeersLive",
      "listGuildChannelsDiscord",
      "listGuildEmojisDiscord",
      "listPinsDiscord",
      "listScheduledEventsDiscord",
      "listThreadsDiscord",
      "monitorDiscordProvider",
      "moveChannelDiscord",
      "pinMessageDiscord",
      "probeDiscord",
      "reactMessageDiscord",
      "readMessagesDiscord",
      "registerBuiltDiscordComponentMessage",
      "removeChannelPermissionDiscord",
      "removeOwnReactionsDiscord",
      "removeReactionDiscord",
      "removeRoleDiscord",
      "resolveDiscordChannelAllowlist",
      "resolveDiscordOutboundSessionRoute",
      "resolveDiscordUserAllowlist",
      "searchMessagesDiscord",
      "sendDiscordComponentMessage",
      "sendMessageDiscord",
      "sendPollDiscord",
      "sendStickerDiscord",
      "sendTypingDiscord",
      "sendVoiceMessageDiscord",
      "setChannelPermissionDiscord",
      "timeoutMemberDiscord",
      "unpinMessageDiscord",
      "uploadEmojiDiscord",
      "uploadStickerDiscord",
    ],
  },
  {
    subpath: "discord-session-key",
    source: "../../extensions/discord/session-key-api.js",
    exports: ["normalizeExplicitDiscordSessionKey"],
  },
  {
    subpath: "discord-surface",
    source: "../../extensions/discord/api.js",
    exports: [
      "buildDiscordComponentMessage",
      "collectDiscordStatusIssues",
      "createDiscordActionGate",
      "DiscordComponentMessageSpec",
      "DiscordSendComponents",
      "DiscordSendEmbeds",
      "DiscordSendResult",
      "handleDiscordMessageAction",
      "inspectDiscordAccount",
      "InspectedDiscordAccount",
      "listDiscordAccountIds",
      "listDiscordDirectoryGroupsFromConfig",
      "listDiscordDirectoryPeersFromConfig",
      "looksLikeDiscordTargetId",
      "normalizeDiscordMessagingTarget",
      "normalizeDiscordOutboundTarget",
      "readDiscordComponentSpec",
      "ResolvedDiscordAccount",
      "resolveDefaultDiscordAccountId",
      "resolveDiscordAccount",
      "resolveDiscordChannelId",
      "resolveDiscordGroupRequireMention",
      "resolveDiscordGroupToolPolicy",
    ],
    typeExports: [
      "DiscordComponentMessageSpec",
      "DiscordSendComponents",
      "DiscordSendEmbeds",
      "DiscordSendResult",
      "InspectedDiscordAccount",
      "ResolvedDiscordAccount",
    ],
  },
  {
    subpath: "discord-thread-bindings",
    source: "../../extensions/discord/runtime-api.js",
    exports: [
      "__testing",
      "autoBindSpawnedDiscordSubagent",
      "createThreadBindingManager",
      "getThreadBindingManager",
      "listThreadBindingsBySessionKey",
      "resolveThreadBindingIdleTimeoutMs",
      "resolveThreadBindingInactivityExpiresAt",
      "resolveThreadBindingMaxAgeExpiresAt",
      "resolveThreadBindingMaxAgeMs",
      "setThreadBindingIdleTimeoutBySessionKey",
      "setThreadBindingMaxAgeBySessionKey",
      "ThreadBindingManager",
      "ThreadBindingRecord",
      "ThreadBindingTargetKind",
      "unbindThreadBindingsBySessionKey",
    ],
    typeExports: ["ThreadBindingManager", "ThreadBindingRecord", "ThreadBindingTargetKind"],
  },
  {
    subpath: "discord-timeouts",
    source: "../../extensions/discord/api.js",
    exports: ["DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS", "DISCORD_DEFAULT_LISTENER_TIMEOUT_MS"],
  },
  {
    subpath: "anthropic-cli",
    source: "../../extensions/anthropic/api.js",
    exports: ["CLAUDE_CLI_BACKEND_ID", "isClaudeCliProvider"],
  },
  {
    subpath: "bluebubbles-policy",
    source: "../../extensions/bluebubbles/api.js",
    exports: [
      "isAllowedBlueBubblesSender",
      "resolveBlueBubblesGroupRequireMention",
      "resolveBlueBubblesGroupToolPolicy",
    ],
  },
  {
    subpath: "browser",
    source: "../../extensions/browser/runtime-api.js",
    exports: [
      "browserHandlers",
      "createBrowserPluginService",
      "createBrowserTool",
      "handleBrowserGatewayRequest",
      "registerBrowserCli",
    ],
  },
  {
    subpath: "browser-runtime",
    source: "../../extensions/browser/runtime-api.js",
    exportAll: true,
  },
  {
    subpath: "cloudflare-ai-gateway",
    source: "../../extensions/cloudflare-ai-gateway/api.js",
    exports: [
      "applyCloudflareAiGatewayConfig",
      "applyCloudflareAiGatewayProviderConfig",
      "buildCloudflareAiGatewayConfigPatch",
      "buildCloudflareAiGatewayModelDefinition",
      "CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_ID",
      "CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF",
      "CLOUDFLARE_AI_GATEWAY_PROVIDER_ID",
      "resolveCloudflareAiGatewayBaseUrl",
    ],
  },
  {
    subpath: "byteplus",
    source: "../../extensions/byteplus/api.js",
    exports: [
      "buildBytePlusCodingProvider",
      "buildBytePlusModelDefinition",
      "buildBytePlusProvider",
      "BYTEPLUS_BASE_URL",
      "BYTEPLUS_CODING_BASE_URL",
      "BYTEPLUS_CODING_MODEL_CATALOG",
      "BYTEPLUS_MODEL_CATALOG",
    ],
  },
  {
    subpath: "chutes",
    source: "../../extensions/chutes/api.js",
    exports: [
      "applyChutesApiKeyConfig",
      "applyChutesConfig",
      "applyChutesProviderConfig",
      "buildChutesModelDefinition",
      "buildChutesProvider",
      "CHUTES_BASE_URL",
      "CHUTES_DEFAULT_MODEL_ID",
      "CHUTES_DEFAULT_MODEL_REF",
      "CHUTES_MODEL_CATALOG",
      "discoverChutesModels",
    ],
  },
  {
    subpath: "deepseek",
    source: "../../extensions/deepseek/api.js",
    exports: [
      "buildDeepSeekModelDefinition",
      "buildDeepSeekProvider",
      "DEEPSEEK_BASE_URL",
      "DEEPSEEK_MODEL_CATALOG",
    ],
  },
  {
    subpath: "feishu-conversation",
    source: "../../extensions/feishu/api.js",
    exports: [
      "buildFeishuConversationId",
      "createFeishuThreadBindingManager",
      "parseFeishuDirectConversationId",
      "parseFeishuConversationId",
      "parseFeishuTargetId",
    ],
  },
  {
    subpath: "google",
    source: "../../extensions/google/api.js",
    exports: [
      "applyGoogleGeminiModelDefault",
      "createGoogleThinkingPayloadWrapper",
      "DEFAULT_GOOGLE_API_BASE_URL",
      "GOOGLE_GEMINI_DEFAULT_MODEL",
      "normalizeGoogleApiBaseUrl",
      "normalizeGoogleModelId",
      "parseGeminiAuth",
      "sanitizeGoogleThinkingPayload",
    ],
  },
  {
    subpath: "feishu-setup",
    source: "../../extensions/feishu/api.js",
    exports: ["feishuSetupAdapter", "feishuSetupWizard"],
  },
  {
    subpath: "github-copilot-login",
    source: "../../extensions/github-copilot/api.js",
    exports: ["githubCopilotLoginCommand"],
  },
  {
    subpath: "huggingface",
    source: "../../extensions/huggingface/api.js",
    exports: [
      "buildHuggingfaceModelDefinition",
      "buildHuggingfaceProvider",
      "discoverHuggingfaceModels",
      "HUGGINGFACE_BASE_URL",
      "HUGGINGFACE_DEFAULT_MODEL_REF",
      "HUGGINGFACE_MODEL_CATALOG",
      "HUGGINGFACE_POLICY_SUFFIXES",
      "isHuggingfacePolicyLocked",
    ],
  },
  {
    subpath: "imessage-targets",
    source: "../../extensions/imessage/api.js",
    exports: [
      "normalizeIMessageHandle",
      "parseChatAllowTargetPrefixes",
      "parseChatTargetPrefixesOrThrow",
      "resolveServicePrefixedAllowTarget",
      "resolveServicePrefixedTarget",
      "ParsedChatTarget",
    ],
    typeExports: ["ParsedChatTarget"],
  },
  {
    subpath: "image-generation-runtime",
    source: "../../extensions/image-generation-core/runtime-api.js",
    exportAll: true,
  },
  {
    subpath: "kimi-coding",
    source: "../../extensions/kimi-coding/api.js",
    exports: ["buildKimiCodingProvider"],
  },
  {
    subpath: "kilocode",
    source: "../../extensions/kilocode/api.js",
    exports: [
      "buildKilocodeProvider",
      "buildKilocodeProviderWithDiscovery",
      "buildKilocodeModelDefinition",
      "discoverKilocodeModels",
      "KILOCODE_BASE_URL",
      "KILOCODE_DEFAULT_CONTEXT_WINDOW",
      "KILOCODE_DEFAULT_COST",
      "KILOCODE_DEFAULT_MAX_TOKENS",
      "KILOCODE_DEFAULT_MODEL_ID",
      "KILOCODE_DEFAULT_MODEL_NAME",
      "KILOCODE_DEFAULT_MODEL_REF",
      "KILOCODE_MODELS_URL",
      "KILOCODE_MODEL_CATALOG",
    ],
  },
  {
    subpath: "imessage-policy",
    source: "../../extensions/imessage/api.js",
    exports: [
      "normalizeIMessageHandle",
      "resolveIMessageGroupRequireMention",
      "resolveIMessageGroupToolPolicy",
    ],
  },
  {
    subpath: "imessage-runtime",
    source: "../../extensions/imessage/runtime-api.js",
    exports: ["monitorIMessageProvider", "probeIMessage", "sendMessageIMessage"],
  },
  {
    subpath: "irc-surface",
    source: "../../extensions/irc/api.js",
    exports: [
      "ircSetupAdapter",
      "ircSetupWizard",
      "listIrcAccountIds",
      "resolveDefaultIrcAccountId",
      "resolveIrcAccount",
    ],
  },
  {
    subpath: "media-understanding-runtime",
    source: "../../extensions/media-understanding-core/runtime-api.js",
    exportAll: true,
  },
  {
    subpath: "memory-core-engine-runtime",
    source: "../../extensions/memory-core/runtime-api.js",
    exportAll: true,
  },
  {
    subpath: "mattermost-policy",
    source: "../../extensions/mattermost/api.js",
    exports: ["isMattermostSenderAllowed"],
  },
  {
    subpath: "litellm",
    source: "../../extensions/litellm/api.js",
    exports: [
      "applyLitellmConfig",
      "applyLitellmProviderConfig",
      "buildLitellmModelDefinition",
      "LITELLM_BASE_URL",
      "LITELLM_DEFAULT_MODEL_ID",
      "LITELLM_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "line-runtime",
    source: "../../extensions/line/runtime-api.js",
    runtimeApiPreExportsPath: "extensions/line/runtime-api.ts",
    typeExports: [
      "Action",
      "CardAction",
      "CreateRichMenuParams",
      "FlexBox",
      "FlexBubble",
      "FlexButton",
      "FlexCarousel",
      "FlexComponent",
      "FlexContainer",
      "FlexImage",
      "FlexText",
      "LineChannelData",
      "LineConfig",
      "LineProbeResult",
      "ListItem",
      "ResolvedLineAccount",
      "RichMenuArea",
      "RichMenuAreaRequest",
      "RichMenuRequest",
      "RichMenuResponse",
      "RichMenuSize",
    ],
  },
  {
    subpath: "line-surface",
    source: "../../extensions/line/runtime-api.js",
    exports: [
      "CardAction",
      "createActionCard",
      "createAgendaCard",
      "createAppleTvRemoteCard",
      "createDeviceControlCard",
      "createEventCard",
      "createImageCard",
      "createInfoCard",
      "createListCard",
      "createMediaPlayerCard",
      "createReceiptCard",
      "LineChannelData",
      "LineConfig",
      "LineConfigSchema",
      "LineProbeResult",
      "listLineAccountIds",
      "ListItem",
      "normalizeAccountId",
      "processLineMessage",
      "ResolvedLineAccount",
      "resolveDefaultLineAccountId",
      "resolveExactLineGroupConfigKey",
      "resolveLineAccount",
    ],
    typeExports: [
      "CardAction",
      "LineChannelData",
      "LineConfig",
      "LineProbeResult",
      "ListItem",
      "ResolvedLineAccount",
    ],
  },
  {
    subpath: "matrix-helper",
    source: "../../extensions/matrix/api.js",
    exports: [
      "findMatrixAccountEntry",
      "getMatrixScopedEnvVarNames",
      "requiresExplicitMatrixDefaultAccount",
      "resolveConfiguredMatrixAccountIds",
      "resolveMatrixAccountStorageRoot",
      "resolveMatrixChannelConfig",
      "resolveMatrixCredentialsDir",
      "resolveMatrixCredentialsPath",
      "resolveMatrixDefaultOrOnlyAccountId",
      "resolveMatrixLegacyFlatStoragePaths",
    ],
  },
  {
    subpath: "matrix-runtime-surface",
    source: "../../extensions/matrix/runtime-api.js",
    exports: ["resolveMatrixAccountStringValues", "setMatrixRuntime"],
  },
  {
    subpath: "matrix-surface",
    source: "../../extensions/matrix/api.js",
    exports: ["createMatrixThreadBindingManager", "resetMatrixThreadBindingsForTests"],
  },
  {
    subpath: "matrix-thread-bindings",
    source: "../../extensions/matrix/api.js",
    exports: [
      "setMatrixThreadBindingIdleTimeoutBySessionKey",
      "setMatrixThreadBindingMaxAgeBySessionKey",
    ],
  },
  {
    subpath: "openrouter",
    source: "../../extensions/openrouter/api.js",
    exports: ["buildOpenrouterProvider", "OPENROUTER_DEFAULT_MODEL_REF"],
  },
  {
    subpath: "minimax",
    source: "../../extensions/minimax/api.js",
    exports: [
      "buildMinimaxPortalProvider",
      "buildMinimaxProvider",
      "isMiniMaxModernModelId",
      "MINIMAX_DEFAULT_MODEL_ID",
      "MINIMAX_DEFAULT_MODEL_REF",
      "MINIMAX_TEXT_MODEL_CATALOG",
      "MINIMAX_TEXT_MODEL_ORDER",
      "MINIMAX_TEXT_MODEL_REFS",
    ],
  },
  {
    subpath: "modelstudio",
    source: "../../extensions/modelstudio/api.js",
    exports: [
      "buildModelStudioDefaultModelDefinition",
      "buildModelStudioModelDefinition",
      "MODELSTUDIO_BASE_URL",
      "MODELSTUDIO_CN_BASE_URL",
      "MODELSTUDIO_DEFAULT_COST",
      "MODELSTUDIO_DEFAULT_MODEL_ID",
      "MODELSTUDIO_DEFAULT_MODEL_REF",
      "MODELSTUDIO_GLOBAL_BASE_URL",
      "buildModelStudioProvider",
    ],
  },
  {
    subpath: "modelstudio-definitions",
    source: "../../extensions/modelstudio/api.js",
    exports: [
      "buildModelStudioDefaultModelDefinition",
      "buildModelStudioModelDefinition",
      "MODELSTUDIO_CN_BASE_URL",
      "MODELSTUDIO_DEFAULT_COST",
      "MODELSTUDIO_DEFAULT_MODEL_ID",
      "MODELSTUDIO_DEFAULT_MODEL_REF",
      "MODELSTUDIO_GLOBAL_BASE_URL",
      "MODELSTUDIO_STANDARD_CN_BASE_URL",
      "MODELSTUDIO_STANDARD_GLOBAL_BASE_URL",
    ],
  },
  {
    subpath: "moonshot",
    source: "../../extensions/moonshot/api.js",
    exports: ["buildMoonshotProvider"],
  },
  {
    subpath: "nvidia",
    source: "../../extensions/nvidia/api.js",
    exports: ["buildNvidiaProvider"],
  },
  {
    subpath: "ollama",
    source: "../../extensions/ollama/runtime-api.js",
    exportAll: true,
  },
  {
    subpath: "ollama-surface",
    source: "../../extensions/ollama/api.js",
    exports: [
      "buildOllamaModelDefinition",
      "buildOllamaProvider",
      "configureOllamaNonInteractive",
      "ensureOllamaModelPulled",
      "enrichOllamaModelsWithContext",
      "fetchOllamaModels",
      "OLLAMA_DEFAULT_BASE_URL",
      "OLLAMA_DEFAULT_CONTEXT_WINDOW",
      "OLLAMA_DEFAULT_COST",
      "OLLAMA_DEFAULT_MAX_TOKENS",
      "OLLAMA_DEFAULT_MODEL",
      "OllamaModelWithContext",
      "OllamaTagModel",
      "OllamaTagsResponse",
      "promptAndConfigureOllama",
      "queryOllamaContextWindow",
      "resolveOllamaApiBase",
    ],
    typeExports: ["OllamaModelWithContext", "OllamaTagModel", "OllamaTagsResponse"],
  },
  {
    subpath: "openai",
    source: "../../extensions/openai/api.js",
    exports: [
      "applyOpenAIConfig",
      "applyOpenAIProviderConfig",
      "buildOpenAICodexProvider",
      "buildOpenAIProvider",
      "OPENAI_CODEX_DEFAULT_MODEL",
      "OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL",
      "OPENAI_DEFAULT_EMBEDDING_MODEL",
      "OPENAI_DEFAULT_IMAGE_MODEL",
      "OPENAI_DEFAULT_MODEL",
      "OPENAI_DEFAULT_TTS_MODEL",
      "OPENAI_DEFAULT_TTS_VOICE",
    ],
  },
  {
    subpath: "opencode",
    source: "../../extensions/opencode/api.js",
    exports: [
      "applyOpencodeZenConfig",
      "applyOpencodeZenModelDefault",
      "applyOpencodeZenProviderConfig",
      "OPENCODE_ZEN_DEFAULT_MODEL",
      "OPENCODE_ZEN_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "opencode-go",
    source: "../../extensions/opencode-go/api.js",
    exports: [
      "applyOpencodeGoConfig",
      "applyOpencodeGoModelDefault",
      "applyOpencodeGoProviderConfig",
      "OPENCODE_GO_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "qianfan",
    source: "../../extensions/qianfan/api.js",
    exports: ["QIANFAN_BASE_URL", "QIANFAN_DEFAULT_MODEL_ID", "buildQianfanProvider"],
  },
  {
    subpath: "signal-account",
    source: "../../extensions/signal/api.js",
    exports: ["resolveSignalAccount", "ResolvedSignalAccount"],
    typeExports: ["ResolvedSignalAccount"],
  },
  {
    subpath: "signal-surface",
    source: "../../extensions/signal/api.js",
    exports: [
      "isSignalSenderAllowed",
      "listEnabledSignalAccounts",
      "listSignalAccountIds",
      "monitorSignalProvider",
      "probeSignal",
      "removeReactionSignal",
      "ResolvedSignalAccount",
      "resolveDefaultSignalAccountId",
      "resolveSignalReactionLevel",
      "sendMessageSignal",
      "sendReactionSignal",
      "signalMessageActions",
      "SignalSender",
    ],
    typeExports: ["ResolvedSignalAccount", "SignalSender"],
  },
  {
    subpath: "provider-reasoning",
    source: "../../extensions/ollama/api.js",
    exports: ["isReasoningModelHeuristic"],
  },
  {
    subpath: "speech-runtime",
    source: "../../extensions/speech-core/runtime-api.js",
    exportAll: true,
  },
  {
    subpath: "sglang",
    source: "../../extensions/sglang/api.js",
    exports: [
      "SGLANG_DEFAULT_API_KEY_ENV_VAR",
      "SGLANG_DEFAULT_BASE_URL",
      "SGLANG_MODEL_PLACEHOLDER",
      "SGLANG_PROVIDER_LABEL",
    ],
  },
  {
    subpath: "synthetic",
    source: "../../extensions/synthetic/api.js",
    exports: [
      "buildSyntheticModelDefinition",
      "buildSyntheticProvider",
      "SYNTHETIC_BASE_URL",
      "SYNTHETIC_DEFAULT_MODEL_REF",
      "SYNTHETIC_MODEL_CATALOG",
    ],
  },
  {
    subpath: "slack-target-parser",
    source: "../../extensions/slack/api.js",
    exports: ["parseSlackTarget", "resolveSlackChannelId"],
  },
  {
    subpath: "slack-account",
    source: "../../extensions/slack/api.js",
    exports: ["resolveSlackAccount", "ResolvedSlackAccount"],
    typeExports: ["ResolvedSlackAccount"],
  },
  {
    subpath: "slack-runtime-surface",
    source: "../../extensions/slack/runtime-api.js",
    exports: [
      "handleSlackAction",
      "listSlackDirectoryGroupsLive",
      "listSlackDirectoryPeersLive",
      "monitorSlackProvider",
      "probeSlack",
      "resolveSlackChannelAllowlist",
      "resolveSlackUserAllowlist",
      "sendMessageSlack",
      "SlackActionContext",
    ],
    typeExports: ["SlackActionContext"],
  },
  {
    subpath: "slack-surface",
    source: "../../extensions/slack/api.js",
    exports: [
      "buildSlackThreadingToolContext",
      "createSlackWebClient",
      "deleteSlackMessage",
      "downloadSlackFile",
      "editSlackMessage",
      "extractSlackToolSend",
      "getSlackMemberInfo",
      "handleSlackHttpRequest",
      "inspectSlackAccount",
      "InspectedSlackAccount",
      "isSlackInteractiveRepliesEnabled",
      "listEnabledSlackAccounts",
      "listSlackAccountIds",
      "listSlackDirectoryGroupsFromConfig",
      "listSlackDirectoryPeersFromConfig",
      "listSlackEmojis",
      "listSlackMessageActions",
      "listSlackPins",
      "listSlackReactions",
      "normalizeAllowListLower",
      "parseSlackBlocksInput",
      "recordSlackThreadParticipation",
      "resolveDefaultSlackAccountId",
      "resolveSlackAutoThreadId",
      "resolveSlackGroupRequireMention",
      "resolveSlackGroupToolPolicy",
      "resolveSlackReplyToMode",
      "ResolvedSlackAccount",
      "sendSlackMessage",
      "pinSlackMessage",
      "reactSlackMessage",
      "readSlackMessages",
      "removeOwnSlackReactions",
      "removeSlackReaction",
      "unpinSlackMessage",
    ],
    typeExports: ["InspectedSlackAccount", "ResolvedSlackAccount"],
  },
  {
    subpath: "together",
    source: "../../extensions/together/api.js",
    exports: [
      "applyTogetherConfig",
      "buildTogetherModelDefinition",
      "buildTogetherProvider",
      "TOGETHER_BASE_URL",
      "TOGETHER_DEFAULT_MODEL_REF",
      "TOGETHER_MODEL_CATALOG",
    ],
  },
  {
    subpath: "venice",
    source: "../../extensions/venice/api.js",
    exports: [
      "buildVeniceModelDefinition",
      "buildVeniceProvider",
      "discoverVeniceModels",
      "VENICE_BASE_URL",
      "VENICE_DEFAULT_MODEL_REF",
      "VENICE_MODEL_CATALOG",
    ],
  },
  {
    subpath: "telegram-account",
    source: "../../extensions/telegram/api.js",
    exports: ["resolveTelegramAccount", "ResolvedTelegramAccount"],
    typeExports: ["ResolvedTelegramAccount"],
  },
  {
    subpath: "telegram-allow-from",
    source: "../../extensions/telegram/api.js",
    exports: ["isNumericTelegramUserId", "normalizeTelegramAllowFromEntry"],
  },
  {
    subpath: "telegram-runtime-surface",
    source: "../../extensions/telegram/runtime-api.js",
    exports: [
      "auditTelegramGroupMembership",
      "buildTelegramExecApprovalPendingPayload",
      "collectTelegramUnmentionedGroupIds",
      "createTelegramThreadBindingManager",
      "createForumTopicTelegram",
      "deleteMessageTelegram",
      "editForumTopicTelegram",
      "editMessageReplyMarkupTelegram",
      "editMessageTelegram",
      "monitorTelegramProvider",
      "pinMessageTelegram",
      "probeTelegram",
      "reactMessageTelegram",
      "renameForumTopicTelegram",
      "resolveTelegramToken",
      "sendMessageTelegram",
      "sendPollTelegram",
      "sendStickerTelegram",
      "sendTypingTelegram",
      "setTelegramThreadBindingIdleTimeoutBySessionKey",
      "setTelegramThreadBindingMaxAgeBySessionKey",
      "shouldSuppressTelegramExecApprovalForwardingFallback",
      "telegramMessageActions",
      "TelegramApiOverride",
      "TelegramProbe",
      "unpinMessageTelegram",
    ],
    typeExports: ["TelegramApiOverride", "TelegramProbe"],
  },
  {
    subpath: "telegram-surface",
    source: "../../extensions/telegram/api.js",
    exports: [
      "buildBrowseProvidersButton",
      "buildModelsKeyboard",
      "buildProviderKeyboard",
      "buildTelegramGroupPeerId",
      "calculateTotalPages",
      "createTelegramActionGate",
      "fetchTelegramChatId",
      "getCacheStats",
      "getModelsPageSize",
      "inspectTelegramAccount",
      "InspectedTelegramAccount",
      "isTelegramExecApprovalApprover",
      "isTelegramExecApprovalClientEnabled",
      "listTelegramAccountIds",
      "listTelegramDirectoryGroupsFromConfig",
      "listTelegramDirectoryPeersFromConfig",
      "looksLikeTelegramTargetId",
      "lookupTelegramChatId",
      "normalizeTelegramMessagingTarget",
      "parseTelegramReplyToMessageId",
      "parseTelegramTarget",
      "parseTelegramThreadId",
      "ProviderInfo",
      "ResolvedTelegramAccount",
      "resolveTelegramAutoThreadId",
      "resolveTelegramGroupRequireMention",
      "resolveTelegramGroupToolPolicy",
      "resolveTelegramInlineButtonsScope",
      "resolveTelegramPollActionGateState",
      "resolveTelegramReactionLevel",
      "resolveTelegramTargetChatType",
      "searchStickers",
      "sendTelegramPayloadMessages",
      "StickerMetadata",
      "TelegramButtonStyle",
      "TelegramInlineButtons",
    ],
    typeExports: [
      "InspectedTelegramAccount",
      "ProviderInfo",
      "ResolvedTelegramAccount",
      "StickerMetadata",
      "TelegramButtonStyle",
      "TelegramInlineButtons",
    ],
  },
  {
    subpath: "vercel-ai-gateway",
    source: "../../extensions/vercel-ai-gateway/api.js",
    exports: [
      "buildVercelAiGatewayProvider",
      "discoverVercelAiGatewayModels",
      "getStaticVercelAiGatewayModelCatalog",
      "VERCEL_AI_GATEWAY_BASE_URL",
      "VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW",
      "VERCEL_AI_GATEWAY_DEFAULT_COST",
      "VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS",
      "VERCEL_AI_GATEWAY_DEFAULT_MODEL_ID",
      "VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF",
      "VERCEL_AI_GATEWAY_PROVIDER_ID",
    ],
  },
  {
    subpath: "volcengine",
    source: "../../extensions/volcengine/api.js",
    exports: [
      "buildDoubaoCodingProvider",
      "buildDoubaoModelDefinition",
      "buildDoubaoProvider",
      "DOUBAO_BASE_URL",
      "DOUBAO_CODING_BASE_URL",
      "DOUBAO_CODING_MODEL_CATALOG",
      "DOUBAO_MODEL_CATALOG",
    ],
  },
  {
    subpath: "vllm",
    source: "../../extensions/vllm/api.js",
    exports: [
      "VLLM_DEFAULT_API_KEY_ENV_VAR",
      "VLLM_DEFAULT_BASE_URL",
      "VLLM_MODEL_PLACEHOLDER",
      "VLLM_PROVIDER_LABEL",
    ],
  },
  {
    subpath: "xai",
    source: "../../extensions/xai/api.js",
    exports: [
      "applyXaiModelCompat",
      "buildXaiCatalogModels",
      "buildXaiModelDefinition",
      "buildXaiProvider",
      "HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING",
      "isModernXaiModel",
      "normalizeXaiModelId",
      "resolveXaiCatalogEntry",
      "resolveXaiForwardCompatModel",
      "XAI_BASE_URL",
      "XAI_DEFAULT_CONTEXT_WINDOW",
      "XAI_DEFAULT_MODEL_ID",
      "XAI_DEFAULT_MODEL_REF",
      "XAI_DEFAULT_MAX_TOKENS",
      "XAI_TOOL_SCHEMA_PROFILE",
    ],
  },
  {
    subpath: "xiaomi",
    source: "../../extensions/xiaomi/api.js",
    exports: [
      "applyXiaomiConfig",
      "buildXiaomiProvider",
      "XIAOMI_DEFAULT_MODEL_ID",
      "XIAOMI_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "zai",
    source: "../../extensions/zai/api.js",
    exports: [
      "applyZaiConfig",
      "applyZaiProviderConfig",
      "ZAI_CN_BASE_URL",
      "ZAI_CODING_CN_BASE_URL",
      "ZAI_CODING_GLOBAL_BASE_URL",
      "ZAI_DEFAULT_MODEL_ID",
      "ZAI_DEFAULT_MODEL_REF",
      "ZAI_GLOBAL_BASE_URL",
    ],
  },
  {
    subpath: "whatsapp-targets",
    source: "../../extensions/whatsapp/api.js",
    exports: ["isWhatsAppGroupJid", "isWhatsAppUserTarget", "normalizeWhatsAppTarget"],
  },
  {
    subpath: "whatsapp-surface",
    source: "../../extensions/whatsapp/api.js",
    exports: [
      "DEFAULT_WEB_MEDIA_BYTES",
      "hasAnyWhatsAppAuth",
      "listEnabledWhatsAppAccounts",
      "listWhatsAppDirectoryGroupsFromConfig",
      "listWhatsAppDirectoryPeersFromConfig",
      "resolveWhatsAppAccount",
      "resolveWhatsAppGroupRequireMention",
      "resolveWhatsAppGroupToolPolicy",
      "resolveWhatsAppOutboundTarget",
    ],
    typeExports: [
      "WebChannelStatus",
      "WebInboundMessage",
      "WebListenerCloseReason",
      "WebMonitorTuning",
    ],
  },
  {
    subpath: "zalo-setup",
    source: "../../extensions/zalo/api.js",
    exports: ["zaloSetupAdapter", "zaloSetupWizard"],
  },
];

export const GENERATED_PLUGIN_SDK_FACADES_BY_SUBPATH = Object.fromEntries(
  GENERATED_PLUGIN_SDK_FACADES.map((entry) => [entry.subpath, entry]),
);

export const GENERATED_PLUGIN_SDK_FACADES_LABEL = "plugin-sdk-facades";
export const GENERATED_PLUGIN_SDK_FACADES_SCRIPT = "scripts/generate-plugin-sdk-facades.mjs";

const MODULE_RESOLUTION_OPTIONS = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
};
const MODULE_RESOLUTION_HOST = ts.createCompilerHost(MODULE_RESOLUTION_OPTIONS, true);
const sourceExportKindsCache = new Map();

function collectRuntimeApiPreExports(repoRoot, runtimeApiPath) {
  const absolutePath = path.join(repoRoot, runtimeApiPath);
  const sourceText = fs.readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
  const exportNames = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!moduleSpecifier) {
      continue;
    }
    if (statement.isTypeOnly) {
      continue;
    }
    if (moduleSpecifier === "openclaw/plugin-sdk/line-runtime") {
      break;
    }
    if (!moduleSpecifier.startsWith("./src/")) {
      continue;
    }
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) {
        exportNames.add(element.name.text);
      }
    }
  }

  return Array.from(exportNames).toSorted((left, right) => left.localeCompare(right));
}

function resolveFacadeSourceTypescriptPath(repoRoot, sourcePath) {
  const absolutePath = path.join(repoRoot, sourcePath);
  const candidates = [absolutePath.replace(/\.js$/, ".ts"), absolutePath.replace(/\.js$/, ".tsx")];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveFacadeSourceExportKinds(repoRoot, sourcePath) {
  const cacheKey = `${repoRoot}::${sourcePath}`;
  const cached = sourceExportKindsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sourceTsPath = resolveFacadeSourceTypescriptPath(repoRoot, sourcePath);
  if (!sourceTsPath) {
    const empty = new Map();
    sourceExportKindsCache.set(cacheKey, empty);
    return empty;
  }

  const program = ts.createProgram(
    [sourceTsPath],
    MODULE_RESOLUTION_OPTIONS,
    MODULE_RESOLUTION_HOST,
  );
  const sourceFile = program.getSourceFile(sourceTsPath);
  if (!sourceFile) {
    const empty = new Map();
    sourceExportKindsCache.set(cacheKey, empty);
    return empty;
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile) ?? sourceFile.symbol;
  const exportKinds = new Map();
  if (moduleSymbol) {
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const flags = symbol.flags;
      exportKinds.set(exported.getName(), {
        type: Boolean(flags & ts.SymbolFlags.Type),
        value: Boolean(flags & ts.SymbolFlags.Value),
      });
    }
  }

  sourceExportKindsCache.set(cacheKey, exportKinds);
  return exportKinds;
}

export function buildPluginSdkFacadeModule(entry, params = {}) {
  if (entry.exportAll) {
    return [
      `// Generated by ${GENERATED_PLUGIN_SDK_FACADES_SCRIPT}. Do not edit manually.`,
      `export * from "${entry.source}";`,
      "",
    ].join("\n");
  }
  const exportNames = entry.runtimeApiPreExportsPath
    ? collectRuntimeApiPreExports(params.repoRoot, entry.runtimeApiPreExportsPath)
    : entry.exports;
  const explicitTypeExports = new Set(entry.typeExports ?? []);
  const valueExports = [];
  const typeExports = [];
  const exportKinds =
    params.repoRoot && exportNames?.length
      ? resolveFacadeSourceExportKinds(params.repoRoot, entry.source)
      : new Map();
  for (const exportName of exportNames ?? []) {
    if (explicitTypeExports.has(exportName)) {
      continue;
    }
    const kind = exportKinds.get(exportName);
    if (kind?.type && !kind.value) {
      typeExports.push(exportName);
      continue;
    }
    valueExports.push(exportName);
  }
  for (const typeExport of entry.typeExports ?? []) {
    if (!typeExports.includes(typeExport)) {
      typeExports.push(typeExport);
    }
  }
  const lines = [`// Generated by ${GENERATED_PLUGIN_SDK_FACADES_SCRIPT}. Do not edit manually.`];
  if (valueExports.length) {
    const exports = valueExports.join(",\n  ");
    lines.push("export {", `  ${exports},`, `} from "${entry.source}";`);
  }
  if (typeExports.length) {
    const exportedTypes = typeExports.join(",\n  ");
    lines.push("export type {", `  ${exportedTypes},`, `} from "${entry.source}";`);
  }
  lines.push("");
  return lines.join("\n");
}
