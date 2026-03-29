// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
export class InputTokens extends APIResource {
    /**
     * Returns input token counts of the request.
     *
     * Returns an object with `object` set to `response.input_tokens` and an
     * `input_tokens` count.
     *
     * @example
     * ```ts
     * const response = await client.responses.inputTokens.count();
     * ```
     */
    count(body = {}, options) {
        return this._client.post('/responses/input_tokens', { body, ...options });
    }
}
//# sourceMappingURL=input-tokens.mjs.map