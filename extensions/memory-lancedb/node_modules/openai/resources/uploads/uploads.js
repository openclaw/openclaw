"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Uploads = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const PartsAPI = tslib_1.__importStar(require("./parts.js"));
const parts_1 = require("./parts.js");
const path_1 = require("../../internal/utils/path.js");
/**
 * Use Uploads to upload large files in multiple parts.
 */
class Uploads extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.parts = new PartsAPI.Parts(this._client);
    }
    /**
     * Creates an intermediate
     * [Upload](https://platform.openai.com/docs/api-reference/uploads/object) object
     * that you can add
     * [Parts](https://platform.openai.com/docs/api-reference/uploads/part-object) to.
     * Currently, an Upload can accept at most 8 GB in total and expires after an hour
     * after you create it.
     *
     * Once you complete the Upload, we will create a
     * [File](https://platform.openai.com/docs/api-reference/files/object) object that
     * contains all the parts you uploaded. This File is usable in the rest of our
     * platform as a regular File object.
     *
     * For certain `purpose` values, the correct `mime_type` must be specified. Please
     * refer to documentation for the
     * [supported MIME types for your use case](https://platform.openai.com/docs/assistants/tools/file-search#supported-files).
     *
     * For guidance on the proper filename extensions for each purpose, please follow
     * the documentation on
     * [creating a File](https://platform.openai.com/docs/api-reference/files/create).
     *
     * Returns the Upload object with status `pending`.
     */
    create(body, options) {
        return this._client.post('/uploads', { body, ...options });
    }
    /**
     * Cancels the Upload. No Parts may be added after an Upload is cancelled.
     *
     * Returns the Upload object with status `cancelled`.
     */
    cancel(uploadID, options) {
        return this._client.post((0, path_1.path) `/uploads/${uploadID}/cancel`, options);
    }
    /**
     * Completes the
     * [Upload](https://platform.openai.com/docs/api-reference/uploads/object).
     *
     * Within the returned Upload object, there is a nested
     * [File](https://platform.openai.com/docs/api-reference/files/object) object that
     * is ready to use in the rest of the platform.
     *
     * You can specify the order of the Parts by passing in an ordered list of the Part
     * IDs.
     *
     * The number of bytes uploaded upon completion must match the number of bytes
     * initially specified when creating the Upload object. No Parts may be added after
     * an Upload is completed. Returns the Upload object with status `completed`,
     * including an additional `file` property containing the created usable File
     * object.
     */
    complete(uploadID, body, options) {
        return this._client.post((0, path_1.path) `/uploads/${uploadID}/complete`, { body, ...options });
    }
}
exports.Uploads = Uploads;
Uploads.Parts = parts_1.Parts;
//# sourceMappingURL=uploads.js.map