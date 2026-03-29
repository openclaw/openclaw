// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as GraderModelsAPI from "./grader-models.mjs";
import { GraderModels, } from "./grader-models.mjs";
export class Graders extends APIResource {
    constructor() {
        super(...arguments);
        this.graderModels = new GraderModelsAPI.GraderModels(this._client);
    }
}
Graders.GraderModels = GraderModels;
//# sourceMappingURL=graders.mjs.map