"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.FineTuning = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const MethodsAPI = tslib_1.__importStar(require("./methods.js"));
const methods_1 = require("./methods.js");
const AlphaAPI = tslib_1.__importStar(require("./alpha/alpha.js"));
const alpha_1 = require("./alpha/alpha.js");
const CheckpointsAPI = tslib_1.__importStar(require("./checkpoints/checkpoints.js"));
const checkpoints_1 = require("./checkpoints/checkpoints.js");
const JobsAPI = tslib_1.__importStar(require("./jobs/jobs.js"));
const jobs_1 = require("./jobs/jobs.js");
class FineTuning extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.methods = new MethodsAPI.Methods(this._client);
        this.jobs = new JobsAPI.Jobs(this._client);
        this.checkpoints = new CheckpointsAPI.Checkpoints(this._client);
        this.alpha = new AlphaAPI.Alpha(this._client);
    }
}
exports.FineTuning = FineTuning;
FineTuning.Methods = methods_1.Methods;
FineTuning.Jobs = jobs_1.Jobs;
FineTuning.Checkpoints = checkpoints_1.Checkpoints;
FineTuning.Alpha = alpha_1.Alpha;
//# sourceMappingURL=fine-tuning.js.map