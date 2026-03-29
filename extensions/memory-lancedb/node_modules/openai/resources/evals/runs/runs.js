"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Runs = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const OutputItemsAPI = tslib_1.__importStar(require("./output-items.js"));
const output_items_1 = require("./output-items.js");
const pagination_1 = require("../../../core/pagination.js");
const path_1 = require("../../../internal/utils/path.js");
/**
 * Manage and run evals in the OpenAI platform.
 */
class Runs extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.outputItems = new OutputItemsAPI.OutputItems(this._client);
    }
    /**
     * Kicks off a new run for a given evaluation, specifying the data source, and what
     * model configuration to use to test. The datasource will be validated against the
     * schema specified in the config of the evaluation.
     */
    create(evalID, body, options) {
        return this._client.post((0, path_1.path) `/evals/${evalID}/runs`, { body, ...options });
    }
    /**
     * Get an evaluation run by ID.
     */
    retrieve(runID, params, options) {
        const { eval_id } = params;
        return this._client.get((0, path_1.path) `/evals/${eval_id}/runs/${runID}`, options);
    }
    /**
     * Get a list of runs for an evaluation.
     */
    list(evalID, query = {}, options) {
        return this._client.getAPIList((0, path_1.path) `/evals/${evalID}/runs`, (pagination_1.CursorPage), {
            query,
            ...options,
        });
    }
    /**
     * Delete an eval run.
     */
    delete(runID, params, options) {
        const { eval_id } = params;
        return this._client.delete((0, path_1.path) `/evals/${eval_id}/runs/${runID}`, options);
    }
    /**
     * Cancel an ongoing evaluation run.
     */
    cancel(runID, params, options) {
        const { eval_id } = params;
        return this._client.post((0, path_1.path) `/evals/${eval_id}/runs/${runID}`, options);
    }
}
exports.Runs = Runs;
Runs.OutputItems = output_items_1.OutputItems;
//# sourceMappingURL=runs.js.map