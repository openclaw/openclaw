"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Graders = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const GraderModelsAPI = tslib_1.__importStar(require("./grader-models.js"));
const grader_models_1 = require("./grader-models.js");
class Graders extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.graderModels = new GraderModelsAPI.GraderModels(this._client);
    }
}
exports.Graders = Graders;
Graders.GraderModels = grader_models_1.GraderModels;
//# sourceMappingURL=graders.js.map