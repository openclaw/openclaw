"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Checkpoints = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const PermissionsAPI = tslib_1.__importStar(require("./permissions.js"));
const permissions_1 = require("./permissions.js");
class Checkpoints extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.permissions = new PermissionsAPI.Permissions(this._client);
    }
}
exports.Checkpoints = Checkpoints;
Checkpoints.Permissions = permissions_1.Permissions;
//# sourceMappingURL=checkpoints.js.map