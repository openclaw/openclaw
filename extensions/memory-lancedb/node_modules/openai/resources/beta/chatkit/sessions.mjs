// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../../core/resource.mjs";
import { buildHeaders } from "../../../internal/headers.mjs";
import { path } from "../../../internal/utils/path.mjs";
export class Sessions extends APIResource {
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
            headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
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
        return this._client.post(path `/chatkit/sessions/${sessionID}/cancel`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'chatkit_beta=v1' }, options?.headers]),
        });
    }
}
//# sourceMappingURL=sessions.mjs.map