// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../core/resource.mjs";
import { ConversationCursorPage } from "../core/pagination.mjs";
import { buildHeaders } from "../internal/headers.mjs";
import { maybeMultipartFormRequestOptions, multipartFormRequestOptions } from "../internal/uploads.mjs";
import { path } from "../internal/utils/path.mjs";
export class Videos extends APIResource {
    /**
     * Create a new video generation job from a prompt and optional reference assets.
     */
    create(body, options) {
        return this._client.post('/videos', multipartFormRequestOptions({ body, ...options }, this._client));
    }
    /**
     * Fetch the latest metadata for a generated video.
     */
    retrieve(videoID, options) {
        return this._client.get(path `/videos/${videoID}`, options);
    }
    /**
     * List recently generated videos for the current project.
     */
    list(query = {}, options) {
        return this._client.getAPIList('/videos', (ConversationCursorPage), { query, ...options });
    }
    /**
     * Permanently delete a completed or failed video and its stored assets.
     */
    delete(videoID, options) {
        return this._client.delete(path `/videos/${videoID}`, options);
    }
    /**
     * Create a character from an uploaded video.
     */
    createCharacter(body, options) {
        return this._client.post('/videos/characters', multipartFormRequestOptions({ body, ...options }, this._client));
    }
    /**
     * Download the generated video bytes or a derived preview asset.
     *
     * Streams the rendered video content for the specified video job.
     */
    downloadContent(videoID, query = {}, options) {
        return this._client.get(path `/videos/${videoID}/content`, {
            query,
            ...options,
            headers: buildHeaders([{ Accept: 'application/binary' }, options?.headers]),
            __binaryResponse: true,
        });
    }
    /**
     * Create a new video generation job by editing a source video or existing
     * generated video.
     */
    edit(body, options) {
        return this._client.post('/videos/edits', multipartFormRequestOptions({ body, ...options }, this._client));
    }
    /**
     * Create an extension of a completed video.
     */
    extend(body, options) {
        return this._client.post('/videos/extensions', multipartFormRequestOptions({ body, ...options }, this._client));
    }
    /**
     * Fetch a character.
     */
    getCharacter(characterID, options) {
        return this._client.get(path `/videos/characters/${characterID}`, options);
    }
    /**
     * Create a remix of a completed video using a refreshed prompt.
     */
    remix(videoID, body, options) {
        return this._client.post(path `/videos/${videoID}/remix`, maybeMultipartFormRequestOptions({ body, ...options }, this._client));
    }
}
//# sourceMappingURL=videos.mjs.map