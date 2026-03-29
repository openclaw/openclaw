// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../core/resource.mjs";
import { CursorPage } from "../core/pagination.mjs";
import { buildHeaders } from "../internal/headers.mjs";
import { sleep } from "../internal/utils/sleep.mjs";
import { APIConnectionTimeoutError } from "../error.mjs";
import { multipartFormRequestOptions } from "../internal/uploads.mjs";
import { path } from "../internal/utils/path.mjs";
/**
 * Files are used to upload documents that can be used with features like Assistants and Fine-tuning.
 */
export class Files extends APIResource {
    /**
     * Upload a file that can be used across various endpoints. Individual files can be
     * up to 512 MB, and each project can store up to 2.5 TB of files in total. There
     * is no organization-wide storage limit.
     *
     * - The Assistants API supports files up to 2 million tokens and of specific file
     *   types. See the
     *   [Assistants Tools guide](https://platform.openai.com/docs/assistants/tools)
     *   for details.
     * - The Fine-tuning API only supports `.jsonl` files. The input also has certain
     *   required formats for fine-tuning
     *   [chat](https://platform.openai.com/docs/api-reference/fine-tuning/chat-input)
     *   or
     *   [completions](https://platform.openai.com/docs/api-reference/fine-tuning/completions-input)
     *   models.
     * - The Batch API only supports `.jsonl` files up to 200 MB in size. The input
     *   also has a specific required
     *   [format](https://platform.openai.com/docs/api-reference/batch/request-input).
     *
     * Please [contact us](https://help.openai.com/) if you need to increase these
     * storage limits.
     */
    create(body, options) {
        return this._client.post('/files', multipartFormRequestOptions({ body, ...options }, this._client));
    }
    /**
     * Returns information about a specific file.
     */
    retrieve(fileID, options) {
        return this._client.get(path `/files/${fileID}`, options);
    }
    /**
     * Returns a list of files.
     */
    list(query = {}, options) {
        return this._client.getAPIList('/files', (CursorPage), { query, ...options });
    }
    /**
     * Delete a file and remove it from all vector stores.
     */
    delete(fileID, options) {
        return this._client.delete(path `/files/${fileID}`, options);
    }
    /**
     * Returns the contents of the specified file.
     */
    content(fileID, options) {
        return this._client.get(path `/files/${fileID}/content`, {
            ...options,
            headers: buildHeaders([{ Accept: 'application/binary' }, options?.headers]),
            __binaryResponse: true,
        });
    }
    /**
     * Waits for the given file to be processed, default timeout is 30 mins.
     */
    async waitForProcessing(id, { pollInterval = 5000, maxWait = 30 * 60 * 1000 } = {}) {
        const TERMINAL_STATES = new Set(['processed', 'error', 'deleted']);
        const start = Date.now();
        let file = await this.retrieve(id);
        while (!file.status || !TERMINAL_STATES.has(file.status)) {
            await sleep(pollInterval);
            file = await this.retrieve(id);
            if (Date.now() - start > maxWait) {
                throw new APIConnectionTimeoutError({
                    message: `Giving up on waiting for file ${id} to finish processing after ${maxWait} milliseconds.`,
                });
            }
        }
        return file;
    }
}
//# sourceMappingURL=files.mjs.map