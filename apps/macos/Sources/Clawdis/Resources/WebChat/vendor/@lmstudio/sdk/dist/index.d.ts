import { Patch } from '@lmstudio/immer-with-plugins';
import { z } from 'zod';
import { ZodError } from 'zod';
import { ZodSchema } from 'zod';
import { ZodType } from 'zod';

/**
 * Represents the result of running `llm.act`. Currently only contains minimum amount of
 * information.
 *
 * If you think more information/fields should be added, please open an issue or a PR on GitHub.
 *
 * @public
 */
export declare class ActResult {
    /**
     * Number of rounds performed.
     *
     * For example, in the following scenario:
     *
     * - User asks the model to add 1234 and 5678.
     * - The model requests to use a calculator tool.
     * - The calculator tool outputs 6912.
     * - The calculator's output is then fed back to the model for a second round of prediction.
     * - The model sees the output and generates a paragraph explaining the result.
     *
     * There are 2 rounds. On the beginning of a round, the callback `onRoundStart` is triggered.
     * On the end of a round, the callback `onRoundEnd` is triggered.
     */
    readonly rounds: number;
    /**
     * Total time taken to run `.act` in seconds. measured from beginning of the `.act` invocation
     * to when the entire operation is finished.
     */
    readonly totalExecutionTimeSeconds: number;
    constructor(
    /**
     * Number of rounds performed.
     *
     * For example, in the following scenario:
     *
     * - User asks the model to add 1234 and 5678.
     * - The model requests to use a calculator tool.
     * - The calculator tool outputs 6912.
     * - The calculator's output is then fed back to the model for a second round of prediction.
     * - The model sees the output and generates a paragraph explaining the result.
     *
     * There are 2 rounds. On the beginning of a round, the callback `onRoundStart` is triggered.
     * On the end of a round, the callback `onRoundEnd` is triggered.
     */
    rounds: number, 
    /**
     * Total time taken to run `.act` in seconds. measured from beginning of the `.act` invocation
     * to when the entire operation is finished.
     */
    totalExecutionTimeSeconds: number);
}

/**
 * Type representing the environment variables that can be set by the user.
 *
 * @public
 */
export declare type AllowableEnvVarKeys = "HSA_OVERRIDE_GFX_VERSION";

/**
 * Allow-list only record of environment variables and their values.
 *
 * @public
 */
export declare type AllowableEnvVars = Partial<Record<AllowableEnvVarKeys, string>>;

/**
 * Represents a dependency on other artifacts.
 *
 * @public
 */
export declare interface ArtifactArtifactDependency extends ArtifactDependencyBase {
    type: "artifact";
    owner: string;
    name: string;
}

/**
 * Represents a dependency of an artifact.
 *
 * @public
 */
export declare type ArtifactDependency = ArtifactModelDependency | ArtifactArtifactDependency;

/**
 * Represents the base type for an artifact dependency.
 *
 * @public
 */
export declare interface ArtifactDependencyBase {
    purpose: ArtifactDependencyPurpose;
}

/**
 * Represents the purpose of an artifact dependency.
 *
 * @public
 */
export declare type ArtifactDependencyPurpose = "baseModel" | "draftModel" | "custom";

/**
 * Represents a plan for downloading artifacts.
 *
 * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
 * tuned for updates.
 * @public
 */
export declare interface ArtifactDownloadPlan {
    nodes: Array<ArtifactDownloadPlanNode>;
    downloadSizeBytes: number;
}

/**
 * Represents information about a model in an artifact download plan.
 *
 * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
 * tuned for updates.
 * @public
 */
export declare type ArtifactDownloadPlanModelInfo = {
    displayName: string;
    sizeBytes: number;
    quantName?: string;
    compatibilityType: ModelCompatibilityType;
};

/**
 * Represents a planner to download an artifact. The plan is not guaranteed to be ready until you
 * await on the method "untilReady".
 *
 * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
 * tuned for updates.
 * @public
 */
export declare class ArtifactDownloadPlanner {
    readonly owner: string;
    readonly name: string;
    private readonly onPlanUpdated;
    private readonly validator;
    private readonly onDisposed;
    private readyDeferredPromise;
    private readonly logger;
    private isReadyBoolean;
    private planValue;
    private currentDownload;
    /**
     * If we received an error after the download starts, we will just raise the error in the download
     * promise.
     *
     * However, if the error was received before download was called (e.g. plan resolution failed),
     * we will store the error here and throw it as soon as `.download` is called. In addition, we
     * will also raise the error in the ready promise. However, since it is not required to attach
     * a listener there
     */
    private errorReceivedBeforeDownloadStart;
    [Symbol.dispose](): void;
    isReady(): boolean;
    untilReady(): Promise<void>;
    getPlan(): ArtifactDownloadPlan;
    /**
     * Download this artifact. `download` can only be called once.
     */
    download(opts: ArtifactDownloadPlannerDownloadOpts): Promise<void>;
}

/**
 * Options for the {@link ArtifactDownloadPlanner#download} method.
 *
 * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
 * tuned for updates.
 * @public
 */
export declare interface ArtifactDownloadPlannerDownloadOpts {
    onStartFinalizing?: () => void;
    onProgress?: (update: DownloadProgressUpdate) => void;
    signal?: AbortSignal;
}

/**
 * Represents the state of a node in an artifact download plan.
 *
 * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
 * tuned for updates.
 * @public
 */
export declare type ArtifactDownloadPlanNode = {
    type: "artifact";
    owner: string;
    name: string;
    state: ArtifactDownloadPlanNodeState;
    artifactType?: ArtifactType;
    sizeBytes?: number;
    dependencyNodes: Array<number>;
} | {
    type: "model";
    state: ArtifactDownloadPlanNodeState;
    resolvedSources?: number;
    totalSources?: number;
    alreadyOwned?: ArtifactDownloadPlanModelInfo;
    selected?: ArtifactDownloadPlanModelInfo;
};

/**
 * Represents the state of a node in an artifact download plan.
 *
 * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
 * tuned for updates.
 * @public
 */
export declare type ArtifactDownloadPlanNodeState = "pending" | "fetching" | "satisfied" | "completed";

/**
 * Base type for the manifest of an artifact.
 *
 * @public
 */
export declare interface ArtifactManifestBase {
    owner: string;
    name: string;
    revision?: number;
    dependencies?: Array<ArtifactDependency>;
    tags?: Array<string>;
}

/**
 * Represents a dependency on a concrete model.
 *
 * @public
 */
export declare interface ArtifactModelDependency extends ArtifactDependencyBase {
    type: "model";
    /**
     * The model key. This is used to identify if whether the dependency has been downloaded or not.
     * Any model matching any of the model keys listed here will be considered a match, and can
     * satisfy the entire model dependency.
     */
    modelKeys: Array<string>;
    /**
     * Describes how to download the model. Currently only supports downloading from a URL.
     */
    sources: Array<ModelDownloadSource>;
}

/**
 * Represents the type of an artifact.
 *
 * @public
 */
export declare type ArtifactType = "plugin" | "preset" | "model";

/**
 * When deriving with an async function, how to reconcile multiple updates coming in out of order.
 *
 * - "eager": Always apply the change as long as the update is newer than the last one.
 */
declare type AsyncDeriveFromStrategy = "eager";

declare class BackendInterface<TContext = never, TRpcEndpoints extends RpcEndpointsSpecBase = {}, TChannelEndpoints extends ChannelEndpointsSpecBase = {}, TSignalEndpoints extends SignalEndpointsSpecBase = {}, TWritableSignalEndpoints extends WritableSignalEndpointsSpecBase = {}> {
    private unhandledEndpoints;
    private existingEndpointNames;
    private rpcEndpoints;
    private channelEndpoints;
    private signalEndpoints;
    private writableSignalEndpoints;
    constructor();
    withContextType<TContextType>(): BackendInterface<TContextType, TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints>;
    private assertEndpointNameNotExists;
    /**
     * Register an Rpc endpoint.
     */
    addRpcEndpoint<TEndpointName extends string, TParametersZod extends ZodType, TReturnsZod extends ZodType>(endpointName: TEndpointName, { parameter, returns, serialization, }: {
        parameter: TParametersZod;
        returns: TReturnsZod;
        serialization?: SerializationType;
    }): BackendInterface<TContext, TRpcEndpoints & {
        [endpointName in TEndpointName]: {
            parameter: z.infer<TParametersZod>;
            returns: z.infer<TReturnsZod>;
        };
    }, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints>;
    addChannelEndpoint<TEndpointName extends string, TCreationParameterZod extends ZodType, TToServerPacketZod extends ZodType, TToClientPacketZod extends ZodType>(endpointName: TEndpointName, { creationParameter, toServerPacket, toClientPacket, serialization, }: {
        creationParameter: TCreationParameterZod;
        toServerPacket: TToServerPacketZod;
        toClientPacket: TToClientPacketZod;
        serialization?: SerializationType;
    }): BackendInterface<TContext, TRpcEndpoints, TChannelEndpoints & {
        [endpointName in TEndpointName]: {
            creationParameter: z.infer<TCreationParameterZod>;
            toServerPacket: z.infer<TToServerPacketZod>;
            toClientPacket: z.infer<TToClientPacketZod>;
        };
    }, TSignalEndpoints, TWritableSignalEndpoints>;
    addSignalEndpoint<TEndpointName extends string, TCreationParameterZod extends ZodType, TSignalDataZod extends ZodType>(endpointName: TEndpointName, { creationParameter, signalData, serialization, }: {
        creationParameter: TCreationParameterZod;
        signalData: TSignalDataZod;
        serialization?: SerializationType;
    }): BackendInterface<TContext, TRpcEndpoints, TChannelEndpoints, TSignalEndpoints & {
        [endpointName in TEndpointName]: {
            creationParameter: z.infer<TCreationParameterZod>;
            signalData: z.infer<TSignalDataZod>;
        };
    }, TWritableSignalEndpoints>;
    addWritableSignalEndpoint<TEndpointName extends string, TCreationParameterZod extends ZodType, TSignalDataZod extends ZodType>(endpointName: TEndpointName, { creationParameter, signalData, serialization, }: {
        creationParameter: TCreationParameterZod;
        signalData: TSignalDataZod;
        serialization?: SerializationType;
    }): BackendInterface<TContext, TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints & {
        [endpointName in TEndpointName]: {
            creationParameter: z.infer<TCreationParameterZod>;
            signalData: z.infer<TSignalDataZod>;
        };
    }>;
    /**
     * Adds a handler for an Rpc endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the endpoint is invoked. When
     * called, the first parameter is the context, and the second parameter is the "parameter" for the
     * RPC call. Can return a value or a promise that resolves to the result.
     */
    handleRpcEndpoint<TEndpointName extends keyof TRpcEndpoints & string>(endpointName: TEndpointName, handler: RpcEndpointHandler<TContext, TRpcEndpoints[TEndpointName]["parameter"], TRpcEndpoints[TEndpointName]["returns"]>): void;
    /**
     * Adds a handler for a channel endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the client creates a channel for
     * this endpoint. When called, the first parameter is the context, the second parameter is the
     * "creationParameter" for the channel, and the third parameter is a channel object that can be
     * used to send and receive messages from the client.
     *
     * Must return a promise. Once that promise is settled, the channel will be closed.
     */
    handleChannelEndpoint<TEndpointName extends keyof TChannelEndpoints & string>(endpointName: TEndpointName, handler: ChannelEndpointHandler<TContext, TChannelEndpoints[TEndpointName]["creationParameter"], TChannelEndpoints[TEndpointName]["toServerPacket"], TChannelEndpoints[TEndpointName]["toClientPacket"]>): void;
    /**
     * Adds a handler for a signal endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the client creates a signal, and at
     * least one subscriber is attached to that signal. When called, the first parameter is the
     * context, and the second parameter is the "creationParameter" for the signal. This method should
     * return a SignalLike, or a promise that resolves to a SignalLike.
     *
     * Note: There is no 1-to-1 correlation between the signal on the client side and the number of
     * times this handler is called. Every time the number of client subscribers changes from 0 to 1,
     * this handler will be called. Every time the number of client subscribers changes from 1 to 0,
     * the signal returned from this handler will be unsubscribed.
     *
     * Caution: Do NOT create new subscriptions that don't self-terminate in this handler, as it will
     * cause memory leaks. That is, either:
     *
     * - Return a signal that already exists
     * - Create and return a LazySignal
     */
    handleSignalEndpoint<TEndpointName extends keyof TSignalEndpoints & string>(endpointName: TEndpointName, handler: SignalEndpointHandler<TContext, TSignalEndpoints[TEndpointName]["creationParameter"], TSignalEndpoints[TEndpointName]["signalData"]>): void;
    /**
     * Adds a handler for a writable signal endpoint.
     *
     * @param endpointName - The name of the endpoint.
     * @param handler - The handler function. Will be called when the client creates a writable
     * signal, and at least one subscriber is attached to that signal. When called, the first
     * parameter is the context, and the second parameter is the "creationParameter" for the signal.
     * This method should return a tuple of the signal and an update function. The update function
     * should be called with the new data, patches, and tags to update the signal.
     *
     * Note: There is no 1-to-1 correlation between the signal on the client side and the number of
     * times this handler is called. Every time the number of client subscribers changes from 0 to 1,
     * this handler will be called. Every time the number of client subscribers changes from 1 to 0
     * the signal returned from this handler will be unsubscribed.
     *
     * Caution: Do NOT create new subscriptions that don't self-terminate in this handler, as it will
     * cause memory leaks. That is, either:
     *
     * - Return a signal that already exists
     * - Create and return a LazySignal
     */
    handleWritableSignalEndpoint<TEndpointName extends keyof TWritableSignalEndpoints & string>(endpointName: TEndpointName, handler: WritableSignalEndpointHandler<TContext, TWritableSignalEndpoints[TEndpointName]["creationParameter"], TWritableSignalEndpoints[TEndpointName]["signalData"]>): void;
    assertAllEndpointsHandled(): void;
    getRpcEndpoint(endpointName: string): RpcEndpoint | undefined;
    getAllRpcEndpoints(): RpcEndpoint[];
    getChannelEndpoint(endpointName: string): ChannelEndpoint | undefined;
    getAllChannelEndpoints(): ChannelEndpoint[];
    getSignalEndpoint(endpointName: string): SignalEndpoint | undefined;
    getAllSignalEndpoints(): SignalEndpoint[];
    getWritableSignalEndpoint(endpointName: string): WritableSignalEndpoint | undefined;
    getAllWritableSignalEndpoints(): WritableSignalEndpoint[];
}

/**
 * @public
 */
export declare interface BackendNotification {
    title: string;
    description?: string;
    noAutoDismiss?: boolean;
}

/**
 * The base class for all controllers.
 *
 * @public
 * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
 * future without warning.
 */
export declare abstract class BaseController {
    /**
     * The LM Studio client instance. Use this to interact with the LM Studio API.
     */
    readonly client: LMStudioClient;
    /**
     * The abort signal that you should listen to for cancellation requests.
     *
     * See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal for more information about
     * abort signals.
     */
    readonly abortSignal: AbortSignal;
    private readonly pluginConfig;
    private readonly globalPluginConfig;
    private readonly workingDirectoryPath;
    constructor(
    /**
     * The LM Studio client instance. Use this to interact with the LM Studio API.
     */
    client: LMStudioClient, 
    /**
     * The abort signal that you should listen to for cancellation requests.
     *
     * See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal for more information about
     * abort signals.
     */
    abortSignal: AbortSignal, pluginConfig: KVConfig, globalPluginConfig: KVConfig, workingDirectoryPath: string | null);
    /**
     * Gets the working directory for the current prediction. If your plugin produces files, you
     * should aim to put them in this directory.
     */
    getWorkingDirectory(): string;
    /**
     * Get the per-chat config for the plugin. Takes in the configSchematics. You can get the
     * values of fields like so:
     *
     * ```ts
     * const config = ctl.getPluginConfig(configSchematics);
     * const value = config.get("fieldKey");
     * ```
     *
     * @remarks
     *
     * If you need to name the type of the returned value, use:
     *
     * `InferParsedConfig<typeof configSchematics>`.
     *
     * Example:
     *
     * ```ts
     * function myFunction(config: InferParsedConfig<typeof configSchematics>) {
     *   // ...
     * }
     *
     * myFunction(ctl.getPluginConfig(configSchematics));
     * ```
     */
    getPluginConfig<TVirtualConfigSchematics extends VirtualConfigSchematics>(configSchematics: ConfigSchematics<TVirtualConfigSchematics>): ParsedConfig<TVirtualConfigSchematics>;
    /**
     * Get the application-wide config for the plugin. Takes in the globalConfigSchematics. You can
     * get the values of fields like so:
     *
     * ```ts
     * const config = ctl.getGlobalPluginConfig(globalConfigSchematics);
     * const value = config.get("fieldKey");
     * ```
     *
     * @remarks
     *
     * If you need to name the type of the returned value, use:
     *
     * `InferParsedConfig<typeof globalConfigSchematics>`.
     *
     * Example:
     *
     * ```ts
     * function myFunction(config: InferParsedConfig<typeof globalConfigSchematics>) {
     *   // ...
     * }
     *
     * myFunction(ctl.getGlobalPluginConfig(globalConfigSchematics));
     * ```
     */
    getGlobalPluginConfig<TVirtualConfigSchematics extends VirtualConfigSchematics>(globalConfigSchematics: ConfigSchematics<TVirtualConfigSchematics>): ParsedConfig<TVirtualConfigSchematics>;
    /**
     * Provides a callback that will be called when the prediction is aborted. If the prediction is
     * already aborted, the callback will be called immediately.
     *
     * You can also use {@link BaseController.abortSignal} if you are using an async function that
     * supports abort signals.
     *
     * See https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal for more information about
     * abort signals.
     */
    onAborted(callback: () => void): void;
}

/** @public */
export declare interface BaseLoadModelOpts<TLoadModelConfig> {
    /**
     * The identifier to use for the loaded model.
     *
     * By default, the identifier is the same as the path (1st parameter). If the identifier already
     * exists, a number will be attached. This option allows you to specify the identifier to use.
     *
     * However, when the identifier is specified and it is in use, an error will be thrown. If the
     * call is successful, it is guaranteed that the loaded model will have the specified identifier.
     */
    identifier?: string;
    /**
     * The configuration to use when loading the model.
     */
    config?: TLoadModelConfig;
    /**
     * An `AbortSignal` to cancel the model loading. This is useful if you wish to add a functionality
     * to cancel the model loading.
     *
     * Example usage:
     *
     * ```typescript
     * const ac = new AbortController();
     * const model = await client.llm.load({
     *   model: "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF",
     *   signal: ac.signal,
     * });
     *
     * // Later, to cancel the model loading
     * ac.abort();
     * ```
     *
     * AbortController/AbortSignal is the standard method for cancelling an asynchronous operation in
     * JavaScript. For more information, visit
     * https://developer.mozilla.org/en-US/docs/Web/API/AbortController
     */
    signal?: AbortSignal;
    /**
     * Idle time to live (TTL) in seconds. If specified, when the model is not used for the specified number
     * of seconds, the model will be automatically unloaded. If the model is used before the TTL, the
     * timer will be reset.
     */
    ttl?: number;
    /**
     * Controls the logging of model loading progress.
     *
     * - If set to `true`, logs progress at the "info" level.
     * - If set to `false`, no logs are emitted. This is the default.
     * - If a specific logging level is desired, it can be provided as a string. Acceptable values are
     *   "debug", "info", "warn", and "error".
     *
     * Logs are directed to the logger specified during the `LMStudioClient` construction.
     *
     * Progress logs will be disabled if an `onProgress` callback is provided.
     *
     * Default value is "info", which logs progress at the "info" level.
     */
    verbose?: boolean | LogLevel;
    /**
     * A function that is called with the progress of the model loading. The function is called with a
     * number between 0 and 1, inclusive, representing the progress of the model loading.
     *
     * If an `onProgress` callback is provided, verbose progress logs will be disabled.
     */
    onProgress?: (progress: number) => void;
}

/**
 * Base interface for all prediction result types, including those that are produced by an LLM and
 * those that are produced by a generator plugin.
 *
 * @public
 */
export declare interface BasePredictionResult {
    /**
     * The generated content of the prediction result.
     */
    content: string;
    /**
     * Part of the generated text that is "reasoning" content. For example, text inside <think>
     * tags.
     */
    reasoningContent: string;
    /**
     * Part of the generated text that is not "reasoning" content. For example, text outside <think>
     * tags.
     */
    nonReasoningContent: string;
}

/**
 * @public
 */
declare type BasicKVFieldValueTypeLibraryMap = BasicKVValueTypesLibrary extends KVFieldValueTypeLibrary<infer TKVFieldValueTypeLibraryMap> ? TKVFieldValueTypeLibraryMap : never;

declare type BasicKVValueTypesLibrary = typeof basicKVValueTypesLibrary;

/**
 * Basic key-value field value types library. These are the types that are exposed to plugins.
 *
 * @public
 */
declare const basicKVValueTypesLibrary: KVFieldValueTypeLibrary<{
    numeric: {
        value: number;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            step?: number | undefined;
            int?: boolean | undefined;
            precision?: number | undefined;
            slider?: {
                min: number;
                max: number;
                step: number;
            } | undefined;
            shortHand?: string | undefined;
        };
    };
} & {
    string: {
        value: string;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            minLength?: number | undefined;
            maxLength?: number | undefined;
            isParagraph?: boolean | undefined;
            isProtected?: boolean | undefined;
            isToken?: boolean | undefined;
            placeholder?: string | undefined;
        };
    };
} & {
    select: {
        value: string;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: {
                key: string;
                condition: {
                    type: "equals";
                    value: any;
                } | {
                    type: "notEquals";
                    value: any;
                };
            }[] | undefined;
            options: (string | {
                value: string;
                displayName: string;
            })[];
        };
    };
} & {
    boolean: {
        value: boolean;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    stringArray: {
        value: string[];
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            maxNumItems?: number | undefined;
            allowEmptyStrings?: boolean | undefined;
        };
    };
}>;

declare type BlockLocation = {
    type: "beforeId";
    id: string;
} | {
    type: "afterId";
    id: string;
};

/**
 * A buffered event will buffer events in a queue if no subscribers are present. When a subscriber
 * is added, all buffered events will trigger sequentially in the next microtask.
 *
 * Similar to Event, events are always emitted during the next microtask.
 *
 * Attempting to add more than one subscriber will resulting in an error.
 */
declare class BufferedEvent<TData> extends Subscribable<TData> {
    private subscriber;
    private queued;
    private isNotifying;
    static create<TData>(): readonly [BufferedEvent<TData>, (data: TData) => void];
    private constructor();
    private emit;
    private notifier;
    subscribe(listener: Listener<TData>): () => void;
    /**
     * Convert this buffered event to an event by stop buffering and triggering events on the new
     * returned event.
     */
    flow(): Event_2<TData>;
}

declare class Channel<TIncomingPacket, TOutgoingPacket> {
    private readonly innerSend;
    /**
     * Trigger when a message is received.
     */
    readonly onMessage: BufferedEvent<TIncomingPacket>;
    private readonly emitOnMessage;
    /**
     * Triggers when the underlying transport has errored out.
     */
    readonly onError: BufferedEvent<any>;
    private readonly emitOnError;
    /**
     * Triggers when the channel has been properly closed and no more messages will be sent or
     * received.
     */
    readonly onClose: BufferedEvent<void>;
    private readonly emitOnClose;
    readonly connectionStatus: Signal<ConnectionStatus>;
    readonly setConnectionStatus: (status: ConnectionStatus) => void;
    private nextAckId;
    /**
     * A map for messages that are waiting for an ACK. The values are the functions to resolve or
     * reject the corresponding promise.
     */
    private readonly waitingForAck;
    private constructor();
    private rejectAllWaitingForAck;
    /**
     * Returned as a part of create. It should be called by the controlling port.
     */
    private receivedACK;
    /**
     * Returned as a part of create. It should be called by the controlling port.
     */
    private receivedMessage;
    /**
     * Returned as a part of create. It should be called by the controlling port.
     */
    private errored;
    /**
     * Returned as a part of create. It should be called by the controlling port.
     */
    private closed;
    static create<TIncomingPacket, TOutgoingPacket>(innerSend: (packet: TOutgoingPacket, ackId?: number) => void): {
        channel: Channel<TIncomingPacket, TOutgoingPacket>;
        receivedAck: (ackId: number) => void;
        receivedMessage: (packet: TIncomingPacket) => void;
        errored: (error: any) => void;
        closed: () => void;
    };
    send(packet: TOutgoingPacket): void;
    sendAndWaitForACK(packet: TOutgoingPacket): Promise<void>;
}

declare interface ChannelEndpoint {
    name: string;
    creationParameter: z.ZodType;
    toServerPacket: z.ZodType;
    toClientPacket: z.ZodType;
    serialization: SerializationType;
    handler: ChannelEndpointHandler | null;
}

declare type ChannelEndpointHandler<TContext = any, TCreationParameter = any, TToServerPacket = any, TToClientPacket = any> = (ctx: TContext, creationParameter: TCreationParameter, channel: Channel<TToServerPacket, TToClientPacket>) => Promise<void>;

declare interface ChannelEndpointSpecBase {
    creationParameter: any;
    toServerPacket: any;
    toClientPacket: any;
}

declare type ChannelEndpointsSpecBase = {
    [endpointName: string]: ChannelEndpointSpecBase;
};

/**
 * Represents a chat history.
 *
 * @public
 */
export declare class Chat extends MaybeMutable<ChatHistoryData> {
    protected getClassName(): string;
    protected create(data: ChatHistoryData, mutable: boolean): this;
    protected cloneData(data: ChatHistoryData): ChatHistoryData;
    /**
     * Don't use this constructor directly.
     *
     * - To create an empty chat history, use `Chat.empty()`.
     * - To create a chat history with existing data, use `Chat.from()`.
     */
    protected constructor(data: ChatHistoryData, mutable: boolean);
    /**
     * Creates an empty mutable chat history.
     */
    static empty(): Chat;
    /**
     * Quickly create a mutable chat history with something that can be converted to a chat history.
     *
     * The created chat history will be a mutable copy of the input.
     *
     * @example
     * ```ts
     * const history = Chat.from([
     *   { role: "user", content: "Hello" },
     *   { role: "assistant", content: "Hi!" },
     *   { role: "user", content: "What is your name?" },
     * ]);
     * ```
     */
    static from(initializer: ChatLike): Chat;
    /**
     * Append a text message to the history.
     */
    append(role: ChatMessageRoleData, content: string, opts?: ChatAppendOpts): void;
    /**
     * Append a message to the history.
     */
    append(message: ChatMessageLike): void;
    /**
     * Make a copy of this history and append a text message to the copy. Return the copy.
     */
    withAppended(role: ChatMessageRoleData, content: string, opts?: ChatAppendOpts): Chat;
    /**
     * Make a copy of this history and append a message to the copy. Return the copy.
     */
    withAppended(message: ChatMessageLike): Chat;
    /**
     * Get the number of messages in the history.
     */
    getLength(): number;
    /**
     * Get the number of messages in the history.
     */
    get length(): number;
    /**
     * Remove the last message from the history. If the history is empty, this method will throw.
     */
    pop(): ChatMessage;
    /**
     * Gets all files contained in this history.
     *
     * @param client - LMStudio client
     */
    getAllFiles(client: LMStudioClient): Array<FileHandle>;
    /**
     * Allows iterating over the files in the history.
     */
    files(client: LMStudioClient): Generator<FileHandle>;
    /**
     * Returns true if this history contains any files.
     */
    hasFiles(): boolean;
    /**
     * Gets the message at the given index. If the index is negative, it will be counted from the end.
     *
     * If the index is out of bounds, this method will throw as oppose to returning undefined. This is
     * to help catch bugs early.
     */
    at(index: number): ChatMessage;
    /**
     * Get all the messages in the history as an array of ChatMessage objects.
     */
    getMessagesArray(): Array<ChatMessage>;
    /**
     * Maps over the messages in the history and returns an array of the results.
     */
    map<TOutput>(mapper: (message: ChatMessage, index: number, array: Array<ChatMessage>) => TOutput): Array<TOutput>;
    /**
     * Maps over the messages in the history and returns a flattened array of the results.
     *
     * This is similar to `Array.prototype.flatMap`, but it works with ChatMessage objects.
     */
    flatMap<TOutput>(mapper: (message: ChatMessage, index: number, array: Array<ChatMessage>) => ReadonlyArray<TOutput> | TOutput): Array<TOutput>;
    /**
     * Allows iterating over the messages in the history.
     */
    [Symbol.iterator](): Generator<ChatMessage>;
    /**
     * Given a predicate, the predicate is called for each file in the history.
     *
     * - If the predicate returns true, the file is removed from the history and is collected into the
     *   returned array.
     * - If the predicate returns false, the file is kept in the history.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If the predicate needs to be async, use the {@link Chat#consumeFilesAsync} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    consumeFiles(client: LMStudioClient, predicate: (file: FileHandle) => boolean): FileHandle[];
    /**
     * Given an async predicate, the predicate is called for each file in the history.
     *
     * - If the predicate returns true, the file is removed from the history and is collected into the
     *  returned array.
     * - If the predicate returns false, the file is kept in the history.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If you need a synchronous version, use the {@link Chat#consumeFiles} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    consumeFilesAsync(client: LMStudioClient, predicate: (file: FileHandle) => Promise<boolean>): Promise<FileHandle[]>;
    getSystemPrompt(): string;
    replaceSystemPrompt(content: string): void;
    filterInPlace(predicate: (message: ChatMessage) => boolean): void;
    toString(): string;
}

/**
 * Options to use with {@link Chat#append}.
 *
 * @public
 */
export declare interface ChatAppendOpts {
    images?: Array<FileHandle>;
}

/**
 * @public
 */
export declare interface ChatHistoryData {
    messages: Array<ChatMessageData>;
}

/**
 * This type provides an easy way of specifying a chat history.
 *
 * Example:
 *
 * ```ts
 * const chat = Chat.from([
 *   { role: "user", content: "Hello" },
 *   { role: "assistant", content: "Hi" },
 *   { role: "user", content: "How are you?" },
 * ]);
 * ```
 *
 * @public
 */
export declare type ChatInput = Array<ChatMessageInput>;

/**
 * Represents anything that can be converted to a Chat. If you want to quickly construct a
 * Chat, use {@link ChatInput}.
 *
 * If a string is provided, it will be converted to a chat history with a single user message with
 * the provided text.
 *
 * @public
 */
export declare type ChatLike = ChatInput | string | Chat | ChatMessageInput | ChatHistoryData;

/**
 * Represents a single message in the history.
 *
 * @public
 */
export declare class ChatMessage extends MaybeMutable<ChatMessageData> {
    protected getClassName(): string;
    protected create(data: ChatMessageData, mutable: boolean): this;
    protected cloneData(data: ChatMessageData): ChatMessageData;
    protected constructor(data: ChatMessageData, mutable: boolean);
    /**
     * Create a mutable text only message.
     */
    static create(role: ChatMessageRoleData, content: string): ChatMessage;
    /**
     * Quickly create a mutable message with something that can be converted to a message.
     */
    static from(initializer: ChatMessageLike): ChatMessage;
    getRole(): "user" | "assistant" | "system" | "tool";
    setRole(role: ChatMessageRoleData): void;
    private getFileParts;
    /**
     * Gets all text contained in this message.
     */
    getText(): string;
    /**
     * Get all tool call results within this message.
     */
    getToolCallResults(): Array<ToolCallResult>;
    /**
     * Gets all file parts contained in this message.
     */
    getToolCallRequests(): Array<ToolCallRequest>;
    /**
     * Gets all files contained in this message.
     *
     * @param client - LMStudio client
     */
    getFiles(client: LMStudioClient): FileHandle[];
    /**
     * Allows iterating over the files in the message.
     */
    files(client: LMStudioClient): Generator<FileHandle>;
    /**
     * Given a predicate, the predicate is called for each file in the message.
     *
     * - If the predicate returns true, the file is removed from the message and is collected into the
     *   returned array.
     * - If the predicate returns false, the file is kept in the message.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If the predicate needs to be async, use the {@link ChatMessage#consumeFilesAsync} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    consumeFiles(client: LMStudioClient, predicate: (file: FileHandle) => boolean): FileHandle[];
    /**
     * Given an async predicate, the predicate is called for each file in the message.
     *
     * - If the predicate returns true, the file is removed from the message and is collected into the
     *  returned array.
     * - If the predicate returns false, the file is kept in the message.
     *
     * This method is useful if you are implementing a promptPreprocessor that needs to convert certain
     * types of files.
     *
     * If you need a synchronous version, use the {@link ChatMessage#consumeFiles} method.
     *
     * @param client - LMStudio client
     * @param predicate - The predicate to call for each file.
     * @returns The files that were consumed.
     */
    consumeFilesAsync(client: LMStudioClient, predicate: (file: FileHandle) => Promise<boolean>): Promise<FileHandle[]>;
    /**
     * Returns true if this message contains any files.
     */
    hasFiles(): boolean;
    /**
     * Append text to the message.
     */
    appendText(text: string): void;
    /**
     * Append a file to the message. Takes in a FileHandle. You can obtain a FileHandle from
     * `client.files.prepareImage`.
     */
    appendFile(file: FileHandle): void;
    /**
     * Replaces all text in the messages.
     *
     * If the message contains other components (such as files), they will kept. The replaced text
     * will be inserted to the beginning of the message.
     */
    replaceText(text: string): void;
    isSystemPrompt(): boolean;
    isUserMessage(): boolean;
    isAssistantMessage(): boolean;
    toString(): string;
}

/**
 * @public
 */
export declare type ChatMessageData = {
    role: "assistant";
    content: Array<ChatMessagePartTextData | ChatMessagePartFileData | ChatMessagePartToolCallRequestData>;
} | {
    role: "user";
    content: Array<ChatMessagePartTextData | ChatMessagePartFileData>;
} | {
    role: "system";
    content: Array<ChatMessagePartTextData | ChatMessagePartFileData>;
} | {
    role: "tool";
    content: Array<ChatMessagePartToolCallResultData>;
};

/**
 * This type provides an easy way of specifying a single chat message.
 *
 * @public
 */
export declare interface ChatMessageInput {
    /**
     * The sender of this message. Only "user", "assistant", and "system" is allowed. Defaults to
     * "user" if not specified.
     */
    role?: "user" | "assistant" | "system";
    /**
     * Text content of the message.
     */
    content?: string;
    /**
     * Images to be sent with the message to be used with vision models. To get a FileHandle, use
     * `client.files.prepareImage`.
     */
    images?: Array<FileHandle>;
}

/**
 * Represents something that can be converted to a ChatMessage.
 *
 * If a string is provided, it will be converted to a message sent by the user.
 *
 * @public
 */
export declare type ChatMessageLike = ChatMessageInput | string | ChatMessage | ChatMessageData;

/**
 * @public
 */
export declare type ChatMessagePartData = ChatMessagePartTextData | ChatMessagePartFileData | ChatMessagePartToolCallRequestData | ChatMessagePartToolCallResultData;

/**
 * @public
 */
export declare interface ChatMessagePartFileData {
    type: "file";
    /**
     * Original file name that is uploaded.
     */
    name: string;
    /**
     * Internal identifier for the file. Autogenerated, and is unique.
     */
    identifier: string;
    /**
     * Size of the file in bytes.
     */
    sizeBytes: number;
    /**
     * Type of the file.
     */
    fileType: FileType;
}

/**
 * @public
 */
export declare interface ChatMessagePartTextData {
    type: "text";
    text: string;
}

/**
 * @public
 */
export declare interface ChatMessagePartToolCallRequestData {
    type: "toolCallRequest";
    /**
     * Tool calls requested
     */
    toolCallRequest: ToolCallRequest;
}

/**
 * @public
 */
export declare interface ChatMessagePartToolCallResultData extends ToolCallResult {
    type: "toolCallResult";
}

/**
 * @public
 */
export declare type ChatMessageRoleData = "assistant" | "user" | "system" | "tool";

/**
 * Represents a source of a citation.
 *
 * @public
 */
export declare interface CitationSource {
    fileName: string;
    absoluteFilePath?: string;
    pageNumber?: number | [start: number, end: number];
    lineNumber?: number | [start: number, end: number];
}

declare class Cleaner {
    private eagerCleaned;
    private readonly disposed;
    private readonly cleanups;
    register(fn: () => void): void;
    private runCleanersInternal;
    [Symbol.dispose](): void;
    eagerClean(): void;
}

declare class ClientPort<TRpcEndpoints extends RpcEndpointsSpecBase, TChannelEndpoints extends ChannelEndpointsSpecBase, TSignalEndpoints extends SignalEndpointsSpecBase, TWritableSignalEndpoints extends WritableSignalEndpointsSpecBase> {
    readonly backendInterface: BackendInterface<unknown, TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints>;
    private readonly transport;
    private readonly logger;
    private openChannels;
    private ongoingRpcs;
    private openSignalSubscriptions;
    private openWritableSignalSubscriptions;
    private openCommunicationsCount;
    private nextChannelId;
    private nextSubscribeId;
    private nextWritableSubscribeId;
    private producedCommunicationWarningsCount;
    private errorDeserializer;
    private verboseErrorMessage;
    constructor(backendInterface: BackendInterface<unknown, TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints>, factory: ClientTransportFactory, { parentLogger, errorDeserializer, verboseErrorMessage, }?: {
        parentLogger?: LoggerInterface;
        errorDeserializer?: (serialized: SerializedLMSExtendedError, directCause: string, stack?: string) => Error;
        verboseErrorMessage?: boolean;
    });
    private communicationWarning;
    private updateOpenCommunicationsCount;
    private receivedChannelSend;
    private receivedChannelAck;
    private receivedChannelClose;
    private receivedChannelError;
    private receivedRpcResult;
    private receivedRpcError;
    private receivedSignalUpdate;
    private receivedSignalError;
    private receivedWritableSignalUpdate;
    private receivedWritableSignalError;
    private receivedCommunicationWarning;
    private receivedKeepAliveAck;
    private receivedMessage;
    private errored;
    callRpc<TEndpointName extends keyof TRpcEndpoints & string>(endpointName: TEndpointName, param: TRpcEndpoints[TEndpointName]["parameter"], { stack }?: {
        stack?: string;
    }): Promise<TRpcEndpoints[TEndpointName]["returns"]>;
    createChannel<TEndpointName extends keyof TChannelEndpoints & string>(endpointName: TEndpointName, param: TChannelEndpoints[TEndpointName]["creationParameter"], onMessage?: (message: TChannelEndpoints[TEndpointName]["toClientPacket"]) => void, { stack }?: {
        stack?: string;
    }): Channel<TChannelEndpoints[TEndpointName]["toClientPacket"], TChannelEndpoints[TEndpointName]["toServerPacket"]>;
    /**
     * Creates a readonly lazy signal will subscribe to the signal endpoint with the given name.
     */
    createSignal<TEndpointName extends keyof TSignalEndpoints & string>(endpointName: TEndpointName, param: TSignalEndpoints[TEndpointName]["creationParameter"], { stack }?: {
        stack?: string;
    }): LazySignal<TSignalEndpoints[TEndpointName]["signalData"] | NotAvailable>;
    createWritableSignal<TEndpointName extends keyof TWritableSignalEndpoints & string>(endpointName: TEndpointName, param: TWritableSignalEndpoints[TEndpointName]["creationParameter"], { stack }?: {
        stack?: string;
    }): [
    signal: OWLSignal<TWritableSignalEndpoints[TEndpointName]["signalData"] | NotAvailable>,
    setter: Setter<TWritableSignalEndpoints[TEndpointName]["signalData"]>
    ];
    [Symbol.asyncDispose](): Promise<void>;
}

declare type ClientToServerMessage = z.infer<typeof clientToServerMessageSchema>;

declare const clientToServerMessageSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"communicationWarning">;
    warning: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "communicationWarning";
    warning: string;
}, {
    type: "communicationWarning";
    warning: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"keepAlive">;
}, "strip", z.ZodTypeAny, {
    type: "keepAlive";
}, {
    type: "keepAlive";
}>, z.ZodObject<{
    type: z.ZodLiteral<"channelCreate">;
    endpoint: z.ZodString;
    channelId: z.ZodNumber;
    creationParameter: z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>;
}, "strip", z.ZodTypeAny, {
    creationParameter: SerializedOpaque<any>;
    type: "channelCreate";
    endpoint: string;
    channelId: number;
}, {
    creationParameter: SerializedOpaque<any>;
    type: "channelCreate";
    endpoint: string;
    channelId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"channelSend">;
    channelId: z.ZodNumber;
    message: z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>;
    ackId: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    message: SerializedOpaque<any>;
    type: "channelSend";
    channelId: number;
    ackId?: number | undefined;
}, {
    message: SerializedOpaque<any>;
    type: "channelSend";
    channelId: number;
    ackId?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"channelAck">;
    channelId: z.ZodNumber;
    ackId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "channelAck";
    channelId: number;
    ackId: number;
}, {
    type: "channelAck";
    channelId: number;
    ackId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"rpcCall">;
    endpoint: z.ZodString;
    callId: z.ZodNumber;
    parameter: z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>;
}, "strip", z.ZodTypeAny, {
    parameter: SerializedOpaque<any>;
    type: "rpcCall";
    endpoint: string;
    callId: number;
}, {
    parameter: SerializedOpaque<any>;
    type: "rpcCall";
    endpoint: string;
    callId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"signalSubscribe">;
    creationParameter: z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>;
    endpoint: z.ZodString;
    subscribeId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    creationParameter: SerializedOpaque<any>;
    type: "signalSubscribe";
    endpoint: string;
    subscribeId: number;
}, {
    creationParameter: SerializedOpaque<any>;
    type: "signalSubscribe";
    endpoint: string;
    subscribeId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"signalUnsubscribe">;
    subscribeId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "signalUnsubscribe";
    subscribeId: number;
}, {
    type: "signalUnsubscribe";
    subscribeId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"writableSignalSubscribe">;
    creationParameter: z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>;
    endpoint: z.ZodString;
    subscribeId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    creationParameter: SerializedOpaque<any>;
    type: "writableSignalSubscribe";
    endpoint: string;
    subscribeId: number;
}, {
    creationParameter: SerializedOpaque<any>;
    type: "writableSignalSubscribe";
    endpoint: string;
    subscribeId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"writableSignalUnsubscribe">;
    subscribeId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "writableSignalUnsubscribe";
    subscribeId: number;
}, {
    type: "writableSignalUnsubscribe";
    subscribeId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"writableSignalUpdate">;
    subscribeId: z.ZodNumber;
    patches: z.ZodArray<z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>, "many">;
    tags: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    type: "writableSignalUpdate";
    subscribeId: number;
    patches: SerializedOpaque<any>[];
    tags: string[];
}, {
    type: "writableSignalUpdate";
    subscribeId: number;
    patches: SerializedOpaque<any>[];
    tags: string[];
}>]>;

declare abstract class ClientTransport extends Transport<ServerToClientMessage, ClientToServerMessage> {
    protected parseIncomingMessage(message: any): ServerToClientMessage;
    send(message: ClientToServerMessage): void;
    /**
     * Called by the client port when the number of open communications changes from 0 to 1. This
     * usually indicates the `socket.ref()` should be called to prevent the process from exiting.
     */
    onHavingOneOrMoreOpenCommunication(): void;
    onHavingNoOpenCommunication(): void;
}

declare type ClientTransportFactory = (receivedMessage: (message: ServerToClientMessage) => void, errored: (error: any) => void, parentLogger: LoggerInterface) => ClientTransport;

/**
 * Theme color options.
 *
 * @public
 */
export declare type ColorPalette = "red" | "green" | "blue" | "yellow" | "orange" | "purple" | "default";

/**
 * @public
 */
export declare interface ConfigSchematics<TVirtualConfigSchematics extends VirtualConfigSchematics> {
    [configSchematicsBrand]?: TVirtualConfigSchematics;
}

declare const configSchematicsBrand: unique symbol;

/**
 * The opaque type for KVConfigSchematicsBuilder that is exposed in lmstudio.js SDK. Notably, this
 * has significantly simplified types and is easier to use.
 *
 * @public
 */
export declare interface ConfigSchematicsBuilder<TVirtualConfigSchematics extends VirtualConfigSchematics> {
    [configSchematicsBuilderBrand]?: TVirtualConfigSchematics;
    /**
     * Adds a field to the config schematics.
     */
    field<TKey extends string, TValueTypeKey extends keyof BasicKVFieldValueTypeLibraryMap & string>(key: TKey, valueTypeKey: TValueTypeKey, valueTypeParams: BasicKVFieldValueTypeLibraryMap[TValueTypeKey]["param"], defaultValue: BasicKVFieldValueTypeLibraryMap[TValueTypeKey]["value"]): ConfigSchematicsBuilder<TVirtualConfigSchematics & {
        [key in TKey]: {
            key: TKey;
            type: BasicKVFieldValueTypeLibraryMap[TValueTypeKey]["value"];
            valueTypeKey: TValueTypeKey;
        };
    }>;
    /**
     * Adds a "scope" to the config schematics. This is useful for grouping fields together.
     */
    scope<TScopeKey extends string, TInnerVirtualConfigSchematics extends VirtualConfigSchematics>(scopeKey: TScopeKey, fn: (builder: ConfigSchematicsBuilder<{}>) => ConfigSchematicsBuilder<TInnerVirtualConfigSchematics>): ConfigSchematicsBuilder<TVirtualConfigSchematics & {
        [InnerKey in keyof TInnerVirtualConfigSchematics & string as `${TScopeKey}.${InnerKey}`]: TInnerVirtualConfigSchematics[InnerKey];
    }>;
    build(): ConfigSchematics<TVirtualConfigSchematics>;
}

declare const configSchematicsBuilderBrand: unique symbol;

declare enum ConnectionStatus {
    /**
     * The underlying transport is connected and is communicating properly.
     */
    Connected = "CONNECTED",
    /**
     * The underlying transport has errored out.
     */
    Errored = "ERRORED",
    /**
     * The channel has been properly closed and no more messages will be sent or received.
     */
    Closed = "CLOSED"
}

/**
 * Options to use with {@link PredictionProcessContentBlockController#appendText}.
 *
 * @public
 */
export declare interface ContentBlockAppendTextOpts {
    tokensCount?: number;
    fromDraftModel?: boolean;
    /**
     * @experimental WIP - do not use yet.
     */
    isStructural?: boolean;
}

/**
 * Options to use with {@link PredictionProcessContentBlockController#appendToolRequest}.
 *
 * @public
 */
export declare interface ContentBlockAppendToolRequestOpts {
    callId: number;
    toolCallRequestId?: string;
    name: string;
    parameters: Record<string, any>;
    pluginIdentifier?: string;
}

/**
 * Options to use with {@link PredictionProcessContentBlockController#appendToolResult}.
 *
 * @public
 */
export declare interface ContentBlockAppendToolResultOpts {
    callId: number;
    toolCallRequestId?: string;
    content: string;
}

/**
 * Options to use with {@link PredictionProcessContentBlockController#replaceToolRequest}.
 *
 * @public
 */
export declare interface ContentBlockReplaceToolRequestOpts {
    callId: number;
    toolCallRequestId?: string;
    name: string;
    parameters: Record<string, any>;
    pluginIdentifier?: string;
}

/**
 * The style of a content block.
 *
 * @public
 */
export declare type ContentBlockStyle = {
    type: "default";
} | {
    type: "customLabel";
    label: string;
    color?: ColorPalette;
} | {
    type: "thinking";
    ended?: boolean;
    title?: string;
};

/**
 * Options to use with {@link RepositoryNamespace#createArtifactDownloadPlanner}.
 *
 * @public
 */
export declare interface CreateArtifactDownloadPlannerOpts {
    owner: string;
    name: string;
    onPlanUpdated?: (plan: ArtifactDownloadPlan) => void;
}

/**
 * Options to use with {@link ProcessingController#createCitationBlock}.
 *
 * @public
 */
export declare interface CreateCitationBlockOpts {
    fileName: string;
    fileIdentifier: string;
    pageNumber?: number | [start: number, end: number];
    lineNumber?: number | [start: number, end: number];
}

/**
 * @public
 */
export declare function createConfigSchematics(): ConfigSchematicsBuilder<{}>;

/**
 * Options to use with {@link ProcessingController#createContentBlock}.
 *
 * @public
 */
export declare interface CreateContentBlockOpts {
    roleOverride?: "user" | "assistant" | "system" | "tool";
    includeInContext?: boolean;
    style?: ContentBlockStyle;
    prefix?: string;
    suffix?: string;
}

declare function createPluginsBackendInterface(): BackendInterface<never, {
    reindexPlugins: {
        parameter: void;
        returns: void;
    };
} & {
    processingHandleUpdate: {
        parameter: {
            pci: string;
            token: string;
            update: ProcessingUpdate;
        };
        returns: void;
    };
} & {
    processingHandleRequest: {
        parameter: {
            pci: string;
            token: string;
            request: ProcessingRequest;
        };
        returns: {
            response: ProcessingRequestResponse;
        };
    };
} & {
    processingPullHistory: {
        parameter: {
            pci: string;
            token: string;
            includeCurrent: boolean;
        };
        returns: {
            messages: ({
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                } | {
                    type: "toolCallRequest";
                    toolCallRequest: FunctionToolCallRequest;
                })[];
                role: "assistant";
            } | {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                })[];
                role: "user";
            } | {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                })[];
                role: "system";
            } | {
                content: {
                    type: "toolCallResult";
                    content: string;
                    toolCallId?: string | undefined;
                }[];
                role: "tool";
            })[];
        };
    };
} & {
    processingGetOrLoadTokenSource: {
        parameter: {
            pci: string;
            token: string;
        };
        returns: {
            tokenSourceIdentifier: TokenSourceIdentifier;
        };
    };
} & {
    processingHasStatus: {
        parameter: {
            pci: string;
            token: string;
        };
        returns: boolean;
    };
} & {
    processingNeedsNaming: {
        parameter: {
            pci: string;
            token: string;
        };
        returns: boolean;
    };
} & {
    processingSuggestName: {
        parameter: {
            name: string;
            pci: string;
            token: string;
        };
        returns: void;
    };
} & {
    processingSetSenderName: {
        parameter: {
            name: string;
            pci: string;
            token: string;
        };
        returns: void;
    };
} & {
    setConfigSchematics: {
        parameter: {
            schematics: SerializedKVConfigSchematics;
        };
        returns: void;
    };
} & {
    setGlobalConfigSchematics: {
        parameter: {
            schematics: SerializedKVConfigSchematics;
        };
        returns: void;
    };
} & {
    pluginInitCompleted: {
        parameter: void;
        returns: void;
    };
}, {
    startToolUseSession: {
        creationParameter: {
            pluginIdentifier: string;
            pluginConfigSpecifier: {
                type: "direct";
                config: {
                    fields: {
                        key: string;
                        value?: any;
                    }[];
                };
                workingDirectoryPath?: string | undefined;
            } | {
                type: "predictionProcess";
                pci: string;
                token: string;
            };
        };
        toServerPacket: {
            type: "callTool";
            name: string;
            callId: number;
            arguments?: any;
        } | {
            type: "abortToolCall";
            callId: number;
        } | {
            type: "discardSession";
        };
        toClientPacket: {
            type: "sessionReady";
            toolDefinitions: {
                function: {
                    name: string;
                    description?: string | undefined;
                    parameters?: {
                        type: "object";
                        properties: Record<string, any>;
                        required? /**
                        * Client requests to discard the session. Upon calling this, the channel will be closed.
                        */: string[] | undefined;
                        additionalProperties?: boolean | undefined;
                        $defs?: Record<string, any> | undefined;
                    } | undefined;
                };
                type: "function";
            }[];
        } | {
            type: "toolCallComplete";
            callId: number;
            result?: any;
        } | {
            type: "toolCallError";
            error: {
                title: string;
                cause?: string | undefined;
                suggestion?: string | undefined;
                errorData?: Record<string, unknown> | undefined;
                displayData?: {
                    code: "generic.specificModelUnloaded";
                } | {
                    code: "generic.noModelMatchingQuery";
                    query: {
                        path?: string | undefined;
                        identifier?: string | undefined;
                        domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                        vision?: boolean | undefined;
                    };
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.pathNotFound";
                    path: string;
                    availablePathsSample: string[];
                    totalModels: number;
                } | {
                    code: "generic.identifierNotFound";
                    identifier: string;
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.domainMismatch";
                    path: string;
                    actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                    expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                } | {
                    code: "generic.engineDoesNotSupportFeature";
                    feature: string;
                    engineName: string;
                    engineType: string;
                    installedVersion: string;
                    supportedVersion: string | null;
                } | {
                    code: "generic.presetNotFound";
                    specifiedFuzzyPresetIdentifier: string;
                    availablePresetsSample: {
                        name: string;
                        identifier: string;
                    }[];
                    totalAvailablePresets: number;
                } | undefined;
                stack?: string | undefined;
                rootTitle?: string | undefined;
            };
            callId: number;
        } | {
            type: "toolCallStatus";
            callId: number;
            statusText: string;
        } | {
            type: "toolCallWarn";
            callId: number;
            warnText: string;
        };
    };
} & {
    generateWithGenerator: {
        creationParameter: {
            history: {
                messages: ({
                    content: ({
                        type: "text";
                        text: string;
                    } | {
                        type: "file";
                        name: string;
                        identifier: string;
                        sizeBytes: number;
                        fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                    } | {
                        type: "toolCallRequest";
                        toolCallRequest: FunctionToolCallRequest;
                    })[];
                    role: "assistant";
                } | {
                    content: ({
                        type: "text";
                        text: string;
                    } | {
                        type: "file";
                        name: string;
                        identifier: string;
                        sizeBytes: number;
                        fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                    })[];
                    role: "user";
                } | {
                    content: ({
                        type: "text";
                        text: string;
                    } | {
                        type: "file";
                        name: string;
                        identifier: string;
                        sizeBytes: number;
                        fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                    })[];
                    role: "system";
                } | {
                    content: {
                        type: "toolCallResult";
                        content: string;
                        toolCallId?: string | undefined;
                    }[];
                    role: "tool";
                })[];
            };
            pluginIdentifier: string;
            pluginConfigSpecifier: {
                type: "direct";
                config: {
                    fields: {
                        key: string;
                        value?: any;
                    }[];
                };
                workingDirectoryPath?: string | undefined;
            } | {
                type: "predictionProcess";
                pci: string;
                token: string;
            };
            tools: {
                function: {
                    name: string;
                    description?: string | undefined;
                    parameters?: {
                        type: "object";
                        properties: Record<string, any>;
                        required? /**
                        * Client requests to discard the session. Upon calling this, the channel will be closed.
                        */: string[] | undefined;
                        additionalProperties?: boolean | undefined;
                        $defs?: Record<string, any> | undefined;
                    } | undefined;
                };
                type: "function";
            }[];
        };
        toServerPacket: {
            type: "cancel";
        };
        toClientPacket: {
            type: "fragment";
            fragment: {
                content: string;
                tokensCount: number;
                containsDrafted: boolean;
                reasoningType: "none" | "reasoning" | "reasoningStartTag" | "reasoningEndTag";
                isStructural: boolean;
            };
        } | {
            type: "promptProcessingProgress";
            progress: number;
        } | {
            type: "toolCallGenerationStart";
            toolCallId?: string | undefined;
        } | {
            type: "toolCallGenerationNameReceived";
            name: string;
        } | {
            type: "toolCallGenerationArgumentFragmentGenerated";
            content: string;
        } | {
            type: "toolCallGenerationEnd";
            toolCallRequest: FunctionToolCallRequest;
        } | {
            type: "toolCallGenerationFailed";
        } | {
            type: "success";
        };
    };
} & {
    registerDevelopmentPlugin: {
        creationParameter: {
            manifest: {
                type: "plugin";
                owner: string;
                name: string;
                runner: "ecmascript" | "node" | "mcpBridge";
                revision?: number | undefined;
                dependencies?: ArtifactDependency[] | undefined;
                tags?: string[] | undefined;
            };
        };
        toServerPacket: {
            type: "end";
        };
        toClientPacket: {
            type: "ready";
            clientIdentifier: string;
            clientPasskey: string;
        };
    };
} & {
    setPromptPreprocessor: {
        creationParameter: void;
        toServerPacket: {
            type: "complete";
            taskId: string;
            processed: {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                } | {
                    type: "toolCallRequest";
                    toolCallRequest: FunctionToolCallRequest;
                })[];
                role: "assistant";
            } | {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                })[];
                role: "user";
            } | {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                })[];
                role: "system";
            } | {
                content: {
                    type: "toolCallResult";
                    content: string;
                    toolCallId?: string | undefined;
                }[];
                role: "tool";
            };
        } | {
            type: "aborted";
            taskId: string;
        } | {
            type: "error";
            error: {
                title: string;
                cause?: string | undefined;
                suggestion?: string | undefined;
                errorData?: Record<string, unknown> | undefined;
                displayData?: {
                    code: "generic.specificModelUnloaded";
                } | {
                    code: "generic.noModelMatchingQuery";
                    query: {
                        path?: string | undefined;
                        identifier?: string | undefined;
                        domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                        vision?: boolean | undefined;
                    };
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.pathNotFound";
                    path: string;
                    availablePathsSample: string[];
                    totalModels: number;
                } | {
                    code: "generic.identifierNotFound";
                    identifier: string;
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.domainMismatch";
                    path: string;
                    actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                    expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                } | {
                    code: "generic.engineDoesNotSupportFeature";
                    feature: string;
                    engineName: string;
                    engineType: string;
                    installedVersion: string;
                    supportedVersion: string | null;
                } | {
                    code: "generic.presetNotFound";
                    specifiedFuzzyPresetIdentifier: string;
                    availablePresetsSample: {
                        name: string;
                        identifier: string;
                    }[];
                    totalAvailablePresets: number;
                } | undefined;
                stack?: string | undefined;
                rootTitle?: string | undefined;
            };
            taskId: string;
        };
        toClientPacket: {
            type: "preprocess";
            config: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            taskId: string;
            input: {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                } | {
                    type: "toolCallRequest";
                    toolCallRequest: FunctionToolCallRequest;
                })[];
                role: "assistant";
            } | {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                })[];
                role: "user";
            } | {
                content: ({
                    type: "text";
                    text: string;
                } | {
                    type: "file";
                    name: string;
                    identifier: string;
                    sizeBytes: number;
                    fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                })[];
                role: "system";
            } | {
                content: {
                    type: "toolCallResult";
                    content: string;
                    toolCallId?: string | undefined;
                }[];
                role: "tool";
            };
            pluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            globalPluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            workingDirectoryPath: string | null;
            enabledPluginInfos: RemotePluginInfo[];
            pci: string;
            token: string;
        } | {
            type: "abort";
            taskId: string;
        };
    };
} & {
    setPredictionLoopHandler: {
        creationParameter: void;
        toServerPacket: {
            type: "complete";
            taskId: string;
        } | {
            type: "aborted";
            taskId: string;
        } | {
            type: "error";
            error: {
                title: string;
                cause?: string | undefined;
                suggestion?: string | undefined;
                errorData?: Record<string, unknown> | undefined;
                displayData?: {
                    code: "generic.specificModelUnloaded";
                } | {
                    code: "generic.noModelMatchingQuery";
                    query: {
                        path?: string | undefined;
                        identifier?: string | undefined;
                        domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                        vision?: boolean | undefined;
                    };
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.pathNotFound";
                    path: string;
                    availablePathsSample: string[];
                    totalModels: number;
                } | {
                    code: "generic.identifierNotFound";
                    identifier: string;
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.domainMismatch";
                    path: string;
                    actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                    expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                } | {
                    code: "generic.engineDoesNotSupportFeature";
                    feature: string;
                    engineName: string;
                    engineType: string;
                    installedVersion: string;
                    supportedVersion: string | null;
                } | {
                    code: "generic.presetNotFound";
                    specifiedFuzzyPresetIdentifier: string;
                    availablePresetsSample: {
                        name: string;
                        identifier: string;
                    }[];
                    totalAvailablePresets: number;
                } | undefined;
                stack?: string | undefined;
                rootTitle?: string | undefined;
            };
            taskId: string;
        };
        toClientPacket: {
            type: "handlePredictionLoop";
            config: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            taskId: string;
            pluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            globalPluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            workingDirectoryPath: string | null;
            enabledPluginInfos: RemotePluginInfo[];
            pci: string;
            token: string;
        } | {
            type: "abort";
            taskId: string;
        };
    };
} & {
    setToolsProvider: {
        creationParameter: void;
        toServerPacket: {
            type: "sessionInitialized";
            toolDefinitions: {
                function: {
                    name: string;
                    description?: string | undefined;
                    parameters?: {
                        type: "object";
                        properties: Record<string, any>;
                        required? /**
                        * Client requests to discard the session. Upon calling this, the channel will be closed.
                        */: string[] | undefined;
                        additionalProperties?: boolean | undefined;
                        $defs?: Record<string, any> | undefined;
                    } | undefined;
                };
                type: "function";
            }[];
            sessionId: string;
        } | {
            type: "sessionInitializationFailed";
            error: {
                title: string;
                cause?: string | undefined;
                suggestion?: string | undefined;
                errorData?: Record<string, unknown> | undefined;
                displayData?: {
                    code: "generic.specificModelUnloaded";
                } | {
                    code: "generic.noModelMatchingQuery";
                    query: {
                        path?: string | undefined;
                        identifier?: string | undefined;
                        domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                        vision?: boolean | undefined;
                    };
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.pathNotFound";
                    path: string;
                    availablePathsSample: string[];
                    totalModels: number;
                } | {
                    code: "generic.identifierNotFound";
                    identifier: string;
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.domainMismatch";
                    path: string;
                    actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                    expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                } | {
                    code: "generic.engineDoesNotSupportFeature";
                    feature: string;
                    engineName: string;
                    engineType: string;
                    installedVersion: string;
                    supportedVersion: string | null;
                } | {
                    code: "generic.presetNotFound";
                    specifiedFuzzyPresetIdentifier: string;
                    availablePresetsSample: {
                        name: string;
                        identifier: string;
                    }[];
                    totalAvailablePresets: number;
                } | undefined;
                stack?: string | undefined;
                rootTitle?: string | undefined;
            };
            sessionId: string;
        } | {
            type: "toolCallComplete";
            callId: string;
            sessionId: string;
            result?: any;
        } | {
            type: "toolCallError";
            error: {
                title: string;
                cause?: string | undefined;
                suggestion?: string | undefined;
                errorData?: Record<string, unknown> | undefined;
                displayData?: {
                    code: "generic.specificModelUnloaded";
                } | {
                    code: "generic.noModelMatchingQuery";
                    query: {
                        path?: string | undefined;
                        identifier?: string | undefined;
                        domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                        vision?: boolean | undefined;
                    };
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.pathNotFound";
                    path: string;
                    availablePathsSample: string[];
                    totalModels: number;
                } | {
                    code: "generic.identifierNotFound";
                    identifier: string;
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.domainMismatch";
                    path: string;
                    actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                    expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                } | {
                    code: "generic.engineDoesNotSupportFeature";
                    feature: string;
                    engineName: string;
                    engineType: string;
                    installedVersion: string;
                    supportedVersion: string | null;
                } | {
                    code: "generic.presetNotFound";
                    specifiedFuzzyPresetIdentifier: string;
                    availablePresetsSample: {
                        name: string;
                        identifier: string;
                    }[];
                    totalAvailablePresets: number;
                } | undefined;
                stack?: string | undefined;
                rootTitle?: string | undefined;
            };
            callId: string;
            sessionId: string;
        } | {
            type: "toolCallStatus";
            callId: string;
            statusText: string;
            sessionId: string;
        } | {
            type: "toolCallWarn";
            callId: string;
            warnText: string;
            sessionId: string;
        };
        toClientPacket: {
            type: "initSession";
            pluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            globalPluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            workingDirectoryPath: string | null;
            sessionId: string;
        } | {
            type: "discardSession";
            sessionId: string;
        } | {
            type: "callTool";
            callId: string;
            sessionId: string;
            toolName: string;
            parameters?: any;
        } | {
            type: "abortToolCall";
            callId: string;
            sessionId: string;
        };
    };
} & {
    setGenerator: {
        creationParameter: void;
        toServerPacket: {
            type: "complete";
            taskId: string;
        } | {
            type: "aborted";
            taskId: string;
        } | {
            type: "error";
            error: {
                title: string;
                cause?: string | undefined;
                suggestion?: string | undefined;
                errorData?: Record<string, unknown> | undefined;
                displayData?: {
                    code: "generic.specificModelUnloaded";
                } | {
                    code: "generic.noModelMatchingQuery";
                    query: {
                        path?: string | undefined;
                        identifier?: string | undefined;
                        domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                        vision?: boolean | undefined;
                    };
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.pathNotFound";
                    path: string;
                    availablePathsSample: string[];
                    totalModels: number;
                } | {
                    code: "generic.identifierNotFound";
                    identifier: string;
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.domainMismatch";
                    path: string;
                    actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                    expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                } | {
                    code: "generic.engineDoesNotSupportFeature";
                    feature: string;
                    engineName: string;
                    engineType: string;
                    installedVersion: string;
                    supportedVersion: string | null;
                } | {
                    code: "generic.presetNotFound";
                    specifiedFuzzyPresetIdentifier: string;
                    availablePresetsSample: {
                        name: string;
                        identifier: string;
                    }[];
                    totalAvailablePresets: number;
                } | undefined;
                stack?: string | undefined;
                rootTitle?: string | undefined;
            };
            taskId: string;
        } | {
            type: "fragmentGenerated";
            content: string;
            opts: LLMPredictionFragmentInputOpts;
            taskId: string;
        } | {
            type: "toolCallGenerationStarted";
            taskId: string;
            toolCallId?: string | undefined;
        } | {
            type: "toolCallGenerationNameReceived";
            taskId: string;
            toolName: string;
        } | {
            type: "toolCallGenerationArgumentFragmentGenerated";
            content: string;
            taskId: string;
        } | {
            type: "toolCallGenerationEnded";
            toolCallRequest: FunctionToolCallRequest;
            taskId: string;
        } | {
            type: "toolCallGenerationFailed";
            error: {
                title: string;
                cause?: string | undefined;
                suggestion?: string | undefined;
                errorData?: Record<string, unknown> | undefined;
                displayData?: {
                    code: "generic.specificModelUnloaded";
                } | {
                    code: "generic.noModelMatchingQuery";
                    query: {
                        path?: string | undefined;
                        identifier?: string | undefined;
                        domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                        vision?: boolean | undefined;
                    };
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.pathNotFound";
                    path: string;
                    availablePathsSample: string[];
                    totalModels: number;
                } | {
                    code: "generic.identifierNotFound";
                    identifier: string;
                    loadedModelsSample: string[];
                    totalLoadedModels: number;
                } | {
                    code: "generic.domainMismatch";
                    path: string;
                    actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                    expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
                } | {
                    code: "generic.engineDoesNotSupportFeature";
                    feature: string;
                    engineName: string;
                    engineType: string;
                    installedVersion: string;
                    supportedVersion: string | null;
                } | {
                    code: "generic.presetNotFound";
                    specifiedFuzzyPresetIdentifier: string;
                    availablePresetsSample: {
                        name: string;
                        identifier: string;
                    }[];
                    totalAvailablePresets: number;
                } | undefined;
                stack?: string | undefined;
                rootTitle?: string | undefined;
            };
            taskId: string;
        };
        toClientPacket: {
            type: "generate";
            toolDefinitions: {
                function: {
                    name: string;
                    description?: string | undefined;
                    parameters?: {
                        type: "object";
                        properties: Record<string, any>;
                        required? /**
                        * Client requests to discard the session. Upon calling this, the channel will be closed.
                        */: string[] | undefined;
                        additionalProperties?: boolean | undefined;
                        $defs?: Record<string, any> | undefined;
                    } | undefined;
                };
                type: "function";
            }[];
            taskId: string;
            input: {
                messages: ({
                    content: ({
                        type: "text";
                        text: string;
                    } | {
                        type: "file";
                        name: string;
                        identifier: string;
                        sizeBytes: number;
                        fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                    } | {
                        type: "toolCallRequest";
                        toolCallRequest: FunctionToolCallRequest;
                    })[];
                    role: "assistant";
                } | {
                    content: ({
                        type: "text";
                        text: string;
                    } | {
                        type: "file";
                        name: string;
                        identifier: string;
                        sizeBytes: number;
                        fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                    })[];
                    role: "user";
                } | {
                    content: ({
                        type: "text";
                        text: string;
                    } | {
                        type: "file";
                        name: string;
                        identifier: string;
                        sizeBytes: number;
                        fileType: "unknown" | "image" | "text/plain" | "application/pdf" | "application/word" | "text/other";
                    })[];
                    role: "system";
                } | {
                    content: {
                        type: "toolCallResult";
                        content: string;
                        toolCallId?: string | undefined;
                    }[];
                    role: "tool";
                })[];
            };
            pluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            globalPluginConfig: {
                fields: {
                    key: string;
                    value?: any;
                }[];
            };
            workingDirectoryPath: string | null;
        } | {
            type: "abort";
            taskId: string;
        };
    };
}, {}, {}>;

/**
 * @public
 */
export declare type DiagnosticsLogEvent = {
    timestamp: number;
    data: DiagnosticsLogEventData;
};

/**
 * @public
 */
export declare type DiagnosticsLogEventData = {
    type: "llm.prediction.input";
    modelPath: string;
    modelIdentifier: string;
    input: string;
};

/** @public */
export declare class DiagnosticsNamespace {
    private readonly diagnosticsPort;
    private readonly validator;
    /**
     * Register a callback to receive log events. Return a function to stop receiving log events.
     *
     * This method is in alpha. Do not use this method in production yet.
     * @alpha
     */
    unstable_streamLogs(listener: (logEvent: DiagnosticsLogEvent) => void): () => void;
}

/**
 * Represents the library and version of a document parsing library.
 *
 * @public
 * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
 * updates.
 */
export declare type DocumentParsingLibraryIdentifier = {
    /**
     * The identifier of the document parsing library.
     */
    library: string;
    /**
     * The version of the document parsing library.
     */
    version: string;
};

/**
 * Options for parsing a document.
 *
 * @public
 * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
 * updates.
 */
export declare type DocumentParsingOpts = {
    /**
     * The parser backend to use for parsing the document. If not specified, the best available parser
     * will be used.
     */
    parserId?: DocumentParsingLibraryIdentifier;
};

/**
 * Options to use with {@link RepositoryNamespace#downloadArtifact}
 *
 * @public
 */
export declare interface DownloadArtifactOpts {
    owner: string;
    name: string;
    revisionNumber: number;
    /**
     * Where to save the artifact.
     */
    path: string;
    onProgress?: (update: DownloadProgressUpdate) => void;
    onStartFinalizing?: () => void;
    signal?: AbortSignal;
}

/** @public */
export declare interface DownloadOpts {
    onProgress?: (update: DownloadProgressUpdate) => void;
    onStartFinalizing?: () => void;
    signal?: AbortSignal;
}

/**
 * @public
 */
export declare interface DownloadProgressUpdate {
    downloadedBytes: number;
    totalBytes: number;
    speedBytesPerSecond: number;
}

/**
 * This represents a set of requirements for a model. It is not tied to a specific model, but rather
 * to a set of requirements that a model must satisfy.
 *
 * For example, if you got the model via `client.llm.get("my-identifier")`, you will get a
 * `LLMModel` for the model with the identifier `my-identifier`. If the model is unloaded, and
 * another model is loaded with the same identifier, using the same `LLMModel` will use the new
 * model.
 *
 * @public
 */
export declare abstract class DynamicHandle<TModelInstanceInfo extends ModelInstanceInfoBase> {
    /**
     * Gets the information of the model that is currently associated with this `DynamicHandle`. If no
     * model is currently associated, this will return `undefined`.
     *
     * Note: As models are loaded/unloaded, the model associated with this `LLMModel` may change at
     * any moment.
     */
    getModelInfo(): Promise<TModelInstanceInfo | undefined>;
    protected getLoadConfig(stack: string): Promise<KVConfig>;
}

/**
 * This represents a set of requirements for a model. It is not tied to a specific model, but rather
 * to a set of requirements that a model must satisfy.
 *
 * For example, if you got the model via `client.embedding.get("my-identifier")`, you will get a
 * `EmbeddingModel` for the model with the identifier `my-identifier`. If the model is unloaded, and
 * another model is loaded with the same identifier, using the same `EmbeddingModel` will use the
 * new model.
 *
 * @public
 */
export declare class EmbeddingDynamicHandle extends DynamicHandle<EmbeddingModelInstanceInfo> {
    embed(inputString: string): Promise<{
        embedding: Array<number>;
    }>;
    embed(inputStrings: Array<string>): Promise<Array<{
        embedding: Array<number>;
    }>>;
    getContextLength(): Promise<number>;
    getEvalBatchSize(): Promise<number>;
    tokenize(inputString: string): Promise<Array<number>>;
    tokenize(inputStrings: Array<string>): Promise<Array<Array<number>>>;
    countTokens(inputString: string): Promise<number>;
}

/**
 * @public
 */
export declare interface EmbeddingLoadModelConfig {
    gpu?: GPUSetting;
    contextLength?: number;
    ropeFrequencyBase?: number;
    ropeFrequencyScale?: number;
    keepModelInMemory?: boolean;
    tryMmap?: boolean;
}

/**
 * Represents a specific loaded Embedding. Most Embedding related operations are inherited from
 * {@link EmbeddingDynamicHandle}.
 *
 * @public
 */
export declare class EmbeddingModel extends EmbeddingDynamicHandle implements SpecificModel {
    readonly identifier: string;
    readonly path: string;
    readonly modelKey: string;
    readonly format: ModelCompatibilityType;
    readonly displayName: string;
    readonly sizeBytes: number;
    unload(): Promise<void>;
    getModelInfo(): Promise<EmbeddingModelInstanceInfo>;
}

/**
 * Embedding model specific information.
 *
 * @public
 */
export declare interface EmbeddingModelAdditionalInfo {
    /**
     * The maximum context length supported by the model.
     */
    maxContextLength: number;
}

/**
 * Info of an embedding model. It is a combination of {@link ModelInfoBase} and
 * {@link EmbeddingModelAdditionalInfo}.
 *
 * @public
 */
export declare type EmbeddingModelInfo = {
    type: "embedding";
} & ModelInfoBase & EmbeddingModelAdditionalInfo;

/**
 * Additional information of an embedding model instance.
 *
 * @public
 */
export declare interface EmbeddingModelInstanceAdditionalInfo {
    /**
     * The currently loaded context length.
     */
    contextLength: number;
}

/**
 * Info of a loaded embedding model instance. It is a combination of {@link ModelInstanceInfoBase},
 * {@link EmbeddingModelAdditionalInfo} and {@link EmbeddingModelInstanceAdditionalInfo}.
 *
 * @public
 */
export declare type EmbeddingModelInstanceInfo = {
    type: "embedding";
} & ModelInstanceInfoBase & EmbeddingModelAdditionalInfo & EmbeddingModelInstanceAdditionalInfo;

/** @public */
export declare class EmbeddingNamespace extends ModelNamespace<EmbeddingLoadModelConfig, EmbeddingModelInstanceInfo, EmbeddingModelInfo, EmbeddingDynamicHandle, EmbeddingModel> {
}

/**
 * Options to use with {@link RepositoryNamespace#ensureAuthenticated}.
 *
 * @public
 */
export declare interface EnsureAuthenticatedOpts {
    onAuthenticationUrl: (url: string) => void;
}

/**
 * Represents an event that can be subscribed to. Emitted events will trigger all subscribers in the
 * next microtask. If multiple events are emitted, they will be triggered in the same microtask.
 */
declare class Event_2<TData> extends Subscribable<TData> {
    private subscribers;
    /**
     * Internal callback that is called when the number of subscribers goes from 0 to 1.
     */
    private onSubscribed;
    /**
     * Internal callback that is called when the number of subscribers goes from 1 to 0.
     */
    private onUnsubscribed;
    /**
     * Internal state that tracks whether the event has any subscribers.
     */
    protected constructor();
    protected emit(data: TData): void;
    static create<TData>(): readonly [Event_2<TData>, (data: TData) => void];
    subscribe(listener: Listener_2<TData>): () => void;
    batch({ minIdleTimeMs, maxBatchTimeMs, }: EventBatchingOpts): Event_2<Array<TData>>;
}

declare interface EventBatchingOpts {
    minIdleTimeMs?: number;
    maxBatchTimeMs?: number;
}

/**
 * Represents a file. Currently, the file can be either in the local file system or base64 encoded.
 *
 * @public
 */
export declare class FileHandle {
    readonly filesNamespace: FilesNamespace;
    readonly identifier: string;
    readonly type: FileType;
    readonly sizeBytes: number;
    /**
     * Original file name
     */
    readonly name: string;
    /**
     * @deprecated Direct construction is not recommended. Please use the `prepareFile` API instead
     */
    constructor(filesNamespace: FilesNamespace, identifier: string, type: FileType, sizeBytes: number, 
    /**
     * Original file name
     */
    name: string);
    private readonly parsedIdentifier;
    /**
     * Gets the absolute file path of this file.
     */
    getFilePath(): Promise<string>;
    isImage(): boolean;
}

/**
 * @public
 *
 * The namespace for file-related operations.
 */
export declare class FilesNamespace {
    private readonly validator;
    /**
     * Adds a temporary image to LM Studio, and returns a FileHandle that can be used to reference
     * this image. This image will be deleted when the client disconnects.
     *
     * This method can only be used in environments that have file system access (such as Node.js).
     */
    prepareImage(path: string): Promise<FileHandle>;
    /**
     * Adds a temporary image to LM Studio. The content of the file is specified using base64. If you
     * are using Node.js and have a file laying around, consider using `prepareImage` instead.
     */
    prepareImageBase64(fileName: string, contentBase64: string): Promise<FileHandle>;
    /**
     * Adds a temporary file to LM Studio, and returns a FileHandle that can be used to reference this
     * file. This file will be deleted when the client disconnects.
     *
     * This method can only be used in environments that have file system access (such as Node.js).
     *
     * @deprecated [DEP-RETRIEVAL] Retrieval API is still in active development. Stay tuned for
     * updates.
     */
    prepareFile(path: string): Promise<FileHandle>;
    /**
     * Adds a temporary file to LM Studio. The content of the file is specified using base64. If you
     * are using Node.js and have a file laying around, consider using `prepareFile` instead.
     *
     * @deprecated [DEP-RETRIEVAL] Retrieval API is still in active development. Stay tuned for
     * updates.   */
    prepareFileBase64(fileName: string, contentBase64: string): Promise<FileHandle>;
    /**
     * @deprecated [DEP-RETRIEVAL] Retrieval API is still in active development. Stay tuned for
     * updates.   */
    retrieve(query: string, files: Array<FileHandle>, opts?: RetrievalOpts): Promise<RetrievalResult>;
    /**
     * Parse a document
     *
     * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
     * updates.
     */
    parseDocument(fileHandle: FileHandle, opts?: ParseDocumentOpts): Promise<ParseDocumentResult>;
    /**
     * Get the parsing method for a document.
     *
     * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
     * updates.
     */
    getDocumentParsingLibrary(fileHandle: FileHandle): Promise<DocumentParsingLibraryIdentifier>;
}

/**
 * @public
 *
 * TODO: Documentation
 */
export declare type FileType = "image" | "text/plain" | "application/pdf" | "application/word" | "text/other" | "unknown";

/**
 * A tool that is a function.
 *
 * @public
 */
export declare interface FunctionTool extends ToolBase {
    type: "function";
    parametersSchema: ZodSchema;
    /**
     * Checks the parameters. If not valid, throws an error.
     */
    checkParameters: (params: any) => void;
    implementation: (params: Record<string, unknown>, ctx: ToolCallContext) => any | Promise<any>;
}

/**
 * @public
 */
export declare interface FunctionToolCallRequest {
    id?: string;
    type: "function";
    arguments?: Record<string, any>;
    name: string;
}

/**
 * TODO: Documentation
 *
 * @public
 */
declare type Generator_2 = (ctl: GeneratorController, history: Chat) => Promise<void>;
export { Generator_2 as Generator }

/**
 * Controller for a generator.
 *
 * @public
 * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
 * future without warning.
 */
export declare class GeneratorController extends BaseController {
    private readonly toolDefinitions;
    private readonly connector;
    private readonly validator;
    /**
     * Get the definitions of the tools available for this generation.
     */
    getToolDefinitions(): Array<LLMTool>;
    /**
     * Use this function to report a text fragment has been generated.
     *
     * @param content - The content that has been generated.
     * @param opts - Additional info about the generated content, such as how many tokens it contains.
     *   See {@link LLMPredictionFragmentInputOpts} for more info. All the fields are optional.
     */
    fragmentGenerated(content: string, opts?: LLMPredictionFragmentInputOpts): void;
    /**
     * Use this function to report that a tool call generation has started. Each
     * `toolCallGenerationStarted` must be paired up with a `toolCallGenerationEnded` call for
     * successfully generated tool calls, or a `toolCallGenerationFailed` call for
     * failed tool calls.
     */
    toolCallGenerationStarted({ toolCallId, }?: {
        /**
         * The LLM specific call id of the tool call.
         */
        toolCallId?: string;
    }): void;
    /**
     * Use this function to report that the name of the tool call has been generated. This function
     * should only be called once for each `toolCallGenerationStarted`.
     *
     * @param toolName - The name of the tool that has been generated.
     */
    toolCallGenerationNameReceived(toolName: string): void;
    /**
     * Use this function to report that a new argument fragment has been generated for the tool call.
     * This function can be called multiple times for each `toolCallGenerationStarted`.
     *
     * @param content - The new fragment that has been generated for the tool call.
     */
    toolCallGenerationArgumentFragmentGenerated(content: string): void;
    /**
     * Use this function to report that a tool call generation has successfully ended. This function
     * should only be called after a `toolCallGenerationStarted` call.
     */
    toolCallGenerationEnded(toolCallRequest: ToolCallRequest): void;
    /**
     * Use this function to report that a tool call generation has failed. This function should only
     * be called after a `toolCallGenerationStarted` call.
     *
     * @param error - The error that occurred during the tool call generation.
     */
    toolCallGenerationFailed(error: Error): void;
}

/**
 * Represents the result of a prediction from a generator plugin.
 *
 * The most notably property is {@link GeneratorPredictionResult#content}, which contains the
 * generated text.
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
export declare class GeneratorPredictionResult implements BasePredictionResult {
    /**
     * The newly generated text as generated by the generator plugin.
     */
    readonly content: string;
    /**
     * Part of the generated text that is "reasoning" content. For example, text inside <think>
     * tags. The generator is responsible for determining what is considered reasoning content.
     */
    readonly reasoningContent: string;
    /**
     * Part of the generated text that is not "reasoning" content. For example, text outside
     * <think> tags. The generator is responsible for determining what is considered reasoning
     * content.
     */
    readonly nonReasoningContent: string;
    /**
     * The identifier of the plugin that generated this result.
     */
    readonly pluginIdentifier: string;
    constructor(
    /**
     * The newly generated text as generated by the generator plugin.
     */
    content: string, 
    /**
     * Part of the generated text that is "reasoning" content. For example, text inside <think>
     * tags. The generator is responsible for determining what is considered reasoning content.
     */
    reasoningContent: string, 
    /**
     * Part of the generated text that is not "reasoning" content. For example, text outside
     * <think> tags. The generator is responsible for determining what is considered reasoning
     * content.
     */
    nonReasoningContent: string, 
    /**
     * The identifier of the plugin that generated this result.
     */
    pluginIdentifier: string);
}

/**
 * @public
 */
export declare type GlobalKVFieldValueTypeLibraryMap = GlobalKVValueTypesLibrary extends KVFieldValueTypeLibrary<infer TKVFieldValueTypeLibraryMap> ? TKVFieldValueTypeLibraryMap : never;

/**
 * @public
 */
export declare type GlobalKVValueTypesLibrary = typeof kvValueTypesLibrary;

/**
 * Settings related to offloading work to the GPU.
 *
 * @public
 * @deprecated We are currently working on an improved way to control split. You can use this for
 * now. We will offer the alternative before this feature is removed.
 */
export declare type GPUSetting = {
    /**
     * A number between 0 to 1 representing the ratio of the work should be distributed to the GPU,
     * where 0 means no work is distributed and 1 means all work is distributed. Can also specify the
     * string "off" to mean 0 and the string "max" to mean 1.
     */
    ratio?: LLMLlamaAccelerationOffloadRatio;
    /**
     * A number between 0 to 1 representing the ratio of the layers whose expert blocks will be
     * forced into CPU memory, where 1 means all expert layers will be in CPU memory regardless of
     * GPU offload configuration and 0 means the expert offload will be determined by GPU offload.
     * Can also specify the string "off" to mean 0 and the string "max" to mean 1.
     */
    numCpuExpertLayersRatio?: LLMLlamaAccelerationOffloadRatio;
    /**
     * The index of the GPU to use as the main GPU.
     */
    mainGpu?: number;
    /**
     * How to split computation across multiple GPUs.
     */
    splitStrategy?: LLMSplitStrategy;
    /**
     * Indices of GPUs to disable.
     */
    disabledGpus?: number[];
};

/**
 * Controller object used to allow/modify/deny a tool call.
 */
declare class GuardToolCallController {
    readonly toolCallRequest: ToolCallRequest;
    readonly tool: Tool;
    readonly resultContainer: [result: GuardToolCallResult | null];
    /**
     * Don't construct this object yourself.
     */
    constructor(toolCallRequest: ToolCallRequest, tool: Tool, resultContainer: [result: GuardToolCallResult | null]);
    private assertNoResultYet;
    /**
     * Allows the tool call to proceed without any modifications.
     */
    allow: () => void;
    /**
     * Allows the tool call to proceed, but overrides the parameters with the provided ones.
     */
    allowAndOverrideParameters: (newParameters: Record<string, any>) => void;
    /**
     * Denys the tool call with a specified reason. This will not interrupt the `.act` call. Instead,
     * the reason you provide will be provided to the model as the tool call result.
     *
     * If `reason` is not provided, a generic default reason will be used.
     *
     * If you wish to immediately fail the `.act` call, you can throw an error instead.
     */
    deny: (reason?: string) => void;
}

declare type GuardToolCallResult = {
    type: "allow";
} | {
    type: "allowAndOverrideParameters";
    parameters: Record<string, any>;
} | {
    type: "deny";
    reason?: string;
};

/**
 * Represents a download source for a Hugging Face model.
 *
 * @public
 */
export declare type HuggingFaceModelDownloadSource = {
    type: "huggingface";
    user: string;
    repo: string;
};

declare type InferClientPort<TBackendInterfaceOrCreator> = TBackendInterfaceOrCreator extends BackendInterface<infer _TContext, infer TRpcEndpoints, infer TChannelEndpoints, infer TSignalEndpoints, infer TWritableSignalEndpoints> ? ClientPort<TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints> : TBackendInterfaceOrCreator extends (...ars: Array<any>) => BackendInterface<infer _TContext, infer TRpcEndpoints, infer TChannelEndpoints, infer TSignalEndpoints, infer TWritableSignalEndpoints> ? ClientPort<TRpcEndpoints, TChannelEndpoints, TSignalEndpoints, TWritableSignalEndpoints> : never;

/**
 * Given the type of a configSchematics, returns the type of the parsed config. Example usage:
 *
 * ```ts
 * const config: InferParsedConfig<typeof configSchematics> = ctl.getPluginConfig(configSchematics);
 * ```
 *
 * @remarks
 *
 * You don't need this type in the above case because TypeScript has type inferencing. It is mainly
 * useful when you want to pass the parsed config around and you need to type the parameter.
 *
 * @public
 */
export declare type InferParsedConfig<TConfigSchematics extends ConfigSchematics<any>> = TConfigSchematics extends ConfigSchematics<infer RVirtualConfigSchematics> ? ParsedConfig<RVirtualConfigSchematics> : never;

/**
 * Stringify options passed to actual implementations of stringify.
 *
 * @public
 */
export declare interface InnerFieldStringifyOpts {
    /**
     * Translate function.
     */
    t: (key: string, fallback: string) => string;
    /**
     * If exists, a soft cap on how long the stringified value should be.
     *
     * This does not have to be followed. Mostly used for fields like promptFormatTemplate where it
     * can grow very large.
     */
    desiredLength?: number;
}

/**
 * Represents a single field value type definition.
 *
 * @public
 */
export declare interface KVConcreteFieldValueType {
    paramType: ZodSchema;
    schemaMaker: (param: any) => ZodSchema;
    effectiveEquals: (a: any, b: any, typeParam: any) => boolean;
    stringify: (value: any, typeParam: any, opts: InnerFieldStringifyOpts) => string;
}

/**
 * @public
 */
export declare type KVConcreteFieldValueTypesMap = Map<string, KVConcreteFieldValueType>;

/**
 * TODO: Documentation
 *
 * @public
 */
export declare interface KVConfig {
    fields: Array<KVConfigField>;
}

/**
 * TODO: Documentation
 *
 * @public
 */
export declare interface KVConfigField {
    key: string;
    value?: any;
}

/**
 * @public
 */
export declare type KVConfigFieldDependency = {
    key: string;
    condition: {
        type: "equals";
        value: any;
    } | {
        type: "notEquals";
        value: any;
    };
};

/**
 * Represents a library of field value types.
 *
 * @public
 */
export declare class KVFieldValueTypeLibrary<TKVFieldValueTypeLibraryMap extends KVVirtualFieldValueTypesMapping> {
    private readonly valueTypes;
    constructor(valueTypes: KVConcreteFieldValueTypesMap);
    /**
     * Gets the schema for a specific field value type with the given key and parameters.
     */
    getSchema<TKey extends keyof TKVFieldValueTypeLibraryMap & string>(key: TKey, param: TKVFieldValueTypeLibraryMap[TKey]["param"]): ZodSchema<TKVFieldValueTypeLibraryMap[TKey]["value"]>;
    parseParamTypes<TKey extends keyof TKVFieldValueTypeLibraryMap & string>(key: TKey, param: any): TKVFieldValueTypeLibraryMap[TKey]["param"];
    effectiveEquals<TKey extends keyof TKVFieldValueTypeLibraryMap & string>(key: TKey, typeParam: TKVFieldValueTypeLibraryMap[TKey]["param"], a: TKVFieldValueTypeLibraryMap[TKey]["value"], b: TKVFieldValueTypeLibraryMap[TKey]["value"]): boolean;
    stringify<TKey extends keyof TKVFieldValueTypeLibraryMap & string>(key: TKey, typeParam: TKVFieldValueTypeLibraryMap[TKey]["param"], opts: InnerFieldStringifyOpts, value: TKVFieldValueTypeLibraryMap[TKey]["value"]): string;
}

/**
 * The global key-value field value types library. This includes all the basic types and additional
 * types that are used in the LM Studio application.
 *
 * @public
 */
export declare const kvValueTypesLibrary: KVFieldValueTypeLibrary<{
    numeric: {
        value: number;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            step?: number | undefined;
            int?: boolean | undefined;
            precision?: number | undefined;
            slider?: {
                min: number;
                max: number;
                step: number;
            } | undefined;
            shortHand?: string | undefined;
        };
    };
} & {
    string: {
        value: string;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            minLength?: number | undefined;
            maxLength?: number | undefined;
            isParagraph?: boolean | undefined;
            isProtected?: boolean | undefined;
            isToken?: boolean | undefined;
            placeholder?: string | undefined;
        };
    };
} & {
    select: {
        value: string;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: {
                key: string;
                condition: {
                    type: "equals";
                    value: any;
                } | {
                    type: "notEquals";
                    value: any;
                };
            }[] | undefined;
            options: (string | {
                value: string;
                displayName: string;
            })[];
        };
    };
} & {
    boolean: {
        value: boolean;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    stringArray: {
        value: string[];
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            maxNumItems?: number | undefined;
            allowEmptyStrings?: boolean | undefined;
        };
    };
} & {
    checkboxNumeric: {
        value: {
            value: number;
            checked: boolean;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            step?: number | undefined;
            int?: boolean | undefined;
            precision?: number | undefined;
            slider?: {
                min: number;
                max: number;
                step: number;
            } | undefined;
            uncheckedHint?: string | undefined;
        };
    };
} & {
    numericArray: {
        value: number[];
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            int?: boolean | undefined;
        };
    };
} & {
    contextOverflowPolicy: {
        value: "stopAtLimit" | "truncateMiddle" | "rollingWindow";
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    context: {
        value: ({
            type: "jsonFile";
            absPath: string;
        } | {
            type: "yamlFile";
            absPath: string;
        })[];
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    contextLength: {
        value: number;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            max?: number | undefined;
        };
    };
} & {
    modelIdentifier: {
        value: string;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            domain?: ("llm" | "embedding" | "imageGen" | "transcription" | "tts")[] | undefined;
        };
    };
} & {
    llmPromptTemplate: {
        value: {
            type: "manual" | "jinja";
            stopStrings: string[];
            manualPromptTemplate?: {
                beforeSystem: string;
                afterSystem: string;
                beforeUser: string;
                afterUser: string;
                beforeAssistant: string;
                afterAssistant: string;
            } | undefined;
            jinjaPromptTemplate?: {
                template: string;
            } | undefined;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    llmReasoningParsing: {
        value: {
            enabled: boolean;
            startString: string;
            endString: string;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    llamaStructuredOutput: {
        value: {
            type: "none" | "json" | "gbnf";
            jsonSchema?: any;
            gbnfGrammar?: string | undefined;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    speculativeDecodingDraftModel: {
        value: string;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    toolUse: {
        value: {
            type: "none";
        } | {
            type: "toolArray";
            tools?: {
                function: {
                    name: string;
                    description?: string | undefined;
                    parameters?: {
                        type: "object";
                        properties: Record<string, any>;
                        required?: string[] | undefined;
                        additionalProperties?: boolean | undefined;
                        $defs?: Record<string, any> | undefined;
                    } | undefined;
                };
                type: "function";
            }[] | undefined;
            force?: boolean | undefined;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    toolNaming: {
        value: "passThrough" | "removeSpecial" | "snakeCase" | "camelCase";
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    llamaAccelerationOffloadRatio: {
        value: number | "max" | "off";
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
            numLayers?: number | undefined;
        };
    };
} & {
    llamaMirostatSampling: {
        value: {
            version: 0 | 1 | 2;
            learningRate: number;
            targetEntropy: number;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    llamaLogitBias: {
        value: [number, number | "-inf"][];
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    llamaCacheQuantizationType: {
        value: {
            value: "f32" | "f16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";
            checked: boolean;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    mlxKvCacheQuantizationType: {
        value: {
            enabled: boolean;
            bits: 2 | 3 | 4 | 6 | 8;
            groupSize: 32 | 64 | 128;
            quantizedStart: number;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    retrievalChunkingMethod: {
        value: {
            type: "recursive-v1";
            chunkSize: number;
            chunkOverlap: number;
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    envVars: {
        value: Partial<Record<"HSA_OVERRIDE_GFX_VERSION", string>>;
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
} & {
    gpuSplitConfig: {
        value: {
            disabledGpus: number[];
            strategy: "custom" | "evenly" | "priorityOrder";
            priority: number[];
            customRatio: number[];
        };
        param: {
            displayName?: string | undefined;
            hint?: string | undefined;
            modelCentric?: boolean | undefined;
            nonConfigurable?: boolean | undefined;
            engineDoesNotSupport?: boolean | undefined;
            machineDependent?: boolean | undefined;
            warning?: string | undefined;
            subtitle?: string | undefined;
            isExperimental?: boolean | undefined;
            dependencies?: KVConfigFieldDependency[] | undefined;
        };
    };
}>;

/**
 * Used internally by KVFieldValueTypesLibrary to keep track of a single field value type definition
 * with the generics.
 *
 * @public
 */
export declare interface KVVirtualFieldValueType {
    value: any;
    param: any;
}

/**
 * Used internally by KVFieldValueTypesLibrary to keep track of all field value type definitions
 * with the generics.
 *
 * @public
 */
export declare type KVVirtualFieldValueTypesMapping = {
    [key: string]: KVVirtualFieldValueType;
};

/**
 * A lazy signal is a signal that will only subscribe to the upstream when at least one subscriber
 * is attached. It will unsubscribe from the upstream when the last subscriber is removed.
 *
 * A lazy signal can possess a special value "NOT_AVAILABLE", accessible from the static property
 * {@link LazySignal.NOT_AVAILABLE}. This value is used to indicate that the value is not available
 * yet. This can happen when the signal is created without an initial value and the upstream has not
 * emitted a value yet.
 */
declare class LazySignal<TData> extends Subscribable<TData> implements SignalLike<TData> {
    private readonly subscribeUpstream;
    static readonly NOT_AVAILABLE: unique symbol;
    private readonly signal;
    private readonly setValue;
    private dataIsStale;
    private upstreamUnsubscribe;
    private subscribersCount;
    private isSubscribedToUpstream;
    /**
     * This event will be triggered even if the value did not change. This is for resolving .pull.
     */
    private readonly updateReceivedEvent;
    private readonly emitUpdateReceivedEvent;
    private readonly updateReceivedSynchronousCallbacks;
    static create<TData>(initialValue: TData, subscribeUpstream: SubscribeUpstream<TData>, equalsPredicate?: (a: TData, b: TData) => boolean): LazySignal<TData>;
    static createWithoutInitialValue<TData>(subscribeUpstream: SubscribeUpstream<TData>, equalsPredicate?: (a: TData, b: TData) => boolean): LazySignal<TData | NotAvailable>;
    static deriveFrom<TSource extends Array<unknown>, TData>(sourceSignals: {
        [TKey in keyof TSource]: SignalLike<TSource[TKey]>;
    }, deriver: (...sourceValues: {
        [TKey in keyof TSource]: StripNotAvailable<TSource[TKey]>;
    }) => TData, outputEqualsPredicate?: (a: TData, b: TData) => boolean): LazySignal<TSource extends Array<infer RElement> ? RElement extends NotAvailable ? TData | NotAvailable : TData : never>;
    static asyncDeriveFrom<TSource extends Array<unknown>, TData>(strategy: AsyncDeriveFromStrategy, sourceSignals: {
        [TKey in keyof TSource]: SignalLike<TSource[TKey]>;
    }, deriver: (...sourceValues: {
        [TKey in keyof TSource]: StripNotAvailable<TSource[TKey]>;
    }) => Promise<TData>, outputEqualsPredicate?: (a: TData, b: TData) => boolean): LazySignal<TData | NotAvailable>;
    protected constructor(initialValue: TData, subscribeUpstream: SubscribeUpstream<TData>, equalsPredicate?: (a: TData, b: TData) => boolean);
    /**
     * Returns whether the value is currently stale.
     *
     * A value is stale whenever the upstream subscription is not active. This can happen in three
     * cases:
     *
     * 1. When no subscriber is attached to this signal, the signal will not subscribe to the
     *    upstream. In this case, the value is always stale.
     * 2. When a subscriber is attached, but the upstream has not yet emitted a single value, the
     *    value is also stale.
     * 3. When the upstream has emitted an error. In this case, the subscription to the upstream is
     *    terminated and the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link LazySignal#pull}.
     */
    isStale(): boolean;
    private subscribeToUpstream;
    private unsubscribeFromUpstream;
    /**
     * Gets the current value of the signal. If the value is not available, it will return
     * {@link LazySignal.NOT_AVAILABLE}. (A value will only be unavailable if the signal is created
     * without an initial value and the upstream has not emitted a value yet.)
     *
     * In addition, the value returned by this method may be stale. Use {@link LazySignal#isStale} to
     * check if the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link LazySignal#pull}.
     */
    get(): TData;
    /**
     * Pulls the current value of the signal. If the value is stale, it will subscribe and wait for
     * the next value from the upstream and return it.
     */
    pull(): Promise<StripNotAvailable<TData>>;
    /**
     * If the data is not stale, the callback will be called synchronously with the current value.
     *
     * If the data is stale, it will pull the current value and call the callback with the value.
     */
    runOnNextFreshData(callback: (value: StripNotAvailable<TData>) => void): void;
    ensureAvailable(): Promise<LazySignal<StripNotAvailable<TData>>>;
    subscribe(subscriber: Subscriber<TData>): () => void;
    subscribeFull(subscriber: SignalFullSubscriber<TData>): () => void;
    /**
     * Subscribes to the signal. Will not cause the signal to subscribe to the upstream.
     */
    passiveSubscribe(subscriber: Subscriber<TData>): () => void;
    passiveSubscribeFull(subscriber: SignalFullSubscriber<TData>): () => void;
    until(predicate: (data: StripNotAvailable<TData>) => boolean): Promise<StripNotAvailable<TData>>;
}

declare type Listener<TData> = (data: TData) => void;

declare type Listener_2<TData> = (data: TData) => void;

/**
 * Represents a specific loaded LLM. Most LLM related operations are inherited from
 * {@link LLMDynamicHandle}.
 *
 * @public
 */
export declare class LLM extends LLMDynamicHandle implements SpecificModel {
    readonly identifier: string;
    readonly path: string;
    readonly modelKey: string;
    readonly format: ModelCompatibilityType;
    readonly displayName: string;
    readonly sizeBytes: number;
    readonly vision: boolean;
    readonly trainedForToolUse: boolean;
    unload(): Promise<void>;
    getModelInfo(): Promise<LLMInstanceInfo>;
}

/**
 * The base options for the `.act` method.
 *
 * @public
 */
export declare interface LLMActBaseOpts<TPredictionResult> {
    /**
     * A callback that is called when the model has output the first token of a prediction. This
     * callback is called with round index (the index of the prediction within `.act(...)`,
     * 0-indexed).
     */
    onFirstToken?: (roundIndex: number) => void;
    /**
     * A callback for each fragment that is output by the model. This callback is called with the
     * fragment that is emitted. The fragment itself is augmented with the round index (the index of
     * the prediction within `.act(...)`, 0-indexed).
     *
     * For example, for an `.act` invocation with 2 predictions, the callback may be called in the
     * following sequence.
     *
     * - `{ roundIndex: 0, content: "f1", ... }` when the first prediction emits `f1`.
     * - `{ roundIndex: 0, content: "f2", ... }` when the first prediction emits `f2`.
     * - `{ roundIndex: 1, content: "f3", ... }` when the second prediction emits `f3`.
     * - `{ roundIndex: 1, content: "f4", ... }` when the second prediction emits `f4`.
     */
    onPredictionFragment?: (fragment: LLMPredictionFragmentWithRoundIndex) => void;
    /**
     * A callback that is called when a message is generated and should be added to the Chat. This is
     * useful if you want to add the generated content to a chat so you can continue the conversation.
     *
     * Note that, during one `act` call, multiple messages may be generated, and this callback
     * will be called multiple times. For example, if the model requests to use a tool during the
     * first prediction and stops after the second prediction, three messages will be created (and
     * thus this callback will be called three times):
     *
     * 1. The first prediction's generated message, which contains information about the tool request.
     * 2. The result of running the tool.
     * 3. The second prediction's generated message.
     */
    onMessage?: (message: ChatMessage) => void;
    /**
     * A callback that will be called when a new round of prediction starts.
     */
    onRoundStart?: (roundIndex: number) => void;
    /**
     * A callback that will be called when a round of prediction ends.
     */
    onRoundEnd?: (roundIndex: number) => void;
    /**
     * A callback that will be called when a prediction in a round is completed. The callback is
     * called with the result of the prediction. You can access the roundIndex via the `.roundIndex`
     * property. (See {@link PredictionResult} for more info).
     *
     * Note: this is called immediately after the prediction is completed. The tools may still be
     * running.
     */
    onPredictionCompleted?: (predictionResult: TPredictionResult) => void;
    /**
     * A callback that is called when the model is processing the prompt. The callback is called with
     * the round index (the index of the prediction within `.act(...)`, 0-indexed) and a number
     * between 0 and 1, representing the progress of the prompt processing.
     *
     * For example, for an `.act` invocation with 2 prediction rounds, the callback may be called
     * in the following sequence.
     *
     * - `(0, 0.3)` when the first prediction's prompt processing is 30% done.
     * - `(0, 0.7)` when the first prediction's prompt processing is 70% done.
     * - ... The model starts to stream the first prediction's output, during which, this callback is
     *   not called.
     * - `(1, 0.3)` when the second prediction's prompt processing is 50% done.
     * - `(1, 0.7)` when the second prediction's prompt processing is 70% done.
     */
    onPromptProcessingProgress?: (roundIndex: number, progress: number) => void;
    /**
     * A callback that is called when the model starts generating a tool call request.
     *
     * This hook is intended for updating the UI, such as showing "XXX is planning to use a tool...".
     * At this stage the tool call request has not been generated thus we don't know what tool will be
     * called. It is guaranteed that each `invocation` of `onToolCallRequestStart` is paired
     * with exactly one `onToolCallRequestEnd` or `onToolCallRequestFailure`.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    onToolCallRequestStart?: (roundIndex: number, callId: number, info: {
        /**
         * The LLM-specific tool call ID that should go into the context. This will be the same as the
         * `toolCallRequest.id`. Depending on the LLM, this may or may not exist, and the format of it
         * may also vary.
         *
         * If you need to match up different stages of the tool call, please use the `callId`, which
         * is provided by lmstudio.js and is guaranteed to behave consistently across all LLMs.
         */
        toolCallId?: string;
    }) => void;
    /**
     * A callback that is called when the model has received the name of the tool.
     *
     * This hook is intended for updating the UI to show the name of the tool that is being called. If
     * the model being used does not support eager function name reporting, this callback will be
     * called right before the `onToolCallRequestEnd` callback.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    onToolCallRequestNameReceived?: (roundIndex: number, callId: number, name: string) => void;
    /**
     * A callback that is called when the model has generated a fragment of the arguments of the tool.
     *
     * This hook is intended for updating the UI to stream the arguments of the tool that is being
     * called. If the model being used does not support function arguments streaming, this callback
     * will be called right before the `onToolCallRequestEnd` callback, but after the
     * `onToolCallRequestNameReceived`.
     *
     * Note, when piecing together all the argument fragments, there is no guarantee that the result
     * will be valid JSON, as some models may not use JSON to represent tool calls.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    onToolCallRequestArgumentFragmentGenerated?: (roundIndex: number, callId: number, content: string) => void;
    /**
     * A callback that is called when a tool call is requested by the model.
     *
     * You should not use this callback to call the tool - the SDK will automatically call the tools
     * you provided in the tools array.
     *
     * Instead, you can use this callback to update the UI or maintain the context. If you are unsure
     * what to do with this callback, you can ignore it.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    onToolCallRequestEnd?: (roundIndex: number, callId: number, info: {
        /**
         * Whether this tool call is queued. This is true iff the tool will not be immediately
         * executed due to a prior tool is currently executing and `allowParallelToolExecution` is set
         * to `false` (the default).
         *
         * If `isQueued` is true for a specific call request, the `onToolCallRequestDequeued` callback
         * will be called for the call before it is executed.
         */
        isQueued: boolean;
        /**
         * The tool call request that was generated by the model. This field is especially unstable
         * as we will likely replace it with a nicer type.
         *
         * Note, this is not guaranteed to be the actual parameters that will be passed to the tool
         * as the `guardToolCall` handler may modify them. If you want to access the final parameters
         * (i.e. to add to the history), you should use the `onToolCallRequestFinalized`.
         */
        toolCallRequest: ToolCallRequest;
        /**
         * The raw output that represents this tool call. It is recommended to present this to
         * the user as is, if desired.
         *
         * @remarks It is not guaranteed to be valid JSON as the model does not necessarily use
         * JSON to represent tool calls.
         */
        rawContent: string | undefined;
    }) => void;
    /**
     * A callback that is called right before the tool call is executed. This is called after the
     * `guardToolCall` handler (if provided) and will have the updated parameters if the
     * `guardToolCall` updated them.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    onToolCallRequestFinalized?: (roundIndex: number, callId: number, info: {
        /**
         * The tool call request that is about to be executed.
         */
        toolCallRequest: ToolCallRequest;
        /**
         * The raw output that represents this tool call. It is recommended to present this to
         * the user as is, if desired.
         *
         * @remarks It is not guaranteed to be valid JSON as the model does not necessarily use
         * JSON to represent tool calls. In addition, it might not match up the `toolCallRequest`
         * as the `guardToolCall` handler may modify the parameters.
         */
        rawContent: string | undefined;
    }) => void;
    /**
     * A callback that is called when a tool call has failed to generate.
     *
     * This hook is intended for updating the UI, such as showing "a tool call has failed to
     * generate.".
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    onToolCallRequestFailure?: (roundIndex: number, callId: number, error: ToolCallRequestError) => void;
    /**
     * A callback that is called when a queued tool call request is dequeued and is about to be
     * executed.
     *
     * This callback will only be called for tool call requests that are queued, i.e. when `isQueued`
     * is `true` in the `onToolCallRequestEnd` callback.
     *
     * If `allowParallelToolExecution` is set to `true`, this callback will never be called as
     * all tool call requests will be handled immediately as they are being generated.
     *
     * If the tool call themselves are very fast, this callback may never be called, because the
     * the first tool call might finish before the second tool call request is generated.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    onToolCallRequestDequeued?: (roundIndex: number, callId: number) => void;
    /**
     * A handler that is called right before a tool call is executed.
     *
     * You may allow/allowAndOverrideParameters/deny the tool call in this handler by calling the
     * respective method on the controller object passed in as the third parameter.
     *
     * An example `guardToolCll` that denies all tool calls is given below:
     *
     * ```ts
     * model.act(history, tools, {
     *   guardToolCall: (roundIndex, callId, { deny }) => {
     *     deny("Tool calls are not allowed :(");
     *   },
     * });
     * ```
     *
     * A more sophisticated example that prompts the user to confirm the tool call in CLI is given
     * below (needs to be run in a Node.js environment):
     *
     * ```ts
     * import readline from "readline/promises";
     *
     * // ...
     *
     * model.act(history, tools, {
     *   guardToolCall: async (roundIndex, callId, { toolCallRequest, allow, deny }) => {
     *     const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
     *     const answer = await rl.question(
     *       `Allow tool ${toolCallRequest.name}(${JSON.stringify(toolCallRequest.arguments)})? (y/n): `
     *     );
     *     rl.close();
     *     if (answer.trim().toLowerCase() === "y") {
     *       allow();
     *     } else {
     *       deny("Tool call denied by user.");
     *     }
     *   },
     * });
     * ```
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     *
     * @remarks
     *
     * You must call one of the methods on the controller object to allow or deny the tool call. If
     * you do not call any of the methods, `.act` will fail.
     */
    guardToolCall?: (roundIndex: number, callId: number, controller: GuardToolCallController) => any | Promise<any>;
    /**
     * A handler that is called when a tool request is made by the model but is invalid.
     *
     * There are multiple ways for a tool request to be invalid. For example, the model can simply
     * output a string that claims to be a tool request, but cannot at all be parsed as one. Or it may
     * request to use a tool that doesn't exist, or the parameters provided are invalid.
     *
     * When this happens, LM Studio will provide why it failed in the error parameter. We will also
     * try to parse the tool request and provide it as the second parameter. However, this is not
     * guaranteed to success, and the second parameter may be `undefined`.
     *
     * If we successfully parsed the request (thus the request parameter is not undefined), anything
     * returned in this callback will be used as the result of the tool call. This is useful for
     * providing a error message to the model so it may try again. However, if nothing (undefined) is
     * returned, LM Studio will not provide a result to the given tool call.
     *
     * If we failed to parsed the request (thus the request parameter is undefined), the return value
     * of this callback will be ignored as LM Studio cannot provide results to a tool call that has
     * failed to parse.
     *
     * If you decide the failure is too severe to continue, you can always throw an error in this
     * callback, which will immediately fail the `.act` call with the same error you provided.
     *
     * By default, we use the following implementation:
     *
     * ```ts
     * handleInvalidToolRequest: (error, request) => {
     *   if (request) {
     *     return error.message;
     *   }
     *   throw error;
     * },
     * ```
     *
     * The default handler will do the following: If the model requested a tool that can be parsed but
     * is still invalid, we will return the error message as the result of the tool call. If the model
     * requested a tool that cannot be parsed, we will throw an error, which will immediately fail the
     * `.act` call.
     *
     * Note, when an invalid tool request occurs due to parameters type mismatch, we will never call
     * the original tool automatically due to security considerations. If you do decide to call the
     * original tool, you can do so manually within this callback.
     *
     * This callback can also be async.
     */
    handleInvalidToolRequest?: (error: ToolCallRequestError, request: ToolCallRequest | undefined) => any | Promise<any>;
    /**
     * Limit the number of prediction rounds that the model can perform. In the last prediction, the
     * model will not be allowed to use more tools.
     *
     * Note, some models may requests multiple tool calls within a single prediction round. This
     * option only limits the number of prediction rounds, not the total number of tool calls.
     */
    maxPredictionRounds?: number;
    /**
     * An abort signal that can be used to cancel the prediction.
     */
    signal?: AbortSignal;
    /**
     * Whether to allow parallel tool calls to be executed in parallel. Defaults to `false`.
     *
     * @remarks
     *
     * Note, disabling this does NOT prevent the model from making parallel tool requests - models can
     * still output multiple tool requests in the same prediction round. However, if this is set to
     * `false`, the SDK will only execute one tool call at a time, and will wait for the previous tool
     * call to finish before executing the next one.
     *
     * Enabling this option can speed up the act process if the tools are expected to take some time
     * to execute, such as when they make network requests. However, it can lead to problems when
     * tools are stateful and have strict ordering requirements.
     */
    allowParallelToolExecution?: boolean;
}

/**
 * Options for {@link LLMDynamicHandle#act}.
 *
 * @public
 */
export declare type LLMActionOpts<TStructuredOutputType = unknown> = LLMPredictionConfigInput<TStructuredOutputType> & LLMActBaseOpts<PredictionResult> & {
    /**
     * Which preset to use.
     *
     * @remarks
     *
     * This preset selection is "layered" between your overrides and the "server session" config.
     * Which means, other fields you specify in this opts object will override the preset, while the
     * preset content will override the "server session" config.
     */
    preset?: string;
};

/**
 * LLM specific information.
 *
 * @public
 */
export declare interface LLMAdditionalInfo {
    /**
     * Whether this model is vision-enabled (i.e. supports image input).
     */
    vision: boolean;
    /**
     * Whether this model is trained natively for tool use.
     */
    trainedForToolUse: boolean;
    /**
     * Maximum context length of the model.
     */
    maxContextLength: number;
}

/**
 * Options for applying a prompt template.
 * @public
 */
export declare interface LLMApplyPromptTemplateOpts {
    /**
     * Whether to omit the BOS token when formatting.
     *
     * Default: false
     */
    omitBosToken?: boolean;
    /**
     * Whether to omit the EOS token when formatting.
     *
     * Default: false
     */
    omitEosToken?: boolean;
    /**
     * Optional tool definitions to include in the prompt.
     */
    toolDefinitions?: Array<LLMTool>;
}

/**
 * Behavior for when the generated tokens length exceeds the context window size. Only the following
 * values are allowed:
 *
 * - `stopAtLimit`: Stop the prediction when the generated tokens length exceeds the context window
 *   size. If the generation is stopped because of this limit, the `stopReason` in the prediction
 *   stats will be set to `contextLengthReached`.
 * - `truncateMiddle`: Keep the system prompt and the first user message, truncate middle.
 * - `rollingWindow`: Maintain a rolling window and truncate past messages.
 *
 * @public
 */
export declare type LLMContextOverflowPolicy = "stopAtLimit" | "truncateMiddle" | "rollingWindow";

/**
 * This represents a set of requirements for a model. It is not tied to a specific model, but rather
 * to a set of requirements that a model must satisfy.
 *
 * For example, if you got the model via `client.llm.model("my-identifier")`, you will get a
 * `LLMDynamicHandle` for the model with the identifier `my-identifier`. If the model is unloaded,
 * and another model is loaded with the same identifier, using the same `LLMDynamicHandle` will use
 * the new model.
 *
 * @public
 */
export declare class LLMDynamicHandle extends DynamicHandle<LLMInstanceInfo> {
    private predictionConfigInputToKVConfig;
    private createZodParser;
    /**
     * Use the loaded model to predict text.
     *
     * This method returns an {@link OngoingPrediction} object. An ongoing prediction can be used as a
     * promise (if you only care about the final result) or as an async iterable (if you want to
     * stream the results as they are being generated).
     *
     * Example usage as a promise (Resolves to a {@link PredictionResult}):
     *
     * ```typescript
     * const result = await model.complete("When will The Winds of Winter be released?");
     * console.log(result.content);
     * ```
     *
     * Or
     *
     * ```typescript
     * model.complete("When will The Winds of Winter be released?")
     *  .then(result =\> console.log(result.content))
     *  .catch(error =\> console.error(error));
     * ```
     *
     * Example usage as an async iterable (streaming):
     *
     * ```typescript
     * for await (const { content } of model.complete("When will The Winds of Winter be released?")) {
     *   process.stdout.write(content);
     * }
     * ```
     *
     * If you wish to stream the result, but also getting the final prediction results (for example,
     * you wish to get the prediction stats), you can use the following pattern:
     *
     * ```typescript
     * const prediction = model.complete("When will The Winds of Winter be released?");
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction.result();
     * console.log(result.stats);
     * ```
     *
     * @param prompt - The prompt to use for prediction.
     * @param opts - Options for the prediction.
     */
    complete<TStructuredOutputType>(prompt: string, opts?: LLMPredictionOpts<TStructuredOutputType>): OngoingPrediction<TStructuredOutputType>;
    private resolveCompletionContext;
    /**
     * Use the loaded model to generate a response based on the given history.
     *
     * This method returns an {@link OngoingPrediction} object. An ongoing prediction can be used as a
     * promise (if you only care about the final result) or as an async iterable (if you want to
     * stream the results as they are being generated).
     *
     * Example usage as a promise (Resolves to a {@link PredictionResult}):
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * const result = await model.respond(history);
     * console.log(result.content);
     * ```
     *
     * Or
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * model.respond(history)
     *  .then(result => console.log(result.content))
     *  .catch(error => console.error(error));
     * ```
     *
     * Example usage as an async iterable (streaming):
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * for await (const { content } of model.respond(history)) {
     *   process.stdout.write(content);
     * }
     * ```
     *
     * If you wish to stream the result, but also getting the final prediction results (for example,
     * you wish to get the prediction stats), you can use the following pattern:
     *
     * ```typescript
     * const history = [{ role: 'user', content: "When will The Winds of Winter be released?" }];
     * const prediction = model.respond(history);
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction;
     * console.log(result.stats);
     * ```
     *
     * @param chat - The LLMChatHistory array to use for generating a response.
     * @param opts - Options for the prediction.
     */
    respond<TStructuredOutputType>(chat: ChatLike, opts?: LLMRespondOpts<TStructuredOutputType>): OngoingPrediction<TStructuredOutputType>;
    /**
     * @param chat - The LLMChatHistory array to act from as the base
     * @param tool - An array of tools that the model can use during the operation. You can create
     * tools by using the `tool` function.
     * @param opts - Additional options
     *
     * Example:
     *
     * ```
     * import { LMStudioClient, tool } from "@lmstudio/sdk";
     * import { z } from "zod";
     *
     * const client = new LMStudioClient();
     * const model = await client.llm.model();
     *
     * const additionTool = tool({
     *   name: "add",
     *   description: "Add two numbers",
     *   parameters: {
     *     a: z.number(),
     *     b: z.number(),
     *   },
     *   implementation: ({ a, b }) => a + b,
     * });
     *
     * await model.act("What is 1234 + 4321?", [additionTool], {
     *   onMessage: message => console.log(message.toString()),
     * });
     * ```
     */
    act(chat: ChatLike, tools: Array<Tool>, opts?: LLMActionOpts): Promise<ActResult>;
    getContextLength(): Promise<number>;
    applyPromptTemplate(history: ChatLike, opts?: LLMApplyPromptTemplateOpts): Promise<string>;
    tokenize(inputString: string): Promise<Array<number>>;
    tokenize(inputStrings: Array<string>): Promise<Array<Array<number>>>;
    countTokens(inputString: string): Promise<number>;
    /**
     * Starts to eagerly preload a draft model. This is useful when you want a draft model to be ready
     * for speculative decoding.
     *
     * Preloading is done on a best-effort basis and may not always succeed. It is not guaranteed that
     * the draft model is actually loaded when this method returns. Thus, this method should only be
     * used as an optimization. The actual draft model used only depends on the parameter set when
     * performing the prediction.
     */
    unstable_preloadDraftModel(draftModelKey: string): Promise<void>;
}

/**
 * Options for the LLM generator's act method.
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
export declare type LLMGeneratorActOpts = LLMActBaseOpts<GeneratorPredictionResult> & {
    /**
     * Config provided to the plugin.
     */
    pluginConfig?: KVConfig;
    /**
     * Working directory for the generator.
     */
    workingDirectory?: string;
};

/**
 * Represents a handle for a generator that can act as a LLM.
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
export declare class LLMGeneratorHandle {
    /**
     * The identifier of the plugin that this handle is associated with.
     */
    readonly identifier: string;
    private getPluginConfigSpecifier;
    /**
     * Use the generator to produce a response based on the given history.
     */
    respond(chat: ChatLike, opts?: LLMGeneratorPredictionOpts): OngoingGeneratorPrediction;
    act(chat: ChatLike, tools: Array<Tool>, opts?: LLMGeneratorActOpts): Promise<ActResult>;
}

/**
 * Options for {@link LLMGeneratorHandle#respond}.
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
export declare interface LLMGeneratorPredictionOpts {
    /**
     * A callback that is called when the first token is generated.
     */
    onFirstToken?: () => void;
    /**
     * A callback that is called when a prediction fragment is generated.
     */
    onPredictionFragment?: (fragment: LLMPredictionFragment) => void;
    /**
     * A convenience callback that is called when the model finishes generation. The callback is
     * called with a message that has the role set to "assistant" and the content set to the generated
     * text.
     *
     * This callback is useful if you want to add the generated message to a chat.
     *
     * For example:
     *
     * ```ts
     * const chat = Chat.empty();
     * chat.append("user", "When will The Winds of Winter be released?");
     *
     * const generator = client.llm.createGeneratorHandle("lmstudio/some-plugin")
     * const prediction = generator.respond(chat, {
     *   onMessage: message => chat.append(message),
     * });
     * ```
     */
    onMessage?: (message: ChatMessage) => void;
    /**
     * An abort signal that
     */
    signal?: AbortSignal;
    /**
     * Config provided to the plugin.
     */
    pluginConfig?: KVConfig;
    /**
     * Working directory for the generator.
     */
    workingDirectory?: string;
}

/**
 * @public
 */
export declare interface LLMGenInfo {
    indexedModelIdentifier: string;
    identifier: string;
    loadModelConfig: KVConfig;
    predictionConfig: KVConfig;
    stats: LLMPredictionStats;
}

/**
 * Info of an LLM. It is a combination of {@link ModelInfoBase} and {@link LLMAdditionalInfo}.
 *
 * @public
 */
export declare type LLMInfo = {
    type: "llm";
} & ModelInfoBase & LLMAdditionalInfo;

/**
 * Additional information of an LLM instance.
 *
 * @public
 */
export declare interface LLMInstanceAdditionalInfo {
    contextLength: number;
}

/**
 * Info of a loaded LLM instance. It is a combination of {@link ModelInstanceInfoBase},
 * {@link LLMAdditionalInfo} and {@link LLMInstanceAdditionalInfo}.
 *
 * @public
 */
export declare type LLMInstanceInfo = {
    type: "llm";
} & ModelInstanceInfoBase & LLMAdditionalInfo & LLMInstanceAdditionalInfo;

/**
 * @public
 */
export declare interface LLMJinjaPromptTemplate {
    template: string;
}

/**
 * How much of the model's work should be offloaded to the GPU. The value should be between 0 and 1.
 * A value of 0 means that no layers are offloaded to the GPU, while a value of 1 means that all
 * layers (that can be offloaded) are offloaded to the GPU.
 *
 * @public
 */
export declare type LLMLlamaAccelerationOffloadRatio = number | "max" | "off";

/**
 * TODO: Add documentation
 *
 * @public
 */
export declare type LLMLlamaCacheQuantizationType = "f32" | "f16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";

/** @public */
export declare interface LLMLoadModelConfig {
    /**
     * How to distribute the work to your GPUs. See {@link GPUSetting} for more information.
     *
     * @public
     * @deprecated We are currently working on an improved way to control split. You can use this for
     * now but expect breakage in the future.
     */
    gpu?: GPUSetting;
    /**
     * If set to true, detected system limits for VRAM will be strictly enforced. If a model + gpu
     * offload combination would exceed the detected available VRAM, model offload will be capped to
     * not exceed the available VRAM.
     *
     * @public
     */
    gpuStrictVramCap?: boolean;
    /**
     * If set to true, KV cache will be offloaded to GPU memory if available. If false, KV cache will
     * be loaded to RAM.
     *
     * @public
     */
    offloadKVCacheToGpu?: boolean;
    /**
     * The size of the context length in number of tokens. This will include both the prompts and the
     * responses. Once the context length is exceeded, the value set in
     * {@link LLMPredictionConfigBase#contextOverflowPolicy} is used to determine the behavior.
     *
     * See {@link LLMContextOverflowPolicy} for more information.
     */
    contextLength?: number;
    /**
     * Custom base frequency for rotary positional embeddings (RoPE).
     *
     * This advanced parameter adjusts how positional information is embedded in the model's
     * representations. Increasing this value may enable better performance at high context lengths by
     * modifying how the model processes position-dependent information.
     */
    ropeFrequencyBase?: number;
    /**
     * Scaling factor for RoPE (Rotary Positional Encoding) frequency.
     *
     * This factor scales the effective context window by modifying how positional information is
     * encoded. Higher values allow the model to handle longer contexts by making positional encoding
     * more granular, which can be particularly useful for extending a model beyond its original
     * training context length.
     */
    ropeFrequencyScale?: number;
    /**
     * Number of input tokens to process together in a single batch during evaluation.
     *
     * Increasing this value typically improves processing speed and throughput by leveraging
     * parallelization, but requires more memory. Finding the optimal batch size often involves
     * balancing between performance gains and available hardware resources.
     */
    evalBatchSize?: number;
    /**
     * Enables Flash Attention for optimized attention computation.
     *
     * Flash Attention is an efficient implementation that reduces memory usage and speeds up
     * generation by optimizing how attention mechanisms are computed. This can significantly
     * improve performance on compatible hardware, especially for longer sequences.
     */
    flashAttention?: boolean;
    /**
     * When enabled, prevents the model from being swapped out of system memory.
     *
     * This option reserves system memory for the model even when portions are offloaded to GPU,
     * ensuring faster access times when the model needs to be used. Improves performance
     * particularly for interactive applications, but increases overall RAM requirements.
     */
    keepModelInMemory?: boolean;
    /**
     * Random seed value for model initialization to ensure reproducible outputs.
     *
     * Setting a specific seed ensures that random operations within the model (like sampling)
     * produce the same results across different runs, which is important for reproducibility
     * in testing and development scenarios.
     */
    seed?: number;
    /**
     * When enabled, stores the key-value cache in half-precision (FP16) format.
     *
     * This option significantly reduces memory usage during inference by using 16-bit floating
     * point numbers instead of 32-bit for the attention cache. While this may slightly reduce
     * numerical precision, the impact on output quality is generally minimal for most applications.
     */
    useFp16ForKVCache?: boolean;
    /**
     * Attempts to use memory-mapped (mmap) file access when loading the model.
     *
     * Memory mapping can improve initial load times by mapping model files directly from disk to
     * memory, allowing the operating system to handle paging. This is particularly beneficial for
     * quick startup, but may reduce performance if the model is larger than available system RAM,
     * causing frequent disk access.
     */
    tryMmap?: boolean;
    /**
     * Specifies the number of experts to use for models with Mixture of Experts (MoE) architecture.
     *
     * MoE models contain multiple "expert" networks that specialize in different aspects of the task.
     * This parameter controls how many of these experts are active during inference, affecting both
     * performance and quality of outputs. Only applicable for models designed with the MoE
     * architecture.
     */
    numExperts?: number;
    /**
     * Quantization type for the Llama model's key cache.
     *
     * This option determines the precision level used to store the key component of the attention
     * mechanism's cache. Lower precision values (e.g., 4-bit or 8-bit quantization) significantly
     * reduce memory usage during inference but may slightly impact output quality. The effect varies
     * between different models, with some being more robust to quantization than others.
     *
     * Set to false to disable quantization and use full precision.
     */
    llamaKCacheQuantizationType?: LLMLlamaCacheQuantizationType | false;
    /**
     * Quantization type for the Llama model's value cache.
     *
     * Similar to the key cache quantization, this option controls the precision used for the value
     * component of the attention mechanism's cache. Reducing precision saves memory but may affect
     * generation quality. This option requires Flash Attention to be enabled to function properly.
     *
     * Different models respond differently to value cache quantization, so experimentation may be
     * needed to find the optimal setting for a specific use case. Set to false to disable
     * quantization.
     */
    llamaVCacheQuantizationType?: LLMLlamaCacheQuantizationType | false;
}

/**
 * @public
 */
export declare interface LLMManualPromptTemplate {
    /**
     * String to be prepended to the system prompt.
     */
    beforeSystem: string;
    /**
     * String to be appended to the system prompt.
     */
    afterSystem: string;
    /**
     * String to be prepended to a user message.
     */
    beforeUser: string;
    /**
     * String to be appended to a user message.
     */
    afterUser: string;
    /**
     * String to be prepended to an assistant message.
     */
    beforeAssistant: string;
    /**
     * String to be appended to an assistant message.
     */
    afterAssistant: string;
}

/** @public */
export declare class LLMNamespace extends ModelNamespace<LLMLoadModelConfig, LLMInstanceInfo, LLMInfo, LLMDynamicHandle, LLM> {
}

/**
 * @public
 */
export declare type LLMPredictionConfig = Omit<LLMPredictionConfigInput<any>, "structured"> & {
    structured?: LLMStructuredPredictionSetting;
};

/**
 * Shared config for running predictions on an LLM.
 *
 * @public
 */
export declare interface LLMPredictionConfigInput<TStructuredOutputType = unknown> {
    /**
     * Number of tokens to predict at most. If set to false, the model will predict as many tokens as
     * it wants.
     *
     * When the prediction is stopped because of this limit, the `stopReason` in the prediction stats
     * will be set to `maxPredictedTokensReached`.
     *
     * See {@link LLMPredictionStopReason} for other reasons that a prediction might stop.
     */
    maxTokens?: number | false;
    /**
     * The temperature parameter for the prediction model. A higher value makes the predictions more
     * random, while a lower value makes the predictions more deterministic. The value should be
     * between 0 and 1.
     */
    temperature?: number;
    /**
     * An array of strings. If the model generates one of these strings, the prediction will stop.
     *
     * When the prediction is stopped because of this limit, the `stopReason` in the prediction stats
     * will be set to `stopStringFound`.
     *
     * See {@link LLMPredictionStopReason} for other reasons that a prediction might stop.
     */
    stopStrings?: Array<string>;
    /**
     * An array of strings. If the model generates one of these strings, the prediction will stop with
     * the `stopReason` `toolCalls`.
     *
     * See {@link LLMPredictionStopReason} for other reasons that a prediction might stop.
     */
    toolCallStopStrings?: Array<string>;
    /**
     * The behavior for when the generated tokens length exceeds the context window size. The allowed
     * values are:
     *
     * - `stopAtLimit`: Stop the prediction when the generated tokens length exceeds the context
     *   window size. If the generation is stopped because of this limit, the `stopReason` in the
     *   prediction stats will be set to `contextLengthReached`
     * - `truncateMiddle`: Keep the system prompt and the first user message, truncate middle.
     * - `rollingWindow`: Maintain a rolling window and truncate past messages.
     */
    contextOverflowPolicy?: LLMContextOverflowPolicy;
    /**
     * Configures the model to output structured JSON data that follows a specific schema defined
     * using Zod.
     *
     * When you provide a Zod schema, the model will be instructed to generate JSON that conforms to
     * that schema rather than free-form text.
     *
     * This is particularly useful for extracting specific data points from model responses or when
     * you need the output in a format that can be directly used by your application.
     */
    structured?: {
        /**
         * IMPORTANT
         *
         * When passing in a zod schema as the structured generation option, you must provide an
         * actual zod schema object. (returned by z.something()). The type here only requires an
         * object with a `parse` function. This is not enough! We need an actual zod schema because
         * we will need to extract the JSON schema from it. If you don't want use zod, consider
         * passing in a `LLMStructuredPredictionSetting` instead.
         *
         * The reason we only have a `parse` function here (as oppose to actually requiring
         * ZodType<TStructuredOutputType> is due to this zod bug causing TypeScript breakage, when
         * multiple versions of zod exist.
         *
         * - https://github.com/colinhacks/zod/issues/577
         * - https://github.com/colinhacks/zod/issues/2697
         * - https://github.com/colinhacks/zod/issues/3435
         */
        parse: (input: any) => TStructuredOutputType;
    } | LLMStructuredPredictionSetting;
    /**
     * @deprecated Raw tools are currently not well-supported. It may or may not work. If you want to
     * use tools, use `model.act` instead.
     */
    rawTools?: LLMToolUseSetting;
    /**
     * What transformations to apply to tool names before sending them to the model. See
     * {@link ToolNaming} for more details.
     */
    toolNaming?: ToolNaming;
    /**
     * Controls token sampling diversity by limiting consideration to the K most likely next tokens.
     *
     * For example, if set to 40, only the 40 tokens with the highest probabilities will be considered
     * for the next token selection. A lower value (e.g., 20) will make the output more focused and
     * conservative, while a higher value (e.g., 100) allows for more creative and diverse outputs.
     *
     * Typical values range from 20 to 100.
     */
    topKSampling?: number;
    /**
     * Applies a penalty to repeated tokens to prevent the model from getting stuck in repetitive
     * patterns.
     *
     * A value of 1.0 means no penalty. Values greater than 1.0 increase the penalty. For example, 1.2
     * would reduce the probability of previously used tokens by 20%. This is particularly useful for
     * preventing the model from repeating phrases or getting stuck in loops.
     *
     * Set to false to disable the penalty completely.
     */
    repeatPenalty?: number | false;
    /**
     * Sets a minimum probability threshold that a token must meet to be considered for generation.
     *
     * For example, if set to 0.05, any token with less than 5% probability will be excluded from
     * consideration. This helps filter out unlikely or irrelevant tokens, potentially improving
     * output quality.
     *
     * Value should be between 0 and 1. Set to false to disable this filter.
     */
    minPSampling?: number | false;
    /**
     * Implements nucleus sampling by only considering tokens whose cumulative probabilities reach a
     * specified threshold.
     *
     * For example, if set to 0.9, the model will consider only the most likely tokens that together
     * add up to 90% of the probability mass. This helps balance between diversity and quality by
     * dynamically adjusting the number of tokens considered based on their probability distribution.
     *
     * Value should be between 0 and 1. Set to false to disable nucleus sampling.
     */
    topPSampling?: number | false;
    /**
     * Controls how often the XTC (Exclude Top Choices) sampling technique is applied during
     * generation.
     *
     * XTC sampling can boost creativity and reduce clichés by occasionally filtering out common
     * tokens. For example, if set to 0.3, there's a 30% chance that XTC sampling will be applied when
     * generating each token.
     *
     * Value should be between 0 and 1. Set to false to disable XTC completely.
     */
    xtcProbability?: number | false;
    /**
     * Defines the lower probability threshold for the XTC (Exclude Top Choices) sampling technique.
     *
     * When XTC sampling is activated (based on xtcProbability), the algorithm identifies tokens with
     * probabilities between this threshold and 0.5, then removes all such tokens except the least
     * probable one. This helps introduce more diverse and unexpected tokens into the generation.
     *
     * Only takes effect when xtcProbability is enabled.
     */
    xtcThreshold?: number | false;
    /**
     * @deprecated We are still working on bringing logProbs to SDK. Stay tuned for updates.
     */
    logProbs?: number | false;
    /**
     * Specifies the number of CPU threads to allocate for model inference.
     *
     * Higher values can improve performance on multi-core systems but may compete with other
     * processes. For example, on an 8-core system, a value of 4-6 might provide good performance
     * while leaving resources for other tasks.
     *
     * If not specified, the system will use a default value based on available hardware.
     */
    cpuThreads?: number;
    /**
     * Defines a custom template for formatting prompts before sending them to the model.
     *
     * Prompt templates allow you to control exactly how conversations are formatted, including
     * system messages, user inputs, and assistant responses. This is particularly useful when
     * working with models that expect specific formatting conventions.
     *
     * Different models may have different optimal prompt templates, so this allows for
     * model-specific customization.
     *
     * @deprecated The current type for promptTemplate is not yet finalized. We are working on a new
     * type that will be more flexible and easier to use. Stay tuned for updates.
     */
    promptTemplate?: LLMPromptTemplate;
    /**
     * The draft model to use for speculative decoding. Speculative decoding is a technique that can
     * drastically increase the generation speed (up to 3x for larger models) by paring a main model
     * with a smaller draft model.
     *
     * See here for more information: https://lmstudio.ai/docs/advanced/speculative-decoding
     *
     * You do not need to load the draft model yourself. Simply specifying its model key here is
     * enough.
     */
    draftModel?: string;
    /**
     * Warning: Experimental and subject to change.
     *
     * @alpha
     * @deprecated This feature is experimental and may change or be removed in the future.
     */
    speculativeDecodingNumDraftTokensExact?: number;
    /**
     * Warning: Experimental and subject to change.
     *
     * Minimum number of drafted tokens required to run draft through the main model.
     *
     * @alpha
     *
     */
    speculativeDecodingMinDraftLengthToConsider?: number;
    /**
     * Warning: Experimental and subject to change.
     *
     * @alpha
     * @deprecated This feature is experimental and may change or be removed in the future.
     */
    speculativeDecodingMinContinueDraftingProbability?: number;
    /**
     * How to parse the reasoning sections in the model output. Only need to specify the `startString`
     * and the `endString`.
     *
     * For example, DeepSeek models use:
     *
     * ```
     * reasoningParsing: {
     *   enabled: true,
     *   startString: "<think>",
     *   endString: "</think>",
     * }
     * ```
     */
    reasoningParsing?: LLMReasoningParsing;
    /**
     * Raw KV Config.
     *
     * @experimental
     * @deprecated Internal mechanism to carry arbitrary config that does not have a public API yet.
     * May change at any time. Do not use.
     */
    raw?: KVConfig;
}

/**
 * Represents a fragment of a prediction from an LLM. Note that a fragment may contain multiple
 * tokens.
 *
 * @public
 */
export declare interface LLMPredictionFragment {
    /**
     * String content of the fragment.
     */
    content: string;
    /**
     * Number of tokens contains in this fragment. Note this value is not always accurate as tokens
     * may be split across fragments. However, over a period of time, the sum of token counts of
     * multiple fragments will be close to the actual token count. As such, this value can be
     * accumulated to provide a "live tokens count".
     */
    tokensCount: number;
    /**
     * Whether this fragment contains tokens from the draft model.
     */
    containsDrafted: boolean;
    /**
     * Type of reasoning for this fragment. See {@link LLMPredictionFragmentReasoningType} for more
     * info.
     */
    reasoningType: LLMPredictionFragmentReasoningType;
    /**
     * TODO: Documentation
     *
     * @experimental WIP - do not use yet.
     */
    isStructural: boolean;
}

/**
 * Options for creating a prediction fragment.
 *
 * @public
 */
export declare interface LLMPredictionFragmentInputOpts {
    /**
     * How many tokens this fragment contains. Defaults to 1.
     */
    tokenCount?: number;
    /**
     * Whether this fragment contains tokens from the draft model (when using speculative decoding).
     * Defaults to `false`.
     */
    containsDrafted?: boolean;
    /**
     * Type of reasoning for this fragment. Defaults to "none".
     */
    reasoningType?: LLMPredictionFragmentReasoningType;
    /**
     * TODO: Documentation
     *
     * @experimental WIP - do not use yet.
     */
    isStructural?: boolean;
}

/**
 * Represents the type of this fragment in terms of reasoning.
 *
 * - `none`: Content outside of a reasoning block.
 * - `reasoning`: Content inside a reasoning block.
 * - `reasoningStartTag`: Start tag of a reasoning block.
 * - `reasoningEndTag`: End tag of a reasoning block.
 *
 * @public
 */
export declare type LLMPredictionFragmentReasoningType = "none" | "reasoning" | "reasoningStartTag" | "reasoningEndTag";

/**
 * A {@link LLMPredictionFragment} with the index of the prediction within `.act(...)`.
 *
 * See {@link LLMPredictionFragment} for more fields.
 *
 * @public
 */
export declare type LLMPredictionFragmentWithRoundIndex = LLMPredictionFragment & {
    roundIndex: number;
};

/**
 * Options for {@link LLMDynamicHandle#complete}.
 *
 * Note, this interface extends {@link LLMPredictionConfigInput}. See its documentation for more
 * fields.
 *
 * Alternatively, use your IDE/editor's intellisense to see the fields.
 *
 * @public
 */
export declare interface LLMPredictionOpts<TStructuredOutputType = unknown> extends LLMPredictionConfigInput<TStructuredOutputType> {
    /**
     * A callback that is called when the model is processing the prompt. The callback is called with
     * a number between 0 and 1, representing the progress of the prompt processing.
     *
     * Prompt processing progress callbacks will only be called before the first token is emitted.
     */
    onPromptProcessingProgress?: (progress: number) => void;
    /**
     * A callback that is called when the model has output the first token.
     */
    onFirstToken?: () => void;
    /**
     * A callback for each fragment that is output by the model.
     */
    onPredictionFragment?: (fragment: LLMPredictionFragment) => void;
    /**
     * A callback that is called when the model starts generating a tool call request.
     *
     * This hook is intended for updating the UI, such as showing "XXX is planning to use a tool...".
     * At this stage the tool call request has not been generated thus we don't know what tool will be
     * called. It is guaranteed that each `invocation` of `onToolCallRequestStart` is paired with
     * exactly one `onToolCallRequestEnd` or `onToolCallRequestFailure`.
     *
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    onToolCallRequestStart?: (callId: number, info: {
        /**
         * The LLM-specific tool call ID that should go into the context. This will be the same as the
         * `toolCallRequest.id`. Depending on the LLM, this may or may not exist, and the format of it
         * may also vary.
         *
         * If you need to match up different stages of the tool call, please use the `callId`, which
         * is provided by lmstudio.js and is guaranteed to behave consistently across all LLMs.
         */
        toolCallId?: string;
    }) => void;
    /**
     * A callback that is called when the model has received the name of the tool.
     *
     * This hook is intended for updating the UI to show the name of the tool that is being called. If
     * the model being used does not support eager function name reporting, this callback will be
     * called right before the `onToolCallRequestEnd` callback.
     *
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    onToolCallRequestNameReceived?: (callId: number, name: string) => void;
    /**
     * A callback that is called when the model has generated a fragment of the arguments of the tool.
     *
     * This hook is intended for updating the UI to stream the arguments of the tool that is being
     * called. If the model being used does not support function arguments streaming, this callback
     * will be called right before the `onToolCallRequestEnd` callback, but after the
     * `onToolCallRequestNameReceived`.
     *
     * Note, when piecing together all the argument fragments, there is no guarantee that the result
     * will be valid JSON, as some models may not use JSON to represent tool calls.
     *
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    onToolCallRequestArgumentFragmentGenerated?: (callId: number, content: string) => void;
    /**
     * A callback that is called when a tool call is requested by the model.
     *
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    onToolCallRequestEnd?: (callId: number, info: {
        /**
         * The tool call request that was generated by the model. This field is especially unstable
         * as we will likely replace it with a nicer type.
         */
        toolCallRequest: ToolCallRequest;
        /**
         * The raw output that represents this tool call. It is recommended to present this to
         * the user as is, if desired.
         *
         * @remarks It is not guaranteed to be valid JSON as the model does not necessarily use
         * JSON to represent tool calls.
         */
        rawContent: string | undefined;
    }) => void;
    /**
     * A callback that is called when a tool call has failed to generate.
     *
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    onToolCallRequestFailure?: (callId: number, error: ToolCallRequestError) => void;
    /**
     * An abort signal that can be used to cancel the prediction.
     */
    signal?: AbortSignal;
    /**
     * Which preset to use.
     *
     * @remarks
     *
     * This preset selection is "layered" between your overrides and the "server session" config.
     * Which means, other fields you specify in this opts object will override the preset, while the
     * preset content will override the "server session" config.
     */
    preset?: string;
}

/** @public */
export declare interface LLMPredictionStats {
    /**
     * The reason why the prediction stopped.
     *
     * This is a string enum with the following possible values:
     *
     * - `userStopped`: The user stopped the prediction. This includes calling the `cancel` method on
     *   the `OngoingPrediction` object.
     * - `modelUnloaded`: The model was unloaded during the prediction.
     * - `failed`: An error occurred during the prediction.
     * - `eosFound`: The model predicted an end-of-sequence token, which is a way for the model to
     *   indicate that it "thinks" the sequence is complete.
     * - `stopStringFound`: A stop string was found in the prediction. (Stop strings can be specified
     *   with the `stopStrings` config option. This stop reason will only occur if the `stopStrings`
     *   config option is set.)
     * - `maxPredictedTokensReached`: The maximum number of tokens to predict was reached. (Length
     *   limit can be specified with the `maxPredictedTokens` config option. This stop reason will
     *   only occur if the `maxPredictedTokens` config option is set to a value other than -1.)
     * - `contextLengthReached`: The context length was reached. This stop reason will only occur if
     *   the `contextOverflowPolicy` is set to `stopAtLimit`.
     */
    stopReason: LLMPredictionStopReason;
    /**
     * The average number of tokens predicted per second.
     *
     * Note: This value can be undefined in the case of a very short prediction which results in a
     * NaN or a Infinity value.
     */
    tokensPerSecond?: number;
    /**
     * The number of GPU layers used in the prediction. (Currently not correct.)
     */
    numGpuLayers?: number;
    /**
     * The time it took to predict the first token in seconds.
     */
    timeToFirstTokenSec?: number;
    /**
     * The total time it took to predict the result in seconds.
     */
    totalTimeSec?: number;
    /**
     * The number of tokens that were supplied.
     */
    promptTokensCount?: number;
    /**
     * The number of tokens that were predicted.
     */
    predictedTokensCount?: number;
    /**
     * The total number of tokens. This is the sum of the prompt tokens and the predicted tokens.
     */
    totalTokensCount?: number;
    /**
     * If the prediction used speculative decoding, this is the model key of the draft model that was
     * used.
     */
    usedDraftModelKey?: string;
    /**
     * Total number of tokens generated by the draft model when using speculative decoding. Undefined
     * if speculative decoding is not used.
     *
     * ```
     * totalDraftTokensCount =
     *   rejectedDraftTokensCount + acceptedDraftTokensCount + ignoredDraftTokensCount
     * ```
     */
    totalDraftTokensCount?: number;
    /**
     * Number of drafted tokens that are accepted by the main model. The higher the better. Undefined
     * if speculative decoding is not used.
     *
     * ```
     * totalDraftTokensCount =
     *   rejectedDraftTokensCount + acceptedDraftTokensCount + ignoredDraftTokensCount
     * ```
     */
    acceptedDraftTokensCount?: number;
    /**
     * Number of draft tokens that are rejected by the main model. The lower the better. Undefined if
     * speculative decoding is not used.
     *
     * ```
     * totalDraftTokensCount =
     *   rejectedDraftTokensCount + acceptedDraftTokensCount + ignoredDraftTokensCount
     * ```
     */
    rejectedDraftTokensCount?: number;
    /**
     * Number of draft tokens that were not sent to the main model for decoding. Undefined if
     * speculative decoding is not used.
     *
     * ```
     * totalDraftTokensCount =
     *   rejectedDraftTokensCount + acceptedDraftTokensCount + ignoredDraftTokensCount
     * ```
     */
    ignoredDraftTokensCount?: number;
}

/**
 * Represents the reason why a prediction stopped. Only the following values are possible:
 *
 * - `userStopped`: The user stopped the prediction. This includes calling the `cancel` method on
 *   the `OngoingPrediction` object.
 * - `modelUnloaded`: The model was unloaded during the prediction.
 * - `failed`: An error occurred during the prediction.
 * - `eosFound`: The model predicted an end-of-sequence token, which is a way for the model to
 *   indicate that it "thinks" the sequence is complete.
 * - `stopStringFound`: A stop string was found in the prediction. (Stop strings can be specified
 *   with the `stopStrings` config option. This stop reason will only occur if the `stopStrings`
 *   config option is set to an array of strings.)
 * - `maxPredictedTokensReached`: The maximum number of tokens to predict was reached. (Length limit
 *   can be specified with the `maxPredictedTokens` config option. This stop reason will only occur
 *   if the `maxPredictedTokens` config option is set to a value other than -1.)
 * - `contextLengthReached`: The context length was reached. This stop reason will only occur if the
 *   `contextOverflowPolicy` is set to `stopAtLimit`.
 *
 * @public
 */
export declare type LLMPredictionStopReason = "userStopped" | "modelUnloaded" | "failed" | "eosFound" | "stopStringFound" | "toolCalls" | "maxPredictedTokensReached" | "contextLengthReached";

/**
 * @public
 */
export declare interface LLMPromptTemplate {
    type: LLMPromptTemplateType;
    manualPromptTemplate?: LLMManualPromptTemplate;
    jinjaPromptTemplate?: LLMJinjaPromptTemplate;
    /**
     * Additional stop strings to be used with this template.
     */
    stopStrings: Array<string>;
}

/** @public */
export declare type LLMPromptTemplateType = "manual" | "jinja";

/**
 * How to parse reasoning sections in the model output. An easier to use type will be added in the
 * future.
 *
 * @public
 */
export declare interface LLMReasoningParsing {
    /**
     * Whether to enable reasoning parsing.
     */
    enabled: boolean;
    startString: string;
    endString: string;
}

/**
 * Options for {@link LLMDynamicHandle#respond}.
 *
 * Note, this interface extends {@link LLMPredictionOpts} and {@link LLMPredictionConfigInput}. See
 * their documentation for more fields.
 *
 * Alternatively, use your IDE/editor's intellisense to see the fields.
 *
 * @public
 */
export declare interface LLMRespondOpts<TStructuredOutputType = unknown> extends LLMPredictionOpts<TStructuredOutputType> {
    /**
     * A convenience callback that is called when the model finishes generation. The callback is
     * called with a message that has the role set to "assistant" and the content set to the generated
     * text.
     *
     * This callback is useful if you want to add the generated message to a chat.
     *
     * For example:
     *
     * ```ts
     * const chat = Chat.empty();
     * chat.append("user", "When will The Winds of Winter be released?");
     *
     * const llm = client.llm.model();
     * const prediction = llm.respond(chat, {
     *   onMessage: message => chat.append(message),
     * });
     * ```
     */
    onMessage?: (message: ChatMessage) => void;
}

/**
 * How to split the model across GPUs.
 * - "evenly": Splits model evenly across GPUs
 * - "favorMainGpu": Fill the main GPU first, then fill the rest of the GPUs evenly
 *
 * @public
 * @deprecated We are currently working on an improved way to control split. You can use this for
 * now. We will offer the alternative before this feature is removed.
 */
export declare type LLMSplitStrategy = "evenly" | "favorMainGpu";

/**
 * Settings for structured prediction. Structured prediction is a way to force the model to generate
 * predictions that conform to a specific structure.
 *
 * For example, you can use structured prediction to make the model only generate valid JSON, or
 * event JSON that conforms to a specific schema (i.e. having strict types).
 *
 * Some examples:
 *
 * Only generate valid JSON:
 *
 * ```ts
 * const prediction = model.complete("...", {
 *   maxTokens: 100,
 *   structured: { type: "json" },
 * });
 * ```
 *
 * Only generate JSON that conforms to a specific schema (See https://json-schema.org/ for more
 * information on authoring JSON schema):
 *
 * ```ts
 * const schema = {
 *   type: "object",
 *   properties: {
 *     name: { type: "string" },
 *     age: { type: "number" },
 *   },
 *   required: ["name", "age"],
 * };
 * const prediction = model.complete("...", {
 *   maxTokens: 100,
 *   structured: { type: "json", jsonSchema: schema },
 * });
 * ```
 *
 * By default, `{ type: "none" }` is used, which means no structured prediction is used.
 *
 * Caveats:
 *
 * - Although the model is forced to generate predictions that conform to the specified structure,
 *   the prediction may be interrupted (for example, if the user stops the prediction). When that
 *   happens, the partial result may not conform to the specified structure. Thus, always check the
 *   prediction result before using it, for example, by wrapping the `JSON.parse` inside a try-catch
 *   block.
 * - In certain cases, the model may get stuck. For example, when forcing it to generate valid JSON,
 *   it may generate a opening brace `{` but never generate a closing brace `}`. In such cases, the
 *   prediction will go on forever until the context length is reached, which can take a long time.
 *   Therefore, it is recommended to always set a `maxTokens` limit.
 *
 * @public
 */
export declare type LLMStructuredPredictionSetting = {
    type: LLMStructuredPredictionType;
    jsonSchema?: any;
    gbnfGrammar?: string;
};

/**
 * @public
 */
export declare type LLMStructuredPredictionType = "none" | "json" | "gbnf";

/**
 * TODO: Documentation
 *
 * @public
 */
export declare type LLMTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: LLMToolParameters;
    };
};

/**
 * TODO: Documentation
 *
 * @public
 */
export declare type LLMToolParameters = {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
    $defs?: Record<string, any>;
};

/**
 * TODO: Documentation
 *
 * @public
 */
export declare type LLMToolUseSetting = {
    type: "none";
} | {
    type: "toolArray";
    tools?: LLMTool[];
    force?: boolean;
};

/** @public */
export declare class LMStudioClient {
    readonly clientIdentifier: string;
    readonly llm: LLMNamespace;
    readonly embedding: EmbeddingNamespace;
    readonly system: SystemNamespace;
    readonly diagnostics: DiagnosticsNamespace;
    readonly files: FilesNamespace;
    readonly repository: RepositoryNamespace;
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    readonly plugins: PluginsNamespace;
    private isLocalhostWithGivenPortLMStudioServer;
    /**
     * Guess the base URL of the LM Studio server by visiting localhost on various default ports.
     */
    private guessBaseUrl;
    private createPort;
    private resolvingBaseUrl;
    private verboseErrorMessages;
    constructor(opts?: LMStudioClientConstructorOpts);
    [Symbol.asyncDispose](): Promise<void>;
}

/** @public */
export declare interface LMStudioClientConstructorOpts {
    /**
     * Changes the logger that is used by LMStudioClient internally. The default logger is `console`.
     * By default, LMStudioClient only logs warnings and errors that require user intervention. If the
     * `verbose` option is enabled while calling supporting methods, those messages will also be
     * directed to the specified logger.
     */
    logger?: LoggerInterface;
    /**
     * The base URL of the LM Studio server. If not provided, LM Studio will attempt to connect to the
     * localhost with various default ports.
     *
     * If you have set a custom port and/or are reverse-proxying, you should pass in the baseUrl.
     *
     * Since LM Studio uses WebSockets, the protocol must be "ws" or "wss".
     *
     * For example, if have changed the port to 8080, you should create the LMStudioClient like so:
     *
     * ```typescript
     * const client = new LMStudioClient({ baseUrl: "ws://127.0.0.1:8080" });
     * ```
     */
    baseUrl?: string;
    /**
     * Whether to include stack traces in the errors caused by LM Studio. By default, this is set to
     * `false`. If set to `true`, LM Studio SDK will include a stack trace in the error message.
     */
    verboseErrorMessages?: boolean;
    /**
     * Changes the client identifier used to authenticate with LM Studio. By default, it uses a
     * randomly generated string.
     *
     * If you wish to share resources across multiple LMStudioClient, you should set them to use the
     * same `clientIdentifier` and `clientPasskey`.
     */
    clientIdentifier?: string;
    /**
     * Changes the client passkey used to authenticate with LM Studio. By default, it uses a randomly
     * generated string.
     *
     * If you wish to share resources across multiple LMStudioClient, you should set them to use the
     * same `clientIdentifier` and `clientPasskey`.
     */
    clientPasskey?: string;
}

/**
 * Represents a file entry in a local artifact.
 *
 * @public
 */
export declare interface LocalArtifactFileEntry {
    relativePath: string;
    sizeBytes: number;
}

/**
 * Represents a the list of files in a local artifact.
 *
 * @public
 */
export declare interface LocalArtifactFileList {
    files: Array<LocalArtifactFileEntry>;
    usedIgnoreFile: string | null;
}

/** @public */
export declare interface LoggerInterface {
    info(...messages: Array<unknown>): void;
    error(...messages: Array<unknown>): void;
    warn(...messages: Array<unknown>): void;
    debug(...messages: Array<unknown>): void;
}

/**
 * Options to use with {@link RepositoryNamespace#loginWithPreAuthenticatedKeys}.
 *
 * @public
 */
export declare interface LoginWithPreAuthenticatedKeysOpts {
    keyId: string;
    publicKey: string;
    privateKey: string;
}

/**
 * Result of {@link RepositoryNamespace#loginWithPreAuthenticatedKeys}.
 *
 * @public
 */
export declare interface LoginWithPreAuthenticatedKeysResult {
    userName: string;
}

/** @public */
export declare type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Represents some underlying data that may or may not be mutable.
 *
 * @public
 */
export declare abstract class MaybeMutable<Data> {
    protected readonly data: Data;
    protected readonly mutable: boolean;
    protected constructor(data: Data, mutable: boolean);
    /**
     * Gets the class name. This is used for printing errors.
     */
    protected abstract getClassName(): string;
    /**
     * Creates a new instance of the class with the given data.
     */
    protected abstract create(data: Data, mutable: boolean): this;
    /**
     * Clones the data.
     */
    protected abstract cloneData(data: Data): Data;
    asMutableCopy(): this;
    asImmutableCopy(): this;
    protected guardMutable(): void;
}

/**
 * @public
 */
export declare type ModelCompatibilityType = "gguf" | "safetensors" | "onnx" | "ggml" | "mlx_placeholder" | "torch_safetensors";

/**
 * @public
 */
export declare type ModelDomainType = "llm" | "embedding" | "imageGen" | "transcription" | "tts";

/**
 * Represents a download source for a concrete model.
 *
 * @public
 */
export declare type ModelDownloadSource = HuggingFaceModelDownloadSource;

/**
 * Information about a model.
 *
 * @public
 */
export declare type ModelInfo = LLMInfo | EmbeddingModelInfo;

/**
 * Represents info of a model that is downloaded and sits on the disk. This is the base type shared
 * by all models of different domains.
 *
 * @public
 */
export declare interface ModelInfoBase {
    /**
     * The key of the model. Use to load the model.
     */
    modelKey: string;
    /**
     * The format of the model.
     */
    format: ModelCompatibilityType;
    /**
     * Machine generated name of the model.
     */
    displayName: string;
    /**
     * The relative path of the model.
     */
    path: string;
    /**
     * The size of the model in bytes.
     */
    sizeBytes: number;
    /**
     * A string that represents the number of params in the model. May not always be available.
     */
    paramsString?: string;
    /**
     * The architecture of the model. May not always be available.
     */
    architecture?: string;
    /**
     * The quantization of the model. May not always be available.
     */
    quantization?: Quantization;
}

/**
 * Information about a model that is loaded.
 *
 * @public
 */
export declare type ModelInstanceInfo = LLMInstanceInfo | EmbeddingModelInstanceInfo;

/**
 * Represents info of a model that is already loaded. Contains all fields from
 * {@link ModelInfoBase}. This is the base typed share by all model instances of different domains.
 *
 * @public
 */
export declare interface ModelInstanceInfoBase extends ModelInfoBase {
    /**
     * The identifier of the instance.
     */
    identifier: string;
    /**
     * The internal immutable reference of the instance.
     */
    instanceReference: string;
}

/**
 * Abstract namespace for namespaces that deal with models.
 *
 * @public
 */
export declare abstract class ModelNamespace<TLoadModelConfig, TModelInstanceInfo extends ModelInstanceInfoBase, TModelInfo extends ModelInfoBase, TDynamicHandle extends DynamicHandle<TModelInstanceInfo>, TSpecificModel> {
    /**
     * Load a model for inferencing. The first parameter is the model key. The second parameter is an
     * optional object with additional options.
     *
     * To find out what models are available, you can use the `lms ls` command, or programmatically
     * use the `client.system.listDownloadedModels` method.
     *
     * Here are some examples:
     *
     * Loading Llama 3.2:
     *
     * ```typescript
     * const model = await client.llm.load("llama-3.2-3b-instruct");
     * ```
     *
     * Once loaded, see {@link LLMDynamicHandle} or {@link EmbeddingDynamicHandle} for how to use the
     * model for inferencing or other things you can do with the model.
     *
     * @param modelKey - The path of the model to load.
     * @param opts - Options for loading the model.
     * @returns A promise that resolves to the model that can be used for inferencing
     */
    load(modelKey: string, opts?: BaseLoadModelOpts<TLoadModelConfig>): Promise<TSpecificModel>;
    /**
     * Unload a model. Once a model is unloaded, it can no longer be used. If you wish to use the
     * model afterwards, you will need to load it with {@link LLMNamespace#loadModel} again.
     *
     * @param identifier - The identifier of the model to unload.
     */
    unload(identifier: string): Promise<void>;
    /**
     * List all the currently loaded models.
     */
    listLoaded(): Promise<Array<TSpecificModel>>;
    /**
     * Get any loaded model of this domain.
     */
    private getAny;
    /**
     * Get a dynamic model handle for any loaded model that satisfies the given query.
     *
     * For more information on the query, see {@link ModelQuery}.
     *
     * Note: The returned handle is not tied to any specific loaded model. Instead, it represents a
     * "handle for a model that satisfies the given query". If the model that satisfies the query is
     * unloaded, the handle will still be valid, but any method calls on it will fail. And later, if a
     * new model is loaded that satisfies the query, the handle will be usable again.
     *
     * You can use {@link DynamicHandle#getModelInfo} to get information about the model that is
     * currently associated with this handle.
     *
     * @example
     *
     * If you have loaded a model with the identifier "my-model", you can use it like this:
     *
     * ```ts
     * const dh = client.llm.createDynamicHandle({ identifier: "my-model" });
     * const prediction = dh.complete("...");
     * ```
     *
     * @example
     *
     * Use the Gemma 2B IT model (given it is already loaded elsewhere):
     *
     * ```ts
     * const dh = client.llm.createDynamicHandle({ path: "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF" });
     * const prediction = dh.complete("...");
     * ```
     *
     * @param query - The query to use to get the model.
     */
    createDynamicHandle(query: ModelQuery): TDynamicHandle;
    /**
     * Get a dynamic model handle by its identifier.
     *
     * Note: The returned handle is not tied to any specific loaded model. Instead, it represents a
     * "handle for a model with the given identifier". If the model with the given identifier is
     * unloaded, the handle will still be valid, but any method calls on it will fail. And later, if a
     * new model is loaded with the same identifier, the handle will be usable again.
     *
     * You can use {@link DynamicHandle#getModelInfo} to get information about the model that is
     * currently associated with this handle.
     *
     * @example
     *
     * If you have loaded a model with the identifier "my-model", you can get use it like this:
     *
     * ```ts
     * const dh = client.llm.createDynamicHandle("my-model");
     * const prediction = dh.complete("...");
     * ```
     *
     * @param identifier - The identifier of the model to get.
     */
    createDynamicHandle(identifier: string): TDynamicHandle;
    /**
     * Create a dynamic handle from the internal instance reference.
     *
     * @alpha
     */
    createDynamicHandleFromInstanceReference(instanceReference: string): TDynamicHandle;
    /**
     * Get a model by its identifier. If no model is loaded with such identifier, load a model with
     * the given key. This is the recommended way of getting a model to work with.
     *
     * For example, to use the DeepSeek r1 distill of Llama 8B:
     *
     * ```typescript
     * const model = await client.llm.model("deepseek-r1-distill-llama-8b");
     * ```
     */
    model(modelKey: string, opts?: BaseLoadModelOpts<TLoadModelConfig>): Promise<TSpecificModel>;
    /**
     * Get any loaded model of this domain. If you want to use a specific model, pass in the model key
     * as a parameter.
     */
    model(): Promise<TSpecificModel>;
}

/**
 * Represents a query for a loaded LLM.
 *
 * @public
 */
export declare interface ModelQuery {
    /**
     * The domain of the model.
     */
    domain?: ModelDomainType;
    /**
     * If specified, the model must have exactly this identifier.
     *
     * Note: The identifier of a model is set when loading the model. It defaults to the filename of
     * the model if not specified. However, this default behavior should not be relied upon. If you
     * wish to query a model by its path, you should specify the path instead of the identifier:
     *
     * Instead of
     *
     * ```ts
     * const model = client.llm.get({ identifier: "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF" });
     * // OR
     * const model = client.llm.get("lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF");
     * ```
     *
     * Use
     *
     * ```ts
     * const model = client.llm.get({ path: "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF" });
     * ```
     */
    identifier?: string;
    /**
     * If specified, the model must have this path.
     *
     * When specifying the model path, you can use the following format:
     *
     * `<publisher>/<repo>[/model_file]`
     *
     * If `model_file` is not specified, any quantization of the model will match this query.
     *
     * Here are some examples:
     *
     * Query any loaded Llama 3 model:
     *
     * ```ts
     * const model = client.llm.get({
     *   path: "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF",
     * });
     * ```
     *
     * Query any loaded model with a specific quantization of the Llama 3 model:
     *
     * ```ts
     * const model = client.llm.get({
     *   path: "lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF/Meta-Llama-3-8B-Instruct-Q4_K_M.gguf",
     * });
     * ```
     */
    path?: string;
    /**
     * If true, the model must have vision capabilities. If false, the model must not have vision
     * capabilities.
     */
    vision?: boolean;
}

/** @public */
export declare interface ModelSearchOpts {
    /**
     * The search term to use when searching for models. If not provided, recommended models will
     * be returned.
     */
    searchTerm?: string;
    /**
     * How many results to return. If not provided, this value will be decided by LM Studio.
     */
    limit?: number;
    /**
     * The model compatibility types to filter by. If not provided, only models that are supported
     * by your current runtimes will be returned.
     */
    compatibilityTypes?: Array<ModelCompatibilityType>;
}

/** @public */
export declare class ModelSearchResultDownloadOption {
    private readonly logger;
    private readonly data;
    readonly quantization?: string;
    readonly name: string;
    readonly sizeBytes: number;
    readonly fitEstimation?: ModelSearchResultDownloadOptionFitEstimation;
    readonly indexedModelIdentifier: string;
    isRecommended(): boolean;
    /**
     * Download the model. Returns the model key which can be used to load the model.
     */
    download(opts?: DownloadOpts): Promise<string>;
}

/**
 * @public
 */
export declare type ModelSearchResultDownloadOptionFitEstimation = "fullGPUOffload" | "partialGPUOffload" | "fitWithoutGPU" | "willNotFit";

/** @public */
export declare class ModelSearchResultEntry {
    private readonly logger;
    private readonly data;
    readonly name: string;
    isExactMatch(): boolean;
    isStaffPick(): boolean;
    getDownloadOptions(): Promise<Array<ModelSearchResultDownloadOption>>;
}

declare type NotAvailable = typeof LazySignal.NOT_AVAILABLE;

/**
 * Represents an ongoing prediction from a generator.
 *
 * Note, this class is Promise-like, meaning you can use it as a promise. It resolves to a
 * {@link GeneratorPredictionResult}, which contains the generated text in the `.content` property. Example
 * usage:
 *
 * ```typescript
 * const result = await generator.complete("When will The Winds of Winter be released?");
 * console.log(result.content);
 * ```
 *
 * Or you can use instances methods like `then` and `catch` to handle the result or error of the
 * prediction.
 *
 * ```typescript
 * generator.complete("When will The Winds of Winter be released?")
 *  .then(result =\> console.log(result.content))
 *  .catch(error =\> console.error(error));
 * ```
 *
 * Alternatively, you can also stream the result (process the results as more content is being
 * generated). For example:
 *
 * ```typescript
 * for await (const { content } of generator.complete("When will The Winds of Winter be released?")) {
 *   process.stdout.write(content);
 * }
 * ```
 *
 * @public
 * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in development.
 * This may change in the future without warning.
 */
export declare class OngoingGeneratorPrediction extends StreamablePromise<LLMPredictionFragment, GeneratorPredictionResult> {
    private readonly pluginIdentifier;
    private readonly onCancel;
    protected collect(fragments: ReadonlyArray<LLMPredictionFragment>): Promise<GeneratorPredictionResult>;
    private constructor();
    /**
     * Get the final prediction results. If you have been streaming the results, awaiting on this
     * method will take no extra effort, as the results are already available in the internal buffer.
     *
     * Example:
     *
     * ```typescript
     * const prediction = generator.complete("When will The Winds of Winter be released?");
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction.result();
     * console.log(result.stats);
     * ```
     *
     * Technically, awaiting on this method is the same as awaiting on the instance itself:
     *
     * ```typescript
     * await prediction.result();
     *
     * // Is the same as:
     *
     * await prediction;
     * ```
     */
    result(): Promise<GeneratorPredictionResult>;
    /**
     * Cancels the prediction.
     */
    cancel(): Promise<void>;
}

/**
 * Represents an ongoing prediction.
 *
 * Note, this class is Promise-like, meaning you can use it as a promise. It resolves to a
 * {@link PredictionResult}, which contains the generated text in the `.content` property. Example
 * usage:
 *
 * ```typescript
 * const result = await model.complete("When will The Winds of Winter be released?");
 * console.log(result.content);
 * ```
 *
 * Or you can use instances methods like `then` and `catch` to handle the result or error of the
 * prediction.
 *
 * ```typescript
 * model.complete("When will The Winds of Winter be released?")
 *  .then(result =\> console.log(result.content))
 *  .catch(error =\> console.error(error));
 * ```
 *
 * Alternatively, you can also stream the result (process the results as more content is being
 * generated). For example:
 *
 * ```typescript
 * for await (const { content } of model.complete("When will The Winds of Winter be released?")) {
 *   process.stdout.write(content);
 * }
 * ```
 *
 * @public
 */
export declare class OngoingPrediction<TStructuredOutputType = unknown> extends StreamablePromise<LLMPredictionFragment, unknown extends TStructuredOutputType ? PredictionResult : StructuredPredictionResult<TStructuredOutputType>> {
    private readonly onCancel;
    private readonly parser;
    private stats;
    private modelInfo;
    private loadModelConfig;
    private predictionConfig;
    protected collect(fragments: ReadonlyArray<LLMPredictionFragment>): Promise<any>;
    private constructor();
    /**
     * Get the final prediction results. If you have been streaming the results, awaiting on this
     * method will take no extra effort, as the results are already available in the internal buffer.
     *
     * Example:
     *
     * ```typescript
     * const prediction = model.complete("When will The Winds of Winter be released?");
     * for await (const { content } of prediction) {
     *   process.stdout.write(content);
     * }
     * const result = await prediction.result();
     * console.log(result.stats);
     * ```
     *
     * Technically, awaiting on this method is the same as awaiting on the instance itself:
     *
     * ```typescript
     * await prediction.result();
     *
     * // Is the same as:
     *
     * await prediction;
     * ```
     */
    result(): Promise<unknown extends TStructuredOutputType ? PredictionResult : StructuredPredictionResult<TStructuredOutputType>>;
    /**
     * Cancels the prediction. This will stop the prediction with stop reason `userStopped`. See
     * {@link LLMPredictionStopReason} for other reasons that a prediction might stop.
     */
    cancel(): Promise<void>;
}

/**
 * OWLSignal - Optimistic Writable Lazy Signal
 *
 * - Signal: It is a signal, i.e. an observable that remembers its current value
 * - Lazy: It is lazy, i.e. it does not subscribe to the upstream until a subscriber is attached
 * - Writable: It is writable, i.e. it has a setter to update its value
 * - Optimistic: It is optimistic, i.e. it updates its value optimistically and then waits for the
 *   upstream to confirm the update
 *   - Once the setter is called, the value is updated optimistically and all subscribers are
 *     notified synchronously
 *
 * Guarantees:
 *
 * - The OWLSignal is designed for single-writer multiple-reader scenarios, as the coordination of
 *   writes are tracked inside the OWLSignal. If there are multiple writers for the same data (i.e.
 *   multiple OWLSignal backed by the same upstream), there are no strong guarantees. For example,
 *   two updaters may read the same value, update it, and write it back to the upstream, causing one
 *   of the updates to be lost. The following guarantees are provided for single-writer scenarios:
 * - The updates are applied in the order they are received, and each updater is guaranteed to see
 *   all updates that were applied before it.
 * - If there are updaters [u_0, u_1, ..., u_n], for any read-only reader, there exists a time t
 *   where the reader will see the updates [u_0, u_1, ..., u_t] in the order they were applied. This
 *   also applies to the writer itself.
 */
declare class OWLSignal<TData> extends Subscribable<TData> implements SignalLike<TData> {
    private readonly writeUpstream;
    static readonly NOT_AVAILABLE: NotAvailable;
    /**
     * The inner signal used to subscribe to the upstream
     */
    private readonly innerSignal;
    /**
     * The outer signal used to notify subscribers of the value (after applying optimistic updates)
     */
    private readonly outerSignal;
    /**
     * The setter function to update the value of the signal.
     */
    private readonly setOuterSignal;
    private isWriteLoopRunning;
    /**
     * We have a passive subscription to the inner signal to update the optimistic value whenever the
     * inner signal changes.
     *
     * However, if the content changes are caused by a write, we want to update the inner value,
     * remove the optimistic update, and apply the remaining optimistic updates all at once.
     *
     * Therefore, when a write is ongoing, we set this flag to true to prevent the passive
     * subscription from updating the optimistic value. We will handle the updates within the write
     * loop.
     */
    private isSubscriptionHandledByWriteLoop;
    /**
     * A queue of updates to apply optimistically.
     */
    private queuedUpdates;
    private writeErrorEvent;
    private emitWriteErrorEvent;
    private applyOptimisticUpdates;
    private updateOptimisticValue;
    private constructor();
    static create<TData>(initialValue: TData, subscribeUpstream: SubscribeUpstream<TData>, 
    /**
     * Returns true if the update is sent to the upstream (thus should wait for the upstream to
     * confirm. Returns false if the update is not sent and the update should be dropped.
     */
    writeUpstream: (data: StripNotAvailable<TData>, patches: Array<Patch>, tags: Array<WriteTag>) => boolean, equalsPredicate?: (a: TData, b: TData) => boolean): readonly [OWLSignal<TData>, Setter<StripNotAvailable<TData>>, (tags: Array<WriteTag>, error: any) => void];
    static createWithoutInitialValue<TData>(subscribeUpstream: SubscribeUpstream<TData | NotAvailable>, writeUpstream: (data: StripNotAvailable<TData>, patches: Array<Patch>, tags: Array<WriteTag>) => boolean, equalsPredicate?: (a: TData, b: TData) => boolean): readonly [OWLSignal<typeof LazySignal.NOT_AVAILABLE | TData>, Setter<StripNotAvailable<TData>>, (tags: Array<WriteTag>, error: any) => void];
    private update;
    /**
     * Starts the write loop if it is not already running.
     */
    private ensureWriteLoop;
    /**
     * The main write loop, it will keep running until there are no more updates to process.
     */
    private writeLoop;
    /**
     * Returns whether the value is currently stale.
     *
     * A value is stale whenever the upstream subscription is not active. This can happen in three
     * cases:
     *
     * 1. When no subscriber is attached to this signal, the signal will not subscribe to the
     *    upstream. In this case, the value is always stale.
     * 2. When a subscriber is attached, but the upstream has not yet emitted a single value, the
     *    value is also stale.
     * 3. When the upstream has emitted an error. In this case, the subscription to the upstream is
     *    terminated and the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link OWLSignal#pull}.
     */
    isStale(): boolean;
    /**
     * Gets the current value of the signal. If the value is not available, it will return
     * {@link OWLSignal.NOT_AVAILABLE}. (A value will only be unavailable if the signal is created
     * without an initial value and the upstream has not emitted a value yet.)
     *
     * In addition, the value returned by this method may be stale. Use {@link OWLSignal#isStale} to
     * check if the value is stale.
     *
     * If you wish to get the current value and ensure that it is not stale, use the method
     * {@link OWLSignal#pull}.
     */
    get(): TData;
    /**
     * Gets the current value of the signal pessimistically. If the value is not available, it will
     * return {@link OWLSignal.NOT_AVAILABLE}. (A value will only be unavailable if the signal is
     * created without an initial value and the upstream has not emitted a value yet.)
     */
    getPessimistic(): TData;
    /**
     * Pulls the current value of the signal. If the value is stale, it will subscribe and wait for
     * the next value from the upstream and return it.
     *
     * You must also provide an `optimistic` flag. If `optimistic` is true, the pending optimistic
     * updates will be applied to the value before returning it.
     */
    pull({ optimistic }?: {
        optimistic?: boolean;
    }): Promise<StripNotAvailable<TData>>;
    private currentEnsureAvailablePromise;
    ensureAvailable(): Promise<OWLSignal<StripNotAvailable<TData>>>;
    subscribe(subscriber: Subscriber<TData>): () => void;
    subscribeFull(subscriber: SignalFullSubscriber<TData>): () => void;
}

/**
 * @public
 */
export declare interface ParsedConfig<TVirtualConfigSchematics extends VirtualConfigSchematics> {
    [configSchematicsBrand]?: TVirtualConfigSchematics;
    get<TKey extends keyof TVirtualConfigSchematics & string>(key: TKey): TVirtualConfigSchematics[TKey]["type"];
}

/**
 * Options for parsing a document.
 *
 * @public
 * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
 * updates.
 */
export declare type ParseDocumentOpts = DocumentParsingOpts & {
    /**
     * A callback function that is called when the parser is identified and loaded.
     */
    onParserLoaded?: (parser: DocumentParsingLibraryIdentifier) => void;
    /**
     * A callback function that is called with the progress of the document parsing (0-1).
     */
    onProgress?: (progress: number) => void;
    /**
     * An optional AbortSignal that can be used to abort the document parsing.
     */
    signal?: AbortSignal;
};

/**
 * The result of parsing a document.
 *
 * @public
 * @deprecated [DEP-DOC-PARSE] Document parsing API is still in active development. Stay tuned for
 * updates.
 */
export declare interface ParseDocumentResult {
    /**
     * String representation of the parsed document.
     */
    content: string;
    /**
     * The parser used to parse the document.
     */
    parser: DocumentParsingLibraryIdentifier;
}

/**
 * @public
 */
export declare interface PluginContext {
    /**
     * Sets the per-chat config schematics associated with this plugin context. Per-chat configs are
     * stored per chat, useful for configurations that would affect context. Returns the same
     * PluginContext for chaining.
     */
    withConfigSchematics: (configSchematics: ConfigSchematics<VirtualConfigSchematics>) => PluginContext;
    /**
     * Sets the global config schematics associated with this plugin context. Global configs are
     * global across the entire application, useful for things like API keys or database
     * configurations. Returns the same PluginContext for chaining.
     */
    withGlobalConfigSchematics: (globalConfigSchematics: ConfigSchematics<VirtualConfigSchematics>) => PluginContext;
    /**
     * Sets the prediction loop handler associated with this plugin context. Returns the same
     * PluginContext for chaining.
     */
    withPredictionLoopHandler(predictionLoopHandler: PredictionLoopHandler): PluginContext;
    /**
     * Sets the promptPreprocessor associated with this plugin context. Returns the same PluginContext for
     * chaining.
     */
    withPromptPreprocessor(preprocess: PromptPreprocessor): PluginContext;
    /**
     * Sets the tools provider associated with this plugin context. Returns the same PluginContext for
     * chaining.
     */
    withToolsProvider(toolsProvider: ToolsProvider): PluginContext;
    /**
     * Sets the generator associated with this plugin context. Returns the same PluginContext for
     * chaining.
     */
    withGenerator(generator: Generator_2): PluginContext;
}

/**
 * @public
 */
export declare interface PluginManifest extends ArtifactManifestBase {
    type: "plugin";
    runner: PluginRunnerType;
}

/**
 * @public
 */
export declare type PluginRunnerType = "ecmascript" | "node" | "mcpBridge";

/**
 * @deprecated This class is used internally by a plugin to register hooks. Do not use directly.
 * @public
 */
declare class PluginSelfRegistrationHost {
    private readonly port;
    private readonly client;
    private readonly rootLogger;
    private readonly validator;
    constructor(port: PluginsPort, client: LMStudioClient, rootLogger: LoggerInterface, validator: Validator);
    /**
     * Sets the promptPreprocessor to be used by the plugin represented by this client.
     *
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setPromptPreprocessor(promptPreprocessor: PromptPreprocessor): void;
    /**
     * Sets the prediction loop handler to be used by the plugin represented by this client.
     *
     * @deprecated [DEP-PLUGIN-PREDICTION-LOOP-HANDLER] Prediction loop handler support is still in
     * development. Stay tuned for updates.
     */
    setPredictionLoopHandler(predictionLoopHandler: PredictionLoopHandler): void;
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setConfigSchematics(configSchematics: ConfigSchematics<any>): Promise<void>;
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setGlobalConfigSchematics(globalConfigSchematics: ConfigSchematics<any>): Promise<void>;
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setToolsProvider(toolsProvider: ToolsProvider): void;
    /**
     * Sets the generator to be used by the plugin represented by this client.
     *
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    setGenerator(generator: Generator_2): void;
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    initCompleted(): Promise<void>;
}

/**
 * @public
 *
 * The namespace for file-related operations. Currently no public-facing methods.
 */
export declare class PluginsNamespace {
    private readonly client;
    private readonly validator;
    private readonly rootLogger;
    /**
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    registerDevelopmentPlugin(opts: RegisterDevelopmentPluginOpts): Promise<RegisterDevelopmentPluginResult>;
    /**
     * Requests LM Studio to reindex all the plugins.
     *
     * CAVEAT: Currently, we do not wait for the reindex to complete before returning. In the future,
     * we will change this behavior and only return after the reindex is completed.
     *
     * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
     * future without warning.
     */
    reindexPlugins(): Promise<void>;
    /**
     * If this client is currently running as a plugin, get the self registration host which can be
     * used to register hooks.
     *
     * @deprecated This method is used by plugins internally to register hooks. Do not use directly.
     */
    getSelfRegistrationHost(): PluginSelfRegistrationHost;
    /**
     * Starts a tool use session use any config specifier.
     */
    private internalStartToolUseSession;
    /**
     * Start a tool use session with a plugin. Note, this method must be used with "Explicit Resource
     * Management". That is, you should use it like so:
     *
     * ```typescript
     * using pluginTools = await client.plugins.pluginTools("owner/name", { ... });
     * // ^ Notice the `using` keyword here.
     * ```
     *
     * If you do not use `using`, you must call `pluginTools[Symbol.dispose]()` after you are done.
     * Otherwise, there will be a memory leak and the plugins you requested tools from will be loaded
     * indefinitely.
     *
     * @experimental [EXP-USE-USE-PLUGIN-TOOLS] Using tools from other applications is still in
     * development. This may change in the future without warning.
     */
    pluginTools(pluginIdentifier: string, opts?: PluginToolsOpts): Promise<RemoteToolUseSession>;
    /**
     * @experimental [EXP-GEN-PREDICT] Using generator plugins programmatically is still in
     * development. This may change in the future without warning.
     */
    createGeneratorHandle(pluginIdentifier: string): LLMGeneratorHandle;
}

declare type PluginsPort = InferClientPort<typeof createPluginsBackendInterface>;

/**
 * Options to use with {@link PluginsNamespace#pluginTools}.
 *
 * @experimental [EXP-USE-USE-PLUGIN-TOOLS] Using tools from other applications is still in
 * development. This may change in the future without warning.
 *
 * @public
 */
declare interface PluginToolsOpts {
    /**
     * @deprecated [DEP-PLUGIN-RAW-CONFIG] Plugin config access API is still in active development.
     * Stay tuned for updates.
     */
    pluginConfig?: KVConfig;
    /**
     * The working directory to use for the plugin tools. If not provided, the tools provider will not
     * get a working directory.
     */
    workingDirectory?: string;
}

/**
 * TODO: Documentation
 *
 * @public
 */
export declare type PredictionLoopHandler = (ctl: PredictionLoopHandlerController) => Promise<void>;

/**
 * @public
 */
export declare type PredictionLoopHandlerController = Omit<ProcessingController, never>;

/**
 * Controller for a citation block in the prediction process. Currently cannot do anything.
 *
 * @public
 */
export declare class PredictionProcessCitationBlockController {
    private readonly id;
}

/**
 * @public
 *
 * TODO: Documentation
 */
export declare class PredictionProcessContentBlockController {
    private readonly id;
    private readonly role;
    appendText(text: string, { tokensCount, fromDraftModel, isStructural }?: ContentBlockAppendTextOpts): void;
    appendToolRequest({ callId, toolCallRequestId, name, parameters, pluginIdentifier, }: ContentBlockAppendToolRequestOpts): void;
    replaceToolRequest({ callId, toolCallRequestId, name, parameters, pluginIdentifier, }: ContentBlockReplaceToolRequestOpts): void;
    appendToolResult({ callId, toolCallRequestId, content, }: ContentBlockAppendToolResultOpts): void;
    replaceText(text: string): void;
    setStyle(style: ContentBlockStyle): void;
    setPrefix(prefix: string): void;
    setSuffix(suffix: string): void;
    attachGenInfo(genInfo: LLMGenInfo): void;
    pipeFrom(prediction: OngoingPrediction): Promise<PredictionResult>;
}

/**
 * Controller for a debug info block in the prediction process. Currently cannot do anything.
 *
 * @public
 */
export declare class PredictionProcessDebugInfoBlockController {
    private readonly id;
}

/**
 * Controller for a status block in the prediction process.
 *
 * @public
 */
export declare class PredictionProcessStatusController {
    private readonly id;
    private readonly indentation;
    private lastSubStatus;
    private lastState;
    setText(text: string): void;
    setState(state: StatusStepState): void;
    remove(): void;
    private getNestedLastSubStatusBlockId;
    addSubStatus(initialState: StatusStepState): PredictionProcessStatusController;
}

/**
 * Controller for a tool status block in the prediction process.
 *
 * @public
 */
export declare class PredictionProcessToolStatusController {
    private readonly id;
    private status;
    private customStatus;
    private customWarnings;
    private updateState;
    setCustomStatusText(status: string): void;
    addWarning(warning: string): void;
    setStatus(status: ToolStatusStepStateStatus): void;
    appendArgumentFragment(content: string): void;
}

/**
 * Represents the result of an LLM prediction.
 *
 * The most notably property is {@link PredictionResult#content}, which contains the generated text.
 * Additionally, the {@link PredictionResult#stats} property contains statistics about the
 * prediction.
 *
 * @public
 */
export declare class PredictionResult implements BasePredictionResult {
    /**
     * The newly generated text as predicted by the LLM.
     */
    readonly content: string;
    /**
     * Part of the generated text that is "reasoning" content. For example, text inside <think>
     * tags. You can adjust what is considered reasoning content by changing the `reasoningParsing`
     * field when performing the prediction.
     */
    readonly reasoningContent: string;
    /**
     * Part of the generated that is not "reasoning" content. For example, text outside <think>
     * tags. You can adjust what is considered reasoning content by changing the `reasoningParsing`
     * field when performing the prediction.
     */
    readonly nonReasoningContent: string;
    /**
     * Statistics about the prediction.
     */
    readonly stats: LLMPredictionStats;
    /**
     * Information about the model used for the prediction.
     */
    readonly modelInfo: LLMInstanceInfo;
    /**
     * The 0-indexed round index of the prediction in multi-round scenario (for example,
     * `.act`). Will always be 0 for single-round predictions such as `.respond` or `.complete`.
     */
    readonly roundIndex: number;
    /**
     * The configuration used to load the model. Not stable, subject to change.
     *
     * @deprecated [DEP-RAW-CONFIG] Raw config access API is still in active development. Stay
     * turned for updates.
     */
    readonly loadConfig: KVConfig;
    /**
     * The configuration used for the prediction. Not stable, subject to change.
     *
     * @deprecated [DEP-RAW-CONFIG] Raw config access API is still in active development. Stay
     * turned for updates.
     */
    readonly predictionConfig: KVConfig;
    constructor(
    /**
     * The newly generated text as predicted by the LLM.
     */
    content: string, 
    /**
     * Part of the generated text that is "reasoning" content. For example, text inside <think>
     * tags. You can adjust what is considered reasoning content by changing the `reasoningParsing`
     * field when performing the prediction.
     */
    reasoningContent: string, 
    /**
     * Part of the generated that is not "reasoning" content. For example, text outside <think>
     * tags. You can adjust what is considered reasoning content by changing the `reasoningParsing`
     * field when performing the prediction.
     */
    nonReasoningContent: string, 
    /**
     * Statistics about the prediction.
     */
    stats: LLMPredictionStats, 
    /**
     * Information about the model used for the prediction.
     */
    modelInfo: LLMInstanceInfo, 
    /**
     * The 0-indexed round index of the prediction in multi-round scenario (for example,
     * `.act`). Will always be 0 for single-round predictions such as `.respond` or `.complete`.
     */
    roundIndex: number, 
    /**
     * The configuration used to load the model. Not stable, subject to change.
     *
     * @deprecated [DEP-RAW-CONFIG] Raw config access API is still in active development. Stay
     * turned for updates.
     */
    loadConfig: KVConfig, 
    /**
     * The configuration used for the prediction. Not stable, subject to change.
     *
     * @deprecated [DEP-RAW-CONFIG] Raw config access API is still in active development. Stay
     * turned for updates.
     */
    predictionConfig: KVConfig);
}

/**
 * @public
 */
export declare class ProcessingController extends BaseController {
    private readonly enabledPluginInfos;
    private sendUpdate;
    /**
     * Gets a mutable copy of the current history. The returned history is a copy, so mutating it will
     * not affect the actual history. It is mutable for convenience reasons.
     *
     * - If you are a promptPreprocessor, this will not include the user message you are currently
     *   preprocessing.
     * - If you are a prediction loop handler, this will include the user message, and can be fed into
     *   the {@link LLMDynamicHandle#respond} method directly.
     */
    pullHistory(): Promise<Chat>;
    createStatus(initialState: StatusStepState): PredictionProcessStatusController;
    addCitations(retrievalResult: RetrievalResult): void;
    addCitations(entries: Array<RetrievalResultEntry>): void;
    createCitationBlock(citedText: string, source: CreateCitationBlockOpts): PredictionProcessCitationBlockController;
    createContentBlock({ roleOverride, includeInContext, style, prefix, suffix, }?: CreateContentBlockOpts): PredictionProcessContentBlockController;
    debug(...messages: Array<any>): void;
    /**
     * Gets the token source associated with this prediction process (i.e. what the user has selected
     * on the top navigation bar).
     *
     * The token source can either be a model or a generator plugin. In both cases, the returned
     * object will contain a ".act" and a ".respond" method, which can be used to generate text.
     *
     * The token source is already pre-configured to use user's prediction config - you don't need to
     * pass through any additional configuration.
     */
    tokenSource(): Promise<LLM | LLMGeneratorHandle>;
    /**
     * Sets the sender name for this message. The sender name shown above the message in the chat.
     */
    setSenderName(name: string): Promise<void>;
    /**
     * Throws an error if the prediction process has been aborted. Sprinkle this throughout your code
     * to ensure that the prediction process is aborted as soon as possible.
     */
    guardAbort(): void;
    /**
     * Whether this prediction process has had any status.
     */
    hasStatus(): Promise<boolean>;
    /**
     * Returns whether this conversation needs a name.
     */
    needsNaming(): Promise<boolean>;
    /**
     * Suggests a name for this conversation.
     */
    suggestName(name: string): Promise<void>;
    requestConfirmToolCall({ callId, pluginIdentifier, name, parameters, }: RequestConfirmToolCallOpts): Promise<RequestConfirmToolCallResult>;
    createToolStatus(callId: number, initialStatus: ToolStatusStepStateStatus): PredictionProcessToolStatusController;
    /**
     * Starts a tool use session with tools available in the prediction process. Note, this method
     * should be used with "Explicit Resource Management". That is, you should use it like so:
     *
     * ```typescript
     * using toolUseSession = await ctl.startToolUseSession();
     * // ^ Notice the `using` keyword here.
     * ```
     *
     * If you do not `using`, you should call `toolUseSession[Symbol.dispose]()` after you are done.
     *
     * If you don't, lmstudio-js will close the session upon the end of the prediction step
     * automatically. However, it is not recommended.
     *
     * @public
     * @deprecated WIP
     */
    startToolUseSession(): Promise<RemoteToolUseSession>;
}

declare type ProcessingRequest = ProcessingRequestConfirmToolCall | ProcessingRequestTextInput;

/**
 * Represents a request to the user to confirm a tool call.
 */
declare type ProcessingRequestConfirmToolCall = {
    type: "confirmToolCall";
    callId: number;
    /**
     * The plugin that provided the tool.
     */
    pluginIdentifier?: string;
    /**
     * The name of the tool to call.
     */
    name: string;
    /**
     * The parameters to pass to the tool.
     */
    parameters: Record<string, any>;
};

declare type ProcessingRequestResponse = ProcessingRequestResponseConfirmToolCall | ProcessingRequestResponseTextInput;

declare type ProcessingRequestResponseConfirmToolCall = {
    type: "confirmToolCall";
    result: {
        type: "allow";
        toolArgsOverride?: Record<string, any>;
    } | {
        type: "deny";
        denyReason?: string;
    };
};

/**
 * @deprecated [DEP-PLUGIN-PREDICTION-LOOP-HANDLER] Prediction loop handler support is still in
 * development. Stay tuned for updates.
 */
declare type ProcessingRequestResponseTextInput = {
    type: "textInput";
    result: string;
};

/**
 * @deprecated [DEP-PLUGIN-PREDICTION-LOOP-HANDLER] Prediction loop handler support is still in
 * development. Stay tuned for updates.
 */
declare type ProcessingRequestTextInput = {
    type: "textInput";
    prompt: string;
};

declare type ProcessingUpdate = ProcessingUpdateStatusCreate | ProcessingUpdateStatusUpdate | ProcessingUpdateStatusRemove | ProcessingUpdateCitationBlockCreate | ProcessingUpdateDebugInfoBlockCreate | ProcessingUpdateContentBlockCreate | ProcessingUpdateContentBlockAppendText | ProcessingUpdateContentBlockAppendToolRequest | ProcessingUpdateContentBlockReplaceToolRequest | ProcessingUpdateContentBlockAppendToolResult | ProcessingUpdateContentBlockReplaceText | ProcessingUpdateContentBlockSetPrefix | ProcessingUpdateContentBlockSetSuffix | ProcessingUpdateContentBlockAttachGenInfo | ProcessingUpdateContentBlockSetStyle | ProcessingUpdateToolStatusCreate | ProcessingUpdateToolStatusUpdate | ProcessingUpdateToolStatusArgumentFragment | ProcessingUpdateSetSenderName;

declare type ProcessingUpdateCitationBlockCreate = {
    type: "citationBlock.create";
    id: string;
    citedText: string;
    fileName: string;
    fileIdentifier: string;
    pageNumber?: number | [start: number, end: number];
    lineNumber?: number | [start: number, end: number];
};

declare type ProcessingUpdateContentBlockAppendText = {
    type: "contentBlock.appendText";
    id: string;
    text: string;
    tokensCount?: number;
    fromDraftModel?: boolean;
    isStructural?: boolean;
};

declare type ProcessingUpdateContentBlockAppendToolRequest = {
    type: "contentBlock.appendToolRequest";
    /**
     * ID of the content block.
     */
    id: string;
    /**
     * Call ID created by LM Studio. Used to pair up requests and responses.
     */
    callId: number;
    /**
     * Model specific optional tool call request ID (string).
     */
    toolCallRequestId?: string;
    /**
     * Name of the tool called.
     */
    name: string;
    /**
     * Arguments of the tool call.
     */
    parameters: Record<string, unknown>;
    /**
     * Optional identifier of the plugin that provided the tool.
     */
    pluginIdentifier?: string;
};

declare type ProcessingUpdateContentBlockAppendToolResult = {
    type: "contentBlock.appendToolResult";
    /**
     * ID of the content block.
     */
    id: string;
    /**
     * Call ID created by LM Studio. Used to pair up requests and responses.
     */
    callId: number;
    /**
     * Model specific optional tool call request ID (string).
     */
    toolCallRequestId?: string;
    /**
     * Result of the tool call.
     */
    content: string;
};

declare type ProcessingUpdateContentBlockAttachGenInfo = {
    type: "contentBlock.attachGenInfo";
    id: string;
    genInfo: LLMGenInfo;
};

declare type ProcessingUpdateContentBlockCreate = {
    type: "contentBlock.create";
    id: string;
    includeInContext: boolean;
    roleOverride?: "user" | "assistant" | "system" | "tool";
    style?: ContentBlockStyle;
    prefix?: string;
    suffix?: string;
};

declare type ProcessingUpdateContentBlockReplaceText = {
    type: "contentBlock.replaceText";
    id: string;
    text: string;
};

declare type ProcessingUpdateContentBlockReplaceToolRequest = {
    type: "contentBlock.replaceToolRequest";
    id: string;
    /**
     * Call ID created by LM Studio. Used to pair up requests and responses.
     */
    callId: number;
    /**
     * Model specific optional tool call request ID (string).
     */
    toolCallRequestId?: string;
    /**
     * Name of the tool called.
     */
    name: string;
    /**
     * Arguments of the tool call.
     */
    parameters: Record<string, unknown>;
    /**
     * Optional identifier of the plugin that provided the tool.
     */
    pluginIdentifier?: string;
};

declare type ProcessingUpdateContentBlockSetPrefix = {
    type: "contentBlock.setPrefix";
    id: string;
    prefix: string;
};

declare type ProcessingUpdateContentBlockSetStyle = {
    type: "contentBlock.setStyle";
    id: string;
    style: ContentBlockStyle;
};

declare type ProcessingUpdateContentBlockSetSuffix = {
    type: "contentBlock.setSuffix";
    id: string;
    suffix: string;
};

declare type ProcessingUpdateDebugInfoBlockCreate = {
    type: "debugInfoBlock.create";
    id: string;
    debugInfo: string;
};

declare type ProcessingUpdateSetSenderName = {
    type: "setSenderName";
    name: string;
};

declare type ProcessingUpdateStatusCreate = {
    type: "status.create";
    id: string;
    state: StatusStepState;
    location?: BlockLocation;
    indentation?: number;
};

declare type ProcessingUpdateStatusRemove = {
    type: "status.remove";
    id: string;
};

declare type ProcessingUpdateStatusUpdate = {
    type: "status.update";
    id: string;
    state: StatusStepState;
};

declare type ProcessingUpdateToolStatusArgumentFragment = {
    type: "toolStatus.argumentFragment";
    id: string;
    content: string;
};

declare type ProcessingUpdateToolStatusCreate = {
    type: "toolStatus.create";
    id: string;
    callId: number;
    state: ToolStatusStepState;
};

declare type ProcessingUpdateToolStatusUpdate = {
    type: "toolStatus.update";
    id: string;
    state: ToolStatusStepState;
};

/**
 * TODO: Documentation
 *
 * @public
 */
export declare type PromptPreprocessor = (ctl: PromptPreprocessorController, userMessage: ChatMessage) => Promise<string | ChatMessage>;

/**
 * @public
 */
export declare type PromptPreprocessorController = Omit<ProcessingController, "createContentBlock" | "setSenderName">;

/**
 * Options to use with {@link RepositoryNamespace#pushArtifact}.
 *
 * @public
 */
export declare interface PushArtifactOpts {
    path: string;
    /**
     * Change the description of the artifact.
     */
    description?: string;
    /**
     * Request to make the artifact private. Only effective if the artifact did not exist before. Will
     * not change the visibility of an existing artifact.
     */
    makePrivate?: boolean;
    /**
     * If true, will write the revision number of the artifact after the push back to the artifact
     * manifest.json.
     */
    writeRevision?: boolean;
    /**
     * Internal overrides for updating artifact metadata.
     */
    overrides?: any;
    onMessage?: (message: string) => void;
}

/**
 * Represents the quantization of a model.
 *
 * @public
 */
declare type Quantization = {
    /**
     * Name of the quantization.
     */
    name: string;
    /**
     * Roughly how many bits this quantization uses per value. This is not accurate and can vary from
     * the actual BPW (bits per weight) of the quantization. Gives a rough idea of the
     * quantization level.
     */
    bits: number;
};

/**
 * A tool that has a its parameters defined by a JSON schema.
 *
 * @public
 * @experimental [EXP-RAW-FUNCTION] This is an experimental feature and may change in the future.
 */
export declare interface RawFunctionTool extends ToolBase {
    type: "rawFunction";
    parametersJsonSchema: any;
    /**
     * Checks the parameters. If not valid, throws an error.
     */
    checkParameters: (params: any) => void;
    implementation: (params: Record<string, unknown>, ctx: ToolCallContext) => any | Promise<any>;
}

/**
 * A function that can be used to create a raw function `Tool` given a function definition and its
 * implementation.
 *
 * @public
 * @experimental Not stable, will likely change in the future.
 */
export declare function rawFunctionTool({ name, description, parametersJsonSchema, implementation, }: {
    name: string;
    description: string;
    parametersJsonSchema: any;
    implementation: (params: Record<string, unknown>, ctx: ToolCallContext) => any | Promise<any>;
}): Tool;

/**
 * Options to use with {@link PluginsNamespace#registerDevelopmentPlugin}.
 *
 * @public
 */
export declare interface RegisterDevelopmentPluginOpts {
    manifest: PluginManifest;
}

/**
 * Result of {@link PluginsNamespace#registerDevelopmentPlugin}.
 *
 * @public
 */
export declare interface RegisterDevelopmentPluginResult {
    clientIdentifier: string;
    clientPasskey: string;
    unregister: () => Promise<void>;
}

/**
 * Represents a plugin that is currently available in LM Studio.
 *
 * @experimental [EXP-USE-PLUGINS-API] Using plugins API is still in development. This may change in
 * the future without warning.
 *
 * @public
 */
declare interface RemotePluginInfo {
    /**
     * The identifier of the plugin. For non-dev plugins, this is the same as the artifact identifier
     * when uploaded to LM Studio Hub. For example, `lmstudio/dice`.
     *
     * For dev plugins, this will be prefixed with `dev/` to indicate that it is a development
     * version. For example, `dev/owner/plugin-name`.
     *
     * The exact format of this identifier may change in the future. You should not parse it.
     */
    identifier: string;
    /**
     * Whether this plugin is in development mode, e.g. running externally using `lms dev`.
     */
    isDev: boolean;
    /**
     * Whether this plugin is trusted.
     */
    isTrusted: boolean;
    /**
     * Whether this plugin has a prompt preprocessor component.
     */
    hasPromptPreprocessor: boolean;
    /**
     * Whether this plugin has a prediction loop handler component.
     */
    hasPredictionLoopHandler: boolean;
    /**
     * Whether this plugin has a tools provider component.
     */
    hasToolsProvider: boolean;
    /**
     * Whether this plugin has a generator component.
     */
    hasGenerator: boolean;
}

/**
 * Represents a tool that is exposed by LMStudio plugins.
 *
 * @public
 * @experimental [EXP-USE-USE-PLUGIN-TOOLS] Using tools from other plugins is still in development.
 * This may change in the future without warning.
 */
declare interface RemoteTool extends ToolBase {
    type: "remoteTool";
    /**
     * Which plugin this tool belongs to.
     */
    pluginIdentifier: string;
    parametersJsonSchema: any;
    checkParameters: (params: any) => void;
    implementation: (params: Record<string, unknown>, ctx: ToolCallContext) => any | Promise<any>;
}

/**
 * Represents a session for using remote tools.
 */
declare interface RemoteToolUseSession extends Disposable {
    tools: Array<RemoteTool>;
    [Symbol.dispose](): void;
}

/** @public */
export declare class RepositoryNamespace {
    private readonly repositoryPort;
    private readonly validator;
    searchModels(opts: ModelSearchOpts): Promise<Array<ModelSearchResultEntry>>;
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    installPluginDependencies(pluginFolder: string): Promise<void>;
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    downloadArtifact(opts: DownloadArtifactOpts): Promise<void>;
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    pushArtifact(opts: PushArtifactOpts): Promise<void>;
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    getLocalArtifactFileList(path: string): Promise<LocalArtifactFileList>;
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    ensureAuthenticated(opts: EnsureAuthenticatedOpts): Promise<void>;
    loginWithPreAuthenticatedKeys(opts: LoginWithPreAuthenticatedKeysOpts): Promise<LoginWithPreAuthenticatedKeysResult>;
    private readonly downloadPlanFinalizationRegistry;
    /**
     * @deprecated [DEP-HUB-API-ACCESS] LM Studio Hub API access is still in active development. Stay
     * tuned for updates.
     */
    createArtifactDownloadPlanner(opts: CreateArtifactDownloadPlannerOpts): ArtifactDownloadPlanner;
}

/**
 * Options to use with {@link ProcessingController#requestConfirmToolCall}.
 *
 * @public
 * @deprecated [DEP-PLUGIN-PREDICTION-LOOP-HANDLER] Prediction loop handler support is still in
 * development. Stay tuned for updates.
 */
export declare interface RequestConfirmToolCallOpts {
    callId: number;
    pluginIdentifier?: string;
    name: string;
    parameters: Record<string, any>;
}

/**
 * Return type of {@link ProcessingController#requestConfirmToolCall}.
 *
 * @public
 * @deprecated [DEP-PLUGIN-PREDICTION-LOOP-HANDLER] Prediction loop handler support is still in
 * development. Stay tuned for updates.
 */
export declare type RequestConfirmToolCallResult = {
    type: "allow";
    toolArgsOverride?: Record<string, any>;
} | {
    type: "deny";
    denyReason?: string;
};

/**
 * @public
 */
export declare interface RetrievalCallbacks {
    /**
     * Callback when the list of files to process is available. This list can be shorter than the list
     * passed in because some files may already have cached embeddings.
     *
     * @param filePathsToProcess - The list of files that will be processed.
     */
    onFileProcessList?: (filesToProcess: Array<FileHandle>) => void;
    /**
     * Callback when starting to process a file.
     *
     * @param file - The file being processed.
     * @param index - The index of the file in the list of files to process.
     * @param filePathsToProcess - The list of files that will be processed. This will be the same as
     * the list passed to `onFileProcessList`.
     */
    onFileProcessingStart?: (file: FileHandle, index: number, filesToProcess: Array<FileHandle>) => void;
    /**
     * Callback when processing a file has ended.
     *
     * @param file - The file that has been processed.
     * @param index - The index of the file in the list of files to process.
     * @param filePathsToProcess - The list of files that will be processed. This will be the same as
     * the list passed to `onFileProcessList`.
     */
    onFileProcessingEnd?: (file: FileHandle, index: number, filesToProcess: Array<FileHandle>) => void;
    /**
     * Callback when starting a processing step for a file. LM Studio process files one at a time and
     * processing each file involves multiple steps. This callback is called when starting a step.
     *
     * @param file - The file being processed.
     * @param step - The step being started.
     */
    onFileProcessingStepStart?: (file: FileHandle, step: RetrievalFileProcessingStep) => void;
    /**
     * Granular progress callback for a processing step.
     *
     * @param file - The file being processed.
     * @param step - The step being started.
     * @param progressInStep - The progress in the step for the step. This value is between 0 and 1.
     */
    onFileProcessingStepProgress?: (file: FileHandle, step: RetrievalFileProcessingStep, progressInStep: number) => void;
    /**
     * Callback when a processing step has ended.
     *
     * @param file - The file being processed.
     * @param step - The step that has ended.
     */
    onFileProcessingStepEnd?: (file: FileHandle, step: RetrievalFileProcessingStep) => void;
    /**
     * Callback when we have embedded all the files and are starting to search in the vector database.
     */
    onSearchingStart?: () => void;
    /**
     * Callback when we have finished searching in the vector database. The chunk usually will be
     * returned immediately after this callback.
     */
    onSearchingEnd?: () => void;
    /**
     * Controls the logging of retrieval progress.
     *
     * - If set to `true`, logs progress at the "info" level.
     * - If set to `false`, no logs are emitted. This is the default.
     * - If a specific logging level is desired, it can be provided as a string. Acceptable values are
     *   "debug", "info", "warn", and "error".
     *
     * Logs are directed to the logger specified during the `LMStudioClient` construction.
     *
     * Progress logs will be disabled if any of the callbacks are provided.
     *
     * Default value is "info", which logs progress at the "info" level.
     */
    verbose?: boolean | LogLevel;
}

/**
 * @public
 */
export declare interface RetrievalChunk {
    content: string;
    score: number;
    citation: CitationSource;
}

/**
 * @public
 */
export declare type RetrievalChunkingMethod = {
    type: "recursive-v1";
    chunkSize: number;
    chunkOverlap: number;
};

/**
 * @public
 */
export declare type RetrievalFileProcessingStep = "loading" | "chunking" | "embedding";

/**
 * @public
 * N.B.: onProgress returns progress as a float taking values from 0 to 1, 1 being completed
 */
export declare type RetrievalOpts = RetrievalCallbacks & {
    /**
     * The chunking method to use. By default uses recursive-v1 with chunk size 512 and chunk overlap
     * 100.
     */
    chunkingMethod?: RetrievalChunkingMethod;
    /**
     * The number of results to return.
     */
    limit?: number;
    /**
     * The embedding model to use.
     */
    embeddingModel?: EmbeddingDynamicHandle;
    /**
     * The path to the database.
     */
    databasePath?: string;
    /**
     * The signal to abort the retrieval
     */
    signal?: AbortSignal;
};

/** @public */
export declare interface RetrievalResult {
    entries: Array<RetrievalResultEntry>;
}

/** @public */
export declare interface RetrievalResultEntry {
    content: string;
    score: number;
    source: FileHandle;
}

declare interface RpcEndpoint {
    name: string;
    parameter: z.ZodType;
    returns: z.ZodType;
    serialization: SerializationType;
    handler: RpcEndpointHandler | null;
}

declare type RpcEndpointHandler<TContext = any, TParameter = any, TReturns = any> = (ctx: TContext, parameter: TParameter) => TReturns | Promise<TReturns>;

declare interface RpcEndpointSpecBase {
    parameter: any;
    returns: any;
}

declare type RpcEndpointsSpecBase = {
    [endpointName: string]: RpcEndpointSpecBase;
};

/**
 * Type of serialization:
 *
 * Raw: JSON.stringify and JSON.parse
 * Superjson: SuperJSON.serialize and SuperJSON.deserialize
 */
declare type SerializationType = "raw" | "superjson";

/**
 * @public
 */
declare interface SerializedKVConfigSchematics {
    fields: Array<SerializedKVConfigSchematicsField>;
    extensionPrefixes?: Array<string>;
}

/**
 * @public
 */
declare interface SerializedKVConfigSchematicsField {
    shortKey: string;
    fullKey: string;
    typeKey: string;
    typeParams: any;
    defaultValue: any;
}

declare type SerializedLMSExtendedError = z.infer<typeof serializedLMSExtendedErrorSchema>;

declare const serializedLMSExtendedErrorSchema: z.ZodObject<{
    title: z.ZodDefault<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    cause: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    suggestion: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    errorData: z.ZodOptional<z.ZodType<Record<string, unknown> | undefined, z.ZodTypeDef, Record<string, unknown> | undefined>>;
    displayData: z.ZodOptional<z.ZodType<{
        code: "generic.specificModelUnloaded";
    } | {
        code: "generic.noModelMatchingQuery";
        query: {
            path?: string | undefined;
            identifier?: string | undefined;
            domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
            vision?: boolean | undefined;
        };
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.pathNotFound";
        path: string;
        availablePathsSample: string[];
        totalModels: number;
    } | {
        code: "generic.identifierNotFound";
        identifier: string;
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.domainMismatch";
        path: string;
        actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
    } | {
        code: "generic.engineDoesNotSupportFeature";
        feature: string;
        engineName: string;
        engineType: string;
        installedVersion: string;
        supportedVersion: string | null;
    } | {
        code: "generic.presetNotFound";
        specifiedFuzzyPresetIdentifier: string;
        availablePresetsSample: {
            name: string;
            identifier: string;
        }[];
        totalAvailablePresets: number;
    } | undefined, z.ZodTypeDef, {
        code: "generic.specificModelUnloaded";
    } | {
        code: "generic.noModelMatchingQuery";
        query: {
            path?: string | undefined;
            identifier?: string | undefined;
            domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
            vision?: boolean | undefined;
        };
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.pathNotFound";
        path: string;
        availablePathsSample: string[];
        totalModels: number;
    } | {
        code: "generic.identifierNotFound";
        identifier: string;
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.domainMismatch";
        path: string;
        actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
    } | {
        code: "generic.engineDoesNotSupportFeature";
        feature: string;
        engineName: string;
        engineType: string;
        installedVersion: string;
        supportedVersion: string | null;
    } | {
        code: "generic.presetNotFound";
        specifiedFuzzyPresetIdentifier: string;
        availablePresetsSample: {
            name: string;
            identifier: string;
        }[];
        totalAvailablePresets: number;
    } | undefined>>;
    stack: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    rootTitle: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    cause?: string | undefined;
    suggestion?: string | undefined;
    errorData?: Record<string, unknown> | undefined;
    displayData?: {
        code: "generic.specificModelUnloaded";
    } | {
        code: "generic.noModelMatchingQuery";
        query: {
            path?: string | undefined;
            identifier?: string | undefined;
            domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
            vision?: boolean | undefined;
        };
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.pathNotFound";
        path: string;
        availablePathsSample: string[];
        totalModels: number;
    } | {
        code: "generic.identifierNotFound";
        identifier: string;
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.domainMismatch";
        path: string;
        actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
    } | {
        code: "generic.engineDoesNotSupportFeature";
        feature: string;
        engineName: string;
        engineType: string;
        installedVersion: string;
        supportedVersion: string | null;
    } | {
        code: "generic.presetNotFound";
        specifiedFuzzyPresetIdentifier: string;
        availablePresetsSample: {
            name: string;
            identifier: string;
        }[];
        totalAvailablePresets: number;
    } | undefined;
    stack?: string | undefined;
    rootTitle?: string | undefined;
}, {
    title?: string | undefined;
    cause?: string | undefined;
    suggestion?: string | undefined;
    errorData?: Record<string, unknown> | undefined;
    displayData?: {
        code: "generic.specificModelUnloaded";
    } | {
        code: "generic.noModelMatchingQuery";
        query: {
            path?: string | undefined;
            identifier?: string | undefined;
            domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
            vision?: boolean | undefined;
        };
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.pathNotFound";
        path: string;
        availablePathsSample: string[];
        totalModels: number;
    } | {
        code: "generic.identifierNotFound";
        identifier: string;
        loadedModelsSample: string[];
        totalLoadedModels: number;
    } | {
        code: "generic.domainMismatch";
        path: string;
        actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
    } | {
        code: "generic.engineDoesNotSupportFeature";
        feature: string;
        engineName: string;
        engineType: string;
        installedVersion: string;
        supportedVersion: string | null;
    } | {
        code: "generic.presetNotFound";
        specifiedFuzzyPresetIdentifier: string;
        availablePresetsSample: {
            name: string;
            identifier: string;
        }[];
        totalAvailablePresets: number;
    } | undefined;
    stack?: string | undefined;
    rootTitle?: string | undefined;
}>;

/**
 * Opaque type that represents a serialized value. The representation here is not accurate and is
 * only used to prevent accidental reading/writing of the opaque value.
 */
declare type SerializedOpaque<T> = {
    [serializedOpaqueSymbol]: T;
};

declare const serializedOpaqueSymbol: unique symbol;

declare type ServerToClientMessage = z.infer<typeof serverToClientMessageSchema>;

declare const serverToClientMessageSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"communicationWarning">;
    warning: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "communicationWarning";
    warning: string;
}, {
    type: "communicationWarning";
    warning: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"keepAliveAck">;
}, "strip", z.ZodTypeAny, {
    type: "keepAliveAck";
}, {
    type: "keepAliveAck";
}>, z.ZodObject<{
    type: z.ZodLiteral<"channelSend">;
    channelId: z.ZodNumber;
    message: z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>;
    ackId: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    message: SerializedOpaque<any>;
    type: "channelSend";
    channelId: number;
    ackId?: number | undefined;
}, {
    message: SerializedOpaque<any>;
    type: "channelSend";
    channelId: number;
    ackId?: number | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"channelAck">;
    channelId: z.ZodNumber;
    ackId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "channelAck";
    channelId: number;
    ackId: number;
}, {
    type: "channelAck";
    channelId: number;
    ackId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"channelClose">;
    channelId: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "channelClose";
    channelId: number;
}, {
    type: "channelClose";
    channelId: number;
}>, z.ZodObject<{
    type: z.ZodLiteral<"channelError">;
    channelId: z.ZodNumber;
    error: z.ZodObject<{
        title: z.ZodDefault<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        cause: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        suggestion: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        errorData: z.ZodOptional<z.ZodType<Record<string, unknown> | undefined, z.ZodTypeDef, Record<string, unknown> | undefined>>;
        displayData: z.ZodOptional<z.ZodType<{
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined, z.ZodTypeDef, {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined>>;
        stack: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        rootTitle: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }, {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "channelError";
    channelId: number;
    error: {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}, {
    type: "channelError";
    channelId: number;
    error: {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"rpcResult">;
    callId: z.ZodNumber;
    result: z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>;
}, "strip", z.ZodTypeAny, {
    type: "rpcResult";
    callId: number;
    result: SerializedOpaque<any>;
}, {
    type: "rpcResult";
    callId: number;
    result: SerializedOpaque<any>;
}>, z.ZodObject<{
    type: z.ZodLiteral<"rpcError">;
    callId: z.ZodNumber;
    error: z.ZodObject<{
        title: z.ZodDefault<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        cause: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        suggestion: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        errorData: z.ZodOptional<z.ZodType<Record<string, unknown> | undefined, z.ZodTypeDef, Record<string, unknown> | undefined>>;
        displayData: z.ZodOptional<z.ZodType<{
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined, z.ZodTypeDef, {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined>>;
        stack: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        rootTitle: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }, {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "rpcError";
    callId: number;
    error: {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}, {
    type: "rpcError";
    callId: number;
    error: {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"signalUpdate">;
    subscribeId: z.ZodNumber;
    patches: z.ZodArray<z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>, "many">;
    tags: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    type: "signalUpdate";
    subscribeId: number;
    patches: SerializedOpaque<any>[];
    tags: string[];
}, {
    type: "signalUpdate";
    subscribeId: number;
    patches: SerializedOpaque<any>[];
    tags: string[];
}>, z.ZodObject<{
    type: z.ZodLiteral<"signalError">;
    subscribeId: z.ZodNumber;
    error: z.ZodObject<{
        title: z.ZodDefault<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        cause: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        suggestion: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        errorData: z.ZodOptional<z.ZodType<Record<string, unknown> | undefined, z.ZodTypeDef, Record<string, unknown> | undefined>>;
        displayData: z.ZodOptional<z.ZodType<{
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined, z.ZodTypeDef, {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined>>;
        stack: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        rootTitle: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }, {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "signalError";
    subscribeId: number;
    error: {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}, {
    type: "signalError";
    subscribeId: number;
    error: {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"writableSignalUpdate">;
    subscribeId: z.ZodNumber;
    patches: z.ZodArray<z.ZodType<SerializedOpaque<any>, z.ZodTypeDef, SerializedOpaque<any>>, "many">;
    tags: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    type: "writableSignalUpdate";
    subscribeId: number;
    patches: SerializedOpaque<any>[];
    tags: string[];
}, {
    type: "writableSignalUpdate";
    subscribeId: number;
    patches: SerializedOpaque<any>[];
    tags: string[];
}>, z.ZodObject<{
    type: z.ZodLiteral<"writableSignalError">;
    subscribeId: z.ZodNumber;
    error: z.ZodObject<{
        title: z.ZodDefault<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        cause: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        suggestion: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        errorData: z.ZodOptional<z.ZodType<Record<string, unknown> | undefined, z.ZodTypeDef, Record<string, unknown> | undefined>>;
        displayData: z.ZodOptional<z.ZodType<{
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined, z.ZodTypeDef, {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined>>;
        stack: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
        rootTitle: z.ZodOptional<z.ZodType<string | undefined, z.ZodTypeDef, string | undefined>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }, {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "writableSignalError";
    subscribeId: number;
    error: {
        title: string;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}, {
    type: "writableSignalError";
    subscribeId: number;
    error: {
        title?: string | undefined;
        cause?: string | undefined;
        suggestion?: string | undefined;
        errorData?: Record<string, unknown> | undefined;
        displayData?: {
            code: "generic.specificModelUnloaded";
        } | {
            code: "generic.noModelMatchingQuery";
            query: {
                path?: string | undefined;
                identifier?: string | undefined;
                domain?: "llm" | "embedding" | "imageGen" | "transcription" | "tts" | undefined;
                vision?: boolean | undefined;
            };
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.pathNotFound";
            path: string;
            availablePathsSample: string[];
            totalModels: number;
        } | {
            code: "generic.identifierNotFound";
            identifier: string;
            loadedModelsSample: string[];
            totalLoadedModels: number;
        } | {
            code: "generic.domainMismatch";
            path: string;
            actualDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
            expectedDomain: "llm" | "embedding" | "imageGen" | "transcription" | "tts";
        } | {
            code: "generic.engineDoesNotSupportFeature";
            feature: string;
            engineName: string;
            engineType: string;
            installedVersion: string;
            supportedVersion: string | null;
        } | {
            code: "generic.presetNotFound";
            specifiedFuzzyPresetIdentifier: string;
            availablePresetsSample: {
                name: string;
                identifier: string;
            }[];
            totalAvailablePresets: number;
        } | undefined;
        stack?: string | undefined;
        rootTitle?: string | undefined;
    };
}>]>;

/**
 * A setter is a function that can be used to update a value. Different flavors of setters are
 * available in properties:
 * - `withProducer`: to update the value using Immer
 * - `withUpdater`: to update the value using a function
 * - `withPatches`: to update the value using a set of patches
 */
declare interface Setter<TData> {
    /**
     * Replaces the value entirely with the given value. If you want to update a substructure of the
     * value, use `withProducer`.
     */
    (value: StripNotAvailable<TData>, tags?: Array<WriteTag>): void;
    /**
     * Updates the value using Immer. (Recommended)
     */
    withProducer(producer: (draft: TData) => void, tags?: Array<WriteTag>): void;
    /**
     * Updates the value using a function. Prefer using `withProducer` instead.
     */
    withUpdater(updater: (oldValue: TData) => StripNotAvailable<TData>, tags?: Array<WriteTag>): void;
    /**
     * Updates the value using a function that returns both the new value and the patches to apply.
     */
    withPatchUpdater(updater: (oldValue: TData) => readonly [newValue: StripNotAvailable<TData>, patches: Array<Patch>], tags?: Array<WriteTag>): void;
    /**
     * Updates the value using a set of patches.
     */
    withPatches(patches: Array<Patch>, tags?: Array<WriteTag>): void;
    /**
     * Similar to `withPatches`, but also accepts the new value. This is useful when the new value is
     * already known.
     */
    withValueAndPatches(newValue: StripNotAvailable<TData>, patches: Array<Patch>, tags?: Array<WriteTag>): void;
}

/**
 * A signal is a wrapper for a value. It can be used to notify subscribers when the value changes.
 * For it to work properly, the value should be immutable.
 *
 * To create a signal, please use the `Signal.create` static method. It will return a signal
 * along with a function to update its value.
 */
declare class Signal<TValue> extends Subscribable<TValue> implements SignalLike<TValue> {
    private value;
    private equalsPredicate;
    /**
     * Creates a signal.
     *
     * @param value - The initial value of the signal.
     * @param equalsPredicate - A function to compare two values. The subscribers will only be called
     * if the value changes according to the `equalsPredicate`. By default, it uses the `===`
     * operator.
     * @returns This method returns a tuple with two elements:
     * - The signal
     * - A function to update the value
     **/
    static create<TValue>(value: TValue, equalsPredicate?: (a: TValue, b: TValue) => boolean): readonly [Signal<TValue>, Setter<TValue>];
    static createReadonly<TValue>(value: TValue): Signal<TValue>;
    protected constructor(value: TValue, equalsPredicate: (a: TValue, b: TValue) => boolean);
    private subscribers;
    /**
     * Returns the current value of the signal.
     */
    get(): TValue;
    pull(): StripNotAvailable<TValue>;
    private queuedUpdaters;
    private isEmitting;
    private notifyFull;
    private notifyAll;
    private notifyAndUpdateIfChanged;
    private isReplaceRoot;
    private update;
    /**
     * Subscribes to the signal. The callback will be called whenever the value changes. All callbacks
     * are called synchronously upon updating. It will NOT be immediately called with the current
     * value. (Use `get()` to get the current value.) Returns a function to unsubscribe.
     *
     * Edge cases involving manipulating the signal in the callback:
     *
     * - If the callback adds new subscribers, they will also be called within the same update.
     * - If the callback causes removal of subscribers that have not been called yet, they will no
     *   longer be called.
     * - If the callback causes an update of the value, the update will be queued. If multiple updates
     *   are queued, only the last one will be executed.
     *
     * Edge cases involving adding the same callback multiple times.
     *
     *  - Callbacks are tracked with a set. Adding the same subscriber will not cause it to be called
     *    multiple times.
     */
    subscribe(callback: Subscriber<TValue>): () => void;
    /**
     * Subscribes to the signal with the callback and trigger the callback immediately with the
     * current value.
     */
    subscribeAndNow(callback: Subscriber<TValue>): () => void;
    subscribeFull(callback: SignalFullSubscriber<TValue>): () => void;
    /**
     * Wait until the signal satisfies a predicate. If the predicate is already satisfied, it will
     * return immediately. Otherwise, it will wait until the signal satisfies the predicate.
     */
    until(predicate: (data: TValue) => boolean): Promise<TValue>;
}

declare interface SignalEndpoint {
    name: string;
    creationParameter: z.ZodType;
    signalData: z.ZodType;
    serialization: SerializationType;
    handler: SignalEndpointHandler | null;
}

declare type SignalEndpointHandler<TContext = any, TCreationParameter = any, TData = any> = (ctx: TContext, creationParameter: TCreationParameter) => SignalLike<TData> | Promise<SignalLike<TData>> | SignalLike<TData | NotAvailable> | Promise<SignalLike<TData | NotAvailable>>;

declare interface SignalEndpointSpecBase {
    creationParameter: any;
    signalData: any;
}

declare type SignalEndpointsSpecBase = {
    [endpointName: string]: SignalEndpointSpecBase;
};

declare type SignalFullSubscriber<TValue> = (value: TValue, patches: Array<Patch>, tags: Array<WriteTag>) => void;

declare interface SignalLike<TValue> extends Subscribable<TValue> {
    get(): TValue;
    subscribe(subscriber: Subscriber<TValue>): () => void;
    subscribeFull(subscriber: SignalFullSubscriber<TValue>): () => void;
    pull(): Promise<StripNotAvailable<TValue>> | StripNotAvailable<TValue>;
}

/**
 * @public
 */
export declare interface SpecificModel extends DynamicHandle<ModelInstanceInfoBase> {
    readonly identifier: string;
    readonly path: string;
    unload(): Promise<void>;
}

declare type StartHttpServerOpts = z.infer<typeof startHttpServerOptsSchema>;

declare const startHttpServerOptsSchema: z.ZodObject<{
    port: z.ZodNumber;
    cors: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    port: number;
    cors: boolean;
}, {
    port: number;
    cors: boolean;
}>;

/**
 * @public
 */
export declare interface StatusStepState {
    status: StatusStepStatus;
    text: string;
}

/**
 * @public
 */
export declare type StatusStepStatus = "waiting" | "loading" | "done" | "error" | "canceled";

/**
 * A StreamablePromise is a promise-like that is also async iterable. This means you can use it as a
 * promise (awaiting it, using `.then`, `.catch`, etc.), and you can also use it as an async
 * iterable (using `for await`).
 *
 * Notably, as much as it implements the async iterable interface, it is not a traditional iterable,
 * as it internally maintains a buffer and new values are pushed into the buffer by the producer, as
 * oppose to being pulled by the consumer.
 *
 * The async iterable interface is used instead of the Node.js object stream because streams are too
 * clunky to use, and the `for await` syntax is much more ergonomic for most people.
 *
 * If any iterator is created for this instance, an empty rejection handler will be attached to the
 * promise to prevent unhandled rejection warnings.
 *
 * This class is provided as an abstract class and is meant to be extended. Crucially, the `collect`
 * method must be implemented, which will be called to convert an array of values into the final
 * resolved value of the promise.
 *
 * In addition, the constructor of the subclass should be marked as private, and a static method
 * that exposes the constructor, the `finished` method, and the `push` method should be provided.
 *
 * @typeParam TFragment - The type of the individual fragments that are pushed into the buffer.
 * @typeParam TFinal - The type of the final resolved value of the promise.
 * @public
 */
export declare abstract class StreamablePromise<TFragment, TFinal> implements Promise<TFinal>, AsyncIterable<TFragment> {
    protected abstract collect(fragments: ReadonlyArray<TFragment>): Promise<TFinal>;
    private promiseFinal;
    private resolveFinal;
    private rejectFinal;
    protected status: "pending" | "resolved" | "rejected";
    private buffer;
    private nextFragmentPromiseBundle;
    /**
     * If there has ever been any iterators created for this instance. Once any iterator is created,
     * a reject handler will be attached to the promise to prevent unhandled rejection warnings, as
     * the errors will be handled by the iterator.
     *
     * The purpose of this variable is to prevent registering the reject handler more than once.
     */
    private hasIterator;
    /**
     * Called by the producer when it has finished producing values. If an error is provided, the
     * promise will be rejected with that error. If no error is provided, the promise will be resolved
     * with the final value.
     *
     * This method should be exposed in the static constructor of the subclass.
     *
     * @param error - The error to reject the promise with, if any.
     */
    protected finished(error?: any): void;
    /**
     * Called by the producer to push a new fragment into the buffer. This method should be exposed in
     * the static constructor of the subclass.
     *
     * This method should be exposed in the static constructor of the subclass.
     *
     * @param fragment - The fragment to push into the buffer.
     */
    protected push(fragment: TFragment): void;
    protected constructor();
    then<TResult1 = TFinal, TResult2 = never>(onfulfilled?: ((value: TFinal) => TResult1 | PromiseLike<TResult1>) | null | undefined, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined): Promise<TResult1 | TResult2>;
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null | undefined): Promise<TFinal | TResult>;
    finally(onfinally?: (() => void) | null | undefined): Promise<TFinal>;
    [Symbol.toStringTag]: string;
    /**
     * If nextFragmentPromiseBundle exists, it is returned. Otherwise, a new one is created and
     * returned.
     */
    private obtainNextFragmentPromiseBundle;
    [Symbol.asyncIterator](): AsyncIterator<TFragment, any, undefined>;
}

declare type StripNotAvailable<T> = T extends NotAvailable ? never : T;

/**
 * Result of a typed structured prediction. In addition to a regular {@link PredictionResult}, there
 * is one additional field: {@link StructuredPredictionResult#parsed}.
 *
 * To enable typed structured prediction, you should pass in a zod schema as the structured option
 * when constructing the prediction config.
 *
 * @public
 */
export declare class StructuredPredictionResult<TStructuredOutputType = unknown> extends PredictionResult {
    /**
     * Parsed result of the structured output.
     */
    readonly parsed: TStructuredOutputType;
    constructor(content: string, reasoningContent: string, nonReasoningContent: string, stats: LLMPredictionStats, modelInfo: LLMInstanceInfo, roundIndex: number, loadConfig: KVConfig, predictionConfig: KVConfig, 
    /**
     * Parsed result of the structured output.
     */
    parsed: TStructuredOutputType);
}

/**
 * Base class for objects that can be subscribed to. Provides common utility methods.
 */
declare abstract class Subscribable<TData> {
    abstract subscribe(listener: (data: TData) => void): () => void;
    subscribeWithCleaner(cleaner: Cleaner, listener: (data: TData) => void): void;
    subscribeOnce(listener: (data: TData) => void): () => void;
    subscribeOnceWithCleaner(cleaner: Cleaner, listener: (data: TData) => void): void;
    derive<TOutput>(deriver: (data: StripNotAvailable<TData>) => StripNotAvailable<TOutput>, outputEqualsPredicate?: (a: TOutput, b: TOutput) => boolean): typeof Subscribable extends {
        get(): TData;
    } ? TOutput extends NotAvailable ? LazySignal<TOutput | NotAvailable> : LazySignal<TOutput> : LazySignal<TOutput | NotAvailable>;
}

declare type Subscriber<TValue> = (value: TValue) => void;

declare type SubscribeUpstream<TData> = (
/**
 * The setter function that should be called whenever the upstream emits a new value. The setter
 * function should be called with the new value.
 */
setDownstream: Setter<TData>, 
/**
 * The error listener should be called when the upstream subscription encounters an error. Once
 * and error is encountered, the subscription to the upstream is assumed to be terminated, meaning
 * the unsubscriber will NOT be called.
 */
errorListener: (error: any) => void) => () => void;

/** @public */
export declare class SystemNamespace {
    private readonly systemPort;
    private readonly validator;
    /**
     * List all downloaded models.
     * @public
     */
    listDownloadedModels(): Promise<Array<ModelInfo>>;
    listDownloadedModels(domain: "llm"): Promise<Array<LLMInfo>>;
    listDownloadedModels(domain: "embedding"): Promise<Array<EmbeddingModelInfo>>;
    whenDisconnected(): Promise<void>;
    notify(notification: BackendNotification): Promise<void>;
    getLMStudioVersion(): Promise<{
        version: string;
        build: number;
    }>;
    /**
     * Sets an experiment flags for LM Studio. This is an unstable API and may change without notice.
     *
     * @experimental
     */
    unstable_setExperimentFlag(flag: string, value: boolean): Promise<void>;
    /**
     * Gets all experiment flags for LM Studio. This is an unstable API and may change without notice.
     *
     * @experimental
     */
    unstable_getExperimentFlags(): Promise<Array<string>>;
    /**
     * Starts the API server on the specified port.
     *
     * @experimental
     */
    startHttpServer(opts: StartHttpServerOpts): Promise<void>;
    /**
     * Stops the API server if it is running.
     *
     * @experimental
     */
    stopHttpServer(): Promise<void>;
}

/**
 * A string literal tag function that does the following:
 *
 * - Removes leading new lines
 * - Removes trailing new lines and whitespace
 * - Removes common indentation from the start of each line (Empty lines are ignored)
 * - Single newlines are replaced with a space + extra whitespace is removed
 *
 * Note: Only spaces are considered.
 *
 * @remarks
 *
 * The exact implementation of this function is not guaranteed to be the same, as we may add
 * additional edge case handling in the future. However, the general behavior should remain the
 * same.
 *
 * @public
 */
export declare function text(strings: TemplateStringsArray, ...values: ReadonlyArray<TextAllowedTypes>): string;

/**
 * The allowed types for the values in the `text` tag function.
 *
 * @public
 */
export declare type TextAllowedTypes = string | number | object;

declare type TokenSourceIdentifier = {
    type: "model";
    identifier: string;
} | {
    type: "generator";
    pluginIdentifier: string;
};

/**
 * Represents a tool that can be given to an LLM with `.act`.
 *
 * @public
 */
export declare type Tool = FunctionTool | RawFunctionTool | UnimplementedRawFunctionTool | RemoteTool;

/**
 * A function that can be used to create a function `Tool` given a function definition and its
 * implementation.
 *
 * @public
 */
export declare function tool<const TParameters extends Record<string, {
    parse(input: any): any;
}>>({ name, description, parameters, implementation, }: {
    name: string;
    description: string;
    /**
     * The parameters of the function. Must be an with values being zod schemas.
     *
     * IMPORTANT
     *
     * The type here only requires an object with a `parse` function. This is not enough! We need an
     * actual zod schema because we will need to extract the JSON schema from it.
     *
     * The reason we only have a `parse` function here (as oppose to actually requiring ZodType is due
     * to this zod bug causing TypeScript breakage, when multiple versions of zod exist.
     *
     * - https://github.com/colinhacks/zod/issues/577
     * - https://github.com/colinhacks/zod/issues/2697
     * - https://github.com/colinhacks/zod/issues/3435
     */
    parameters: TParameters;
    implementation: (params: {
        [K in keyof TParameters]: TParameters[K] extends {
            parse: (input: any) => infer RReturnType;
        } ? RReturnType : never;
    }, ctx: ToolCallContext) => any | Promise<any>;
}): Tool;

/**
 * Shared properties of all tools.
 *
 * @public
 */
export declare interface ToolBase {
    name: string;
    description: string;
}

/**
 * Use this context object to report status and/or getting information about whether the tool call
 * should be aborted.
 *
 * This is passed to the tool implementation as the second argument.
 *
 * @public
 */
export declare interface ToolCallContext {
    /**
     * Report the current status of the tool call. The LLM will not be able to see this.
     */
    status: (text: string) => void;
    /**
     * Report a recoverable error, i.e. something unexpected happened, but you have already handled
     * it. The LLM will not be able to see this.
     *
     * Error handling best practices:
     *
     * - If the error is recoverable (really just a warning), use `warn` to report it.
     * - If the error is not recoverable, but you think the LLM can try again, you should return the
     *   error as a string. For example, `return "Error: file already exists."`.
     * - If the error is disastrous and something truly unexpected happened, you should just throw
     *   the error. This is useful for cases like failing to connect to the database.
     */
    warn: (text: string) => void;
    /**
     * A signal that should be listened to in order to know when to abort the tool call. Not necessary
     * for simple tools calls, however recommended for long running tools such as those that uses
     * makes multiple network requests.
     */
    signal: AbortSignal;
    /**
     * The internal ID of the tool call. This allows you to match up tool calls. Is guaranteed to be
     * unique within one `.act` call.
     *
     * @remarks This field is not the same as the `toolCallId` inside the tool call request, as the
     * existence and format of that ID is model dependent.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     */
    callId: number;
}

/**
 * @public
 */
export declare type ToolCallRequest = FunctionToolCallRequest;

/**
 * Represents an error that is caused by invalid tool call request.
 *
 * @public
 * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
 * change in the future
 */
export declare class ToolCallRequestError extends Error {
    /**
     * The raw output that was generated by the model before the tool call. The exact nature of this
     * fields depends on the error. It sometimes include the entire tool calls section, or sometimes
     * just the single tool call that failed.
     *
     * This field is not always available, and may be `undefined`.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    readonly rawContent: string | undefined;
    constructor(message: string, 
    /**
     * The raw output that was generated by the model before the tool call. The exact nature of this
     * fields depends on the error. It sometimes include the entire tool calls section, or sometimes
     * just the single tool call that failed.
     *
     * This field is not always available, and may be `undefined`.
     *
     * @experimental [EXP-GRANULAR-ACT] More granular .act status reporting is experimental and may
     * change in the future
     * @experimental [EXP-NON-ACT-TOOL-CALLBACKS] Tool call callbacks in .respond/.complete is in an
     * experimental feature. This may change in the future without warning.
     */
    rawContent: string | undefined);
}

/**
 * Represents the result of a tool call.
 *
 * @public
 */
export declare interface ToolCallResult {
    content: string;
    toolCallId?: string;
}

/**
 * Determine how to apply name transformations to tools.
 *
 * - `passThrough`: The tool name is used as-is, without any transformations. This is generally not
 *   recommended as the tool name can contain weird characters that may confuse the model.
 * - `removeSpecial`: The tool name is transformed to replace non-alphanumeric characters with
 *   underscores.
 * - `snakeCase`: The tool name is transformed to snake_case.
 * - `camelCase`: The tool name is transformed to camelCase.
 */
declare type ToolNaming = "passThrough" | "removeSpecial" | "snakeCase" | "camelCase";

/**
 * Tools provider a function that when called, return a list of tools.
 *
 * @public
 */
export declare type ToolsProvider = (ctl: ToolsProviderController) => Promise<Array<Tool>>;

/**
 * Controller for tools provider.
 *
 * @public
 * @experimental [EXP-PLUGIN-CORE] Plugin support is still in development. This may change in the
 * future without warning.
 */
export declare class ToolsProviderController extends BaseController {
}

declare type ToolStatusStepState = {
    status: ToolStatusStepStateStatus;
    customStatus: string;
    customWarnings: Array<string>;
};

/**
 * Represents the state of a tool call.
 *
 * @public
 */
export declare type ToolStatusStepStateStatus = {
    type: "generatingToolCall";
    /**
     * The name of the tool to be called (if known).
     */
    name?: string;
    /**
     * The identifier of the plugin that provided the tool, if known + applicable.
     */
    pluginIdentifier?: string;
    /**
     * The string representation of the arguments (as being streamed).
     */
    argumentsString?: string;
} | {
    type: "toolCallGenerationFailed";
    error: string;
    rawContent?: string;
} | {
    type: "toolCallQueued";
} | {
    type: "confirmingToolCall";
} | {
    type: "toolCallDenied";
    denyReason?: string;
} | {
    type: "callingTool";
} | {
    type: "toolCallFailed";
    error: string;
} | {
    type: "toolCallSucceeded";
    timeMs: number;
};

declare abstract class Transport<TIncoming, TOutgoing> {
    /**
     * Implemented by ClientTransport / ServerTransport. Called by transport implementation to verify
     * incoming message.
     */
    protected abstract parseIncomingMessage(message: any): TIncoming;
    /**
     * Implemented by transport. At this point, message is already validated.
     */
    protected abstract sendViaTransport(message: TOutgoing): void;
    /**
     * Implemented by ClientTransport / ServerTransport. Call by outside to send a message.
     */
    abstract send(message: TOutgoing): void;
    /**
     * Whether this transport has been disposed.
     */
    protected disposed: boolean;
    [Symbol.asyncDispose](): Promise<void>;
}

declare interface UnimplementedRawFunctionTool extends ToolBase {
    type: "unimplementedRawFunction";
    parametersJsonSchema: any;
    checkParameters: (params: any) => void;
    implementation: (params: Record<string, unknown>, ctx: ToolCallContext) => never;
}

/**
 * A function that can be used to create a raw function `Tool` that is not implemented yet. When
 * using `.act`, upon encountering an unimplemented tool, the `.act` will stop gracefully.
 *
 * @public
 * @experimental Not stable, will likely change in the future.
 */
export declare function unimplementedRawFunctionTool({ name, description, parametersJsonSchema, }: {
    name: string;
    description: string;
    parametersJsonSchema: any;
}): UnimplementedRawFunctionTool;

declare class Validator {
    private readonly attachStack;
    constructor({ attachStack }?: ValidatorConstructorOpts);
    /**
     * Pretty-prints a Zod error.
     *
     * @param rootObjectName - The name of the object being validated (used for error messages)
     * @param error - The Zod error to pretty-print
     *
     * @returns The pretty-printed error in a string
     */
    static prettyPrintZod(rootObjectName: string, error: ZodError): string;
    /**
     * Validates a value against a schema and throws an error if it's invalid.
     *
     * @param lead - The start of the error message (used for error messages)
     * @param rootObjectName - The name of the object being validated (used for error messages)
     * @param schema - The schema to validate against
     * @param value - The value to validate
     *
     * @returns The validated value
     * @throws An error if the value is invalid
     */
    validateOrThrow<T>(lead: string, rootObjectName: string, schema: z.Schema<T>, value: unknown, stack?: string): T;
    /**
     * Validates multiple values against multiple schemas and throws an error if any of them are
     * invalid. All values are validated before any errors are thrown. This is useful when you want to
     * validate multiple values at once and want to see all the errors at once.
     *
     * @param leadProducer - The function to produce the start of the error message (used for error).
     * It is called with a set of indices of the invalid values.
     * @param rootObjectNames - The names of the objects being validated (used for error messages)
     * @param schemas - The schemas to validate against
     * @param values - The values to validate
     *
     * @returns The validated values
     * @throws An error if any of the values are invalid
     */
    validateMultipleOrThrow<T extends Array<unknown>>(leadProducer: (erroredValues: Set<number>) => string, rootObjectNames: Array<string>, schemas: Array<z.Schema<unknown>>, values: T, stack?: string): T;
    /**
     * Validates a value against a schema and throws an error if it's invalid. This is a convenience
     * function for validating one single method parameter.
     *
     * @param className - The name of the class containing the method (used for error messages)
     * @param methodName - The name of the method (used for error messages)
     * @param paramName - The name of the parameter being validated (used for error messages)
     * @param schema - The schema to validate against
     * @param value - The value to validate
     *
     * @returns The validated value
     * @throws An error if the value is invalid
     */
    validateMethodParamOrThrow<T>(className: string, methodName: string, paramName: string, schema: z.Schema<T>, value: unknown, stack?: string): T;
    /**
     * Validates multiple values against multiple schemas and throws an error if any of them are
     * invalid. This is a convenience function for validating multiple method parameters.
     *
     * @param className - The name of the class containing the method (used for error messages)
     * @param methodName - The name of the method (used for error messages)
     * @param paramNames - The names of the parameters being validated (used for error messages)
     * @param schemas - The schemas to validate against
     * @param values - The values to validate
     *
     * @returns The validated values
     * @throws An error if any of the values are invalid
     */
    validateMethodParamsOrThrow<T extends Array<unknown>>(className: string, methodName: string, paramNames: Array<string>, schemas: Array<z.Schema<unknown>>, values: T, stack?: string): T;
    /**
     * Validates a value against a schema and throws an error if it's invalid. This is a convenience
     * function for validating one single constructor parameter.
     *
     * @param className - The name of the class (used for error messages)
     * @param paramName - The name of the parameter being validated (used for error messages)
     * @param schema - The schema to validate against
     * @param value - The value to validate
     *
     * @returns The validated value
     * @throws An error if the value is invalid
     */
    validateConstructorParamOrThrow<T>(className: string, paramName: string, schema: z.Schema<T>, value: unknown, stack?: string): T;
    /**
     * Validates multiple values against multiple schemas and throws an error if any of them are
     * invalid. This is a convenience function for validating multiple constructor parameters.
     *
     * @param className - The name of the class (used for error messages)
     * @param paramNames - The names of the parameters being validated (used for error messages)
     *
     * @param schemas - The schemas to validate against
     * @param values - The values to validate
     */
    validateConstructorParamsOrThrow<T extends Array<unknown>>(className: string, paramNames: Array<string>, schemas: Array<z.Schema<unknown>>, values: T, stack?: string): T;
}

declare interface ValidatorConstructorOpts {
    attachStack?: boolean;
}

/**
 * @public
 */
export declare type VirtualConfigSchematics = {
    [key: string]: {
        key: string;
        type: any;
        valueTypeKey: string;
    };
};

declare interface WritableSignalEndpoint {
    name: string;
    creationParameter: z.ZodType;
    signalData: z.ZodType;
    serialization: SerializationType;
    handler: WritableSignalEndpointHandler | null;
}

declare type WritableSignalEndpointHandler<TContext = any, TCreationParameter = any, TData = any> = (ctx: TContext, creationParameter: TCreationParameter) => readonly [signal: SignalLike<TData>, setter: Setter<TData>] | Promise<readonly [signal: SignalLike<TData>, setter: Setter<TData>]> | readonly [signal: SignalLike<TData | NotAvailable>, setter: Setter<TData>] | Promise<readonly [signal: SignalLike<TData | NotAvailable>, setter: Setter<TData>]>;

declare interface WritableSignalEndpointSpecBase {
    creationParameter: any;
    signalData: any;
}

declare type WritableSignalEndpointsSpecBase = {
    [endpointName: string]: WritableSignalEndpointSpecBase;
};

/**
 * A write tag is a tag that can be optionally passed to a setter to identify the update.
 */
declare type WriteTag = string;

export { }
