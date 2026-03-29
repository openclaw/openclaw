// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../../../core/resource.mjs";
import { CursorPage } from "../../../../core/pagination.mjs";
import { buildHeaders } from "../../../../internal/headers.mjs";
import { path } from "../../../../internal/utils/path.mjs";
/**
 * Build Assistants that can call models and use tools.
 *
 * @deprecated The Assistants API is deprecated in favor of the Responses API
 */
export class Steps extends APIResource {
    /**
     * Retrieves a run step.
     *
     * @deprecated The Assistants API is deprecated in favor of the Responses API
     */
    retrieve(stepID, params, options) {
        const { thread_id, run_id, ...query } = params;
        return this._client.get(path `/threads/${thread_id}/runs/${run_id}/steps/${stepID}`, {
            query,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Returns a list of run steps belonging to a run.
     *
     * @deprecated The Assistants API is deprecated in favor of the Responses API
     */
    list(runID, params, options) {
        const { thread_id, ...query } = params;
        return this._client.getAPIList(path `/threads/${thread_id}/runs/${runID}/steps`, (CursorPage), {
            query,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
}
//# sourceMappingURL=steps.mjs.map