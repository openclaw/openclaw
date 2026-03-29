import { APIResource } from "../../core/resource.js";
import { APIPromise } from "../../core/api-promise.js";
import { type Uploadable } from "../../core/uploads.js";
import { RequestOptions } from "../../internal/request-options.js";
/**
 * Use Uploads to upload large files in multiple parts.
 */
export declare class Parts extends APIResource {
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
    create(uploadID: string, body: PartCreateParams, options?: RequestOptions): APIPromise<UploadPart>;
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
//# sourceMappingURL=parts.d.ts.map