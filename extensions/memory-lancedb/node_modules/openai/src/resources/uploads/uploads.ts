// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as FilesAPI from '../files';
import * as PartsAPI from './parts';
import { PartCreateParams, Parts, UploadPart } from './parts';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

/**
 * Use Uploads to upload large files in multiple parts.
 */
export class Uploads extends APIResource {
  parts: PartsAPI.Parts = new PartsAPI.Parts(this._client);

  /**
   * Creates an intermediate
   * [Upload](https://platform.openai.com/docs/api-reference/uploads/object) object
   * that you can add
   * [Parts](https://platform.openai.com/docs/api-reference/uploads/part-object) to.
   * Currently, an Upload can accept at most 8 GB in total and expires after an hour
   * after you create it.
   *
   * Once you complete the Upload, we will create a
   * [File](https://platform.openai.com/docs/api-reference/files/object) object that
   * contains all the parts you uploaded. This File is usable in the rest of our
   * platform as a regular File object.
   *
   * For certain `purpose` values, the correct `mime_type` must be specified. Please
   * refer to documentation for the
   * [supported MIME types for your use case](https://platform.openai.com/docs/assistants/tools/file-search#supported-files).
   *
   * For guidance on the proper filename extensions for each purpose, please follow
   * the documentation on
   * [creating a File](https://platform.openai.com/docs/api-reference/files/create).
   *
   * Returns the Upload object with status `pending`.
   */
  create(body: UploadCreateParams, options?: RequestOptions): APIPromise<Upload> {
    return this._client.post('/uploads', { body, ...options });
  }

  /**
   * Cancels the Upload. No Parts may be added after an Upload is cancelled.
   *
   * Returns the Upload object with status `cancelled`.
   */
  cancel(uploadID: string, options?: RequestOptions): APIPromise<Upload> {
    return this._client.post(path`/uploads/${uploadID}/cancel`, options);
  }

  /**
   * Completes the
   * [Upload](https://platform.openai.com/docs/api-reference/uploads/object).
   *
   * Within the returned Upload object, there is a nested
   * [File](https://platform.openai.com/docs/api-reference/files/object) object that
   * is ready to use in the rest of the platform.
   *
   * You can specify the order of the Parts by passing in an ordered list of the Part
   * IDs.
   *
   * The number of bytes uploaded upon completion must match the number of bytes
   * initially specified when creating the Upload object. No Parts may be added after
   * an Upload is completed. Returns the Upload object with status `completed`,
   * including an additional `file` property containing the created usable File
   * object.
   */
  complete(uploadID: string, body: UploadCompleteParams, options?: RequestOptions): APIPromise<Upload> {
    return this._client.post(path`/uploads/${uploadID}/complete`, { body, ...options });
  }
}

/**
 * The Upload object can accept byte chunks in the form of Parts.
 */
export interface Upload {
  /**
   * The Upload unique identifier, which can be referenced in API endpoints.
   */
  id: string;

  /**
   * The intended number of bytes to be uploaded.
   */
  bytes: number;

  /**
   * The Unix timestamp (in seconds) for when the Upload was created.
   */
  created_at: number;

  /**
   * The Unix timestamp (in seconds) for when the Upload will expire.
   */
  expires_at: number;

  /**
   * The name of the file to be uploaded.
   */
  filename: string;

  /**
   * The object type, which is always "upload".
   */
  object: 'upload';

  /**
   * The intended purpose of the file.
   * [Please refer here](https://platform.openai.com/docs/api-reference/files/object#files/object-purpose)
   * for acceptable values.
   */
  purpose: string;

  /**
   * The status of the Upload.
   */
  status: 'pending' | 'completed' | 'cancelled' | 'expired';

  /**
   * The `File` object represents a document that has been uploaded to OpenAI.
   */
  file?: FilesAPI.FileObject | null;
}

export interface UploadCreateParams {
  /**
   * The number of bytes in the file you are uploading.
   */
  bytes: number;

  /**
   * The name of the file to upload.
   */
  filename: string;

  /**
   * The MIME type of the file.
   *
   * This must fall within the supported MIME types for your file purpose. See the
   * supported MIME types for assistants and vision.
   */
  mime_type: string;

  /**
   * The intended purpose of the uploaded file.
   *
   * See the
   * [documentation on File purposes](https://platform.openai.com/docs/api-reference/files/create#files-create-purpose).
   */
  purpose: FilesAPI.FilePurpose;

  /**
   * The expiration policy for a file. By default, files with `purpose=batch` expire
   * after 30 days and all other files are persisted until they are manually deleted.
   */
  expires_after?: UploadCreateParams.ExpiresAfter;
}

export namespace UploadCreateParams {
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

export interface UploadCompleteParams {
  /**
   * The ordered list of Part IDs.
   */
  part_ids: Array<string>;

  /**
   * The optional md5 checksum for the file contents to verify if the bytes uploaded
   * matches what you expect.
   */
  md5?: string;
}

Uploads.Parts = Parts;

export declare namespace Uploads {
  export {
    type Upload as Upload,
    type UploadCreateParams as UploadCreateParams,
    type UploadCompleteParams as UploadCompleteParams,
  };

  export { Parts as Parts, type UploadPart as UploadPart, type PartCreateParams as PartCreateParams };
}
