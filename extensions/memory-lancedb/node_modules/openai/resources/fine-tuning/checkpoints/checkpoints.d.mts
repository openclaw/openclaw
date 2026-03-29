import { APIResource } from "../../../core/resource.mjs";
import * as PermissionsAPI from "./permissions.mjs";
import { PermissionCreateParams, PermissionCreateResponse, PermissionCreateResponsesPage, PermissionDeleteParams, PermissionDeleteResponse, PermissionListParams, PermissionListResponse, PermissionListResponsesPage, PermissionRetrieveParams, PermissionRetrieveResponse, Permissions } from "./permissions.mjs";
export declare class Checkpoints extends APIResource {
    permissions: PermissionsAPI.Permissions;
}
export declare namespace Checkpoints {
    export { Permissions as Permissions, type PermissionCreateResponse as PermissionCreateResponse, type PermissionRetrieveResponse as PermissionRetrieveResponse, type PermissionListResponse as PermissionListResponse, type PermissionDeleteResponse as PermissionDeleteResponse, type PermissionCreateResponsesPage as PermissionCreateResponsesPage, type PermissionListResponsesPage as PermissionListResponsesPage, type PermissionCreateParams as PermissionCreateParams, type PermissionRetrieveParams as PermissionRetrieveParams, type PermissionListParams as PermissionListParams, type PermissionDeleteParams as PermissionDeleteParams, };
}
//# sourceMappingURL=checkpoints.d.mts.map