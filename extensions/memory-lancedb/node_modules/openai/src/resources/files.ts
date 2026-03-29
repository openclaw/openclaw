// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise } from '../core/pagination';
import { type Uploadable } from '../core/uploads';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { sleep } from '../internal/utils/sleep';
import { APIConnectionTimeoutError } from '../error';
import { multipartFormRequestOptions } from '../internal/uploads';
import { path } from '../internal/utils/path';

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
  create(body: FileCreateParams, options?: RequestOptions): APIPromise<FileObject> {
    return this._client.post('/files', multipartFormRequestOptions({ body, ...options }, this._client));
  }

  /**
   * Returns information about a specific file.
   */
  retrieve(fileID: string, options?: RequestOptions): APIPromise<FileObject> {
    return this._client.get(path`/files/${fileID}`, options);
  }

  /**
   * Returns a list of files.
   */
  list(
    query: FileListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<FileObjectsPage, FileObject> {
    return this._client.getAPIList('/files', CursorPage<FileObject>, { query, ...options });
  }

  /**
   * Delete a file and remove it from all vector stores.
   */
  delete(fileID: string, options?: RequestOptions): APIPromise<FileDeleted> {
    return this._client.delete(path`/files/${fileID}`, options);
  }

  /**
   * Returns the contents of the specified file.
   */
  content(fileID: string, options?: RequestOptions): APIPromise<Response> {
    return this._client.get(path`/files/${fileID}/content`, {
      ...options,
      headers: buildHeaders([{ Accept: 'application/binary' }, options?.headers]),
      __binaryResponse: true,
    });
  }

  /**
   * Waits for the given file to be processed, default timeout is 30 mins.
   */
  async waitForProcessing(
    id: string,
    { pollInterval = 5000, maxWait = 30 * 60 * 1000 }: { pollInterval?: number; maxWait?: number } = {},
  ): Promise<FileObject> {
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

export type FileObjectsPage = CursorPage<FileObject>;

export type FileContent = string;

export interface FileDeleted {
  id: string;

  deleted: boolean;

  object: 'file';
}

/**
 * The `File` object represents a document that has been uploaded to OpenAI.
 */
export interface FileObject {
  /**
   * The file identifier, which can be referenced in the API endpoints.
   */
  id: string;

  /**
   * The size of the file, in bytes.
   */
  bytes: number;

  /**
   * The Unix timestamp (in seconds) for when the file was created.
   */
  created_at: number;

  /**
   * The name of the file.
   */
  filename: string;

  /**
   * The object type, which is always `file`.
   */
  object: 'file';

  /**
   * The intended purpose of the file. Supported values are `assistants`,
   * `assistants_output`, `batch`, `batch_output`, `fine-tune`, `fine-tune-results`,
   * `vision`, and `user_data`.
   */
  purpose:
    | 'assistants'
    | 'assistants_output'
    | 'batch'
    | 'batch_output'
    | 'fine-tune'
    | 'fine-tune-results'
    | 'vision'
    | 'user_data';

  /**
   * @deprecated Deprecated. The current status of the file, which can be either
   * `uploaded`, `processed`, or `error`.
   */
  status: 'uploaded' | 'processed' | 'error';

  /**
   * The Unix timestamp (in seconds) for when the file will expire.
   */
  expires_at?: number;

  /**
   * @deprecated Deprecated. For details on why a fine-tuning training file failed
   * validation, see the `error` field on `fine_tuning.job`.
   */
  status_details?: string;
}

/**
 * The intended purpose of the uploaded file. One of:
 *
 * - `assistants`: Used in the Assistants API
 * - `batch`: Used in the Batch API
 * - `fine-tune`: Used for fine-tuning
 * - `vision`: Images used for vision fine-tuning
 * - `user_data`: Flexible file type for any purpose
 * - `evals`: Used for eval data sets
 */
export type FilePurpose = 'assistants' | 'batch' | 'fine-tune' | 'vision' | 'user_data' | 'evals';

export interface FileCreateParams {
  /**
   * The File object (not file name) to be uploaded.
   */
  file: Uploadable;

  /**
   * The intended purpose of the uploaded file. One of:
   *
   * - `assistants`: Used in the Assistants API
   * - `batch`: Used in the Batch API
   * - `fine-tune`: Used for fine-tuning
   * - `vision`: Images used for vision fine-tuning
   * - `user_data`: Flexible file type for any purpose
   * - `evals`: Used for eval data sets
   */
  purpose: FilePurpose;

  /**
   * The expiration policy for a file. By default, files with `purpose=batch` expire
   * after 30 days and all other files are persisted until they are manually deleted.
   */
  expires_after?: FileCreateParams.ExpiresAfter;
}

export namespace FileCreateParams {
  /**
   * The expiration policy for a file. By default, files with `purpose=batch` expire
   * after 30 days and all other files are persisted until they are manually deleted.
   */
  export interface ExpiresAfter {
    /**
     * Anchor timestamp after which the expiration policy applies. Supported anchors:
     * `created_at`.
     */
    anchor: 'created_at';

    /**
     * The number of seconds after the anchor time that the file will expire. Must be
     * between 3600 (1 hour) and 2592000 (30 days).
     */
    seconds: number;
  }
}

export interface FileListParams extends CursorPageParams {
  /**
   * Sort order by the `created_at` timestamp of the objects. `asc` for ascending
   * order and `desc` for descending order.
   */
  order?: 'asc' | 'desc';

  /**
   * Only return files with the given purpose.
   */
  purpose?: string;
}

export declare namespace Files {
  export {
    type FileContent as FileContent,
    type FileDeleted as FileDeleted,
    type FileObject as FileObject,
    type FilePurpose as FilePurpose,
    type FileObjectsPage as FileObjectsPage,
    type FileCreateParams as FileCreateParams,
    type FileListParams as FileListParams,
  };
}
