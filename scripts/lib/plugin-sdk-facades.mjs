import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { BUNDLED_PLUGIN_PATH_PREFIX, bundledPluginFile } from "./bundled-plugin-paths.mjs";

function pluginSource(dirName, artifactBasename = "api.js") {
  return `openclaw/plugin-source/${dirName}/${artifactBasename}`;
}

function runtimeApiSourcePath(dirName) {
  return bundledPluginFile(dirName, "runtime-api.ts");
}

const BUNDLED_PLUGIN_SOURCE_RELATIVE_PREFIX = `../../${BUNDLED_PLUGIN_PATH_PREFIX}`;

export const GENERATED_PLUGIN_SDK_FACADES = [
  {
    subpath: "amazon-bedrock",
    source: pluginSource("amazon-bedrock", "api.js"),
    exports: [
      "discoverBedrockModels",
      "mergeImplicitBedrockProvider",
      "resetBedrockDiscoveryCacheForTest",
      "resolveBedrockConfigApiKey",
      "resolveImplicitBedrockProvider",
    ],
  },
  {
    subpath: "anthropic-vertex",
    source: pluginSource("anthropic-vertex", "api.js"),
    exports: [
      "ANTHROPIC_VERTEX_DEFAULT_MODEL_ID",
      "buildAnthropicVertexProvider",
      "hasAnthropicVertexAvailableAuth",
      "hasAnthropicVertexCredentials",
      "mergeImplicitAnthropicVertexProvider",
      "resolveAnthropicVertexClientRegion",
      "resolveAnthropicVertexConfigApiKey",
      "resolveImplicitAnthropicVertexProvider",
      "resolveAnthropicVertexProjectId",
      "resolveAnthropicVertexRegion",
      "resolveAnthropicVertexRegionFromBaseUrl",
    ],
  },
  {
    subpath: "discord-account",
    source: pluginSource("discord", "api.js"),
    exports: ["resolveDiscordAccount", "ResolvedDiscordAccount"],
    typeExports: ["ResolvedDiscordAccount"],
  },
  {
    subpath: "discord-runtime-surface",
    source: pluginSource("discord", "runtime-api.js"),
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
    source: pluginSource("discord", "session-key-api.js"),
    exports: ["normalizeExplicitDiscordSessionKey"],
  },
  {
    subpath: "discord-surface",
    source: pluginSource("discord", "api.js"),
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
      "isDiscordExecApprovalApprover",
      "isDiscordExecApprovalClientEnabled",
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
      "resolveDiscordRuntimeGroupPolicy",
      "resolveDiscordGroupRequireMention",
      "resolveDiscordGroupToolPolicy",
    ],
    typeExports: [
      "DiscordComponentMessageSpec",
      "DiscordProbe",
      "DiscordSendComponents",
      "DiscordSendEmbeds",
      "DiscordSendResult",
      "DiscordTokenResolution",
      "InspectedDiscordAccount",
      "ResolvedDiscordAccount",
    ],
  },
  {
    subpath: "discord-thread-bindings",
    source: pluginSource("discord", "runtime-api.js"),
    exports: [
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
    source: pluginSource("discord", "timeouts.js"),
    exports: ["DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS", "DISCORD_DEFAULT_LISTENER_TIMEOUT_MS"],
  },
  {
    subpath: "anthropic-cli",
    source: pluginSource("anthropic", "api.js"),
    exports: ["CLAUDE_CLI_BACKEND_ID", "isClaudeCliProvider"],
  },
  {
    subpath: "bluebubbles-policy",
    source: pluginSource("bluebubbles", "api.js"),
    exports: [
      "isAllowedBlueBubblesSender",
      "resolveBlueBubblesGroupRequireMention",
      "resolveBlueBubblesGroupToolPolicy",
    ],
  },
  {
    subpath: "browser",
    source: pluginSource("browser", "runtime-api.js"),
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
    source: pluginSource("browser", "runtime-api.js"),
    exports: [
      "BrowserBridge",
      "BrowserCreateProfileResult",
      "BrowserDeleteProfileResult",
      "BrowserExecutable",
      "BrowserFormField",
      "BrowserResetProfileResult",
      "BrowserRouteRegistrar",
      "BrowserServerState",
      "BrowserStatus",
      "BrowserTab",
      "BrowserTransport",
      "DEFAULT_AI_SNAPSHOT_MAX_CHARS",
      "DEFAULT_BROWSER_EVALUATE_ENABLED",
      "DEFAULT_OPENCLAW_BROWSER_COLOR",
      "DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME",
      "DEFAULT_UPLOAD_DIR",
      "OpenClawPluginApi",
      "OpenClawPluginToolContext",
      "OpenClawPluginToolFactory",
      "ProfileStatus",
      "ResolvedBrowserConfig",
      "ResolvedBrowserProfile",
      "SnapshotResult",
      "applyBrowserProxyPaths",
      "browserAct",
      "browserArmDialog",
      "browserArmFileChooser",
      "browserCloseTab",
      "browserConsoleMessages",
      "browserCreateProfile",
      "browserDeleteProfile",
      "browserFocusTab",
      "browserHandlers",
      "browserNavigate",
      "browserOpenTab",
      "browserPdfSave",
      "browserProfiles",
      "browserResetProfile",
      "browserScreenshotAction",
      "browserSnapshot",
      "browserStart",
      "browserStatus",
      "browserStop",
      "browserTabAction",
      "browserTabs",
      "closeTrackedBrowserTabsForSessions",
      "createBrowserControlContext",
      "createBrowserPluginService",
      "createBrowserRouteContext",
      "createBrowserRouteDispatcher",
      "createBrowserRuntimeState",
      "createBrowserTool",
      "definePluginEntry",
      "ensureBrowserControlAuth",
      "getBrowserControlState",
      "getBrowserProfileCapabilities",
      "handleBrowserGatewayRequest",
      "installBrowserAuthMiddleware",
      "installBrowserCommonMiddleware",
      "isPersistentBrowserProfileMutation",
      "movePathToTrash",
      "normalizeBrowserFormField",
      "normalizeBrowserFormFieldValue",
      "normalizeBrowserRequestPath",
      "parseBrowserMajorVersion",
      "persistBrowserProxyFiles",
      "readBrowserVersion",
      "redactCdpUrl",
      "registerBrowserCli",
      "registerBrowserRoutes",
      "resolveBrowserConfig",
      "resolveBrowserControlAuth",
      "resolveExistingPathsWithinRoot",
      "resolveGoogleChromeExecutableForPlatform",
      "resolveProfile",
      "resolveRequestedBrowserProfile",
      "runBrowserProxyCommand",
      "startBrowserBridgeServer",
      "startBrowserControlServiceFromConfig",
      "stopBrowserBridgeServer",
      "stopBrowserControlService",
      "stopBrowserRuntime",
      "trackSessionBrowserTab",
      "untrackSessionBrowserTab",
    ],
    typeExports: [
      "BrowserBridge",
      "BrowserCreateProfileResult",
      "BrowserDeleteProfileResult",
      "BrowserExecutable",
      "BrowserFormField",
      "BrowserResetProfileResult",
      "BrowserRouteRegistrar",
      "BrowserServerState",
      "BrowserStatus",
      "BrowserTab",
      "BrowserTransport",
      "OpenClawPluginApi",
      "OpenClawPluginToolContext",
      "OpenClawPluginToolFactory",
      "ProfileStatus",
      "ResolvedBrowserConfig",
      "ResolvedBrowserProfile",
      "SnapshotResult",
    ],
  },
  {
    subpath: "cloudflare-ai-gateway",
    source: pluginSource("cloudflare-ai-gateway", "api.js"),
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
    source: pluginSource("byteplus", "api.js"),
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
    source: pluginSource("chutes", "api.js"),
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
    source: pluginSource("deepseek", "api.js"),
    exports: [
      "buildDeepSeekModelDefinition",
      "buildDeepSeekProvider",
      "DEEPSEEK_BASE_URL",
      "DEEPSEEK_MODEL_CATALOG",
    ],
  },
  {
    subpath: "feishu-conversation",
    source: pluginSource("feishu", "api.js"),
    exports: [
      "buildFeishuConversationId",
      "createFeishuThreadBindingManager",
      "feishuSessionBindingAdapterChannels",
      "feishuThreadBindingTesting",
      "parseFeishuDirectConversationId",
      "parseFeishuConversationId",
      "parseFeishuTargetId",
    ],
  },
  {
    subpath: "google",
    source: pluginSource("google", "api.js"),
    exports: [
      "applyGoogleGeminiModelDefault",
      "DEFAULT_GOOGLE_API_BASE_URL",
      "GOOGLE_GEMINI_DEFAULT_MODEL",
      "isGoogleGenerativeAiApi",
      "normalizeAntigravityModelId",
      "normalizeGoogleApiBaseUrl",
      "normalizeGoogleGenerativeAiBaseUrl",
      "normalizeGoogleModelId",
      "normalizeGoogleProviderConfig",
      "parseGeminiAuth",
      "resolveGoogleGenerativeAiApiOrigin",
      "resolveGoogleGenerativeAiTransport",
      "shouldNormalizeGoogleProviderConfig",
      "shouldNormalizeGoogleGenerativeAiProviderConfig",
    ],
  },
  {
    subpath: "feishu-setup",
    source: pluginSource("feishu", "api.js"),
    exports: ["feishuSetupAdapter", "feishuSetupWizard"],
  },
  {
    subpath: "github-copilot-login",
    source: pluginSource("github-copilot", "api.js"),
    exports: ["githubCopilotLoginCommand"],
  },
  {
    subpath: "huggingface",
    source: pluginSource("huggingface", "api.js"),
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
    source: pluginSource("imessage", "api.js"),
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
    source: pluginSource("image-generation-core", "runtime-api.js"),
    exports: [
      "generateImage",
      "listRuntimeImageGenerationProviders",
      "GenerateImageParams",
      "GenerateImageRuntimeResult",
    ],
    typeExports: ["GenerateImageParams", "GenerateImageRuntimeResult"],
  },
  {
    subpath: "kimi-coding",
    source: pluginSource("kimi-coding", "api.js"),
    exports: ["buildKimiCodingProvider"],
  },
  {
    subpath: "kilocode",
    source: pluginSource("kilocode", "api.js"),
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
    source: pluginSource("imessage", "api.js"),
    exports: [
      "normalizeIMessageHandle",
      "resolveIMessageRuntimeGroupPolicy",
      "resolveIMessageGroupRequireMention",
      "resolveIMessageGroupToolPolicy",
    ],
  },
  {
    subpath: "imessage-runtime",
    source: pluginSource("imessage", "runtime-api.js"),
    exports: ["monitorIMessageProvider", "probeIMessage", "sendMessageIMessage"],
    typeExports: ["IMessageProbe"],
  },
  {
    subpath: "irc-surface",
    source: pluginSource("irc", "api.js"),
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
    source: pluginSource("media-understanding-core", "runtime-api.js"),
    exports: [
      "describeImageFile",
      "describeImageFileWithModel",
      "describeVideoFile",
      "runMediaUnderstandingFile",
      "transcribeAudioFile",
      "RunMediaUnderstandingFileParams",
      "RunMediaUnderstandingFileResult",
    ],
    typeExports: ["RunMediaUnderstandingFileParams", "RunMediaUnderstandingFileResult"],
  },
  {
    subpath: "memory-core-engine-runtime",
    source: pluginSource("memory-core", "runtime-api.js"),
    exports: [
      "BuiltinMemoryEmbeddingProviderDoctorMetadata",
      "getBuiltinMemoryEmbeddingProviderDoctorMetadata",
      "getMemorySearchManager",
      "listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata",
      "MemoryIndexManager",
    ],
    typeExports: ["BuiltinMemoryEmbeddingProviderDoctorMetadata"],
  },
  {
    subpath: "mattermost-policy",
    source: pluginSource("mattermost", "api.js"),
    exports: ["isMattermostSenderAllowed"],
  },
  {
    subpath: "litellm",
    source: pluginSource("litellm", "api.js"),
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
    source: pluginSource("line", "runtime-api.js"),
    runtimeApiPreExportsPath: runtimeApiSourcePath("line"),
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
    source: pluginSource("line", "runtime-api.js"),
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
    source: pluginSource("matrix", "api.js"),
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
    source: pluginSource("matrix", "runtime-api.js"),
    exports: ["resolveMatrixAccountStringValues", "setMatrixRuntime"],
  },
  {
    subpath: "matrix-surface",
    source: pluginSource("matrix", "api.js"),
    exports: [
      "createMatrixThreadBindingManager",
      "matrixSessionBindingAdapterChannels",
      "resetMatrixThreadBindingsForTests",
    ],
  },
  {
    subpath: "matrix-thread-bindings",
    source: pluginSource("matrix", "api.js"),
    exports: [
      "setMatrixThreadBindingIdleTimeoutBySessionKey",
      "setMatrixThreadBindingMaxAgeBySessionKey",
    ],
  },
  {
    subpath: "openrouter",
    source: pluginSource("openrouter", "api.js"),
    exports: [
      "applyOpenrouterConfig",
      "applyOpenrouterProviderConfig",
      "buildOpenrouterProvider",
      "OPENROUTER_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "minimax",
    source: pluginSource("minimax", "api.js"),
    exports: [
      "applyMinimaxApiConfig",
      "applyMinimaxApiConfigCn",
      "applyMinimaxApiProviderConfig",
      "applyMinimaxApiProviderConfigCn",
      "buildMinimaxPortalProvider",
      "buildMinimaxProvider",
      "isMiniMaxModernModelId",
      "MINIMAX_API_BASE_URL",
      "MINIMAX_CN_API_BASE_URL",
      "MINIMAX_DEFAULT_MODEL_ID",
      "MINIMAX_DEFAULT_MODEL_REF",
      "MINIMAX_TEXT_MODEL_CATALOG",
      "MINIMAX_TEXT_MODEL_ORDER",
      "MINIMAX_TEXT_MODEL_REFS",
    ],
  },
  {
    subpath: "modelstudio",
    source: pluginSource("modelstudio", "api.js"),
    exports: [
      "applyModelStudioNativeStreamingUsageCompat",
      "buildModelStudioDefaultModelDefinition",
      "buildModelStudioModelDefinition",
      "MODELSTUDIO_BASE_URL",
      "MODELSTUDIO_CN_BASE_URL",
      "MODELSTUDIO_DEFAULT_COST",
      "MODELSTUDIO_DEFAULT_MODEL_ID",
      "MODELSTUDIO_DEFAULT_MODEL_REF",
      "MODELSTUDIO_GLOBAL_BASE_URL",
      "MODELSTUDIO_STANDARD_CN_BASE_URL",
      "MODELSTUDIO_STANDARD_GLOBAL_BASE_URL",
      "MODELSTUDIO_MODEL_CATALOG",
      "isNativeModelStudioBaseUrl",
      "buildModelStudioProvider",
    ],
  },
  {
    subpath: "modelstudio-definitions",
    source: pluginSource("modelstudio", "api.js"),
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
    source: pluginSource("moonshot", "api.js"),
    exports: [
      "applyMoonshotNativeStreamingUsageCompat",
      "buildMoonshotProvider",
      "isNativeMoonshotBaseUrl",
      "MOONSHOT_BASE_URL",
      "MOONSHOT_CN_BASE_URL",
      "MOONSHOT_DEFAULT_MODEL_ID",
      "MOONSHOT_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "mistral",
    source: pluginSource("mistral", "api.js"),
    exports: [
      "applyMistralConfig",
      "applyMistralProviderConfig",
      "buildMistralModelDefinition",
      "buildMistralProvider",
      "MISTRAL_BASE_URL",
      "MISTRAL_DEFAULT_MODEL_ID",
      "MISTRAL_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "nvidia",
    source: pluginSource("nvidia", "api.js"),
    exports: ["buildNvidiaProvider"],
  },
  {
    subpath: "ollama",
    source: pluginSource("ollama", "runtime-api.js"),
    exports: [
      "buildAssistantMessage",
      "buildOllamaChatRequest",
      "convertToOllamaMessages",
      "createOllamaEmbeddingProvider",
      "createConfiguredOllamaCompatNumCtxWrapper",
      "createConfiguredOllamaCompatStreamWrapper",
      "createConfiguredOllamaStreamFn",
      "createOllamaStreamFn",
      "DEFAULT_OLLAMA_EMBEDDING_MODEL",
      "isOllamaCompatProvider",
      "OLLAMA_NATIVE_BASE_URL",
      "parseNdjsonStream",
      "resolveOllamaBaseUrlForRun",
      "resolveOllamaCompatNumCtxEnabled",
      "shouldInjectOllamaCompatNumCtx",
      "wrapOllamaCompatNumCtx",
    ],
    typeExports: ["OllamaEmbeddingClient", "OllamaEmbeddingProvider"],
  },
  {
    subpath: "ollama-surface",
    source: pluginSource("ollama", "api.js"),
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
    source: pluginSource("openai", "api.js"),
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
    source: pluginSource("opencode", "api.js"),
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
    source: pluginSource("opencode-go", "api.js"),
    exports: [
      "applyOpencodeGoConfig",
      "applyOpencodeGoModelDefault",
      "applyOpencodeGoProviderConfig",
      "OPENCODE_GO_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "qianfan",
    source: pluginSource("qianfan", "api.js"),
    exports: ["QIANFAN_BASE_URL", "QIANFAN_DEFAULT_MODEL_ID", "buildQianfanProvider"],
  },
  {
    subpath: "signal-account",
    source: pluginSource("signal", "api.js"),
    exports: ["resolveSignalAccount", "ResolvedSignalAccount"],
    typeExports: ["ResolvedSignalAccount"],
  },
  {
    subpath: "signal-surface",
    source: pluginSource("signal", "api.js"),
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
    typeExports: ["ResolvedSignalAccount", "SignalProbe", "SignalSender"],
  },
  {
    subpath: "provider-reasoning",
    source: pluginSource("ollama", "api.js"),
    exports: ["isReasoningModelHeuristic"],
  },
  {
    subpath: "speech-runtime",
    source: pluginSource("speech-core", "runtime-api.js"),
    exports: [
      "_test",
      "buildTtsSystemPromptHint",
      "getLastTtsAttempt",
      "getResolvedSpeechProviderConfig",
      "getTtsMaxLength",
      "getTtsProvider",
      "isSummarizationEnabled",
      "isTtsEnabled",
      "isTtsProviderConfigured",
      "listSpeechVoices",
      "maybeApplyTtsToPayload",
      "ResolvedTtsConfig",
      "ResolvedTtsModelOverrides",
      "resolveTtsAutoMode",
      "resolveTtsConfig",
      "resolveTtsPrefsPath",
      "resolveTtsProviderOrder",
      "setLastTtsAttempt",
      "setSummarizationEnabled",
      "setTtsAutoMode",
      "setTtsEnabled",
      "setTtsMaxLength",
      "setTtsProvider",
      "synthesizeSpeech",
      "textToSpeech",
      "textToSpeechTelephony",
      "TtsDirectiveOverrides",
      "TtsDirectiveParseResult",
      "TtsResult",
      "TtsSynthesisResult",
      "TtsTelephonyResult",
    ],
    typeExports: [
      "ResolvedTtsConfig",
      "ResolvedTtsModelOverrides",
      "TtsDirectiveOverrides",
      "TtsDirectiveParseResult",
      "TtsResult",
      "TtsSynthesisResult",
      "TtsTelephonyResult",
    ],
  },
  {
    subpath: "sglang",
    source: pluginSource("sglang", "api.js"),
    exports: [
      "buildSglangProvider",
      "SGLANG_DEFAULT_API_KEY_ENV_VAR",
      "SGLANG_DEFAULT_BASE_URL",
      "SGLANG_MODEL_PLACEHOLDER",
      "SGLANG_PROVIDER_LABEL",
    ],
  },
  {
    subpath: "synthetic",
    source: pluginSource("synthetic", "api.js"),
    exports: [
      "applySyntheticConfig",
      "applySyntheticProviderConfig",
      "buildSyntheticModelDefinition",
      "buildSyntheticProvider",
      "SYNTHETIC_BASE_URL",
      "SYNTHETIC_DEFAULT_MODEL_REF",
      "SYNTHETIC_MODEL_CATALOG",
    ],
  },
  {
    subpath: "slack-target-parser",
    source: pluginSource("slack", "api.js"),
    exports: ["parseSlackTarget", "resolveSlackChannelId"],
  },
  {
    subpath: "slack-account",
    source: pluginSource("slack", "api.js"),
    exports: ["resolveSlackAccount", "ResolvedSlackAccount"],
    typeExports: ["ResolvedSlackAccount"],
  },
  {
    subpath: "slack-runtime-surface",
    source: pluginSource("slack", "runtime-api.js"),
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
    source: pluginSource("slack", "api.js"),
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
      "resolveSlackRuntimeGroupPolicy",
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
    typeExports: ["InspectedSlackAccount", "ResolvedSlackAccount", "SlackProbe"],
  },
  {
    subpath: "together",
    source: pluginSource("together", "api.js"),
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
    source: pluginSource("venice", "api.js"),
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
    source: pluginSource("telegram", "api.js"),
    exports: ["resolveTelegramAccount", "ResolvedTelegramAccount"],
    typeExports: ["ResolvedTelegramAccount"],
  },
  {
    subpath: "telegram-allow-from",
    source: pluginSource("telegram", "api.js"),
    exports: ["isNumericTelegramUserId", "normalizeTelegramAllowFromEntry"],
  },
  {
    subpath: "telegram-runtime-surface",
    source: pluginSource("telegram", "runtime-api.js"),
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
      "resetTelegramThreadBindingsForTests",
      "resolveTelegramRuntimeGroupPolicy",
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
    source: pluginSource("telegram", "api.js"),
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
      "isTelegramExecApprovalAuthorizedSender",
      "isTelegramExecApprovalClientEnabled",
      "isTelegramExecApprovalTargetRecipient",
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
      "TelegramProbe",
      "TelegramTokenResolution",
    ],
  },
  {
    subpath: "vercel-ai-gateway",
    source: pluginSource("vercel-ai-gateway", "api.js"),
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
    source: pluginSource("volcengine", "api.js"),
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
    source: pluginSource("vllm", "api.js"),
    exports: [
      "buildVllmProvider",
      "VLLM_DEFAULT_API_KEY_ENV_VAR",
      "VLLM_DEFAULT_BASE_URL",
      "VLLM_MODEL_PLACEHOLDER",
      "VLLM_PROVIDER_LABEL",
    ],
  },
  {
    subpath: "xai",
    source: pluginSource("xai", "api.js"),
    exports: [
      "applyXaiConfig",
      "applyXaiProviderConfig",
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
    source: pluginSource("xiaomi", "api.js"),
    exports: [
      "applyXiaomiConfig",
      "applyXiaomiProviderConfig",
      "buildXiaomiProvider",
      "XIAOMI_DEFAULT_MODEL_ID",
      "XIAOMI_DEFAULT_MODEL_REF",
    ],
  },
  {
    subpath: "zai",
    source: pluginSource("zai", "api.js"),
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
    source: pluginSource("whatsapp", "api.js"),
    exports: ["isWhatsAppGroupJid", "isWhatsAppUserTarget", "normalizeWhatsAppTarget"],
  },
  {
    subpath: "whatsapp-surface",
    source: pluginSource("whatsapp", "api.js"),
    exportSources: {
      DEFAULT_WEB_MEDIA_BYTES: pluginSource("whatsapp", "constants.js"),
    },
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
      "whatsappAccessControlTesting",
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
    source: pluginSource("zalo", "api.js"),
    exports: [
      "evaluateZaloGroupAccess",
      "resolveZaloRuntimeGroupPolicy",
      "zaloSetupAdapter",
      "zaloSetupWizard",
    ],
  },
];

export const GENERATED_PLUGIN_SDK_FACADES_BY_SUBPATH = Object.fromEntries(
  GENERATED_PLUGIN_SDK_FACADES.map((entry) => [entry.subpath, entry]),
);

export const GENERATED_PLUGIN_SDK_FACADES_LABEL = "plugin-sdk-facades";
export const GENERATED_PLUGIN_SDK_FACADES_SCRIPT = "scripts/generate-plugin-sdk-facades.mjs";
export const GENERATED_PLUGIN_SDK_FACADE_TYPES_OUTPUT =
  "src/generated/plugin-sdk-facade-type-map.generated.ts";

function rewriteFacadeTypeImportSpecifier(sourcePath) {
  if (sourcePath.startsWith("openclaw/plugin-source/")) {
    const { dirName, artifactBasename } = normalizeFacadeSourceParts(sourcePath);
    return `${BUNDLED_PLUGIN_SOURCE_RELATIVE_PREFIX}${dirName}/${artifactBasename}`;
  }
  if (sourcePath.startsWith(BUNDLED_PLUGIN_SOURCE_RELATIVE_PREFIX)) {
    return sourcePath;
  }
  return sourcePath;
}

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

function listFacadeEntrySourcePaths(entry) {
  return Array.from(new Set([entry.source, ...Object.values(entry.exportSources ?? {})]));
}

function buildFacadeSourceModuleKey(sourceIndex) {
  return `source${sourceIndex + 1}`;
}

function isPrimitiveTypeLike(type) {
  if (type.isUnion()) {
    return type.types.every((member) => isPrimitiveTypeLike(member));
  }
  const primitiveFlags =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void;
  return Boolean(type.flags & primitiveFlags);
}

function isArrayTypeLike(checker, type) {
  if (type.isUnion()) {
    return type.types.every((member) => isArrayTypeLike(checker, member));
  }
  return checker.isArrayType(type) || checker.isTupleType(type);
}

function normalizeFacadeSourceParts(sourcePath) {
  const pluginSourceMatch = /^openclaw\/plugin-source\/([^/]+)\/([^/]+)$/u.exec(sourcePath);
  if (pluginSourceMatch) {
    return {
      dirName: pluginSourceMatch[1],
      artifactBasename: pluginSourceMatch[2],
    };
  }
  const match = /^\.\.\/\.\.\/extensions\/([^/]+)\/([^/]+)$/u.exec(sourcePath);
  if (!match) {
    throw new Error(`Unsupported plugin-sdk facade source: ${sourcePath}`);
  }
  return {
    dirName: match[1],
    artifactBasename: match[2],
  };
}

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
  const absolutePath = sourcePath.startsWith("openclaw/plugin-source/")
    ? path.resolve(repoRoot, "extensions", sourcePath.slice("openclaw/plugin-source/".length))
    : path.resolve(repoRoot, "src/plugin-sdk", sourcePath);
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
      const declaration =
        symbol.valueDeclaration ?? exported.valueDeclaration ?? exported.declarations?.[0];
      const typeAtLocation = declaration
        ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
        : checker.getDeclaredTypeOfSymbol(symbol);
      exportKinds.set(exported.getName(), {
        type: Boolean(flags & ts.SymbolFlags.Type),
        value: Boolean(flags & ts.SymbolFlags.Value),
        functionLike: Boolean(flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Method)),
        callable: typeAtLocation.getCallSignatures().length > 0,
        arrayLike: isArrayTypeLike(checker, typeAtLocation),
        primitiveLike: isPrimitiveTypeLike(typeAtLocation),
      });
    }
  }

  sourceExportKindsCache.set(cacheKey, exportKinds);
  return exportKinds;
}

export function buildPluginSdkFacadeModule(entry, params = {}) {
  const sourceExportKinds = params.repoRoot
    ? resolveFacadeSourceExportKinds(params.repoRoot, entry.source)
    : new Map();
  const exportNames = entry.exportAll
    ? Array.from(sourceExportKinds.keys()).toSorted((left, right) => left.localeCompare(right))
    : entry.runtimeApiPreExportsPath
      ? collectRuntimeApiPreExports(params.repoRoot, entry.runtimeApiPreExportsPath)
      : entry.exports;
  const explicitTypeExports = new Set(entry.typeExports ?? []);
  const valueExports = [];
  const typeExports = [];
  const valueExportsBySource = new Map();
  let needsLazyArrayHelper = false;
  let needsLazyObjectHelper = false;
  for (const exportName of exportNames ?? []) {
    if (explicitTypeExports.has(exportName)) {
      continue;
    }
    const kind = sourceExportKinds.get(exportName);
    if (kind?.type && !kind.value) {
      typeExports.push(exportName);
      continue;
    }
    valueExports.push(exportName);
    if (kind?.arrayLike) {
      needsLazyArrayHelper = true;
    } else if (!kind?.functionLike && !kind?.callable && !kind?.primitiveLike) {
      needsLazyObjectHelper = true;
    }
    const sourcePath = entry.exportSources?.[exportName] ?? entry.source;
    const exportsForSource = valueExportsBySource.get(sourcePath) ?? [];
    exportsForSource.push(exportName);
    valueExportsBySource.set(sourcePath, exportsForSource);
  }
  for (const typeExport of entry.typeExports ?? []) {
    if (!typeExports.includes(typeExport)) {
      typeExports.push(typeExport);
    }
  }
  const lines = [`// Generated by ${GENERATED_PLUGIN_SDK_FACADES_SCRIPT}. Do not edit manually.`];
  if (valueExports.length || typeExports.length) {
    lines.push(
      'import type { PluginSdkFacadeTypeMap } from "../generated/plugin-sdk-facade-type-map.generated.js";',
    );
    lines.push(`type FacadeEntry = PluginSdkFacadeTypeMap[${JSON.stringify(entry.subpath)}];`);
    lines.push('type FacadeModule = FacadeEntry["module"];');
    for (const [sourceIndex] of listFacadeEntrySourcePaths(entry).entries()) {
      if (sourceIndex === 0) {
        continue;
      }
      lines.push(
        `type FacadeModule${sourceIndex + 1} = FacadeEntry["sourceModules"][${JSON.stringify(buildFacadeSourceModuleKey(sourceIndex))}]["module"];`,
      );
    }
  }
  if (valueExports.length) {
    const runtimeImports = ["loadBundledPluginPublicSurfaceModuleSync"];
    if (needsLazyArrayHelper) {
      runtimeImports.unshift("createLazyFacadeArrayValue");
    }
    if (needsLazyObjectHelper) {
      runtimeImports.unshift("createLazyFacadeObjectValue");
    }
    lines.push(`import { ${runtimeImports.join(", ")} } from "./facade-runtime.js";`);
    for (const [sourceIndex, sourcePath] of listFacadeEntrySourcePaths(entry).entries()) {
      if (!valueExportsBySource.has(sourcePath)) {
        continue;
      }
      const { dirName: sourceDirName, artifactBasename: sourceArtifactBasename } =
        normalizeFacadeSourceParts(sourcePath);
      const loaderSuffix = sourceIndex === 0 ? "" : String(sourceIndex + 1);
      const moduleTypeName = sourceIndex === 0 ? "FacadeModule" : `FacadeModule${sourceIndex + 1}`;
      lines.push("");
      lines.push(`function loadFacadeModule${loaderSuffix}(): ${moduleTypeName} {`);
      lines.push(`  return loadBundledPluginPublicSurfaceModuleSync<${moduleTypeName}>({`);
      lines.push(`    dirName: ${JSON.stringify(sourceDirName)},`);
      lines.push(`    artifactBasename: ${JSON.stringify(sourceArtifactBasename)},`);
      lines.push("  });");
      lines.push("}");
    }
  }
  if (valueExports.length) {
    const sourceIndexByPath = new Map(
      listFacadeEntrySourcePaths(entry).map((sourcePath, index) => [sourcePath, index]),
    );
    for (const exportName of valueExports) {
      const kind = sourceExportKinds.get(exportName);
      const sourcePath = entry.exportSources?.[exportName] ?? entry.source;
      const sourceIndex = sourceIndexByPath.get(sourcePath) ?? 0;
      const loaderSuffix = sourceIndex === 0 ? "" : String(sourceIndex + 1);
      const moduleTypeName = sourceIndex === 0 ? "FacadeModule" : `FacadeModule${sourceIndex + 1}`;
      if (kind?.functionLike || kind?.callable) {
        lines.push(
          `export const ${exportName}: ${moduleTypeName}[${JSON.stringify(exportName)}] = ((...args) =>`,
        );
        lines.push(
          `  loadFacadeModule${loaderSuffix}()[${JSON.stringify(exportName)}](...args)) as ${moduleTypeName}[${JSON.stringify(exportName)}];`,
        );
        continue;
      }
      if (kind?.arrayLike) {
        lines.push(
          `export const ${exportName}: ${moduleTypeName}[${JSON.stringify(exportName)}] = createLazyFacadeArrayValue(() => loadFacadeModule${loaderSuffix}()[${JSON.stringify(exportName)}] as unknown as readonly unknown[]) as ${moduleTypeName}[${JSON.stringify(exportName)}];`,
        );
        continue;
      }
      if (!kind?.primitiveLike) {
        lines.push(
          `export const ${exportName}: ${moduleTypeName}[${JSON.stringify(exportName)}] = createLazyFacadeObjectValue(() => loadFacadeModule${loaderSuffix}()[${JSON.stringify(exportName)}] as object) as ${moduleTypeName}[${JSON.stringify(exportName)}];`,
        );
        continue;
      }
      lines.push(
        `export const ${exportName}: ${moduleTypeName}[${JSON.stringify(exportName)}] = loadFacadeModule${loaderSuffix}()[${JSON.stringify(exportName)}];`,
      );
    }
  }
  if (typeExports.length) {
    for (const exportedType of typeExports) {
      lines.push(
        `export type ${exportedType} = FacadeEntry["types"][${JSON.stringify(exportedType)}];`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function buildPluginSdkFacadeTypeMapModule(entries) {
  const lines = [`// Generated by ${GENERATED_PLUGIN_SDK_FACADES_SCRIPT}. Do not edit manually.`];
  lines.push("export interface PluginSdkFacadeTypeMap {");
  for (const entry of entries) {
    const moduleImportPath = rewriteFacadeTypeImportSpecifier(entry.source);
    lines.push(`  ${JSON.stringify(entry.subpath)}: {`);
    lines.push(`    module: typeof import(${JSON.stringify(moduleImportPath)});`);
    lines.push("    sourceModules: {");
    for (const [sourceIndex, sourcePath] of listFacadeEntrySourcePaths(entry).entries()) {
      const rewrittenSourcePath = rewriteFacadeTypeImportSpecifier(sourcePath);
      lines.push(`      ${JSON.stringify(buildFacadeSourceModuleKey(sourceIndex))}: {`);
      lines.push(`        module: typeof import(${JSON.stringify(rewrittenSourcePath)});`);
      lines.push("      };");
    }
    lines.push("    };");
    lines.push("    types: {");
    for (const exportedType of entry.typeExports ?? []) {
      const typeImportPath = rewriteFacadeTypeImportSpecifier(entry.source);
      lines.push(
        `      ${JSON.stringify(exportedType)}: import(${JSON.stringify(typeImportPath)}).${exportedType};`,
      );
    }
    lines.push("    };");
    lines.push("  };");
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}
