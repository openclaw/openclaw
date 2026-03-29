"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Alpha = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const GradersAPI = tslib_1.__importStar(require("./graders.js"));
const graders_1 = require("./graders.js");
class Alpha extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.graders = new GradersAPI.Graders(this._client);
    }
}
exports.Alpha = Alpha;
Alpha.Graders = graders_1.Graders;
//# sourceMappingURL=alpha.js.map