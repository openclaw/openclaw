// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as PermissionsAPI from './permissions';
import {
  PermissionCreateParams,
  PermissionCreateResponse,
  PermissionCreateResponsesPage,
  PermissionDeleteParams,
  PermissionDeleteResponse,
  PermissionListParams,
  PermissionListResponse,
  PermissionListResponsesPage,
  PermissionRetrieveParams,
  PermissionRetrieveResponse,
  Permissions,
} from './permissions';

export class Checkpoints extends APIResource {
  permissions: PermissionsAPI.Permissions = new PermissionsAPI.Permissions(this._client);
}

Checkpoints.Permissions = Permissions;

export declare namespace Checkpoints {
  export {
    Permissions as Permissions,
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
