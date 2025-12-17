type Fetch = typeof fetch;
interface Config {
    host: string;
    fetch?: Fetch;
    proxy?: boolean;
    headers?: HeadersInit;
}
interface Options {
    numa: boolean;
    num_ctx: number;
    num_batch: number;
    num_gpu: number;
    main_gpu: number;
    low_vram: boolean;
    f16_kv: boolean;
    logits_all: boolean;
    vocab_only: boolean;
    use_mmap: boolean;
    use_mlock: boolean;
    embedding_only: boolean;
    num_thread: number;
    num_keep: number;
    seed: number;
    num_predict: number;
    top_k: number;
    top_p: number;
    tfs_z: number;
    typical_p: number;
    repeat_last_n: number;
    temperature: number;
    repeat_penalty: number;
    presence_penalty: number;
    frequency_penalty: number;
    mirostat: number;
    mirostat_tau: number;
    mirostat_eta: number;
    penalize_newline: boolean;
    stop: string[];
}
interface GenerateRequest {
    model: string;
    prompt: string;
    suffix?: string;
    system?: string;
    template?: string;
    context?: number[];
    stream?: boolean;
    raw?: boolean;
    format?: string | object;
    images?: Uint8Array[] | string[];
    keep_alive?: string | number;
    think?: boolean | 'high' | 'medium' | 'low';
    logprobs?: boolean;
    top_logprobs?: number;
    options?: Partial<Options>;
}
interface Message {
    role: string;
    content: string;
    thinking?: string;
    images?: Uint8Array[] | string[];
    tool_calls?: ToolCall[];
    tool_name?: string;
}
interface ToolCall {
    function: {
        name: string;
        arguments: {
            [key: string]: any;
        };
    };
}
interface Tool {
    type: string;
    function: {
        name?: string;
        description?: string;
        type?: string;
        parameters?: {
            type?: string;
            $defs?: any;
            items?: any;
            required?: string[];
            properties?: {
                [key: string]: {
                    type?: string | string[];
                    items?: any;
                    description?: string;
                    enum?: any[];
                };
            };
        };
    };
}
interface ChatRequest {
    model: string;
    messages?: Message[];
    stream?: boolean;
    format?: string | object;
    keep_alive?: string | number;
    tools?: Tool[];
    think?: boolean | 'high' | 'medium' | 'low';
    logprobs?: boolean;
    top_logprobs?: number;
    options?: Partial<Options>;
}
interface PullRequest {
    model: string;
    insecure?: boolean;
    stream?: boolean;
}
interface PushRequest {
    model: string;
    insecure?: boolean;
    stream?: boolean;
}
interface CreateRequest {
    model: string;
    from?: string;
    stream?: boolean;
    quantize?: string;
    template?: string;
    license?: string | string[];
    system?: string;
    parameters?: Record<string, unknown>;
    messages?: Message[];
    adapters?: Record<string, string>;
}
interface DeleteRequest {
    model: string;
}
interface CopyRequest {
    source: string;
    destination: string;
}
interface ShowRequest {
    model: string;
    system?: string;
    template?: string;
    options?: Partial<Options>;
}
interface EmbedRequest {
    model: string;
    input: string | string[];
    truncate?: boolean;
    keep_alive?: string | number;
    dimensions?: number;
    options?: Partial<Options>;
}
interface EmbeddingsRequest {
    model: string;
    prompt: string;
    keep_alive?: string | number;
    options?: Partial<Options>;
}
interface TokenLogprob {
    token: string;
    logprob: number;
}
interface Logprob extends TokenLogprob {
    top_logprobs?: TokenLogprob[];
}
interface GenerateResponse {
    model: string;
    created_at: Date;
    response: string;
    thinking?: string;
    done: boolean;
    done_reason: string;
    context: number[];
    total_duration: number;
    load_duration: number;
    prompt_eval_count: number;
    prompt_eval_duration: number;
    eval_count: number;
    eval_duration: number;
    logprobs?: Logprob[];
}
interface ChatResponse {
    model: string;
    created_at: Date;
    message: Message;
    done: boolean;
    done_reason: string;
    total_duration: number;
    load_duration: number;
    prompt_eval_count: number;
    prompt_eval_duration: number;
    eval_count: number;
    eval_duration: number;
    logprobs?: Logprob[];
}
interface EmbedResponse {
    model: string;
    embeddings: number[][];
    total_duration: number;
    load_duration: number;
    prompt_eval_count: number;
}
interface EmbeddingsResponse {
    embedding: number[];
}
interface ProgressResponse {
    status: string;
    digest: string;
    total: number;
    completed: number;
}
interface ModelResponse {
    name: string;
    modified_at: Date;
    model: string;
    size: number;
    digest: string;
    details: ModelDetails;
    expires_at: Date;
    size_vram: number;
}
interface ModelDetails {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
}
interface ShowResponse {
    license: string;
    modelfile: string;
    parameters: string;
    template: string;
    system: string;
    details: ModelDetails;
    messages: Message[];
    modified_at: Date;
    model_info: Map<string, any>;
    capabilities: string[];
    projector_info?: Map<string, any>;
}
interface VersionResponse {
    version: string;
}
interface ListResponse {
    models: ModelResponse[];
}
interface ErrorResponse {
    error: string;
}
interface StatusResponse {
    status: string;
}
interface WebSearchRequest {
    query: string;
    maxResults?: number;
}
interface WebSearchResult {
    content: string;
}
interface WebSearchResponse {
    results: WebSearchResult[];
}
interface WebFetchRequest {
    url: string;
}
interface WebFetchResponse {
    title: string;
    url: string;
    content: string;
    links: string[];
}

/**
 * An AsyncIterator which can be aborted
 */
declare class AbortableAsyncIterator<T extends object> {
    private readonly abortController;
    private readonly itr;
    private readonly doneCallback;
    constructor(abortController: AbortController, itr: AsyncGenerator<T | ErrorResponse>, doneCallback: () => void);
    abort(): void;
    [Symbol.asyncIterator](): AsyncGenerator<Awaited<T>, void, unknown>;
}

declare class Ollama {
    protected readonly config: Config;
    protected readonly fetch: Fetch;
    protected readonly ongoingStreamedRequests: AbortableAsyncIterator<object>[];
    constructor(config?: Partial<Config>);
    abort(): void;
    /**
     * Processes a request to the Ollama server. If the request is streamable, it will return a
     * AbortableAsyncIterator that yields the response messages. Otherwise, it will return the response
     * object.
     * @param endpoint {string} - The endpoint to send the request to.
     * @param request {object} - The request object to send to the endpoint.
     * @protected {T | AbortableAsyncIterator<T>} - The response object or a AbortableAsyncIterator that yields
     * response messages.
     * @throws {Error} - If the response body is missing or if the response is an error.
     * @returns {Promise<T | AbortableAsyncIterator<T>>} - The response object or a AbortableAsyncIterator that yields the streamed response.
     */
    protected processStreamableRequest<T extends object>(endpoint: string, request: {
        stream?: boolean;
    } & Record<string, any>): Promise<T | AbortableAsyncIterator<T>>;
    /**
     * Encodes an image to base64 if it is a Uint8Array.
     * @param image {Uint8Array | string} - The image to encode.
     * @returns {Promise<string>} - The base64 encoded image.
     */
    encodeImage(image: Uint8Array | string): Promise<string>;
    generate(request: GenerateRequest & {
        stream: true;
    }): Promise<AbortableAsyncIterator<GenerateResponse>>;
    generate(request: GenerateRequest & {
        stream?: false;
    }): Promise<GenerateResponse>;
    chat(request: ChatRequest & {
        stream: true;
    }): Promise<AbortableAsyncIterator<ChatResponse>>;
    chat(request: ChatRequest & {
        stream?: false;
    }): Promise<ChatResponse>;
    create(request: CreateRequest & {
        stream: true;
    }): Promise<AbortableAsyncIterator<ProgressResponse>>;
    create(request: CreateRequest & {
        stream?: false;
    }): Promise<ProgressResponse>;
    pull(request: PullRequest & {
        stream: true;
    }): Promise<AbortableAsyncIterator<ProgressResponse>>;
    pull(request: PullRequest & {
        stream?: false;
    }): Promise<ProgressResponse>;
    push(request: PushRequest & {
        stream: true;
    }): Promise<AbortableAsyncIterator<ProgressResponse>>;
    push(request: PushRequest & {
        stream?: false;
    }): Promise<ProgressResponse>;
    /**
     * Deletes a model from the server. The request object should contain the name of the model to
     * delete.
     * @param request {DeleteRequest} - The request object.
     * @returns {Promise<StatusResponse>} - The response object.
     */
    delete(request: DeleteRequest): Promise<StatusResponse>;
    /**
     * Copies a model from one name to another. The request object should contain the name of the
     * model to copy and the new name.
     * @param request {CopyRequest} - The request object.
     * @returns {Promise<StatusResponse>} - The response object.
     */
    copy(request: CopyRequest): Promise<StatusResponse>;
    /**
     * Lists the models on the server.
     * @returns {Promise<ListResponse>} - The response object.
     * @throws {Error} - If the response body is missing.
     */
    list(): Promise<ListResponse>;
    /**
     * Shows the metadata of a model. The request object should contain the name of the model.
     * @param request {ShowRequest} - The request object.
     * @returns {Promise<ShowResponse>} - The response object.
     */
    show(request: ShowRequest): Promise<ShowResponse>;
    /**
     * Embeds text input into vectors.
     * @param request {EmbedRequest} - The request object.
     * @returns {Promise<EmbedResponse>} - The response object.
     */
    embed(request: EmbedRequest): Promise<EmbedResponse>;
    /**
     * Embeds a text prompt into a vector.
     * @param request {EmbeddingsRequest} - The request object.
     * @returns {Promise<EmbeddingsResponse>} - The response object.
     */
    embeddings(request: EmbeddingsRequest): Promise<EmbeddingsResponse>;
    /**
     * Lists the running models on the server
     * @returns {Promise<ListResponse>} - The response object.
     * @throws {Error} - If the response body is missing.
     */
    ps(): Promise<ListResponse>;
    /**
     * Returns the Ollama server version.
     * @returns {Promise<VersionResponse>} - The server version object.
     */
    version(): Promise<VersionResponse>;
    /**
     * Performs web search using the Ollama web search API
     * @param request {WebSearchRequest} - The search request containing query and options
     * @returns {Promise<WebSearchResponse>} - The search results
     * @throws {Error} - If the request is invalid or the server returns an error
     */
    webSearch(request: WebSearchRequest): Promise<WebSearchResponse>;
    /**
     * Fetches a single page using the Ollama web fetch API
     * @param request {WebFetchRequest} - The fetch request containing a URL
     * @returns {Promise<WebFetchResponse>} - The fetch result
     * @throws {Error} - If the request is invalid or the server returns an error
     */
    webFetch(request: WebFetchRequest): Promise<WebFetchResponse>;
}
declare const _default: Ollama;

export { AbortableAsyncIterator as A, type CreateRequest as C, type DeleteRequest as D, type EmbedRequest as E, type Fetch as F, type GenerateRequest as G, type Logprob as L, type Message as M, Ollama as O, type ProgressResponse as P, type ShowRequest as S, type ToolCall as T, type VersionResponse as V, type WebSearchRequest as W, _default as _, type Config as a, type Options as b, type Tool as c, type ChatRequest as d, type PullRequest as e, type PushRequest as f, type CopyRequest as g, type EmbeddingsRequest as h, type TokenLogprob as i, type GenerateResponse as j, type ChatResponse as k, type EmbedResponse as l, type EmbeddingsResponse as m, type ModelResponse as n, type ModelDetails as o, type ShowResponse as p, type ListResponse as q, type ErrorResponse as r, type StatusResponse as s, type WebSearchResult as t, type WebSearchResponse as u, type WebFetchRequest as v, type WebFetchResponse as w };
