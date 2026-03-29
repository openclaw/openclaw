"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Evals = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const RunsAPI = tslib_1.__importStar(require("./runs/runs.js"));
const runs_1 = require("./runs/runs.js");
const pagination_1 = require("../../core/pagination.js");
const path_1 = require("../../internal/utils/path.js");
/**
 * Manage and run evals in the OpenAI platform.
 */
class Evals extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.runs = new RunsAPI.Runs(this._client);
    }
    /**
     * Create the structure of an evaluation that can be used to test a model's
     * performance. An evaluation is a set of testing criteria and the config for a
     * data source, which dictates the schema of the data used in the evaluation. After
     * creating an evaluation, you can run it on different models and model parameters.
     * We support several types of graders and datasources. For more information, see
     * the [Evals guide](https://platform.openai.com/docs/guides/evals).
     */
    create(body, options) {
        return this._client.post('/evals', { body, ...options });
    }
    /**
     * Get an evaluation by ID.
     */
    retrieve(evalID, options) {
        return this._client.get((0, path_1.path) `/evals/${evalID}`, options);
    }
    /**
     * Update certain properties of an evaluation.
     */
    update(evalID, body, options) {
        return this._client.post((0, path_1.path) `/evals/${evalID}`, { body, ...options });
    }
    /**
     * List evaluations for a project.
     */
    list(query = {}, options) {
        return this._client.getAPIList('/evals', (pagination_1.CursorPage), { query, ...options });
    }
    /**
     * Delete an evaluation.
     */
    delete(evalID, options) {
        return this._client.delete((0, path_1.path) `/evals/${evalID}`, options);
    }
}
exports.Evals = Evals;
Evals.Runs = runs_1.Runs;
//# sourceMappingURL=evals.js.map