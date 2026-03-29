"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sessions = void 0;
const resource_1 = require("../../../core/resource.js");
const headers_1 = require("../../../internal/headers.js");
const path_1 = require("../../../internal/utils/path.js");
class Sessions extends resource_1.APIResource {
    /**
     * Create a ChatKit session.
     *
     * @example
     * ```ts
     * const chatSession =
     *   await client.beta.chatkit.sessions.create({
     *     user: 'x',
     *     workflow: { id: 'id' },
     *   });
     * ```
     */
    create(body, options) {
        return this._client.post('/chatkit/sessions', {
            body,
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
        });
    }
    /**
     * Cancel an active ChatKit session and return its most recent metadata.
     *
     * Cancelling prevents new requests from using the issued client secret.
     *
     * @example
     * ```ts
     * const chatSession =
     *   await client.beta.chatkit.sessions.cancel('cksess_123');
     * ```
     */
    cancel(sessionID, options) {
        return this._client.post((0, path_1.path) `/chatkit/sessions/${sessionID}/cancel`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
        });
    }
}
exports.Sessions = Sessions;
//# sourceMappingURL=sessions.js.map