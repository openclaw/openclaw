// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { Page, PagePromise } from '../core/pagination';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

/**
 * List and describe the various models available in the API.
 */
export class Models extends APIResource {
  /**
   * Retrieves a model instance, providing basic information about the model such as
   * the owner and permissioning.
   */
  retrieve(model: string, options?: RequestOptions): APIPromise<Model> {
    return this._client.get(path`/models/${model}`, options);
  }

  /**
   * Lists the currently available models, and provides basic information about each
   * one such as the owner and availability.
   */
  list(options?: RequestOptions): PagePromise<ModelsPage, Model> {
    return this._client.getAPIList('/models', Page<Model>, options);
  }

  /**
   * Delete a fine-tuned model. You must have the Owner role in your organization to
   * delete a model.
   */
  delete(model: string, options?: RequestOptions): APIPromise<ModelDeleted> {
    return this._client.delete(path`/models/${model}`, options);
  }
}

// Note: no pagination actually occurs yet, this is for forwards-compatibility.
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
