// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { type Uploadable } from '../../core/uploads';
import { RequestOptions } from '../../internal/request-options';
import { multipartFormRequestOptions } from '../../internal/uploads';
import { path } from '../../internal/utils/path';

/**
 * Use Uploads to upload large files in multiple parts.
 */
export class Parts extends APIResource {
  /**
   * Adds a
   * [Part](https://platform.openai.com/docs/api-reference/uploads/part-object) to an
   * [Upload](https://platform.openai.com/docs/api-reference/uploads/object) object.
   * A Part represents a chunk of bytes from the file you are trying to upload.
   *
   * Each Part can be at most 64 MB, and you can add Parts until you hit the Upload
   * maximum of 8 GB.
   *
   * It is possible to add multiple Parts in parallel. You can decide the intended
   * order of the Parts when you
   * [complete the Upload](https://platform.openai.com/docs/api-reference/uploads/complete).
   */
  create(uploadID: string, body: PartCreateParams, options?: RequestOptions): APIPromise<UploadPart> {
    return this._client.post(
      path`/uploads/${uploadID}/parts`,
      multipartFormRequestOptions({ body, ...options }, this._client),
    );
  }
}

/**
 * The upload Part represents a chunk of bytes we can add to an Upload object.
 */
export interface UploadPart {
  /**
   * The upload Part unique identifier, which can be referenced in API endpoints.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the Part was created.
   */
  created_at: number;

  /**
   * The object type, which is always `upload.part`.
   */
  object: 'upload.part';

  /**
   * The ID of the Upload object that this Part was added to.
   */
  upload_id: string;
}

export interface PartCreateParams {
  /**
   * The chunk of bytes for this Part.
   */
  data: Uploadable;
}

export declare namespace Parts {
  export { type UploadPart as UploadPart, type PartCreateParams as PartCreateParams };
}
