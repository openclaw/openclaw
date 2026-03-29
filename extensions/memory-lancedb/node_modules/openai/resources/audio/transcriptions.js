"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transcriptions = void 0;
const resource_1 = require("../../core/resource.js");
const uploads_1 = require("../../internal/uploads.js");
/**
 * Turn audio into text or text into audio.
 */
class Transcriptions extends resource_1.APIResource {
    create(body, options) {
        return this._client.post('/audio/transcriptions', (0, uploads_1.multipartFormRequestOptions)({
            body,
            ...options,
            stream: body.stream ?? false,
            __metadata: { model: body.model },
        }, this._client));
    }
}
exports.Transcriptions = Transcriptions;
//# sourceMappingURL=transcriptions.js.map