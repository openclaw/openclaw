// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as MethodsAPI from "./methods.mjs";
import { Methods, } from "./methods.mjs";
import * as AlphaAPI from "./alpha/alpha.mjs";
import { Alpha } from "./alpha/alpha.mjs";
import * as CheckpointsAPI from "./checkpoints/checkpoints.mjs";
import { Checkpoints } from "./checkpoints/checkpoints.mjs";
import * as JobsAPI from "./jobs/jobs.mjs";
import { Jobs, } from "./jobs/jobs.mjs";
export class FineTuning extends APIResource {
    constructor() {
        super(...arguments);
        this.methods = new MethodsAPI.Methods(this._client);
        this.jobs = new JobsAPI.Jobs(this._client);
        this.checkpoints = new CheckpointsAPI.Checkpoints(this._client);
        this.alpha = new AlphaAPI.Alpha(this._client);
    }
}
FineTuning.Methods = Methods;
FineTuning.Jobs = Jobs;
FineTuning.Checkpoints = Checkpoints;
FineTuning.Alpha = Alpha;
//# sourceMappingURL=fine-tuning.mjs.map