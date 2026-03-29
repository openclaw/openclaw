import { APIResource } from "../../../core/resource.js";
import * as CompletionsAPI from "./completions.js";
import { ChatCompletionStoreMessagesPage } from "./completions.js";
import { type CursorPageParams, PagePromise } from "../../../core/pagination.js";
import { RequestOptions } from "../../../internal/request-options.js";
/**
 * Given a list of messages comprising a conversation, the model will return a response.
 */
export declare class Messages extends APIResource {
    /**
     * Get the messages in a stored chat completion. Only Chat Completions that have
     * been created with the `store` parameter set to `true` will be returned.
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const chatCompletionStoreMessage of client.chat.completions.messages.list(
     *   'completion_id',
     * )) {
     *   // ...
     * }
     * ```
     */
    list(completionID: string, query?: MessageListParams | null | undefined, options?: RequestOptions): PagePromise<ChatCompletionStoreMessagesPage, CompletionsAPI.ChatCompletionStoreMessage>;
}
export interface MessageListParams extends CursorPageParams {
    /**
     * Sort order for messages by timestamp. Use `asc` for ascending order or `desc`
     * for descending order. Defaults to `asc`.
     */
    order?: 'asc' | 'desc';
}
export declare namespace Messages {
    export { type MessageListParams as MessageListParams };
}
export { type ChatCompletionStoreMessagesPage };
//# sourceMappingURL=messages.d.ts.map