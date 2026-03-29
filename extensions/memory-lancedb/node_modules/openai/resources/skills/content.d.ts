import { APIResource } from "../../core/resource.js";
import { APIPromise } from "../../core/api-promise.js";
import { RequestOptions } from "../../internal/request-options.js";
export declare class Content extends APIResource {
    /**
     * Download a skill zip bundle by its ID.
     */
    retrieve(skillID: string, options?: RequestOptions): APIPromise<Response>;
}
//# sourceMappingURL=content.d.ts.map