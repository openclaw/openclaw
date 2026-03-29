"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatCompletionRunner = exports.ChatCompletionStream = exports.ParsingToolFunction = exports.ChatCompletionStreamingRunner = exports.Completions = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const MessagesAPI = tslib_1.__importStar(require("./messages.js"));
const messages_1 = require("./messages.js");
const pagination_1 = require("../../../core/pagination.js");
const path_1 = require("../../../internal/utils/path.js");
const ChatCompletionRunner_1 = require("../../../lib/ChatCompletionRunner.js");
const ChatCompletionStreamingRunner_1 = require("../../../lib/ChatCompletionStreamingRunner.js");
const ChatCompletionStream_1 = require("../../../lib/ChatCompletionStream.js");
const parser_1 = require("../../../lib/parser.js");
/**
 * Given a list of messages comprising a conversation, the model will return a response.
 */
class Completions extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.messages = new MessagesAPI.Messages(this._client);
    }
    create(body, options) {
        return this._client.post('/chat/completions', { body, ...options, stream: body.stream ?? false });
    }
    /**
     * Get a stored chat completion. Only Chat Completions that have been created with
     * the `store` parameter set to `true` will be returned.
     *
     * @example
     * ```ts
     * const chatCompletion =
     *   await client.chat.completions.retrieve('completion_id');
     * ```
     */
    retrieve(completionID, options) {
        return this._client.get((0, path_1.path) `/chat/completions/${completionID}`, options);
    }
    /**
     * Modify a stored chat completion. Only Chat Completions that have been created
     * with the `store` parameter set to `true` can be modified. Currently, the only
     * supported modification is to update the `metadata` field.
     *
     * @example
     * ```ts
     * const chatCompletion = await client.chat.completions.update(
     *   'completion_id',
     *   { metadata: { foo: 'string' } },
     * );
     * ```
     */
    update(completionID, body, options) {
        return this._client.post((0, path_1.path) `/chat/completions/${completionID}`, { body, ...options });
    }
    /**
     * List stored Chat Completions. Only Chat Completions that have been stored with
     * the `store` parameter set to `true` will be returned.
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const chatCompletion of client.chat.completions.list()) {
     *   // ...
     * }
     * ```
     */
    list(query = {}, options) {
        return this._client.getAPIList('/chat/completions', (pagination_1.CursorPage), { query, ...options });
    }
    /**
     * Delete a stored chat completion. Only Chat Completions that have been created
     * with the `store` parameter set to `true` can be deleted.
     *
     * @example
     * ```ts
     * const chatCompletionDeleted =
     *   await client.chat.completions.delete('completion_id');
     * ```
     */
    delete(completionID, options) {
        return this._client.delete((0, path_1.path) `/chat/completions/${completionID}`, options);
    }
    parse(body, options) {
        (0, parser_1.validateInputTools)(body.tools);
        return this._client.chat.completions
            .create(body, {
            ...options,
            headers: {
                ...options?.headers,
                'X-Stainless-Helper-Method': 'chat.completions.parse',
            },
        })
            ._thenUnwrap((completion) => (0, parser_1.parseChatCompletion)(completion, body));
    }
    runTools(body, options) {
        if (body.stream) {
            return ChatCompletionStreamingRunner_1.ChatCompletionStreamingRunner.runTools(this._client, body, options);
        }
        return ChatCompletionRunner_1.ChatCompletionRunner.runTools(this._client, body, options);
    }
    /**
     * Creates a chat completion stream
     */
    stream(body, options) {
        return ChatCompletionStream_1.ChatCompletionStream.createChatCompletion(this._client, body, options);
    }
}
exports.Completions = Completions;
var ChatCompletionStreamingRunner_2 = require("../../../lib/ChatCompletionStreamingRunner.js");
Object.defineProperty(exports, "ChatCompletionStreamingRunner", { enumerable: true, get: function () { return ChatCompletionStreamingRunner_2.ChatCompletionStreamingRunner; } });
var RunnableFunction_1 = require("../../../lib/RunnableFunction.js");
Object.defineProperty(exports, "ParsingToolFunction", { enumerable: true, get: function () { return RunnableFunction_1.ParsingToolFunction; } });
var ChatCompletionStream_2 = require("../../../lib/ChatCompletionStream.js");
Object.defineProperty(exports, "ChatCompletionStream", { enumerable: true, get: function () { return ChatCompletionStream_2.ChatCompletionStream; } });
var ChatCompletionRunner_2 = require("../../../lib/ChatCompletionRunner.js");
Object.defineProperty(exports, "ChatCompletionRunner", { enumerable: true, get: function () { return ChatCompletionRunner_2.ChatCompletionRunner; } });
Completions.Messages = messages_1.Messages;
//# sourceMappingURL=completions.js.map