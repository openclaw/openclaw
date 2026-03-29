import { FinalRequestOptions } from "../internal/request-options.mjs";
import { APIPromise } from "./api-promise.mjs";
import { type OpenAI } from "../client.mjs";
import { type APIResponseProps } from "../internal/parse.mjs";
export type PageRequestOptions = Pick<FinalRequestOptions, 'query' | 'headers' | 'body' | 'path' | 'method'>;
export declare abstract class AbstractPage<Item> implements AsyncIterable<Item> {
    #private;
    protected options: FinalRequestOptions;
    protected response: Response;
    protected body: unknown;
    constructor(client: OpenAI, response: Response, body: unknown, options: FinalRequestOptions);
    abstract nextPageRequestOptions(): PageRequestOptions | null;
    abstract getPaginatedItems(): Item[];
    hasNextPage(): boolean;
    getNextPage(): Promise<this>;
    iterPages(): AsyncGenerator<this>;
    [Symbol.asyncIterator](): AsyncGenerator<Item>;
}
/**
 * This subclass of Promise will resolve to an instantiated Page once the request completes.
 *
 * It also implements AsyncIterable to allow auto-paginating iteration on an unawaited list call, eg:
 *
 *    for await (const item of client.items.list()) {
 *      console.log(item)
 *    }
 */
export declare class PagePromise<PageClass extends AbstractPage<Item>, Item = ReturnType<PageClass['getPaginatedItems']>[number]> extends APIPromise<PageClass> implements AsyncIterable<Item> {
    constructor(client: OpenAI, request: Promise<APIResponseProps>, Page: new (...args: ConstructorParameters<typeof AbstractPage>) => PageClass);
    /**
     * Allow auto-paginating iteration on an unawaited list call, eg:
     *
     *    for await (const item of client.items.list()) {
     *      console.log(item)
     *    }
     */
    [Symbol.asyncIterator](): AsyncGenerator<Item>;
}
export interface PageResponse<Item> {
    data: Array<Item>;
    object: string;
}
/**
 * Note: no pagination actually occurs yet, this is for forwards-compatibility.
 */
export declare class Page<Item> extends AbstractPage<Item> implements PageResponse<Item> {
    data: Array<Item>;
    object: string;
    constructor(client: OpenAI, response: Response, body: PageResponse<Item>, options: FinalRequestOptions);
    getPaginatedItems(): Item[];
    nextPageRequestOptions(): PageRequestOptions | null;
}
export interface CursorPageResponse<Item> {
    data: Array<Item>;
    has_more: boolean;
}
export interface CursorPageParams {
    after?: string;
    limit?: number;
}
export declare class CursorPage<Item extends {
    id: string;
}> extends AbstractPage<Item> implements CursorPageResponse<Item> {
    data: Array<Item>;
    has_more: boolean;
    constructor(client: OpenAI, response: Response, body: CursorPageResponse<Item>, options: FinalRequestOptions);
    getPaginatedItems(): Item[];
    hasNextPage(): boolean;
    nextPageRequestOptions(): PageRequestOptions | null;
}
export interface ConversationCursorPageResponse<Item> {
    data: Array<Item>;
    has_more: boolean;
    last_id: string;
}
export interface ConversationCursorPageParams {
    after?: string;
    limit?: number;
}
export declare class ConversationCursorPage<Item> extends AbstractPage<Item> implements ConversationCursorPageResponse<Item> {
    data: Array<Item>;
    has_more: boolean;
    last_id: string;
    constructor(client: OpenAI, response: Response, body: ConversationCursorPageResponse<Item>, options: FinalRequestOptions);
    getPaginatedItems(): Item[];
    hasNextPage(): boolean;
    nextPageRequestOptions(): PageRequestOptions | null;
}
//# sourceMappingURL=pagination.d.mts.map