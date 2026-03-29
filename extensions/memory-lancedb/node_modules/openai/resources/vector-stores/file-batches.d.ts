import { APIResource } from "../../core/resource.js";
import * as FilesAPI from "./files.js";
import { VectorStoreFilesPage } from "./files.js";
import * as VectorStoresAPI from "./vector-stores.js";
import { APIPromise } from "../../core/api-promise.js";
import { type CursorPageParams, PagePromise } from "../../core/pagination.js";
import { RequestOptions } from "../../internal/request-options.js";
import { type Uploadable } from "../../uploads.js";
export declare class FileBatches extends APIResource {
    /**
     * Create a vector store file batch.
     */
    create(vectorStoreID: string, body: FileBatchCreateParams, options?: RequestOptions): APIPromise<VectorStoreFileBatch>;
    /**
     * Retrieves a vector store file batch.
     */
    retrieve(batchID: string, params: FileBatchRetrieveParams, options?: RequestOptions): APIPromise<VectorStoreFileBatch>;
    /**
     * Cancel a vector store file batch. This attempts to cancel the processing of
     * files in this batch as soon as possible.
     */
    cancel(batchID: string, params: FileBatchCancelParams, options?: RequestOptions): APIPromise<VectorStoreFileBatch>;
    /**
     * Create a vector store batch and poll until all files have been processed.
     */
    createAndPoll(vectorStoreId: string, body: FileBatchCreateParams, options?: RequestOptions & {
        pollIntervalMs?: number;
    }): Promise<VectorStoreFileBatch>;
    /**
     * Returns a list of vector store files in a batch.
     */
    listFiles(batchID: string, params: FileBatchListFilesParams, options?: RequestOptions): PagePromise<VectorStoreFilesPage, FilesAPI.VectorStoreFile>;
    /**
     * Wait for the given file batch to be processed.
     *
     * Note: this will return even if one of the files failed to process, you need to
     * check batch.file_counts.failed_count to handle this case.
     */
    poll(vectorStoreID: string, batchID: string, options?: RequestOptions & {
        pollIntervalMs?: number;
    }): Promise<VectorStoreFileBatch>;
    /**
     * Uploads the given files concurrently and then creates a vector store file batch.
     *
     * The concurrency limit is configurable using the `maxConcurrency` parameter.
     */
    uploadAndPoll(vectorStoreId: string, { files, fileIds }: {
        files: Uploadable[];
        fileIds?: string[];
    }, options?: RequestOptions & {
        pollIntervalMs?: number;
        maxConcurrency?: number;
    }): Promise<VectorStoreFileBatch>;
}
/**
 * A batch of files attached to a vector store.
 */
export interface VectorStoreFileBatch {
    /**
     * The identifier, which can be referenced in API endpoints.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) for when the vector store files batch was
     * created.
     */
    created_at: number;
    file_counts: VectorStoreFileBatch.FileCounts;
    /**
     * The object type, which is always `vector_store.file_batch`.
     */
    object: 'vector_store.files_batch';
    /**
     * The status of the vector store files batch, which can be either `in_progress`,
     * `completed`, `cancelled` or `failed`.
     */
    status: 'in_progress' | 'completed' | 'cancelled' | 'failed';
    /**
     * The ID of the
     * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object)
     * that the [File](https://platform.openai.com/docs/api-reference/files) is
     * attached to.
     */
    vector_store_id: string;
}
export declare namespace VectorStoreFileBatch {
    interface FileCounts {
        /**
         * The number of files that where cancelled.
         */
        cancelled: number;
        /**
         * The number of files that have been processed.
         */
        completed: number;
        /**
         * The number of files that have failed to process.
         */
        failed: number;
        /**
         * The number of files that are currently being processed.
         */
        in_progress: number;
        /**
         * The total number of files.
         */
        total: number;
    }
}
export interface FileBatchCreateParams {
    /**
     * Set of 16 key-value pairs that can be attached to an object. This can be useful
     * for storing additional information about the object in a structured format, and
     * querying for objects via API or the dashboard. Keys are strings with a maximum
     * length of 64 characters. Values are strings with a maximum length of 512
     * characters, booleans, or numbers.
     */
    attributes?: {
        [key: string]: string | number | boolean;
    } | null;
    /**
     * The chunking strategy used to chunk the file(s). If not set, will use the `auto`
     * strategy. Only applicable if `file_ids` is non-empty.
     */
    chunking_strategy?: VectorStoresAPI.FileChunkingStrategyParam;
    /**
     * A list of [File](https://platform.openai.com/docs/api-reference/files) IDs that
     * the vector store should use. Useful for tools like `file_search` that can access
     * files. If `attributes` or `chunking_strategy` are provided, they will be applied
     * to all files in the batch. The maximum batch size is 2000 files. Mutually
     * exclusive with `files`.
     */
    file_ids?: Array<string>;
    /**
     * A list of objects that each include a `file_id` plus optional `attributes` or
     * `chunking_strategy`. Use this when you need to override metadata for specific
     * files. The global `attributes` or `chunking_strategy` will be ignored and must
     * be specified for each file. The maximum batch size is 2000 files. Mutually
     * exclusive with `file_ids`.
     */
    files?: Array<FileBatchCreateParams.File>;
}
export declare namespace FileBatchCreateParams {
    interface File {
        /**
         * A [File](https://platform.openai.com/docs/api-reference/files) ID that the
         * vector store should use. Useful for tools like `file_search` that can access
         * files.
         */
        file_id: string;
        /**
         * Set of 16 key-value pairs that can be attached to an object. This can be useful
         * for storing additional information about the object in a structured format, and
         * querying for objects via API or the dashboard. Keys are strings with a maximum
         * length of 64 characters. Values are strings with a maximum length of 512
         * characters, booleans, or numbers.
         */
        attributes?: {
            [key: string]: string | number | boolean;
        } | null;
        /**
         * The chunking strategy used to chunk the file(s). If not set, will use the `auto`
         * strategy. Only applicable if `file_ids` is non-empty.
         */
        chunking_strategy?: VectorStoresAPI.FileChunkingStrategyParam;
    }
}
export interface FileBatchRetrieveParams {
    /**
     * The ID of the vector store that the file batch belongs to.
     */
    vector_store_id: string;
}
export interface FileBatchCancelParams {
    /**
     * The ID of the vector store that the file batch belongs to.
     */
    vector_store_id: string;
}
export interface FileBatchListFilesParams extends CursorPageParams {
    /**
     * Path param: The ID of the vector store that the files belong to.
     */
    vector_store_id: string;
    /**
     * Query param: A cursor for use in pagination. `before` is an object ID that
     * defines your place in the list. For instance, if you make a list request and
     * receive 100 objects, starting with obj_foo, your subsequent call can include
     * before=obj_foo in order to fetch the previous page of the list.
     */
    before?: string;
    /**
     * Query param: Filter by file status. One of `in_progress`, `completed`, `failed`,
     * `cancelled`.
     */
    filter?: 'in_progress' | 'completed' | 'failed' | 'cancelled';
    /**
     * Query param: Sort order by the `created_at` timestamp of the objects. `asc` for
     * ascending order and `desc` for descending order.
     */
    order?: 'asc' | 'desc';
}
export declare namespace FileBatches {
    export { type VectorStoreFileBatch as VectorStoreFileBatch, type FileBatchCreateParams as FileBatchCreateParams, type FileBatchRetrieveParams as FileBatchRetrieveParams, type FileBatchCancelParams as FileBatchCancelParams, type FileBatchListFilesParams as FileBatchListFilesParams, };
}
export { type VectorStoreFilesPage };
//# sourceMappingURL=file-batches.d.ts.map