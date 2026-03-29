// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import { CursorPage } from "../../core/pagination.mjs";
import { path } from "../../internal/utils/path.mjs";
export class InputItems extends APIResource {
    /**
     * Returns a list of input items for a given response.
     *
     * @example
     * ```ts
     * // Automatically fetches more pages as needed.
     * for await (const responseItem of client.responses.inputItems.list(
     *   'response_id',
     * )) {
     *   // ...
     * }
     * ```
     */
    list(responseID, query = {}, options) {
        return this._client.getAPIList(path `/responses/${responseID}/input_items`, (CursorPage), { query, ...options });
    }
}
//# sourceMappingURL=input-items.mjs.map