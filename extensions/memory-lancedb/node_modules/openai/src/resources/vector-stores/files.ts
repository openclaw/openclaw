// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as VectorStoresAPI from './vector-stores';
import { APIPromise } from '../../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise, Page } from '../../core/pagination';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { sleep } from '../../internal/utils';
import { Uploadable } from '../../uploads';
import { path } from '../../internal/utils/path';

export class Files extends APIResource {
  /**
   * Create a vector store file by attaching a
   * [File](https://platform.openai.com/docs/api-reference/files) to a
   * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object).
   */
  create(
    vectorStoreID: string,
    body: FileCreateParams,
    options?: RequestOptions,
  ): APIPromise<VectorStoreFile> {
    return this._client.post(path`/vector_stores/${vectorStoreID}/files`, {
      body,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Retrieves a vector store file.
   */
  retrieve(
    fileID: string,
    params: FileRetrieveParams,
    options?: RequestOptions,
  ): APIPromise<VectorStoreFile> {
    const { vector_store_id } = params;
    return this._client.get(path`/vector_stores/${vector_store_id}/files/${fileID}`, {
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Update attributes on a vector store file.
   */
  update(fileID: string, params: FileUpdateParams, options?: RequestOptions): APIPromise<VectorStoreFile> {
    const { vector_store_id, ...body } = params;
    return this._client.post(path`/vector_stores/${vector_store_id}/files/${fileID}`, {
      body,
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Returns a list of vector store files.
   */
  list(
    vectorStoreID: string,
    query: FileListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<VectorStoreFilesPage, VectorStoreFile> {
    return this._client.getAPIList(path`/vector_stores/${vectorStoreID}/files`, CursorPage<VectorStoreFile>, {
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
  delete(
    fileID: string,
    params: FileDeleteParams,
    options?: RequestOptions,
  ): APIPromise<VectorStoreFileDeleted> {
    const { vector_store_id } = params;
    return this._client.delete(path`/vector_stores/${vector_store_id}/files/${fileID}`, {
      ...options,
      headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]),
    });
  }

  /**
   * Attach a file to the given vector store and wait for it to be processed.
   */
  async createAndPoll(
    vectorStoreId: string,
    body: FileCreateParams,
    options?: RequestOptions & { pollIntervalMs?: number },
  ): Promise<VectorStoreFile> {
    const file = await this.create(vectorStoreId, body, options);
    return await this.poll(vectorStoreId, file.id, options);
  }
  /**
   * Wait for the vector store file to finish processing.
   *
   * Note: this will return even if the file failed to process, you need to check
   * file.last_error and file.status to handle these cases
   */
  async poll(
    vectorStoreID: string,
    fileID: string,
    options?: RequestOptions & { pollIntervalMs?: number },
  ): Promise<VectorStoreFile> {
    const headers = buildHeaders([
      options?.headers,
      {
        'X-Stainless-Poll-Helper': 'true',
        'X-Stainless-Custom-Poll-Interval': options?.pollIntervalMs?.toString() ?? undefined,
      },
    ]);

    while (true) {
      const fileResponse = await this.retrieve(
        fileID,
        {
          vector_store_id: vectorStoreID,
        },
        { ...options, headers },
      ).withResponse();

      const file = fileResponse.data;

      switch (file.status) {
        case 'in_progress':
          let sleepInterval = 5000;

          if (options?.pollIntervalMs) {
            sleepInterval = options.pollIntervalMs;
          } else {
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
  async upload(vectorStoreId: string, file: Uploadable, options?: RequestOptions): Promise<VectorStoreFile> {
    const fileInfo = await this._client.files.create({ file: file, purpose: 'assistants' }, options);
    return this.create(vectorStoreId, { file_id: fileInfo.id }, options);
  }
  /**
   * Add a file to a vector store and poll until processing is complete.
   */
  async uploadAndPoll(
    vectorStoreId: string,
    file: Uploadable,
    options?: RequestOptions & { pollIntervalMs?: number },
  ): Promise<VectorStoreFile> {
    const fileInfo = await this.upload(vectorStoreId, file, options);
    return await this.poll(vectorStoreId, fileInfo.id, options);
  }

  /**
   * Retrieve the parsed contents of a vector store file.
   */
  content(
    fileID: string,
    params: FileContentParams,
    options?: RequestOptions,
  ): PagePromise<FileContentResponsesPage, FileContentResponse> {
    const { vector_store_id } = params;
    return this._client.getAPIList(
      path`/vector_stores/${vector_store_id}/files/${fileID}/content`,
      Page<FileContentResponse>,
      { ...options, headers: buildHeaders([{ 'OpenAI-Beta': 'assistants=v2' }, options?.headers]) },
    );
  }
}

export type VectorStoreFilesPage = CursorPage<VectorStoreFile>;

// Note: no pagination actually occurs yet, this is for forwards-compatibility.
export type FileContentResponsesPage = Page<FileContentResponse>;

/**
 * A list of files attached to a vector store.
 */
export interface VectorStoreFile {
  /**
   * The identifier, which can be referenced in API endpoints.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the vector store file was created.
   */
  created_at: number;

  /**
   * The last error associated with this vector store file. Will be `null` if there
   * are no errors.
   */
  last_error: VectorStoreFile.LastError | null;

  /**
   * The object type, which is always `vector_store.file`.
   */
  object: 'vector_store.file';

  /**
   * The status of the vector store file, which can be either `in_progress`,
   * `completed`, `cancelled`, or `failed`. The status `completed` indicates that the
   * vector store file is ready for use.
   */
  status: 'in_progress' | 'completed' | 'cancelled' | 'failed';

  /**
   * The total vector store usage in bytes. Note that this may be different from the
   * original file size.
   */
  usage_bytes: number;

  /**
   * The ID of the
   * [vector store](https://platform.openai.com/docs/api-reference/vector-stores/object)
   * that the [File](https://platform.openai.com/docs/api-reference/files) is
   * attached to.
   */
  vector_store_id: string;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard. Keys are strings with a maximum
   * length of 64 characters. Values are strings with a maximum length of 512
   * characters, booleans, or numbers.
   */
  attributes?: { [key: string]: string | number | boolean } | null;

  /**
   * The strategy used to chunk the file.
   */
  chunking_strategy?: VectorStoresAPI.FileChunkingStrategy;
}

export namespace VectorStoreFile {
  /**
   * The last error associated with this vector store file. Will be `null` if there
   * are no errors.
   */
  export interface LastError {
    /**
     * One of `server_error`, `unsupported_file`, or `invalid_file`.
     */
    code: 'server_error' | 'unsupported_file' | 'invalid_file';

    /**
     * A human-readable description of the error.
     */
    message: string;
  }
}

export interface VectorStoreFileDeleted {
  id: string;

  deleted: boolean;

  object: 'vector_store.file.deleted';
}

export interface FileContentResponse {
  /**
   * The text content
   */
  text?: string;

  /**
   * The content type (currently only `"text"`)
   */
  type?: string;
}

export interface FileCreateParams {
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
  attributes?: { [key: string]: string | number | boolean } | null;

  /**
   * The chunking strategy used to chunk the file(s). If not set, will use the `auto`
   * strategy. Only applicable if `file_ids` is non-empty.
   */
  chunking_strategy?: VectorStoresAPI.FileChunkingStrategyParam;
}

export interface FileRetrieveParams {
  /**
   * The ID of the vector store that the file belongs to.
   */
  vector_store_id: string;
}

export interface FileUpdateParams {
  /**
   * Path param: The ID of the vector store the file belongs to.
   */
  vector_store_id: string;

  /**
   * Body param: Set of 16 key-value pairs that can be attached to an object. This
   * can be useful for storing additional information about the object in a
   * structured format, and querying for objects via API or the dashboard. Keys are
   * strings with a maximum length of 64 characters. Values are strings with a
   * maximum length of 512 characters, booleans, or numbers.
   */
  attributes: { [key: string]: string | number | boolean } | null;
}

export interface FileListParams extends CursorPageParams {
  /**
   * A cursor for use in pagination. `before` is an object ID that defines your place
   * in the list. For instance, if you make a list request and receive 100 objects,
   * starting with obj_foo, your subsequent call can include before=obj_foo in order
   * to fetch the previous page of the list.
   */
  before?: string;

  /**
   * Filter by file status. One of `in_progress`, `completed`, `failed`, `cancelled`.
   */
  filter?: 'in_progress' | 'completed' | 'failed' | 'cancelled';

  /**
   * Sort order by the `created_at` timestamp of the objects. `asc` for ascending
   * order and `desc` for descending order.
   */
  order?: 'asc' | 'desc';
}

export interface FileDeleteParams {
  /**
   * The ID of the vector store that the file belongs to.
   */
  vector_store_id: string;
}

export interface FileContentParams {
  /**
   * The ID of the vector store.
   */
  vector_store_id: string;
}

export declare namespace Files {
  export {
    type VectorStoreFile as VectorStoreFile,
    type VectorStoreFileDeleted as VectorStoreFileDeleted,
    type FileContentResponse as FileContentResponse,
    type VectorStoreFilesPage as VectorStoreFilesPage,
    type FileContentResponsesPage as FileContentResponsesPage,
    type FileCreateParams as FileCreateParams,
    type FileRetrieveParams as FileRetrieveParams,
    type FileUpdateParams as FileUpdateParams,
    type FileListParams as FileListParams,
    type FileDeleteParams as FileDeleteParams,
    type FileContentParams as FileContentParams,
  };
}
