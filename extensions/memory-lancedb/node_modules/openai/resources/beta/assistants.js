"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Assistants = void 0;
const resource_1 = require("../../core/resource.js");
const pagination_1 = require("../../core/pagination.js");
const headers_1 = require("../../internal/headers.js");
const path_1 = require("../../internal/utils/path.js");
/**
 * Build Assistants that can call models and use tools.
 */
class Assistants extends resource_1.APIResource {
    /**
     * Create an assistant with a model and instructions.
     *
     * @deprecated
     */
    create(body, options) {
        return this._client.post('/assistants', {
            body,
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Retrieves an assistant.
     *
     * @deprecated
     */
    retrieve(assistantID, options) {
        return this._client.get((0, path_1.path) `/assistants/${assistantID}`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Modifies an assistant.
     *
     * @deprecated
     */
    update(assistantID, body, options) {
        return this._client.post((0, path_1.path) `/assistants/${assistantID}`, {
            body,
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Returns a list of assistants.
     *
     * @deprecated
     */
    list(query = {}, options) {
        return this._client.getAPIList('/assistants', (pagination_1.CursorPage), {
            query,
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Delete an assistant.
     *
     * @deprecated
     */
    delete(assistantID, options) {
        return this._client.delete((0, path_1.path) `/assistants/${assistantID}`, {
            ...options,
            headers: (0, headers_1.buildHeaders)([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
}
exports.Assistants = Assistants;
//# sourceMappingURL=assistants.js.map