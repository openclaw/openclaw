// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import { CursorPage, Page } from "../../core/pagination.mjs";
import { buildHeaders } from "../../internal/headers.mjs";
import { sleep } from "../../internal/utils.mjs";
import { path } from "../../internal/utils/path.mjs";
export class Files extends APIResource {
    /**
     * Create a vector store file by attaching a
     * [File](https://platform.openai.com/docs/api-reference/files) to a
     * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object).
     */
    create(vectorStoreID, body, options) {
        return this._client.post(path `/vector_stores/${vectorStoreID}/files`, {
            body,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Retrieves a vector store file.
     */
    retrieve(fileID, params, options) {
        const { vector_store_id } = params;
        return this._client.get(path `/vector_stores/${vector_store_id}/files/${fileID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Update attributes on a vector store file.
     */
    update(fileID, params, options) {
        const { vector_store_id, ...body } = params;
        return this._client.post(path `/vector_stores/${vector_store_id}/files/${fileID}`, {
            body,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Returns a list of vector store files.
     */
    list(vectorStoreID, query = {}, options) {
        return this._client.getAPIList(path `/vector_stores/${vectorStoreID}/files`, (CursorPage), {
            query,
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Delete a vector store file. This will remove the file from the vector store but
     * the file itself will not be deleted. To delete the file, use the
     * [delete file](https://platform.openai.com/docs/api-reference/files/delete)
     * endpoint.
     */
    delete(fileID, params, options) {
        const { vector_store_id } = params;
        return this._client.delete(path `/vector_stores/${vector_store_id}/files/${fileID}`, {
            ...options,
            headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
        });
    }
    /**
     * Attach a file to the given vector store and wait for it to be processed.
     */
    async createAndPoll(vectorStoreId, body, options) {
        const file = await this.create(vectorStoreId, body, options);
        return await this.poll(vectorStoreId, file.id, options);
    }
    /**
     * Wait for the vector store file to finish processing.
     *
     * Note: this will return even if the file failed to process, you need to check
     * file.last_error and file.status to handle these cases
     */
    async poll(vectorStoreID, fileID, options) {
        const headers = buildHeaders([
            options?.headers,
            {
                'X-Stainless-Poll-Helper': 'true',
                'X-Stainless-Custom-Poll-Interval': options?.pollIntervalMs?.toString() ?? undefined,
            },
        ]);
        while (true) {
            const fileResponse = await this.retrieve(fileID, {
                vector_store_id: vectorStoreID,
            }, { ...options, headers }).withResponse();
            const file = fileResponse.data;
            switch (file.status) {
                case 'in_progress':
                    let sleepInterval = 5000;
                    if (options?.pollIntervalMs) {
                        sleepInterval = options.pollIntervalMs;
                    }
                    else {
                        const headerInterval = fileResponse.response.headers.get('openai-poll-after-ms');
                        if (headerInterval) {
                            const headerIntervalMs = parseInt(headerInterval);
                            if (!isNaN(headerIntervalMs)) {
                                sleepInterval = headerIntervalMs;
                            }
                        }
                    }
                    await sleep(sleepInterval);
                    break;
                case 'failed':
                case 'completed':
                    return file;
            }
        }
    }
    /**
     * Upload a file to the `files` API and then attach it to the given vector store.
     *
     * Note the file will be asynchronously processed (you can use the alternative
     * polling helper method to wait for processing to complete).
     */
    async upload(vectorStoreId, file, options) {
        const fileInfo = await this._client.files.create({ file: file, purpose: 'assistants' }, options);
        return this.create(vectorStoreId, { file_id: fileInfo.id }, options);
    }
    /**
     * Add a file to a vector store and poll until processing is complete.
     */
    async uploadAndPoll(vectorStoreId, file, options) {
        const fileInfo = await this.upload(vectorStoreId, file, options);
        return await this.poll(vectorStoreId, fileInfo.id, options);
    }
    /**
     * Retrieve the parsed contents of a vector store file.
     */
    content(fileID, params, options) {
        const { vector_store_id } = params;
        return this._client.getAPIList(path `/vector_stores/${vector_store_id}/files/${fileID}/content`, (Page), { ...options, headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]) });
    }
}
//# sourceMappingURL=files.mjs.map