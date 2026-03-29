// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../core/resource.mjs";
import { multipartFormRequestOptions } from "../internal/uploads.mjs";
/**
 * Given a prompt and/or an input image, the model will generate a new image.
 */
export class Images extends APIResource {
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
        return this._client.post('/images/variations', multipartFormRequestOptions({ body, ...options }, this._client));
    }
    edit(body, options) {
        return this._client.post('/images/edits', multipartFormRequestOptions({ body, ...options, stream: body.stream ?? false }, this._client));
    }
    generate(body, options) {
        return this._client.post('/images/generations', { body, ...options, stream: body.stream ?? false });
    }
}
//# sourceMappingURL=images.mjs.map