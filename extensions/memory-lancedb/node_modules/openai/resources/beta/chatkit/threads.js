"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Threads = void 0;
const resource_1 = require("../../../core/resource.js");
const pagination_1 = require("../../../core/pagination.js");
const headers_1 = require("../../../internal/headers.js");
const path_1 = require("../../../internal/utils/path.js");
class Threads extends resource_1.APIResource {
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
        return this._client.get((0, path_1.path) `/chatkit/threads/${threadID}`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
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
        return this._client.getAPIList('/chatkit/threads', (pagination_1.ConversationCursorPage), {
            query,
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
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
        return this._client.delete((0, path_1.path) `/chatkit/threads/${threadID}`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
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
        return this._client.getAPIList((0, path_1.path) `/chatkit/threads/${threadID}/items`, (pagination_1.ConversationCursorPage), { query, ...options, headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]) });
    }
}
exports.Threads = Threads;
//# sourceMappingURL=threads.js.map