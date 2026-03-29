"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Moderations = void 0;
const resource_1 = require("../core/resource.js");
/**
 * Given text and/or image inputs, classifies if those inputs are potentially harmful.
 */
class Moderations extends resource_1.APIResource {
    /**
     * Classifies if text and/or image inputs are potentially harmful. Learn more in
     * the [moderation guide](https://platform.openai.com/docs/guides/moderation).
     */
    create(body, options) {
        return this._client.post('/moderations', { body, ...options });
    }
}
exports.Moderations = Moderations;
//# sourceMappingURL=moderations.js.map