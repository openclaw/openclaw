"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Batches = void 0;
const resource_1 = require("../core/resource.js");
const pagination_1 = require("../core/pagination.js");
const path_1 = require("../internal/utils/path.js");
/**
 * Create large batches of API requests to run asynchronously.
 */
class Batches extends resource_1.APIResource {
    /**
     * Creates and executes a batch from an uploaded file of requests
     */
    create(body, options) {
        return this._client.post('/batches', { body, ...options });
    }
    /**
     * Retrieves a batch.
     */
    retrieve(batchID, options) {
        return this._client.get((0, path_1.path) `/batches/${batchID}`, options);
    }
    /**
     * List your organization's batches.
     */
    list(query = {}, options) {
        return this._client.getAPIList('/batches', (pagination_1.CursorPage), { query, ...options });
    }
    /**
     * Cancels an in-progress batch. The batch will be in status `cancelling` for up to
     * 10 minutes, before changing to `cancelled`, where it will have partial results
     * (if any) available in the output file.
     */
    cancel(batchID, options) {
        return this._client.post((0, path_1.path) `/batches/${batchID}/cancel`, options);
    }
}
exports.Batches = Batches;
//# sourceMappingURL=batches.js.map