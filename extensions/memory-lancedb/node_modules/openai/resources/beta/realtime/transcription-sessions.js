"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranscriptionSessions = void 0;
const resource_1 = require("../../../core/resource.js");
const headers_1 = require("../../../internal/headers.js");
class TranscriptionSessions extends resource_1.APIResource {
    /**
     * Create an ephemeral API token for use in client-side applications with the
     * Realtime API specifically for realtime transcriptions. Can be configured with
     * the same session parameters as the `transcription_session.update` client event.
     *
     * It responds with a session object, plus a `client_secret` key which contains a
     * usable ephemeral API token that can be used to authenticate browser clients for
     * the Realtime API.
     *
     * @example
     * ```ts
     * const transcriptionSession =
     *   await client.beta.realtime.transcriptionSessions.create();
     * ```
     */
    create(body, options) {
        return this._client.post('/realtime/transcription_sessions', {
            body,
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
}
exports.TranscriptionSessions = TranscriptionSessions;
//# sourceMappingURL=transcription-sessions.js.map