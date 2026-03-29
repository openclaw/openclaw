// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { parseResponse, addOutputText, } from "../../lib/ResponsesParser.mjs";
import { ResponseStream } from "../../lib/responses/ResponseStream.mjs";
import { APIResource } from "../../core/resource.mjs";
import * as InputItemsAPI from "./input-items.mjs";
import { InputItems } from "./input-items.mjs";
import * as InputTokensAPI from "./input-tokens.mjs";
import { InputTokens } from "./input-tokens.mjs";
import { buildHeaders } from "../../internal/headers.mjs";
import { path } from "../../internal/utils/path.mjs";
export class Responses extends APIResource {
    constructor() {
        super(...arguments);
        this.inputItems = new InputItemsAPI.InputItems(this._client);
        this.inputTokens = new InputTokensAPI.InputTokens(this._client);
    }
    create(body, options) {
        return this._client.post('/responses', { body, ...options, stream: body.stream ?? false })._thenUnwrap((rsp) => {
            if ('object' in rsp && rsp.object === 'response') {
                addOutputText(rsp);
            }
            return rsp;
        });
    }
    retrieve(responseID, query = {}, options) {
        return this._client.get(path `/responses/${responseID}`, {
            query,
            ...options,
            stream: query?.stream ?? false,
        })._thenUnwrap((rsp) => {
            if ('object' in rsp && rsp.object === 'response') {
                addOutputText(rsp);
            }
            return rsp;
        });
    }
    /**
     * Deletes a model response with the given ID.
     *
     * @example
     * ```ts
     * await client.responses.delete(
     *   'resp_677efb5139a88190b512bc3fef8e535d',
     * );
     * ```
     */
    delete(responseID, options) {
        return this._client.delete(path `/responses/${responseID}`, {
            ...options,
            headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
        });
    }
    parse(body, options) {
        return this._client.responses
            .create(body, options)
            ._thenUnwrap((response) => parseResponse(response, body));
    }
    /**
     * Creates a model response stream
     */
    stream(body, options) {
        return ResponseStream.createResponse(this._client, body, options);
    }
    /**
     * Cancels a model response with the given ID. Only responses created with the
     * `background` parameter set to `true` can be cancelled.
     * [Learn more](https://platform.openai.com/docs/guides/background).
     *
     * @example
     * ```ts
     * const response = await client.responses.cancel(
     *   'resp_677efb5139a88190b512bc3fef8e535d',
     * );
     * ```
     */
    cancel(responseID, options) {
        return this._client.post(path `/responses/${responseID}/cancel`, options);
    }
    /**
     * Compact a conversation. Returns a compacted response object.
     *
     * Learn when and how to compact long-running conversations in the
     * [conversation state guide](https://platform.openai.com/docs/guides/conversation-state#managing-the-context-window).
     * For ZDR-compatible compaction details, see
     * [Compaction (advanced)](https://platform.openai.com/docs/guides/conversation-state#compaction-advanced).
     *
     * @example
     * ```ts
     * const compactedResponse = await client.responses.compact({
     *   model: 'gpt-5.4',
     * });
     * ```
     */
    compact(body, options) {
        return this._client.post('/responses/compact', { body, ...options });
    }
}
Responses.InputItems = InputItems;
Responses.InputTokens = InputTokens;
//# sourceMappingURL=responses.mjs.map