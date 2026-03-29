"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Videos = void 0;
const resource_1 = require("../core/resource.js");
const pagination_1 = require("../core/pagination.js");
const headers_1 = require("../internal/headers.js");
const uploads_1 = require("../internal/uploads.js");
const path_1 = require("../internal/utils/path.js");
class Videos extends resource_1.APIResource {
    /**
     * Create a new video generation job from a prompt and optional reference assets.
     */
    create(body, options) {
        return this._client.post('/videos', (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
    /**
     * Fetch the latest metadata for a generated video.
     */
    retrieve(videoID, options) {
        return this._client.get((0, path_1.path) `/videos/${videoID}`, options);
    }
    /**
     * List recently generated videos for the current project.
     */
    list(query = {}, options) {
        return this._client.getAPIList('/videos', (pagination_1.ConversationCursorPage), { query, ...options });
    }
    /**
     * Permanently delete a completed or failed video and its stored assets.
     */
    delete(videoID, options) {
        return this._client.delete((0, path_1.path) `/videos/${videoID}`, options);
    }
    /**
     * Create a character from an uploaded video.
     */
    createCharacter(body, options) {
        return this._client.post('/videos/characters', (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
    /**
     * Download the generated video bytes or a derived preview asset.
     *
     * Streams the rendered video content for the specified video job.
     */
    downloadContent(videoID, query = {}, options) {
        return this._client.get((0, path_1.path) `/videos/${videoID}/content`, {
            query,
            ...options,
            headers: (0, headers_1.buildHeaders)([{ Accept: 'application/binary' }, options?.headers]),
            __binaryResponse: true,
        });
    }
    /**
     * Create a new video generation job by editing a source video or existing
     * generated video.
     */
    edit(body, options) {
        return this._client.post('/videos/edits', (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
    /**
     * Create an extension of a completed video.
     */
    extend(body, options) {
        return this._client.post('/videos/extensions', (0, uploads_1.multipartFormRequestOptions)({ body, ...options }, this._client));
    }
    /**
     * Fetch a character.
     */
    getCharacter(characterID, options) {
        return this._client.get((0, path_1.path) `/videos/characters/${characterID}`, options);
    }
    /**
     * Create a remix of a completed video using a refreshed prompt.
     */
    remix(videoID, body, options) {
        return this._client.post((0, path_1.path) `/videos/${videoID}/remix`, (0, uploads_1.maybeMultipartFormRequestOptions)({ body, ...options }, this._client));
    }
}
exports.Videos = Videos;
//# sourceMappingURL=videos.js.map