// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import { CursorPage } from "../../core/pagination.mjs";
import { buildHeaders } from "../../internal/headers.mjs";
import { path } from "../../internal/utils/path.mjs";
/**
 * Build Assistants that can call models and use tools.
 */
export class Assistants extends APIResource {
    /**
     * Create an assistant with a model and instructions.
     *
     * @deprecated
     */
    create(body, options) {
        return this._client.post('/assistants', {
            body,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Retrieves an assistant.
     *
     * @deprecated
     */
    retrieve(assistantID, options) {
        return this._client.get(path `/assistants/${assistantID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Modifies an assistant.
     *
     * @deprecated
     */
    update(assistantID, body, options) {
        return this._client.post(path `/assistants/${assistantID}`, {
            body,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Returns a list of assistants.
     *
     * @deprecated
     */
    list(query = {}, options) {
        return this._client.getAPIList('/assistants', (CursorPage), {
            query,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Delete an assistant.
     *
     * @deprecated
     */
    delete(assistantID, options) {
        return this._client.delete(path `/assistants/${assistantID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
}
//# sourceMappingURL=assistants.mjs.map