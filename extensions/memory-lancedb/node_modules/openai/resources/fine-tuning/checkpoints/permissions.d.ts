import { APIResource } from "../../../core/resource.js";
import { APIPromise } from "../../../core/api-promise.js";
import { ConversationCursorPage, type ConversationCursorPageParams, Page, PagePromise } from "../../../core/pagination.js";
import { RequestOptions } from "../../../internal/request-options.js";
/**
 * Manage fine-tuning jobs to tailor a model to your specific training data.
 */
export declare class Permissions extends APIResource {
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
    create(fineTunedModelCheckpoint: string, body: PermissionCreateParams, options?: RequestOptions): PagePromise<PermissionCreateResponsesPage, PermissionCreateResponse>;
    /**
     * **NOTE:** This endpoint requires an [admin API key](../admin-api-keys).
     *
     * Organization owners can use this endpoint to view all permissions for a
     * fine-tuned model checkpoint.
     *
     * @deprecated Retrieve is deprecated. Please swap to the paginated list method instead.
     */
    retrieve(fineTunedModelCheckpoint: string, query?: PermissionRetrieveParams | null | undefined, options?: RequestOptions): APIPromise<PermissionRetrieveResponse>;
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
    list(fineTunedModelCheckpoint: string, query?: PermissionListParams | null | undefined, options?: RequestOptions): PagePromise<PermissionListResponsesPage, PermissionListResponse>;
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
    delete(permissionID: string, params: PermissionDeleteParams, options?: RequestOptions): APIPromise<PermissionDeleteResponse>;
}
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
export declare namespace PermissionRetrieveResponse {
    /**
     * The `checkpoint.permission` object represents a permission for a fine-tuned
     * model checkpoint.
     */
    interface Data {
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
    export { type PermissionCreateResponse as PermissionCreateResponse, type PermissionRetrieveResponse as PermissionRetrieveResponse, type PermissionListResponse as PermissionListResponse, type PermissionDeleteResponse as PermissionDeleteResponse, type PermissionCreateResponsesPage as PermissionCreateResponsesPage, type PermissionListResponsesPage as PermissionListResponsesPage, type PermissionCreateParams as PermissionCreateParams, type PermissionRetrieveParams as PermissionRetrieveParams, type PermissionListParams as PermissionListParams, type PermissionDeleteParams as PermissionDeleteParams, };
}
//# sourceMappingURL=permissions.d.ts.map