import { APIResource } from "../../../core/resource.js";
import * as ContentAPI from "./content.js";
import { Content, ContentRetrieveParams } from "./content.js";
import { APIPromise } from "../../../core/api-promise.js";
import { CursorPage, type CursorPageParams, PagePromise } from "../../../core/pagination.js";
import { type Uploadable } from "../../../core/uploads.js";
import { RequestOptions } from "../../../internal/request-options.js";
export declare class Files extends APIResource {
    content: ContentAPI.Content;
    /**
     * Create a Container File
     *
     * You can send either a multipart/form-data request with the raw file content, or
     * a JSON request with a file ID.
     */
    create(containerID: string, body: FileCreateParams, options?: RequestOptions): APIPromise<FileCreateResponse>;
    /**
     * Retrieve Container File
     */
    retrieve(fileID: string, params: FileRetrieveParams, options?: RequestOptions): APIPromise<FileRetrieveResponse>;
    /**
     * List Container files
     */
    list(containerID: string, query?: FileListParams | null | undefined, options?: RequestOptions): PagePromise<FileListResponsesPage, FileListResponse>;
    /**
     * Delete Container File
     */
    delete(fileID: string, params: FileDeleteParams, options?: RequestOptions): APIPromise<void>;
}
export type FileListResponsesPage = CursorPage<FileListResponse>;
export interface FileCreateResponse {
    /**
     * Unique identifier for the file.
     */
    id: string;
    /**
     * Size of the file in bytes.
     */
    bytes: number;
    /**
     * The container this file belongs to.
     */
    container_id: string;
    /**
     * Unix timestamp (in seconds) when the file was created.
     */
    created_at: number;
    /**
     * The type of this object (`container.file`).
     */
    object: 'container.file';
    /**
     * Path of the file in the container.
     */
    path: string;
    /**
     * Source of the file (e.g., `user`, `assistant`).
     */
    source: string;
}
export interface FileRetrieveResponse {
    /**
     * Unique identifier for the file.
     */
    id: string;
    /**
     * Size of the file in bytes.
     */
    bytes: number;
    /**
     * The container this file belongs to.
     */
    container_id: string;
    /**
     * Unix timestamp (in seconds) when the file was created.
     */
    created_at: number;
    /**
     * The type of this object (`container.file`).
     */
    object: 'container.file';
    /**
     * Path of the file in the container.
     */
    path: string;
    /**
     * Source of the file (e.g., `user`, `assistant`).
     */
    source: string;
}
export interface FileListResponse {
    /**
     * Unique identifier for the file.
     */
    id: string;
    /**
     * Size of the file in bytes.
     */
    bytes: number;
    /**
     * The container this file belongs to.
     */
    container_id: string;
    /**
     * Unix timestamp (in seconds) when the file was created.
     */
    created_at: number;
    /**
     * The type of this object (`container.file`).
     */
    object: 'container.file';
    /**
     * Path of the file in the container.
     */
    path: string;
    /**
     * Source of the file (e.g., `user`, `assistant`).
     */
    source: string;
}
export interface FileCreateParams {
    /**
     * The File object (not file name) to be uploaded.
     */
    file?: Uploadable;
    /**
     * Name of the file to create.
     */
    file_id?: string;
}
export interface FileRetrieveParams {
    container_id: string;
}
export interface FileListParams extends CursorPageParams {
    /**
     * Sort order by the `created_at` timestamp of the objects. `asc` for ascending
     * order and `desc` for descending order.
     */
    order?: 'asc' | 'desc';
}
export interface FileDeleteParams {
    container_id: string;
}
export declare namespace Files {
    export { type FileCreateResponse as FileCreateResponse, type FileRetrieveResponse as FileRetrieveResponse, type FileListResponse as FileListResponse, type FileListResponsesPage as FileListResponsesPage, type FileCreateParams as FileCreateParams, type FileRetrieveParams as FileRetrieveParams, type FileListParams as FileListParams, type FileDeleteParams as FileDeleteParams, };
    export { Content as Content, type ContentRetrieveParams as ContentRetrieveParams };
}
//# sourceMappingURL=files.d.ts.map