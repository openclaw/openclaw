import { APIResource } from "../../../core/resource.mjs";
import * as ContentAPI from "./content.mjs";
import { Content, ContentRetrieveParams } from "./content.mjs";
import { APIPromise } from "../../../core/api-promise.mjs";
import { CursorPage, type CursorPageParams, PagePromise } from "../../../core/pagination.mjs";
import { type Uploadable } from "../../../core/uploads.mjs";
import { RequestOptions } from "../../../internal/request-options.mjs";
export declare class Versions extends APIResource {
    content: ContentAPI.Content;
    /**
     * Create a new immutable skill version.
     */
    create(skillID: string, body?: VersionCreateParams | null | undefined, options?: RequestOptions): APIPromise<SkillVersion>;
    /**
     * Get a specific skill version.
     */
    retrieve(version: string, params: VersionRetrieveParams, options?: RequestOptions): APIPromise<SkillVersion>;
    /**
     * List skill versions for a skill.
     */
    list(skillID: string, query?: VersionListParams | null | undefined, options?: RequestOptions): PagePromise<SkillVersionsPage, SkillVersion>;
    /**
     * Delete a skill version.
     */
    delete(version: string, params: VersionDeleteParams, options?: RequestOptions): APIPromise<DeletedSkillVersion>;
}
export type SkillVersionsPage = CursorPage<SkillVersion>;
export interface DeletedSkillVersion {
    id: string;
    deleted: boolean;
    object: 'skill.version.deleted';
    /**
     * The deleted skill version.
     */
    version: string;
}
export interface SkillVersion {
    /**
     * Unique identifier for the skill version.
     */
    id: string;
    /**
     * Unix timestamp (seconds) for when the version was created.
     */
    created_at: number;
    /**
     * Description of the skill version.
     */
    description: string;
    /**
     * Name of the skill version.
     */
    name: string;
    /**
     * The object type, which is `skill.version`.
     */
    object: 'skill.version';
    /**
     * Identifier of the skill for this version.
     */
    skill_id: string;
    /**
     * Version number for this skill.
     */
    version: string;
}
export interface SkillVersionList {
    /**
     * A list of items
     */
    data: Array<SkillVersion>;
    /**
     * The ID of the first item in the list.
     */
    first_id: string | null;
    /**
     * Whether there are more items available.
     */
    has_more: boolean;
    /**
     * The ID of the last item in the list.
     */
    last_id: string | null;
    /**
     * The type of object returned, must be `list`.
     */
    object: 'list';
}
export interface VersionCreateParams {
    /**
     * Whether to set this version as the default.
     */
    default?: boolean;
    /**
     * Skill files to upload (directory upload) or a single zip file.
     */
    files?: Array<Uploadable> | Uploadable;
}
export interface VersionRetrieveParams {
    /**
     * The identifier of the skill.
     */
    skill_id: string;
}
export interface VersionListParams extends CursorPageParams {
    /**
     * Sort order of results by version number.
     */
    order?: 'asc' | 'desc';
}
export interface VersionDeleteParams {
    /**
     * The identifier of the skill.
     */
    skill_id: string;
}
export declare namespace Versions {
    export { type DeletedSkillVersion as DeletedSkillVersion, type SkillVersion as SkillVersion, type SkillVersionList as SkillVersionList, type SkillVersionsPage as SkillVersionsPage, type VersionCreateParams as VersionCreateParams, type VersionRetrieveParams as VersionRetrieveParams, type VersionListParams as VersionListParams, type VersionDeleteParams as VersionDeleteParams, };
    export { Content as Content, type ContentRetrieveParams as ContentRetrieveParams };
}
//# sourceMappingURL=versions.d.mts.map