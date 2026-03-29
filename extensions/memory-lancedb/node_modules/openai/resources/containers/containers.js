"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Containers = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const FilesAPI = tslib_1.__importStar(require("./files/files.js"));
const files_1 = require("./files/files.js");
const pagination_1 = require("../../core/pagination.js");
const headers_1 = require("../../internal/headers.js");
const path_1 = require("../../internal/utils/path.js");
class Containers extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.files = new FilesAPI.Files(this._client);
    }
    /**
     * Create Container
     */
    create(body, options) {
        return this._client.post('/containers', { body, ...options });
    }
    /**
     * Retrieve Container
     */
    retrieve(containerID, options) {
        return this._client.get((0, path_1.path) `/containers/${containerID}`, options);
    }
    /**
     * List Containers
     */
    list(query = {}, options) {
        return this._client.getAPIList('/containers', (pagination_1.CursorPage), { query, ...options });
    }
    /**
     * Delete Container
     */
    delete(containerID, options) {
        return this._client.delete((0, path_1.path) `/containers/${containerID}`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ Accept: '*/*' }, options?.headers]),
        });
    }
}
exports.Containers = Containers;
Containers.Files = files_1.Files;
//# sourceMappingURL=containers.js.map