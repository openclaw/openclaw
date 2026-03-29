// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import { multipartFormRequestOptions } from "../../internal/uploads.mjs";
/**
 * Turn audio into text or text into audio.
 */
export class Translations extends APIResource {
    create(body, options) {
        return this._client.post('/audio/translations', multipartFormRequestOptions({ body, ...options, __metadata: { model: body.model } }, this._client));
    }
}
//# sourceMappingURL=translations.mjs.map