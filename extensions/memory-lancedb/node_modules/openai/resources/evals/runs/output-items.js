"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutputItems = void 0;
const resource_1 = require("../../../core/resource.js");
const pagination_1 = require("../../../core/pagination.js");
const path_1 = require("../../../internal/utils/path.js");
/**
 * Manage and run evals in the OpenAI platform.
 */
class OutputItems extends resource_1.APIResource {
    /**
     * Get an evaluation run output item by ID.
     */
    retrieve(outputItemID, params, options) {
        const { eval_id, run_id } = params;
        return this._client.get((0, path_1.path) `/evals/${eval_id}/runs/${run_id}/output_items/${outputItemID}`, options);
    }
    /**
     * Get a list of output items for an evaluation run.
     */
    list(runID, params, options) {
        const { eval_id, ...query } = params;
        return this._client.getAPIList((0, path_1.path) `/evals/${eval_id}/runs/${runID}/output_items`, (pagination_1.CursorPage), { query, ...options });
    }
}
exports.OutputItems = OutputItems;
//# sourceMappingURL=output-items.js.map