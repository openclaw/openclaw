"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Chat = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const CompletionsAPI = tslib_1.__importStar(require("./completions/completions.js"));
const completions_1 = require("./completions/completions.js");
class Chat extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.completions = new CompletionsAPI.Completions(this._client);
    }
}
exports.Chat = Chat;
Chat.Completions = completions_1.Completions;
//# sourceMappingURL=chat.js.map