import type { RequestInit, RequestInfo } from "./internal/builtin-types.mjs";
import type { PromiseOrValue, MergedRequestInit, FinalizedRequestInit } from "./internal/types.mjs";
export type { Logger, LogLevel } from "./internal/utils/log.mjs";
import * as Opts from "./internal/request-options.mjs";
import * as Errors from "./core/error.mjs";
import * as Pagination from "./core/pagination.mjs";
import { type ConversationCursorPageParams, ConversationCursorPageResponse, type CursorPageParams, CursorPageResponse, PageResponse } from "./core/pagination.mjs";
import * as Uploads from "./core/uploads.mjs";
import * as API from "./resources/index.mjs";
import { APIPromise } from "./core/api-promise.mjs";
import { Batch, BatchCreateParams, BatchError, BatchListParams, BatchRequestCounts, BatchUsage, Batches, BatchesPage } from "./resources/batches.mjs";
import { Completion, CompletionChoice, CompletionCreateParams, CompletionCreateParamsNonStreaming, CompletionCreateParamsStreaming, CompletionUsage, Completions } from "./resources/completions.mjs";
import { CreateEmbeddingResponse, Embedding, EmbeddingCreateParams, EmbeddingModel, Embeddings } from "./resources/embeddings.mjs";
import { FileContent, FileCreateParams, FileDeleted, FileListParams, FileObject, FileObjectsPage, FilePurpose, Files } from "./resources/files.mjs";
import { Image, ImageCreateVariationParams, ImageEditCompletedEvent, ImageEditParams, ImageEditParamsNonStreaming, ImageEditParamsStreaming, ImageEditPartialImageEvent, ImageEditStreamEvent, ImageGenCompletedEvent, ImageGenPartialImageEvent, ImageGenStreamEvent, ImageGenerateParams, ImageGenerateParamsNonStreaming, ImageGenerateParamsStreaming, ImageModel, Images, ImagesResponse } from "./resources/images.mjs";
import { Model, ModelDeleted, Models, ModelsPage } from "./resources/models.mjs";
import { Moderation, ModerationCreateParams, ModerationCreateResponse, ModerationImageURLInput, ModerationModel, ModerationMultiModalInput, ModerationTextInput, Moderations } from "./resources/moderations.mjs";
import { ImageInputReferenceParam, Video, VideoCreateCharacterParams, VideoCreateCharacterResponse, VideoCreateError, VideoCreateParams, VideoDeleteResponse, VideoDownloadContentParams, VideoEditParams, VideoExtendParams, VideoGetCharacterResponse, VideoListParams, VideoModel, VideoRemixParams, VideoSeconds, VideoSize, Videos, VideosPage } from "./resources/videos.mjs";
import { Audio, AudioModel, AudioResponseFormat } from "./resources/audio/audio.mjs";
import { Beta } from "./resources/beta/beta.mjs";
import { Chat } from "./resources/chat/chat.mjs";
import { ContainerCreateParams, ContainerCreateResponse, ContainerListParams, ContainerListResponse, ContainerListResponsesPage, ContainerRetrieveResponse, Containers } from "./resources/containers/containers.mjs";
import { Conversations } from "./resources/conversations/conversations.mjs";
import { EvalCreateParams, EvalCreateResponse, EvalCustomDataSourceConfig, EvalDeleteResponse, EvalListParams, EvalListResponse, EvalListResponsesPage, EvalRetrieveResponse, EvalStoredCompletionsDataSourceConfig, EvalUpdateParams, EvalUpdateResponse, Evals } from "./resources/evals/evals.mjs";
import { FineTuning } from "./resources/fine-tuning/fine-tuning.mjs";
import { Graders } from "./resources/graders/graders.mjs";
import { Realtime } from "./resources/realtime/realtime.mjs";
import { Responses } from "./resources/responses/responses.mjs";
import { DeletedSkill, Skill, SkillCreateParams, SkillList, SkillListParams, SkillUpdateParams, Skills, SkillsPage } from "./resources/skills/skills.mjs";
import { Upload, UploadCompleteParams, UploadCreateParams, Uploads as UploadsAPIUploads } from "./resources/uploads/uploads.mjs";
import { AutoFileChunkingStrategyParam, FileChunkingStrategy, FileChunkingStrategyParam, OtherFileChunkingStrategyObject, StaticFileChunkingStrategy, StaticFileChunkingStrategyObject, StaticFileChunkingStrategyObjectParam, VectorStore, VectorStoreCreateParams, VectorStoreDeleted, VectorStoreListParams, VectorStoreSearchParams, VectorStoreSearchResponse, VectorStoreSearchResponsesPage, VectorStoreUpdateParams, VectorStores, VectorStoresPage } from "./resources/vector-stores/vector-stores.mjs";
import { Webhooks } from "./resources/webhooks/webhooks.mjs";
import { ChatCompletion, ChatCompletionAllowedToolChoice, ChatCompletionAllowedTools, ChatCompletionAssistantMessageParam, ChatCompletionAudio, ChatCompletionAudioParam, ChatCompletionChunk, ChatCompletionContentPart, ChatCompletionContentPartImage, ChatCompletionContentPartInputAudio, ChatCompletionContentPartRefusal, ChatCompletionContentPartText, ChatCompletionCreateParams, ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsStreaming, ChatCompletionCustomTool, ChatCompletionDeleted, ChatCompletionDeveloperMessageParam, ChatCompletionFunctionCallOption, ChatCompletionFunctionMessageParam, ChatCompletionFunctionTool, ChatCompletionListParams, ChatCompletionMessage, ChatCompletionMessageCustomToolCall, ChatCompletionMessageFunctionToolCall, ChatCompletionMessageParam, ChatCompletionMessageToolCall, ChatCompletionModality, ChatCompletionNamedToolChoice, ChatCompletionNamedToolChoiceCustom, ChatCompletionPredictionContent, ChatCompletionReasoningEffort, ChatCompletionRole, ChatCompletionStoreMessage, ChatCompletionStreamOptions, ChatCompletionSystemMessageParam, ChatCompletionTokenLogprob, ChatCompletionTool, ChatCompletionToolChoiceOption, ChatCompletionToolMessageParam, ChatCompletionUpdateParams, ChatCompletionUserMessageParam, ChatCompletionsPage } from "./resources/chat/completions/completions.mjs";
import { type Fetch } from "./internal/builtin-types.mjs";
import { HeadersLike, NullableHeaders } from "./internal/headers.mjs";
import { FinalRequestOptions, RequestOptions } from "./internal/request-options.mjs";
import { type LogLevel, type Logger } from "./internal/utils/log.mjs";
export type ApiKeySetter = () => Promise<string>;
export interface ClientOptions {
    /**
     * API key used for authentication.
     *
     * - Accepts either a static string or an async function that resolves to a string.
     * - Defaults to process.env['OPENAI_API_KEY'].
     * - When a function is provided, it is invoked before each request so you can rotate
     *   or refresh credentials at runtime.
     * - The function must return a non-empty string; otherwise an OpenAIError is thrown.
     * - If the function throws, the error is wrapped in an OpenAIError with the original
     *   error available as `cause`.
     */
    apiKey?: string | ApiKeySetter | undefined;
    /**
     * Defaults to process.env['OPENAI_ORG_ID'].
     */
    organization?: string | null | undefined;
    /**
     * Defaults to process.env['OPENAI_PROJECT_ID'].
     */
    project?: string | null | undefined;
    /**
     * Defaults to process.env['OPENAI_WEBHOOK_SECRET'].
     */
    webhookSecret?: string | null | undefined;
    /**
     * Override the default base URL for the API, e.g., "https://api.example.com/v2/"
     *
     * Defaults to process.env['OPENAI_BASE_URL'].
     */
    baseURL?: string | null | undefined;
    /**
     * The maximum amount of time (in milliseconds) that the client should wait for a response
     * from the server before timing out a single request.
     *
     * Note that request timeouts are retried by default, so in a worst-case scenario you may wait
     * much longer than this timeout before the promise succeeds or fails.
     *
     * @unit milliseconds
     */
    timeout?: number | undefined;
    /**
     * Additional `RequestInit` options to be passed to `fetch` calls.
     * Properties will be overridden by per-request `fetchOptions`.
     */
    fetchOptions?: MergedRequestInit | undefined;
    /**
     * Specify a custom `fetch` function implementation.
     *
     * If not provided, we expect that `fetch` is defined globally.
     */
    fetch?: Fetch | undefined;
    /**
     * The maximum number of times that the client will retry a request in case of a
     * temporary failure, like a network error or a 5XX error from the server.
     *
     * @default 2
     */
    maxRetries?: number | undefined;
    /**
     * Default headers to include with every request to the API.
     *
     * These can be removed in individual requests by explicitly setting the
     * header to `null` in request options.
     */
    defaultHeaders?: HeadersLike | undefined;
    /**
     * Default query parameters to include with every request to the API.
     *
     * These can be removed in individual requests by explicitly setting the
     * param to `undefined` in request options.
     */
    defaultQuery?: Record<string, string | undefined> | undefined;
    /**
     * By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
     * Only set this option to `true` if you understand the risks and have appropriate mitigations in place.
     */
    dangerouslyAllowBrowser?: boolean | undefined;
    /**
     * Set the log level.
     *
     * Defaults to process.env['OPENAI_LOG'] or 'warn' if it isn't set.
     */
    logLevel?: LogLevel | undefined;
    /**
     * Set the logger.
     *
     * Defaults to globalThis.console.
     */
    logger?: Logger | undefined;
}
/**
 * API Client for interfacing with the OpenAI API.
 */
export declare class OpenAI {
    #private;
    apiKey: string;
    organization: string | null;
    project: string | null;
    webhookSecret: string | null;
    baseURL: string;
    maxRetries: number;
    timeout: number;
    logger: Logger;
    logLevel: LogLevel | undefined;
    fetchOptions: MergedRequestInit | undefined;
    private fetch;
    protected idempotencyHeader?: string;
    protected _options: ClientOptions;
    /**
     * API Client for interfacing with the OpenAI API.
     *
     * @param {string | undefined} [opts.apiKey=process.env['OPENAI_API_KEY'] ?? undefined]
     * @param {string | null | undefined} [opts.organization=process.env['OPENAI_ORG_ID'] ?? null]
     * @param {string | null | undefined} [opts.project=process.env['OPENAI_PROJECT_ID'] ?? null]
     * @param {string | null | undefined} [opts.webhookSecret=process.env['OPENAI_WEBHOOK_SECRET'] ?? null]
     * @param {string} [opts.baseURL=process.env['OPENAI_BASE_URL'] ?? https://api.openai.com/v1] - Override the default base URL for the API.
     * @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
     * @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
     * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
     * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
     * @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
     * @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
     * @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
     */
    constructor({ baseURL, apiKey, organization, project, webhookSecret, ...opts }?: ClientOptions);
    /**
     * Create a new client instance re-using the same options given to the current client with optional overriding.
     */
    withOptions(options: Partial<ClientOptions>): this;
    protected defaultQuery(): Record<string, string | undefined> | undefined;
    protected validateHeaders({ values, nulls }: NullableHeaders): void;
    protected authHeaders(opts: FinalRequestOptions): Promise<NullableHeaders | undefined>;
    protected stringifyQuery(query: object | Record<string, unknown>): string;
    private getUserAgent;
    protected defaultIdempotencyKey(): string;
    protected makeStatusError(status: number, error: Object, message: string | undefined, headers: Headers): Errors.APIError;
    _callApiKey(): Promise<boolean>;
    buildURL(path: string, query: Record<string, unknown> | null | undefined, defaultBaseURL?: string | undefined): string;
    /**
     * Used as a callback for mutating the given `FinalRequestOptions` object.
     */
    protected prepareOptions(options: FinalRequestOptions): Promise<void>;
    /**
     * Used as a callback for mutating the given `RequestInit` object.
     *
     * This is useful for cases where you want to add certain headers based off of
     * the request properties, e.g. `method` or `url`.
     */
    protected prepareRequest(request: RequestInit, { url, options }: {
        url: string;
        options: FinalRequestOptions;
    }): Promise<void>;
    get<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp>;
    post<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp>;
    patch<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp>;
    put<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp>;
    delete<Rsp>(path: string, opts?: PromiseOrValue<RequestOptions>): APIPromise<Rsp>;
    private methodRequest;
    request<Rsp>(options: PromiseOrValue<FinalRequestOptions>, remainingRetries?: number | null): APIPromise<Rsp>;
    private makeRequest;
    getAPIList<Item, PageClass extends Pagination.AbstractPage<Item> = Pagination.AbstractPage<Item>>(path: string, Page: new (...args: any[]) => PageClass, opts?: PromiseOrValue<RequestOptions>): Pagination.PagePromise<PageClass, Item>;
    requestAPIList<Item = unknown, PageClass extends Pagination.AbstractPage<Item> = Pagination.AbstractPage<Item>>(Page: new (...args: ConstructorParameters<typeof Pagination.AbstractPage>) => PageClass, options: PromiseOrValue<FinalRequestOptions>): Pagination.PagePromise<PageClass, Item>;
    fetchWithTimeout(url: RequestInfo, init: RequestInit | undefined, ms: number, controller: AbortController): Promise<Response>;
    private shouldRetry;
    private retryRequest;
    private calculateDefaultRetryTimeoutMillis;
    buildRequest(inputOptions: FinalRequestOptions, { retryCount }?: {
        retryCount?: number;
    }): Promise<{
        req: FinalizedRequestInit;
        url: string;
        timeout: number;
    }>;
    private buildHeaders;
    private _makeAbort;
    private buildBody;
    static OpenAI: typeof OpenAI;
    static DEFAULT_TIMEOUT: number;
    static OpenAIError: typeof Errors.OpenAIError;
    static APIError: typeof Errors.APIError;
    static APIConnectionError: typeof Errors.APIConnectionError;
    static APIConnectionTimeoutError: typeof Errors.APIConnectionTimeoutError;
    static APIUserAbortError: typeof Errors.APIUserAbortError;
    static NotFoundError: typeof Errors.NotFoundError;
    static ConflictError: typeof Errors.ConflictError;
    static RateLimitError: typeof Errors.RateLimitError;
    static BadRequestError: typeof Errors.BadRequestError;
    static AuthenticationError: typeof Errors.AuthenticationError;
    static InternalServerError: typeof Errors.InternalServerError;
    static PermissionDeniedError: typeof Errors.PermissionDeniedError;
    static UnprocessableEntityError: typeof Errors.UnprocessableEntityError;
    static InvalidWebhookSignatureError: typeof Errors.InvalidWebhookSignatureError;
    static toFile: typeof Uploads.toFile;
    /**
     * Given a prompt, the model will return one or more predicted completions, and can also return the probabilities of alternative tokens at each position.
     */
    completions: API.Completions;
    chat: API.Chat;
    /**
     * Get a vector representation of a given input that can be easily consumed by machine learning models and algorithms.
     */
    embeddings: API.Embeddings;
    /**
     * Files are used to upload documents that can be used with features like Assistants and Fine-tuning.
     */
    files: API.Files;
    /**
     * Given a prompt and/or an input image, the model will generate a new image.
     */
    images: API.Images;
    audio: API.Audio;
    /**
     * Given text and/or image inputs, classifies if those inputs are potentially harmful.
     */
    moderations: API.Moderations;
    /**
     * List and describe the various models available in the API.
     */
    models: API.Models;
    fineTuning: API.FineTuning;
    graders: API.Graders;
    vectorStores: API.VectorStores;
    webhooks: API.Webhooks;
    beta: API.Beta;
    /**
     * Create large batches of API requests to run asynchronously.
     */
    batches: API.Batches;
    /**
     * Use Uploads to upload large files in multiple parts.
     */
    uploads: API.Uploads;
    responses: API.Responses;
    realtime: API.Realtime;
    /**
     * Manage conversations and conversation items.
     */
    conversations: API.Conversations;
    /**
     * Manage and run evals in the OpenAI platform.
     */
    evals: API.Evals;
    containers: API.Containers;
    skills: API.Skills;
    videos: API.Videos;
}
export declare namespace OpenAI {
    export type RequestOptions = Opts.RequestOptions;
    export import Page = Pagination.Page;
    export { type PageResponse as PageResponse };
    export import CursorPage = Pagination.CursorPage;
    export { type CursorPageParams as CursorPageParams, type CursorPageResponse as CursorPageResponse };
    export import ConversationCursorPage = Pagination.ConversationCursorPage;
    export { type ConversationCursorPageParams as ConversationCursorPageParams, type ConversationCursorPageResponse as ConversationCursorPageResponse, };
    export { Completions as Completions, type Completion as Completion, type CompletionChoice as CompletionChoice, type CompletionUsage as CompletionUsage, type CompletionCreateParams as CompletionCreateParams, type CompletionCreateParamsNonStreaming as CompletionCreateParamsNonStreaming, type CompletionCreateParamsStreaming as CompletionCreateParamsStreaming, };
    export { Chat as Chat, type ChatCompletion as ChatCompletion, type ChatCompletionAllowedToolChoice as ChatCompletionAllowedToolChoice, type ChatCompletionAssistantMessageParam as ChatCompletionAssistantMessageParam, type ChatCompletionAudio as ChatCompletionAudio, type ChatCompletionAudioParam as ChatCompletionAudioParam, type ChatCompletionChunk as ChatCompletionChunk, type ChatCompletionContentPart as ChatCompletionContentPart, type ChatCompletionContentPartImage as ChatCompletionContentPartImage, type ChatCompletionContentPartInputAudio as ChatCompletionContentPartInputAudio, type ChatCompletionContentPartRefusal as ChatCompletionContentPartRefusal, type ChatCompletionContentPartText as ChatCompletionContentPartText, type ChatCompletionCustomTool as ChatCompletionCustomTool, type ChatCompletionDeleted as ChatCompletionDeleted, type ChatCompletionDeveloperMessageParam as ChatCompletionDeveloperMessageParam, type ChatCompletionFunctionCallOption as ChatCompletionFunctionCallOption, type ChatCompletionFunctionMessageParam as ChatCompletionFunctionMessageParam, type ChatCompletionFunctionTool as ChatCompletionFunctionTool, type ChatCompletionMessage as ChatCompletionMessage, type ChatCompletionMessageCustomToolCall as ChatCompletionMessageCustomToolCall, type ChatCompletionMessageFunctionToolCall as ChatCompletionMessageFunctionToolCall, type ChatCompletionMessageParam as ChatCompletionMessageParam, type ChatCompletionMessageToolCall as ChatCompletionMessageToolCall, type ChatCompletionModality as ChatCompletionModality, type ChatCompletionNamedToolChoice as ChatCompletionNamedToolChoice, type ChatCompletionNamedToolChoiceCustom as ChatCompletionNamedToolChoiceCustom, type ChatCompletionPredictionContent as ChatCompletionPredictionContent, type ChatCompletionRole as ChatCompletionRole, type ChatCompletionStoreMessage as ChatCompletionStoreMessage, type ChatCompletionStreamOptions as ChatCompletionStreamOptions, type ChatCompletionSystemMessageParam as ChatCompletionSystemMessageParam, type ChatCompletionTokenLogprob as ChatCompletionTokenLogprob, type ChatCompletionTool as ChatCompletionTool, type ChatCompletionToolChoiceOption as ChatCompletionToolChoiceOption, type ChatCompletionToolMessageParam as ChatCompletionToolMessageParam, type ChatCompletionUserMessageParam as ChatCompletionUserMessageParam, type ChatCompletionAllowedTools as ChatCompletionAllowedTools, type ChatCompletionReasoningEffort as ChatCompletionReasoningEffort, type ChatCompletionsPage as ChatCompletionsPage, type ChatCompletionCreateParams as ChatCompletionCreateParams, type ChatCompletionCreateParamsNonStreaming as ChatCompletionCreateParamsNonStreaming, type ChatCompletionCreateParamsStreaming as ChatCompletionCreateParamsStreaming, type ChatCompletionUpdateParams as ChatCompletionUpdateParams, type ChatCompletionListParams as ChatCompletionListParams, };
    export { Embeddings as Embeddings, type CreateEmbeddingResponse as CreateEmbeddingResponse, type Embedding as Embedding, type EmbeddingModel as EmbeddingModel, type EmbeddingCreateParams as EmbeddingCreateParams, };
    export { Files as Files, type FileContent as FileContent, type FileDeleted as FileDeleted, type FileObject as FileObject, type FilePurpose as FilePurpose, type FileObjectsPage as FileObjectsPage, type FileCreateParams as FileCreateParams, type FileListParams as FileListParams, };
    export { Images as Images, type Image as Image, type ImageEditCompletedEvent as ImageEditCompletedEvent, type ImageEditPartialImageEvent as ImageEditPartialImageEvent, type ImageEditStreamEvent as ImageEditStreamEvent, type ImageGenCompletedEvent as ImageGenCompletedEvent, type ImageGenPartialImageEvent as ImageGenPartialImageEvent, type ImageGenStreamEvent as ImageGenStreamEvent, type ImageModel as ImageModel, type ImagesResponse as ImagesResponse, type ImageCreateVariationParams as ImageCreateVariationParams, type ImageEditParams as ImageEditParams, type ImageEditParamsNonStreaming as ImageEditParamsNonStreaming, type ImageEditParamsStreaming as ImageEditParamsStreaming, type ImageGenerateParams as ImageGenerateParams, type ImageGenerateParamsNonStreaming as ImageGenerateParamsNonStreaming, type ImageGenerateParamsStreaming as ImageGenerateParamsStreaming, };
    export { Audio as Audio, type AudioModel as AudioModel, type AudioResponseFormat as AudioResponseFormat };
    export { Moderations as Moderations, type Moderation as Moderation, type ModerationImageURLInput as ModerationImageURLInput, type ModerationModel as ModerationModel, type ModerationMultiModalInput as ModerationMultiModalInput, type ModerationTextInput as ModerationTextInput, type ModerationCreateResponse as ModerationCreateResponse, type ModerationCreateParams as ModerationCreateParams, };
    export { Models as Models, type Model as Model, type ModelDeleted as ModelDeleted, type ModelsPage as ModelsPage, };
    export { FineTuning as FineTuning };
    export { Graders as Graders };
    export { VectorStores as VectorStores, type AutoFileChunkingStrategyParam as AutoFileChunkingStrategyParam, type FileChunkingStrategy as FileChunkingStrategy, type FileChunkingStrategyParam as FileChunkingStrategyParam, type OtherFileChunkingStrategyObject as OtherFileChunkingStrategyObject, type StaticFileChunkingStrategy as StaticFileChunkingStrategy, type StaticFileChunkingStrategyObject as StaticFileChunkingStrategyObject, type StaticFileChunkingStrategyObjectParam as StaticFileChunkingStrategyObjectParam, type VectorStore as VectorStore, type VectorStoreDeleted as VectorStoreDeleted, type VectorStoreSearchResponse as VectorStoreSearchResponse, type VectorStoresPage as VectorStoresPage, type VectorStoreSearchResponsesPage as VectorStoreSearchResponsesPage, type VectorStoreCreateParams as VectorStoreCreateParams, type VectorStoreUpdateParams as VectorStoreUpdateParams, type VectorStoreListParams as VectorStoreListParams, type VectorStoreSearchParams as VectorStoreSearchParams, };
    export { Webhooks as Webhooks };
    export { Beta as Beta };
    export { Batches as Batches, type Batch as Batch, type BatchError as BatchError, type BatchRequestCounts as BatchRequestCounts, type BatchUsage as BatchUsage, type BatchesPage as BatchesPage, type BatchCreateParams as BatchCreateParams, type BatchListParams as BatchListParams, };
    export { UploadsAPIUploads as Uploads, type Upload as Upload, type UploadCreateParams as UploadCreateParams, type UploadCompleteParams as UploadCompleteParams, };
    export { Responses as Responses };
    export { Realtime as Realtime };
    export { Conversations as Conversations };
    export { Evals as Evals, type EvalCustomDataSourceConfig as EvalCustomDataSourceConfig, type EvalStoredCompletionsDataSourceConfig as EvalStoredCompletionsDataSourceConfig, type EvalCreateResponse as EvalCreateResponse, type EvalRetrieveResponse as EvalRetrieveResponse, type EvalUpdateResponse as EvalUpdateResponse, type EvalListResponse as EvalListResponse, type EvalDeleteResponse as EvalDeleteResponse, type EvalListResponsesPage as EvalListResponsesPage, type EvalCreateParams as EvalCreateParams, type EvalUpdateParams as EvalUpdateParams, type EvalListParams as EvalListParams, };
    export { Containers as Containers, type ContainerCreateResponse as ContainerCreateResponse, type ContainerRetrieveResponse as ContainerRetrieveResponse, type ContainerListResponse as ContainerListResponse, type ContainerListResponsesPage as ContainerListResponsesPage, type ContainerCreateParams as ContainerCreateParams, type ContainerListParams as ContainerListParams, };
    export { Skills as Skills, type DeletedSkill as DeletedSkill, type Skill as Skill, type SkillList as SkillList, type SkillsPage as SkillsPage, type SkillCreateParams as SkillCreateParams, type SkillUpdateParams as SkillUpdateParams, type SkillListParams as SkillListParams, };
    export { Videos as Videos, type ImageInputReferenceParam as ImageInputReferenceParam, type Video as Video, type VideoCreateError as VideoCreateError, type VideoModel as VideoModel, type VideoSeconds as VideoSeconds, type VideoSize as VideoSize, type VideoDeleteResponse as VideoDeleteResponse, type VideoCreateCharacterResponse as VideoCreateCharacterResponse, type VideoGetCharacterResponse as VideoGetCharacterResponse, type VideosPage as VideosPage, type VideoCreateParams as VideoCreateParams, type VideoListParams as VideoListParams, type VideoCreateCharacterParams as VideoCreateCharacterParams, type VideoDownloadContentParams as VideoDownloadContentParams, type VideoEditParams as VideoEditParams, type VideoExtendParams as VideoExtendParams, type VideoRemixParams as VideoRemixParams, };
    export type AllModels = API.AllModels;
    export type ChatModel = API.ChatModel;
    export type ComparisonFilter = API.ComparisonFilter;
    export type CompoundFilter = API.CompoundFilter;
    export type CustomToolInputFormat = API.CustomToolInputFormat;
    export type ErrorObject = API.ErrorObject;
    export type FunctionDefinition = API.FunctionDefinition;
    export type FunctionParameters = API.FunctionParameters;
    export type Metadata = API.Metadata;
    export type Reasoning = API.Reasoning;
    export type ReasoningEffort = API.ReasoningEffort;
    export type ResponseFormatJSONObject = API.ResponseFormatJSONObject;
    export type ResponseFormatJSONSchema = API.ResponseFormatJSONSchema;
    export type ResponseFormatText = API.ResponseFormatText;
    export type ResponseFormatTextGrammar = API.ResponseFormatTextGrammar;
    export type ResponseFormatTextPython = API.ResponseFormatTextPython;
    export type ResponsesModel = API.ResponsesModel;
}
//# sourceMappingURL=client.d.mts.map