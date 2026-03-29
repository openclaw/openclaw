"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Content = void 0;
const resource_1 = require("../../core/resource.js");
const headers_1 = require("../../internal/headers.js");
const path_1 = require("../../internal/utils/path.js");
class Content extends resource_1.APIResource {
    /**
     * Download a skill zip bundle by its ID.
     */
    retrieve(skillID, options) {
        return this._client.get((0, path_1.path) `/skills/${skillID}/content`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ Accept: 'application/binary' }, options?.headers]),
            __binaryResponse: true,
        });
    }
}
exports.Content = Content;
//# sourceMappingURL=content.js.map