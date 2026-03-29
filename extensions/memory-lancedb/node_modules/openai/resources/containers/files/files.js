"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Files = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const ContentAPI = tslib_1.__importStar(require("./content.js"));
const content_1 = require("./content.js");
const pagination_1 = require("../../../core/pagination.js");
const headers_1 = require("../../../internal/headers.js");
const uploads_1 = require("../../../internal/uploads.js");
const path_1 = require("../../../internal/utils/path.js");
class Files extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.content = new ContentAPI.Content(this._client);
    }
    /**
     * Create a Container File
     *
     * You can send either a multipart/form-data request with the raw file content, or
     * a JSON request with a file ID.
     */
    create(containerID, body, options) {
        return this._client.post((0, path_1.path) `/containers/${containerID}/files`, (0, uploads_1.maybeMultipartFormRequestOptions)({ body, ...options }, this._client));
    }
    /**
     * Retrieve Container File
     */
    retrieve(fileID, params, options) {
        const { container_id } = params;
        return this._client.get((0, path_1.path) `/containers/${container_id}/files/${fileID}`, options);
    }
    /**
     * List Container files
     */
    list(containerID, query = {}, options) {
        return this._client.getAPIList((0, path_1.path) `/containers/${containerID}/files`, (pagination_1.CursorPage), {
            query,
            ...options,
        });
    }
    /**
     * Delete Container File
     */
    delete(fileID, params, options) {
        const { container_id } = params;
        return this._client.delete((0, path_1.path) `/containers/${container_id}/files/${fileID}`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ Accept: '*/*' }, options?.headers]),
        });
    }
}
exports.Files = Files;
Files.Content = content_1.Content;
//# sourceMappingURL=files.js.map