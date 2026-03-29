// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as FileBatchesAPI from "./file-batches.mjs";
import { FileBatches, } from "./file-batches.mjs";
import * as FilesAPI from "./files.mjs";
import { Files, } from "./files.mjs";
import { CursorPage, Page } from "../../core/pagination.mjs";
import { buildHeaders } from "../../internal/headers.mjs";
import { path } from "../../internal/utils/path.mjs";
export class VectorStores extends APIResource {
    constructor() {
        super(...arguments);
        this.files = new FilesAPI.Files(this._client);
        this.fileBatches = new FileBatchesAPI.FileBatches(this._client);
    }
    /**
     * Create a vector store.
     */
    create(body, options) {
        return this._client.post('/vector_stores', {
            body,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Retrieves a vector store.
     */
    retrieve(vectorStoreID, options) {
        return this._client.get(path `/vector_stores/${vectorStoreID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Modifies a vector store.
     */
    update(vectorStoreID, body, options) {
        return this._client.post(path `/vector_stores/${vectorStoreID}`, {
            body,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Returns a list of vector stores.
     */
    list(query = {}, options) {
        return this._client.getAPIList('/vector_stores', (CursorPage), {
            query,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Delete a vector store.
     */
    delete(vectorStoreID, options) {
        return this._client.delete(path `/vector_stores/${vectorStoreID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Search a vector store for relevant chunks based on a query and file attributes
     * filter.
     */
    search(vectorStoreID, body, options) {
        return this._client.getAPIList(path `/vector_stores/${vectorStoreID}/search`, (Page), {
            body,
            method: 'post',
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
}
VectorStores.Files = Files;
VectorStores.FileBatches = FileBatches;
//# sourceMappingURL=vector-stores.mjs.map