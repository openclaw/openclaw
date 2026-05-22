import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { type ModelCatalog, type ModelCatalogAlias, type ModelCatalogCost, type ModelCatalogDiscovery, type ModelCatalogInput, type ModelCatalogModel, type ModelCatalogProvider, type ModelCatalogStatus, type ModelCatalogSuppression, type ModelCatalogTieredCost } from "../model-catalog/index.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { type PluginManifestCommandAlias } from "./manifest-command-aliases.js";
import type { PluginConfigUiHint } from "./manifest-types.js";
import type { PluginKind } from "./plugin-kind.types.js";
export declare const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export declare const PLUGIN_MANIFEST_FILENAMES: readonly ["openclaw.plugin.json"];
export declare const MAX_PLUGIN_MANIFEST_BYTES: number;
export declare function clearPluginManifestLoadCache(): void;
export type PluginManifestChannelConfig = {
    schema: JsonSchemaObject;
    uiHints?: Record<string, PluginConfigUiHint>;
    runtime?: ChannelConfigRuntimeSchema;
    label?: string;
    description?: string;
    preferOver?: string[];
    commands?: PluginManifestChannelCommandDefaults;
};
export type PluginManifestChannelCommandDefaults = {
    nativeCommandsAutoEnabled?: boolean;
    nativeSkillsAutoEnabled?: boolean;
};
export type PluginManifestModelSupport = {
    /**
     * Cheap manifest-owned model-id prefixes for transparent provider activation
     * from shorthand model refs such as `gpt-5.4` or `claude-sonnet-4.6`.
     */
    modelPrefixes?: string[];
    /**
     * Regex sources matched against the raw model id after profile suffixes are
     * stripped. Use this when simple prefixes are not expressive enough.
     */
    modelPatterns?: string[];
};
export type PluginManifestModelCatalogInput = ModelCatalogInput;
export type PluginManifestModelCatalogDiscovery = ModelCatalogDiscovery;
export type PluginManifestModelCatalogStatus = ModelCatalogStatus;
export type PluginManifestModelCatalogTieredCost = ModelCatalogTieredCost;
export type PluginManifestModelCatalogCost = ModelCatalogCost;
export type PluginManifestModelCatalogModel = ModelCatalogModel;
export type PluginManifestModelCatalogProvider = ModelCatalogProvider;
export type PluginManifestModelCatalogAlias = ModelCatalogAlias;
export type PluginManifestModelCatalogSuppression = ModelCatalogSuppression;
export type PluginManifestModelCatalog = ModelCatalog;
export type PluginManifestModelPricingModelIdTransform = "version-dots";
export type PluginManifestModelPricingSource = {
    provider?: string;
    passthroughProviderModel?: boolean;
    modelIdTransforms?: PluginManifestModelPricingModelIdTransform[];
};
export type PluginManifestModelPricingProvider = {
    external?: boolean;
    openRouter?: PluginManifestModelPricingSource | false;
    liteLLM?: PluginManifestModelPricingSource | false;
};
export type PluginManifestModelPricing = {
    providers?: Record<string, PluginManifestModelPricingProvider>;
};
export type PluginManifestModelIdPrefixRule = {
    modelPrefix: string;
    prefix: string;
};
export type PluginManifestModelIdNormalizationProvider = {
    aliases?: Record<string, string>;
    stripPrefixes?: string[];
    prefixWhenBare?: string;
    prefixWhenBareAfterAliasStartsWith?: PluginManifestModelIdPrefixRule[];
};
export type PluginManifestModelIdNormalization = {
    providers?: Record<string, PluginManifestModelIdNormalizationProvider>;
};
export type PluginManifestProviderEndpoint = {
    /**
     * Core endpoint class this plugin-owned endpoint should map to. Core must
     * already know the class; manifests own host/baseUrl matching metadata.
     */
    endpointClass: string;
    /** Hostnames that should resolve to this endpoint class. */
    hosts?: string[];
    /** Host suffixes that should resolve to this endpoint class. */
    hostSuffixes?: string[];
    /** Exact normalized base URLs that should resolve to this endpoint class. */
    baseUrls?: string[];
    /** Static Google Vertex region metadata for exact global hosts. */
    googleVertexRegion?: string;
    /** Host suffix whose prefix should be exposed as the Google Vertex region. */
    googleVertexRegionHostSuffix?: string;
};
export type PluginManifestProviderRequestProvider = {
    family?: string;
    compatibilityFamily?: "moonshot";
    openAICompletions?: {
        supportsStreamingUsage?: boolean;
    };
};
export type PluginManifestProviderRequest = {
    providers?: Record<string, PluginManifestProviderRequestProvider>;
};
export type PluginManifestActivationCapability = "provider" | "channel" | "tool" | "hook";
export type PluginManifestActivation = {
    /**
     * Explicit Gateway startup activation. Set true when the plugin must be
     * imported during Gateway startup; set false when narrower activation
     * triggers should load it on demand.
     */
    onStartup?: boolean;
    /**
     * Provider ids that should include this plugin in activation/load plans.
     * This is planner metadata only; runtime behavior still comes from register().
     */
    onProviders?: string[];
    /** Agent harness runtime ids that should include this plugin in activation/load plans. */
    onAgentHarnesses?: string[];
    /** Command ids that should include this plugin in activation/load plans. */
    onCommands?: string[];
    /** Channel ids that should include this plugin in activation/load plans. */
    onChannels?: string[];
    /** Route kinds that should include this plugin in activation/load plans. */
    onRoutes?: string[];
    /** Root-relative config paths that should include this plugin in startup/load plans. */
    onConfigPaths?: string[];
    /** Broad capability hints for activation/load plans. Prefer narrower ownership metadata. */
    onCapabilities?: PluginManifestActivationCapability[];
};
export type PluginManifestDefaultPlatform = NodeJS.Platform;
export type PluginManifestSetupProvider = {
    /** Provider id surfaced during setup/onboarding. */
    id: string;
    /** Setup/auth methods that this provider supports. */
    authMethods?: string[];
    /** Environment variables that can satisfy setup without runtime loading. */
    envVars?: string[];
    /**
     * Cheap local evidence that a provider can authenticate without loading
     * runtime code. Evidence checks must not read secrets, shell out, or call
     * provider APIs.
     */
    authEvidence?: PluginManifestSetupProviderAuthEvidence[];
};
export type PluginManifestSetupProviderAuthEvidence = {
    /** Generic local file evidence gated by required environment metadata. */
    type: "local-file-with-env";
    /** Optional env var containing an explicit credential file path. */
    fileEnvVar?: string;
    /** Optional fallback credential file paths. Supports `${HOME}` and `${APPDATA}`. */
    fallbackPaths?: string[];
    /** At least one of these env vars must be non-empty when provided. */
    requiresAnyEnv?: string[];
    /** Every env var listed here must be non-empty when provided. */
    requiresAllEnv?: string[];
    /** Non-secret marker returned when this evidence is present. */
    credentialMarker: string;
    /** Human-readable auth source label. */
    source?: string;
};
export type PluginManifestSetup = {
    /** Cheap provider setup metadata exposed before runtime loads. */
    providers?: PluginManifestSetupProvider[];
    /** Setup-time backend ids available without full runtime activation. */
    cliBackends?: string[];
    /** Config migration ids owned by this plugin's setup surface. */
    configMigrations?: string[];
    /**
     * Whether setup still needs plugin runtime execution after descriptor lookup.
     * Defaults to false when omitted.
     */
    requiresRuntime?: boolean;
};
export type PluginManifestQaRunner = {
    /** Subcommand mounted beneath `openclaw qa`, for example `matrix`. */
    commandName: string;
    /** Optional user-facing help text for fallback host stubs. */
    description?: string;
};
export type PluginManifestConfigLiteral = string | number | boolean | null;
export type PluginManifestDangerousConfigFlag = {
    /**
     * Dot-separated config path relative to `plugins.entries.<id>.config`.
     * Supports `*` wildcards for map/array segments.
     */
    path: string;
    /** Exact literal that marks this config value as dangerous. */
    equals: PluginManifestConfigLiteral;
};
export type PluginManifestSecretInputPath = {
    /**
     * Dot-separated config path relative to `plugins.entries.<id>.config`.
     * Supports `*` wildcards for map/array segments.
     */
    path: string;
    /** Expected resolved type for SecretRef materialization. */
    expected?: "string";
};
export type PluginManifestSecretInputContracts = {
    /**
     * Override bundled-plugin default enablement when deciding whether this
     * SecretRef surface is active. Use this when the plugin is bundled but the
     * surface should stay inactive until explicitly enabled in config.
     */
    bundledDefaultEnabled?: boolean;
    paths: PluginManifestSecretInputPath[];
};
export type PluginManifestConfigContracts = {
    /**
     * Root-relative config paths that indicate this plugin's setup-time
     * compatibility migrations might apply. Use this to keep generic runtime
     * config reads from loading every plugin setup surface when the config does
     * not reference the plugin at all.
     */
    compatibilityMigrationPaths?: string[];
    /**
     * Root-relative compatibility paths that this plugin can service during
     * runtime before plugin code fully activates. Use this for legacy surfaces
     * that should cheaply narrow bundled candidate sets without importing every
     * compatible plugin runtime.
     */
    compatibilityRuntimePaths?: string[];
    dangerousFlags?: PluginManifestDangerousConfigFlag[];
    secretInputs?: PluginManifestSecretInputContracts;
};
export type PluginManifest = {
    id: string;
    configSchema: JsonSchemaObject;
    enabledByDefault?: boolean;
    enabledByDefaultOnPlatforms?: PluginManifestDefaultPlatform[];
    /** Legacy plugin ids that should normalize to this plugin id. */
    legacyPluginIds?: string[];
    /** Provider ids that should auto-enable this plugin when referenced in auth/config/models. */
    autoEnableWhenConfiguredProviders?: string[];
    kind?: PluginKind | PluginKind[];
    channels?: string[];
    providers?: string[];
    /**
     * Optional lightweight module that exports provider plugin metadata for
     * auth/catalog discovery. It should not import the full plugin runtime.
     */
    providerDiscoveryEntry?: string;
    /**
     * Cheap model-family ownership metadata used before plugin runtime loads.
     * Use this for shorthand model refs that omit an explicit provider prefix.
     */
    modelSupport?: PluginManifestModelSupport;
    /**
     * Declarative model catalog metadata used by future read-only listing,
     * onboarding, and model picker surfaces before provider runtime loads.
     */
    modelCatalog?: PluginManifestModelCatalog;
    /** Manifest-owned external pricing lookup policy for provider refs. */
    modelPricing?: PluginManifestModelPricing;
    /** Manifest-owned model-id normalization used before provider runtime loads. */
    modelIdNormalization?: PluginManifestModelIdNormalization;
    /** Cheap provider endpoint metadata used before provider runtime loads. */
    providerEndpoints?: PluginManifestProviderEndpoint[];
    /** Cheap provider request metadata used before provider runtime loads. */
    providerRequest?: PluginManifestProviderRequest;
    /** Cheap startup activation lookup for plugin-owned CLI inference backends. */
    cliBackends?: string[];
    /**
     * Provider or CLI backend refs whose plugin-owned synthetic auth hook should
     * be probed during cold model discovery before the runtime registry exists.
     */
    syntheticAuthRefs?: string[];
    /**
     * Bundled-plugin-owned placeholder API key values that represent non-secret
     * local, OAuth, or ambient credential state.
     */
    nonSecretAuthMarkers?: string[];
    /**
     * Plugin-owned command aliases that should resolve to this plugin during
     * config diagnostics before runtime loads.
     */
    commandAliases?: PluginManifestCommandAlias[];
    /**
     * Cheap provider-auth env lookup without booting plugin runtime.
     *
     * @deprecated Prefer setup.providers[].envVars for generic setup/status env
     * metadata. This field remains supported through the provider env-var
     * compatibility adapter during the deprecation window.
     */
    providerAuthEnvVars?: Record<string, string[]>;
    /** Provider ids that should reuse another provider id for auth lookup. */
    providerAuthAliases?: Record<string, string>;
    /** Cheap channel env lookup without booting plugin runtime. */
    channelEnvVars?: Record<string, string[]>;
    /**
     * Cheap onboarding/auth-choice metadata used by config validation, CLI help,
     * and non-runtime auth-choice routing before provider runtime loads.
     */
    providerAuthChoices?: PluginManifestProviderAuthChoice[];
    /** Cheap activation planner metadata exposed before plugin runtime loads. */
    activation?: PluginManifestActivation;
    /** Cheap setup/onboarding metadata exposed before plugin runtime loads. */
    setup?: PluginManifestSetup;
    /** Cheap QA runner metadata exposed before plugin runtime loads. */
    qaRunners?: PluginManifestQaRunner[];
    skills?: string[];
    name?: string;
    description?: string;
    version?: string;
    uiHints?: Record<string, PluginConfigUiHint>;
    /**
     * Static capability ownership snapshot used for manifest-driven discovery,
     * compat wiring, and contract coverage without importing plugin runtime.
     */
    contracts?: PluginManifestContracts;
    /** Cheap media-understanding provider defaults without importing plugin runtime. */
    mediaUnderstandingProviderMetadata?: Record<string, PluginManifestMediaUnderstandingProviderMetadata>;
    /** Cheap image-generation provider auth metadata without importing plugin runtime. */
    imageGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
    /** Cheap video-generation provider auth metadata without importing plugin runtime. */
    videoGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
    /** Cheap music-generation provider auth metadata without importing plugin runtime. */
    musicGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
    /** Cheap plugin-tool availability metadata without importing plugin runtime. */
    toolMetadata?: Record<string, PluginManifestToolMetadata>;
    /** Manifest-owned config behavior consumed by generic core helpers. */
    configContracts?: PluginManifestConfigContracts;
    channelConfigs?: Record<string, PluginManifestChannelConfig>;
};
export type PluginManifestContracts = {
    embeddedExtensionFactories?: string[];
    agentToolResultMiddleware?: string[];
    /**
     * Provider ids whose external auth profile hook can contribute runtime-only
     * credentials. Declaring this lets auth-store overlays load only the owning
     * plugin instead of every provider plugin.
     */
    externalAuthProviders?: string[];
    memoryEmbeddingProviders?: string[];
    speechProviders?: string[];
    realtimeTranscriptionProviders?: string[];
    realtimeVoiceProviders?: string[];
    mediaUnderstandingProviders?: string[];
    documentExtractors?: string[];
    imageGenerationProviders?: string[];
    videoGenerationProviders?: string[];
    musicGenerationProviders?: string[];
    webContentExtractors?: string[];
    webFetchProviders?: string[];
    webSearchProviders?: string[];
    migrationProviders?: string[];
    tools?: string[];
};
export type PluginManifestMediaUnderstandingCapability = "image" | "audio" | "video";
export type PluginManifestMediaUnderstandingProviderMetadata = {
    capabilities?: PluginManifestMediaUnderstandingCapability[];
    defaultModels?: Partial<Record<PluginManifestMediaUnderstandingCapability, string>>;
    autoPriority?: Partial<Record<PluginManifestMediaUnderstandingCapability, number>>;
    nativeDocumentInputs?: Array<"pdf">;
};
export type PluginManifestProviderBaseUrlGuard = {
    provider: string;
    defaultBaseUrl?: string;
    allowedBaseUrls: string[];
};
export type PluginManifestCapabilityProviderAuthSignal = {
    provider: string;
    providerBaseUrl?: PluginManifestProviderBaseUrlGuard;
};
export type PluginManifestCapabilityProviderModeConfigSignal = {
    path?: string;
    default?: string;
    allowed?: string[];
    disallowed?: string[];
};
export type PluginManifestCapabilityProviderConfigSignal = {
    rootPath: string;
    overlayPath?: string;
    required?: string[];
    requiredAny?: string[];
    mode?: PluginManifestCapabilityProviderModeConfigSignal;
};
export type PluginManifestCapabilityProviderMetadata = {
    aliases?: string[];
    authProviders?: string[];
    authSignals?: PluginManifestCapabilityProviderAuthSignal[];
    configSignals?: PluginManifestCapabilityProviderConfigSignal[];
};
export type PluginManifestToolMetadata = PluginManifestCapabilityProviderMetadata & {
    optional?: boolean;
};
export type PluginManifestProviderAuthChoice = {
    /** Provider id owned by this manifest entry. */
    provider: string;
    /** Provider auth method id that this choice should dispatch to. */
    method: string;
    /** Stable auth-choice id used by onboarding and other CLI auth flows. */
    choiceId: string;
    /** Optional user-facing choice label/hint for grouped onboarding UI. */
    choiceLabel?: string;
    choiceHint?: string;
    /** Lower values sort earlier in interactive assistant pickers. */
    assistantPriority?: number;
    /** Keep the choice out of interactive assistant pickers while preserving manual CLI support. */
    assistantVisibility?: "visible" | "manual-only";
    /** Legacy choice ids that should point users at this replacement choice. */
    deprecatedChoiceIds?: string[];
    /** Optional grouping metadata for auth-choice pickers. */
    groupId?: string;
    groupLabel?: string;
    groupHint?: string;
    /** Optional CLI flag metadata for one-flag auth flows such as API keys. */
    optionKey?: string;
    cliFlag?: string;
    cliOption?: string;
    cliDescription?: string;
    /**
     * Interactive onboarding surfaces where this auth choice should appear.
     * Defaults to `["text-inference"]` when omitted.
     */
    onboardingScopes?: PluginManifestOnboardingScope[];
};
export type PluginManifestOnboardingScope = "text-inference" | "image-generation";
export type PluginManifestLoadResult = {
    ok: true;
    manifest: PluginManifest;
    manifestPath: string;
} | {
    ok: false;
    error: string;
    manifestPath: string;
};
export declare function resolvePluginManifestPath(rootDir: string): string;
export declare function loadPluginManifest(rootDir: string, rejectHardlinks?: boolean, rootRealPath?: string): PluginManifestLoadResult;
export type PluginPackageChannel = {
    id?: string;
    label?: string;
    selectionLabel?: string;
    detailLabel?: string;
    docsPath?: string;
    docsLabel?: string;
    blurb?: string;
    order?: number;
    aliases?: readonly string[];
    preferOver?: readonly string[];
    systemImage?: string;
    selectionDocsPrefix?: string;
    selectionDocsOmitLabel?: boolean;
    selectionExtras?: readonly string[];
    markdownCapable?: boolean;
    exposure?: {
        configured?: boolean;
        setup?: boolean;
        docs?: boolean;
    };
    showConfigured?: boolean;
    showInSetup?: boolean;
    quickstartAllowFrom?: boolean;
    forceAccountBinding?: boolean;
    preferSessionLookupForAnnounceTarget?: boolean;
    commands?: PluginManifestChannelCommandDefaults;
    configuredState?: {
        specifier?: string;
        exportName?: string;
        env?: {
            allOf?: readonly string[];
            anyOf?: readonly string[];
        };
    };
    persistedAuthState?: {
        specifier?: string;
        exportName?: string;
    };
    doctorCapabilities?: PluginPackageChannelDoctorCapabilities;
    cliAddOptions?: readonly PluginPackageChannelCliOption[];
};
export type PluginPackageChannelDoctorCapabilities = {
    dmAllowFromMode?: "topOnly" | "topOrNested" | "nestedOnly";
    groupModel?: "sender" | "route" | "hybrid";
    groupAllowFromFallbackToAllowFrom?: boolean;
    warnOnEmptyGroupSenderAllowlist?: boolean;
};
export type PluginPackageChannelCliOption = {
    flags: string;
    description: string;
    defaultValue?: boolean | string;
};
export type PluginPackageInstall = {
    clawhubSpec?: string;
    npmSpec?: string;
    localPath?: string;
    defaultChoice?: "clawhub" | "npm" | "local";
    minHostVersion?: string;
    expectedIntegrity?: string;
    allowInvalidConfigRecovery?: boolean;
};
export type OpenClawPackageStartup = {
    /**
     * Opt-in for channel plugins whose `setupEntry` fully covers the gateway
     * startup surface needed before the server starts listening.
     */
    deferConfiguredChannelFullLoadUntilAfterListen?: boolean;
};
export type OpenClawPackageSetupFeatures = {
    configPromotion?: boolean;
    legacyStateMigrations?: boolean;
    legacySessionSurfaces?: boolean;
};
export type OpenClawPackageManifest = {
    extensions?: string[];
    runtimeExtensions?: string[];
    setupEntry?: string;
    runtimeSetupEntry?: string;
    setupFeatures?: OpenClawPackageSetupFeatures;
    plugin?: {
        id?: string;
        label?: string;
    };
    channel?: PluginPackageChannel;
    install?: PluginPackageInstall;
    startup?: OpenClawPackageStartup;
};
export declare const DEFAULT_PLUGIN_ENTRY_CANDIDATES: readonly ["index.ts", "index.js", "index.mjs", "index.cjs"];
export type PackageExtensionResolution = {
    status: "ok";
    entries: string[];
} | {
    status: "missing";
    entries: [];
} | {
    status: "empty";
    entries: [];
};
export type ManifestKey = typeof MANIFEST_KEY;
export type PackageManifest = {
    name?: string;
    version?: string;
    description?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;
export declare function getPackageManifestMetadata(manifest: PackageManifest | undefined): OpenClawPackageManifest | undefined;
export declare function resolvePackageExtensionEntries(manifest: PackageManifest | undefined): PackageExtensionResolution;
