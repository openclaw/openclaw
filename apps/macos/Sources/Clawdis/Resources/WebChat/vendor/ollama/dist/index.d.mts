import { O as Ollama$1, C as CreateRequest, A as AbortableAsyncIterator, P as ProgressResponse } from './shared/ollama.1bfa89da.mjs';
export { d as ChatRequest, k as ChatResponse, a as Config, g as CopyRequest, D as DeleteRequest, E as EmbedRequest, l as EmbedResponse, h as EmbeddingsRequest, m as EmbeddingsResponse, r as ErrorResponse, F as Fetch, G as GenerateRequest, j as GenerateResponse, q as ListResponse, L as Logprob, M as Message, o as ModelDetails, n as ModelResponse, b as Options, e as PullRequest, f as PushRequest, S as ShowRequest, p as ShowResponse, s as StatusResponse, i as TokenLogprob, c as Tool, T as ToolCall, V as VersionResponse, v as WebFetchRequest, w as WebFetchResponse, W as WebSearchRequest, u as WebSearchResponse, t as WebSearchResult } from './shared/ollama.1bfa89da.mjs';

declare class Ollama extends Ollama$1 {
    encodeImage(image: Uint8Array | Buffer | string): Promise<string>;
    /**
     * checks if a file exists
     * @param path {string} - The path to the file
     * @private @internal
     * @returns {Promise<boolean>} - Whether the file exists or not
     */
    private fileExists;
    create(request: CreateRequest & {
        stream: true;
    }): Promise<AbortableAsyncIterator<ProgressResponse>>;
    create(request: CreateRequest & {
        stream?: false;
    }): Promise<ProgressResponse>;
}
declare const _default: Ollama;

export { AbortableAsyncIterator, CreateRequest, Ollama, ProgressResponse, _default as default };
