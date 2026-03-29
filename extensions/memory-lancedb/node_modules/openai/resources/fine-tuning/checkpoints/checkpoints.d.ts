import { APIResource } from "../../../core/resource.js";
import * as PermissionsAPI from "./permissions.js";
import { PermissionCreateParams, PermissionCreateResponse, PermissionCreateResponsesPage, PermissionDeleteParams, PermissionDeleteResponse, PermissionListParams, PermissionListResponse, PermissionListResponsesPage, PermissionRetrieveParams, PermissionRetrieveResponse, Permissions } from "./permissions.js";
export declare class Checkpoints extends APIResource {
    permissions: PermissionsAPI.Permissions;
}
export declare namespace Checkpoints {
    export { Permissions as Permissions, type PermissionCreateResponse as PermissionCreateResponse, type PermissionRetrieveResponse as PermissionRetrieveResponse, type PermissionListResponse as PermissionListResponse, type PermissionDeleteResponse as PermissionDeleteResponse, type PermissionCreateResponsesPage as PermissionCreateResponsesPage, type PermissionListResponsesPage as PermissionListResponsesPage, type PermissionCreateParams as PermissionCreateParams, type PermissionRetrieveParams as PermissionRetrieveParams, type PermissionListParams as PermissionListParams, type PermissionDeleteParams as PermissionDeleteParams, };
}
//# sourceMappingURL=checkpoints.d.ts.map