"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputTokens = void 0;
const resource_1 = require("../../core/resource.js");
class InputTokens extends resource_1.APIResource {
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
exports.InputTokens = InputTokens;
//# sourceMappingURL=input-tokens.js.map