// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import { multipartFormRequestOptions } from "../../internal/uploads.mjs";
/**
 * Turn audio into text or text into audio.
 */
export class Transcriptions extends APIResource {
    create(body, options) {
        return this._client.post('/audio/transcriptions', multipartFormRequestOptions({
            body,
            ...options,
            stream: body.stream ?? false,
            __metadata: { model: body.model },
        }, this._client));
    }
}
//# sourceMappingURL=transcriptions.mjs.map