// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as ContentAPI from './content';
import { Content, ContentRetrieveParams } from './content';
import { APIPromise } from '../../../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise } from '../../../core/pagination';
import { type Uploadable } from '../../../core/uploads';
import { buildHeaders } from '../../../internal/headers';
import { RequestOptions } from '../../../internal/request-options';
import { maybeMultipartFormRequestOptions } from '../../../internal/uploads';
import { path } from '../../../internal/utils/path';

export class Files extends APIResource {
  content: ContentAPI.Content = new ContentAPI.Content(this._client);

  /**
   * Create a Container File
   *
   * You can send either a multipart/form-data request with the raw file content, or
   * a JSON request with a file ID.
   */
  create(
    containerID: string,
    body: FileCreateParams,
    options?: RequestOptions,
  ): APIPromise<FileCreateResponse> {
    return this._client.post(
      path`/containers/${containerID}/files`,
      maybeMultipartFormRequestOptions({ body, ...options }, this._client),
    );
  }

  /**
   * Retrieve Container File
   */
  retrieve(
    fileID: string,
    params: FileRetrieveParams,
    options?: RequestOptions,
  ): APIPromise<FileRetrieveResponse> {
    const { container_id } = params;
    return this._client.get(path`/containers/${container_id}/files/${fileID}`, options);
  }

  /**
   * List Container files
   */
  list(
    containerID: string,
    query: FileListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<FileListResponsesPage, FileListResponse> {
    return this._client.getAPIList(path`/containers/${containerID}/files`, CursorPage<FileListResponse>, {
      query,
      ...options,
    });
  }

  /**
   * Delete Container File
   */
  delete(fileID: string, params: FileDeleteParams, options?: RequestOptions): APIPromise<void> {
    const { container_id } = params;
    return this._client.delete(path`/containers/${container_id}/files/${fileID}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
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

Files.Content = Content;

export declare namespace Files {
  export {
    type FileCreateResponse as FileCreateResponse,
    type FileRetrieveResponse as FileRetrieveResponse,
    type FileListResponse as FileListResponse,
    type FileListResponsesPage as FileListResponsesPage,
    type FileCreateParams as FileCreateParams,
    type FileRetrieveParams as FileRetrieveParams,
    type FileListParams as FileListParams,
    type FileDeleteParams as FileDeleteParams,
  };

  export { Content as Content, type ContentRetrieveParams as ContentRetrieveParams };
}
