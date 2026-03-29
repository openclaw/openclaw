// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../../core/resource.mjs";
import { CursorPage } from "../../../core/pagination.mjs";
import { path } from "../../../internal/utils/path.mjs";
/**
 * Manage fine-tuning jobs to tailor a model to your specific training data.
 */
export class Checkpoints extends APIResource {
    /**
     * List checkpoints for a fine-tuning job.
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const fineTuningJobCheckpoint of client.fineTuning.jobs.checkpoints.list(
     *   'ft-AF1WoRqd3aJAHsqc9NY7iL8F',
     * )) {
     *   // ...
     * }
     * ```
     */
    list(fineTuningJobID, query = {}, options) {
        return this._client.getAPIList(path `/fine_tuning/jobs/${fineTuningJobID}/checkpoints`, (CursorPage), { query, ...options });
    }
}
//# sourceMappingURL=checkpoints.mjs.map