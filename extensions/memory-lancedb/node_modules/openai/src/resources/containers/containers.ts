// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as ResponsesAPI from '../responses/responses';
import * as FilesAPI from './files/files';
import {
  FileCreateParams,
  FileCreateResponse,
  FileDeleteParams,
  FileListParams,
  FileListResponse,
  FileListResponsesPage,
  FileRetrieveParams,
  FileRetrieveResponse,
  Files,
} from './files/files';
import { APIPromise } from '../../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise } from '../../core/pagination';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Containers extends APIResource {
  files: FilesAPI.Files = new FilesAPI.Files(this._client);

  /**
   * Create Container
   */
  create(body: ContainerCreateParams, options?: RequestOptions): APIPromise<ContainerCreateResponse> {
    return this._client.post('/containers', { body, ...options });
  }

  /**
   * Retrieve Container
   */
  retrieve(containerID: string, options?: RequestOptions): APIPromise<ContainerRetrieveResponse> {
    return this._client.get(path`/containers/${containerID}`, options);
  }

  /**
   * List Containers
   */
  list(
    query: ContainerListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<ContainerListResponsesPage, ContainerListResponse> {
    return this._client.getAPIList('/containers', CursorPage<ContainerListResponse>, { query, ...options });
  }

  /**
   * Delete Container
   */
  delete(containerID: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/containers/${containerID}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export type ContainerListResponsesPage = CursorPage<ContainerListResponse>;

export interface ContainerCreateResponse {
  /**
   * Unique identifier for the container.
   */
  id: string;

  /**
   * Unix timestamp (in seconds) when the container was created.
   */
  created_at: number;

  /**
   * Name of the container.
   */
  name: string;

  /**
   * The type of this object.
   */
  object: string;

  /**
   * Status of the container (e.g., active, deleted).
   */
  status: string;

  /**
   * The container will expire after this time period. The anchor is the reference
   * point for the expiration. The minutes is the number of minutes after the anchor
   * before the container expires.
   */
  expires_after?: ContainerCreateResponse.ExpiresAfter;

  /**
   * Unix timestamp (in seconds) when the container was last active.
   */
  last_active_at?: number;

  /**
   * The memory limit configured for the container.
   */
  memory_limit?: '1g' | '4g' | '16g' | '64g';

  /**
   * Network access policy for the container.
   */
  network_policy?: ContainerCreateResponse.NetworkPolicy;
}

export namespace ContainerCreateResponse {
  /**
   * The container will expire after this time period. The anchor is the reference
   * point for the expiration. The minutes is the number of minutes after the anchor
   * before the container expires.
   */
  export interface ExpiresAfter {
    /**
     * The reference point for the expiration.
     */
    anchor?: 'last_active_at';

    /**
     * The number of minutes after the anchor before the container expires.
     */
    minutes?: number;
  }

  /**
   * Network access policy for the container.
   */
  export interface NetworkPolicy {
    /**
     * The network policy mode.
     */
    type: 'allowlist' | 'disabled';

    /**
     * Allowed outbound domains when `type` is `allowlist`.
     */
    allowed_domains?: Array<string>;
  }
}

export interface ContainerRetrieveResponse {
  /**
   * Unique identifier for the container.
   */
  id: string;

  /**
   * Unix timestamp (in seconds) when the container was created.
   */
  created_at: number;

  /**
   * Name of the container.
   */
  name: string;

  /**
   * The type of this object.
   */
  object: string;

  /**
   * Status of the container (e.g., active, deleted).
   */
  status: string;

  /**
   * The container will expire after this time period. The anchor is the reference
   * point for the expiration. The minutes is the number of minutes after the anchor
   * before the container expires.
   */
  expires_after?: ContainerRetrieveResponse.ExpiresAfter;

  /**
   * Unix timestamp (in seconds) when the container was last active.
   */
  last_active_at?: number;

  /**
   * The memory limit configured for the container.
   */
  memory_limit?: '1g' | '4g' | '16g' | '64g';

  /**
   * Network access policy for the container.
   */
  network_policy?: ContainerRetrieveResponse.NetworkPolicy;
}

export namespace ContainerRetrieveResponse {
  /**
   * The container will expire after this time period. The anchor is the reference
   * point for the expiration. The minutes is the number of minutes after the anchor
   * before the container expires.
   */
  export interface ExpiresAfter {
    /**
     * The reference point for the expiration.
     */
    anchor?: 'last_active_at';

    /**
     * The number of minutes after the anchor before the container expires.
     */
    minutes?: number;
  }

  /**
   * Network access policy for the container.
   */
  export interface NetworkPolicy {
    /**
     * The network policy mode.
     */
    type: 'allowlist' | 'disabled';

    /**
     * Allowed outbound domains when `type` is `allowlist`.
     */
    allowed_domains?: Array<string>;
  }
}

export interface ContainerListResponse {
  /**
   * Unique identifier for the container.
   */
  id: string;

  /**
   * Unix timestamp (in seconds) when the container was created.
   */
  created_at: number;

  /**
   * Name of the container.
   */
  name: string;

  /**
   * The type of this object.
   */
  object: string;

  /**
   * Status of the container (e.g., active, deleted).
   */
  status: string;

  /**
   * The container will expire after this time period. The anchor is the reference
   * point for the expiration. The minutes is the number of minutes after the anchor
   * before the container expires.
   */
  expires_after?: ContainerListResponse.ExpiresAfter;

  /**
   * Unix timestamp (in seconds) when the container was last active.
   */
  last_active_at?: number;

  /**
   * The memory limit configured for the container.
   */
  memory_limit?: '1g' | '4g' | '16g' | '64g';

  /**
   * Network access policy for the container.
   */
  network_policy?: ContainerListResponse.NetworkPolicy;
}

export namespace ContainerListResponse {
  /**
   * The container will expire after this time period. The anchor is the reference
   * point for the expiration. The minutes is the number of minutes after the anchor
   * before the container expires.
   */
  export interface ExpiresAfter {
    /**
     * The reference point for the expiration.
     */
    anchor?: 'last_active_at';

    /**
     * The number of minutes after the anchor before the container expires.
     */
    minutes?: number;
  }

  /**
   * Network access policy for the container.
   */
  export interface NetworkPolicy {
    /**
     * The network policy mode.
     */
    type: 'allowlist' | 'disabled';

    /**
     * Allowed outbound domains when `type` is `allowlist`.
     */
    allowed_domains?: Array<string>;
  }
}

export interface ContainerCreateParams {
  /**
   * Name of the container to create.
   */
  name: string;

  /**
   * Container expiration time in seconds relative to the 'anchor' time.
   */
  expires_after?: ContainerCreateParams.ExpiresAfter;

  /**
   * IDs of files to copy to the container.
   */
  file_ids?: Array<string>;

  /**
   * Optional memory limit for the container. Defaults to "1g".
   */
  memory_limit?: '1g' | '4g' | '16g' | '64g';

  /**
   * Network access policy for the container.
   */
  network_policy?: ResponsesAPI.ContainerNetworkPolicyDisabled | ResponsesAPI.ContainerNetworkPolicyAllowlist;

  /**
   * An optional list of skills referenced by id or inline data.
   */
  skills?: Array<ResponsesAPI.SkillReference | ResponsesAPI.InlineSkill>;
}

export namespace ContainerCreateParams {
  /**
   * Container expiration time in seconds relative to the 'anchor' time.
   */
  export interface ExpiresAfter {
    /**
     * Time anchor for the expiration time. Currently only 'last_active_at' is
     * supported.
     */
    anchor: 'last_active_at';

    minutes: number;
  }
}

export interface ContainerListParams extends CursorPageParams {
  /**
   * Filter results by container name.
   */
  name?: string;

  /**
   * Sort order by the `created_at` timestamp of the objects. `asc` for ascending
   * order and `desc` for descending order.
   */
  order?: 'asc' | 'desc';
}

Containers.Files = Files;

export declare namespace Containers {
  export {
    type ContainerCreateResponse as ContainerCreateResponse,
    type ContainerRetrieveResponse as ContainerRetrieveResponse,
    type ContainerListResponse as ContainerListResponse,
    type ContainerListResponsesPage as ContainerListResponsesPage,
    type ContainerCreateParams as ContainerCreateParams,
    type ContainerListParams as ContainerListParams,
  };

  export {
    Files as Files,
    type FileCreateResponse as FileCreateResponse,
    type FileRetrieveResponse as FileRetrieveResponse,
    type FileListResponse as FileListResponse,
    type FileListResponsesPage as FileListResponsesPage,
    type FileCreateParams as FileCreateParams,
    type FileRetrieveParams as FileRetrieveParams,
    type FileListParams as FileListParams,
    type FileDeleteParams as FileDeleteParams,
  };
}
