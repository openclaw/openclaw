import { APIResource } from "../core/resource.js";
import { APIPromise } from "../core/api-promise.js";
import { Page, PagePromise } from "../core/pagination.js";
import { RequestOptions } from "../internal/request-options.js";
/**
 * List and describe the various models available in the API.
 */
export declare class Models extends APIResource {
    /**
     * Retrieves a model instance, providing basic information about the model such as
     * the owner and permissioning.
     */
    retrieve(model: string, options?: RequestOptions): APIPromise<Model>;
    /**
     * Lists the currently available models, and provides basic information about each
     * one such as the owner and availability.
     */
    list(options?: RequestOptions): PagePromise<ModelsPage, Model>;
    /**
     * Delete a fine-tuned model. You must have the Owner role in your organization to
     * delete a model.
     */
    delete(model: string, options?: RequestOptions): APIPromise<ModelDeleted>;
}
export type ModelsPage = Page<Model>;
/**
 * Describes an OpenAI model offering that can be used with the API.
 */
export interface Model {
    /**
     * The model identifier, which can be referenced in the API endpoints.
     */
    id: string;
    /**
     * The Unix timestamp (in seconds) when the model was created.
     */
    created: number;
    /**
     * The object type, which is always "model".
     */
    object: 'model';
    /**
     * The organization that owns the model.
     */
    owned_by: string;
}
export interface ModelDeleted {
    id: string;
    deleted: boolean;
    object: string;
}
export declare namespace Models {
    export { type Model as Model, type ModelDeleted as ModelDeleted, type ModelsPage as ModelsPage };
}
//# sourceMappingURL=models.d.ts.map