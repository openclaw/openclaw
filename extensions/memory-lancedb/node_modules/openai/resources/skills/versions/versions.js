"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Versions = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const ContentAPI = tslib_1.__importStar(require("./content.js"));
const content_1 = require("./content.js");
const pagination_1 = require("../../../core/pagination.js");
const uploads_1 = require("../../../internal/uploads.js");
const path_1 = require("../../../internal/utils/path.js");
class Versions extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.content = new ContentAPI.Content(this._client);
    }
    /**
     * Create a new immutable skill version.
     */
    create(skillID, body = {}, options) {
        return this._client.post((0, path_1.path) `/skills/${skillID}/versions`, (0, uploads_1.maybeMultipartFormRequestOptions)({ body, ...options }, this._client));
    }
    /**
     * Get a specific skill version.
     */
    retrieve(version, params, options) {
        const { skill_id } = params;
        return this._client.get((0, path_1.path) `/skills/${skill_id}/versions/${version}`, options);
    }
    /**
     * List skill versions for a skill.
     */
    list(skillID, query = {}, options) {
        return this._client.getAPIList((0, path_1.path) `/skills/${skillID}/versions`, (pagination_1.CursorPage), {
            query,
            ...options,
        });
    }
    /**
     * Delete a skill version.
     */
    delete(version, params, options) {
        const { skill_id } = params;
        return this._client.delete((0, path_1.path) `/skills/${skill_id}/versions/${version}`, options);
    }
}
exports.Versions = Versions;
Versions.Content = content_1.Content;
//# sourceMappingURL=versions.js.map