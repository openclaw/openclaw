// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { buildHeaders } from '../../../internal/headers';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

export class Content extends APIResource {
  /**
   * Download a skill version zip bundle.
   */
  retrieve(version: string, params: ContentRetrieveParams, options?: RequestOptions): APIPromise<Response> {
    const { skill_id } = params;
    return this._client.get(path`/skills/${skill_id}/versions/${version}/content`, {
      ...options,
      headers: buildHeaders([{ Accept: 'application/binary' }, options?.headers]),
      __binaryResponse: true,
    });
  }
}

export interface ContentRetrieveParams {
  /**
   * The identifier of the skill.
   */
  skill_id: string;
}

export declare namespace Content {
  export { type ContentRetrieveParams as ContentRetrieveParams };
}
