// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../../core/resource.mjs";
import { ConversationCursorPage, } from "../../../core/pagination.mjs";
import { buildHeaders } from "../../../internal/headers.mjs";
import { path } from "../../../internal/utils/path.mjs";
export class Threads extends APIResource {
    /**
     * Retrieve a ChatKit thread by its identifier.
     *
     * @example
     * ```ts
     * const chatkitThread =
     *   await client.beta.chatkit.threads.retrieve('cthr_123');
     * ```
     */
    retrieve(threadID, options) {
        return this._client.get(path `/chatkit/threads/${threadID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
        });
    }
    /**
     * List ChatKit threads with optional pagination and user filters.
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const chatkitThread of client.beta.chatkit.threads.list()) {
     *   // ...
     * }
     * ```
     */
    list(query = {}, options) {
        return this._client.getAPIList('/chatkit/threads', (ConversationCursorPage), {
            query,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
        });
    }
    /**
     * Delete a ChatKit thread along with its items and stored attachments.
     *
     * @example
     * ```ts
     * const thread = await client.beta.chatkit.threads.delete(
     *   'cthr_123',
     * );
     * ```
     */
    delete(threadID, options) {
        return this._client.delete(path `/chatkit/threads/${threadID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
        });
    }
    /**
     * List items that belong to a ChatKit thread.
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const thread of client.beta.chatkit.threads.listItems(
     *   'cthr_123',
     * )) {
     *   // ...
     * }
     * ```
     */
    listItems(threadID, query = {}, options) {
        return this._client.getAPIList(path `/chatkit/threads/${threadID}/items`, (ConversationCursorPage), { query, ...options, headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]) });
    }
}
//# sourceMappingURL=threads.mjs.map