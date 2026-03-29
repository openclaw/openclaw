// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import {
  ConversationCursorPage,
  type ConversationCursorPageParams,
  Page,
  PagePromise,
} from '../../../core/pagination';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

/**
 * Manage fine-tuning jobs to tailor a model to your specific training data.
 */
export class Permissions extends APIResource {
  /**
   * **NOTE:** Calling this endpoint requires an [admin API key](../admin-api-keys).
   *
   * This enables organization owners to share fine-tuned models with other projects
   * in their organization.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const permissionCreateResponse of client.fineTuning.checkpoints.permissions.create(
   *   'ft:gpt-4o-mini-2024-07-18:org:weather:B7R9VjQd',
   *   { project_ids: ['string'] },
   * )) {
   *   // ...
   * }
   * ```
   */
  create(
    fineTunedModelCheckpoint: string,
    body: PermissionCreateParams,
    options?: RequestOptions,
  ): PagePromise<PermissionCreateResponsesPage, PermissionCreateResponse> {
    return this._client.getAPIList(
      path`/fine_tuning/checkpoints/${fineTunedModelCheckpoint}/permissions`,
      Page<PermissionCreateResponse>,
      { body, method: 'post', ...options },
    );
  }

  /**
   * **NOTE:** This endpoint requires an [admin API key](../admin-api-keys).
   *
   * Organization owners can use this endpoint to view all permissions for a
   * fine-tuned model checkpoint.
   *
   * @deprecated Retrieve is deprecated. Please swap to the paginated list method instead.
   */
  retrieve(
    fineTunedModelCheckpoint: string,
    query: PermissionRetrieveParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<PermissionRetrieveResponse> {
    return this._client.get(path`/fine_tuning/checkpoints/${fineTunedModelCheckpoint}/permissions`, {
      query,
      ...options,
    });
  }

  /**
   * **NOTE:** This endpoint requires an [admin API key](../admin-api-keys).
   *
   * Organization owners can use this endpoint to view all permissions for a
   * fine-tuned model checkpoint.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const permissionListResponse of client.fineTuning.checkpoints.permissions.list(
   *   'ft-AF1WoRqd3aJAHsqc9NY7iL8F',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(
    fineTunedModelCheckpoint: string,
    query: PermissionListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<PermissionListResponsesPage, PermissionListResponse> {
    return this._client.getAPIList(
      path`/fine_tuning/checkpoints/${fineTunedModelCheckpoint}/permissions`,
      ConversationCursorPage<PermissionListResponse>,
      { query, ...options },
    );
  }

  /**
   * **NOTE:** This endpoint requires an [admin API key](../admin-api-keys).
   *
   * Organization owners can use this endpoint to delete a permission for a
   * fine-tuned model checkpoint.
   *
   * @example
   * ```ts
   * const permission =
   *   await client.fineTuning.checkpoints.permissions.delete(
   *     'cp_zc4Q7MP6XxulcVzj4MZdwsAB',
   *     {
   *       fine_tuned_model_checkpoint:
   *         'ft:gpt-4o-mini-2024-07-18:org:weather:B7R9VjQd',
   *     },
   *   );
   * ```
   */
  delete(
    permissionID: string,
    params: PermissionDeleteParams,
    options?: RequestOptions,
  ): APIPromise<PermissionDeleteResponse> {
    const { fine_tuned_model_checkpoint } = params;
    return this._client.delete(
      path`/fine_tuning/checkpoints/${fine_tuned_model_checkpoint}/permissions/${permissionID}`,
      options,
    );
  }
}

// Note: no pagination actually occurs yet, this is for forwards-compatibility.
export type PermissionCreateResponsesPage = Page<PermissionCreateResponse>;

export type PermissionListResponsesPage = ConversationCursorPage<PermissionListResponse>;

/**
 * The `checkpoint.permission` object represents a permission for a fine-tuned
 * model checkpoint.
 */
export interface PermissionCreateResponse {
  /**
   * The permission identifier, which can be referenced in the API endpoints.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the permission was created.
   */
  created_at: number;

  /**
   * The object type, which is always "checkpoint.permission".
   */
  object: 'checkpoint.permission';

  /**
   * The project identifier that the permission is for.
   */
  project_id: string;
}

export interface PermissionRetrieveResponse {
  data: Array<PermissionRetrieveResponse.Data>;

  has_more: boolean;

  object: 'list';

  first_id?: string | null;

  last_id?: string | null;
}

export namespace PermissionRetrieveResponse {
  /**
   * The `checkpoint.permission` object represents a permission for a fine-tuned
   * model checkpoint.
   */
  export interface Data {
    /**
     * The permission identifier, which can be referenced in the API endpoints.
     */
    id: string;

    /**
     * The Unix timestamp (in seconds) for when the permission was created.
     */
    created_at: number;

    /**
     * The object type, which is always "checkpoint.permission".
     */
    object: 'checkpoint.permission';

    /**
     * The project identifier that the permission is for.
     */
    project_id: string;
  }
}

/**
 * The `checkpoint.permission` object represents a permission for a fine-tuned
 * model checkpoint.
 */
export interface PermissionListResponse {
  /**
   * The permission identifier, which can be referenced in the API endpoints.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the permission was created.
   */
  created_at: number;

  /**
   * The object type, which is always "checkpoint.permission".
   */
  object: 'checkpoint.permission';

  /**
   * The project identifier that the permission is for.
   */
  project_id: string;
}

export interface PermissionDeleteResponse {
  /**
   * The ID of the fine-tuned model checkpoint permission that was deleted.
   */
  id: string;

  /**
   * Whether the fine-tuned model checkpoint permission was successfully deleted.
   */
  deleted: boolean;

  /**
   * The object type, which is always "checkpoint.permission".
   */
  object: 'checkpoint.permission';
}

export interface PermissionCreateParams {
  /**
   * The project identifiers to grant access to.
   */
  project_ids: Array<string>;
}

export interface PermissionRetrieveParams {
  /**
   * Identifier for the last permission ID from the previous pagination request.
   */
  after?: string;

  /**
   * Number of permissions to retrieve.
   */
  limit?: number;

  /**
   * The order in which to retrieve permissions.
   */
  order?: 'ascending' | 'descending';

  /**
   * The ID of the project to get permissions for.
   */
  project_id?: string;
}

export interface PermissionListParams extends ConversationCursorPageParams {
  /**
   * The order in which to retrieve permissions.
   */
  order?: 'ascending' | 'descending';

  /**
   * The ID of the project to get permissions for.
   */
  project_id?: string;
}

export interface PermissionDeleteParams {
  /**
   * The ID of the fine-tuned model checkpoint to delete a permission for.
   */
  fine_tuned_model_checkpoint: string;
}

export declare namespace Permissions {
  export {
    type PermissionCreateResponse as PermissionCreateResponse,
    type PermissionRetrieveResponse as PermissionRetrieveResponse,
    type PermissionListResponse as PermissionListResponse,
    type PermissionDeleteResponse as PermissionDeleteResponse,
    type PermissionCreateResponsesPage as PermissionCreateResponsesPage,
    type PermissionListResponsesPage as PermissionListResponsesPage,
    type PermissionCreateParams as PermissionCreateParams,
    type PermissionRetrieveParams as PermissionRetrieveParams,
    type PermissionListParams as PermissionListParams,
    type PermissionDeleteParams as PermissionDeleteParams,
  };
}
