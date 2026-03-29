"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Completions = void 0;
const resource_1 = require("../core/resource.js");
/**
 * Given a prompt, the model will return one or more predicted completions, and can also return the probabilities of alternative tokens at each position.
 */
class Completions extends resource_1.APIResource {
    create(body, options) {
        return this._client.post('/completions', { body, ...options, stream: body.stream ?? false });
    }
}
exports.Completions = Completions;
//# sourceMappingURL=completions.js.map