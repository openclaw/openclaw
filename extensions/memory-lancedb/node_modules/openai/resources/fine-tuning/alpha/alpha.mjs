// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../../core/resource.mjs";
import * as GradersAPI from "./graders.mjs";
import { Graders, } from "./graders.mjs";
export class Alpha extends APIResource {
    constructor() {
        super(...arguments);
        this.graders = new GradersAPI.Graders(this._client);
    }
}
Alpha.Graders = Graders;
//# sourceMappingURL=alpha.mjs.map