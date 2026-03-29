"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Images = void 0;
const resource_1 = require("../core/resource.js");
const uploads_1 = require("../internal/uploads.js");
/**
 * Given a prompt and/or an input image, the model will generate a new image.
 */
class Images extends resource_1.APIResource {
    /**
     * Creates a variation of a given image. This endpoint only supports `dall-e-2`.
     *
     * @example
     * ```ts
     * const imagesResponse = await client.images.createVariation({
     *   image: fs.createReadStream('otter.png'),
     * });
     * ```
     */
    createVariation(body, options) {
        return this._client.post('/images/variations', (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
    edit(body, options) {
        return this._client.post('/images/edits', (0, uploads_1.multipartFormRequestOptions)({ body, ...options, stream: body.stream ?? false }, this._client));
    }
    generate(body, options) {
        return this._client.post('/images/generations', { body, ...options, stream: body.stream ?? false });
    }
}
exports.Images = Images;
//# sourceMappingURL=images.js.map