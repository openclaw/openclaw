// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as Shared from '../shared';
import * as GraderModelsAPI from '../graders/grader-models';
import * as ResponsesAPI from '../responses/responses';
import * as RunsAPI from './runs/runs';
import {
  CreateEvalCompletionsRunDataSource,
  CreateEvalJSONLRunDataSource,
  EvalAPIError,
  RunCancelParams,
  RunCancelResponse,
  RunCreateParams,
  RunCreateResponse,
  RunDeleteParams,
  RunDeleteResponse,
  RunListParams,
  RunListResponse,
  RunListResponsesPage,
  RunRetrieveParams,
  RunRetrieveResponse,
  Runs,
} from './runs/runs';
import { APIPromise } from '../../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise } from '../../core/pagination';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

/**
 * Manage and run evals in the OpenAI platform.
 */
export class Evals extends APIResource {
  runs: RunsAPI.Runs = new RunsAPI.Runs(this._client);

  /**
   * Create the structure of an evaluation that can be used to test a model's
   * performance. An evaluation is a set of testing criteria and the config for a
   * data source, which dictates the schema of the data used in the evaluation. After
   * creating an evaluation, you can run it on different models and model parameters.
   * We support several types of graders and datasources. For more information, see
   * the [Evals guide](https://platform.openai.com/docs/guides/evals).
   */
  create(body: EvalCreateParams, options?: RequestOptions): APIPromise<EvalCreateResponse> {
    return this._client.post('/evals', { body, ...options });
  }

  /**
   * Get an evaluation by ID.
   */
  retrieve(evalID: string, options?: RequestOptions): APIPromise<EvalRetrieveResponse> {
    return this._client.get(path`/evals/${evalID}`, options);
  }

  /**
   * Update certain properties of an evaluation.
   */
  update(evalID: string, body: EvalUpdateParams, options?: RequestOptions): APIPromise<EvalUpdateResponse> {
    return this._client.post(path`/evals/${evalID}`, { body, ...options });
  }

  /**
   * List evaluations for a project.
   */
  list(
    query: EvalListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<EvalListResponsesPage, EvalListResponse> {
    return this._client.getAPIList('/evals', CursorPage<EvalListResponse>, { query, ...options });
  }

  /**
   * Delete an evaluation.
   */
  delete(evalID: string, options?: RequestOptions): APIPromise<EvalDeleteResponse> {
    return this._client.delete(path`/evals/${evalID}`, options);
  }
}

export type EvalListResponsesPage = CursorPage<EvalListResponse>;

/**
 * A CustomDataSourceConfig which specifies the schema of your `item` and
 * optionally `sample` namespaces. The response schema defines the shape of the
 * data that will be:
 *
 * - Used to define your testing criteria and
 * - What data is required when creating a run
 */
export interface EvalCustomDataSourceConfig {
  /**
   * The json schema for the run data source items. Learn how to build JSON schemas
   * [here](https://json-schema.org/).
   */
  schema: { [key: string]: unknown };

  /**
   * The type of data source. Always `custom`.
   */
  type: 'custom';
}

/**
 * @deprecated Deprecated in favor of LogsDataSourceConfig.
 */
export interface EvalStoredCompletionsDataSourceConfig {
  /**
   * The json schema for the run data source items. Learn how to build JSON schemas
   * [here](https://json-schema.org/).
   */
  schema: { [key: string]: unknown };

  /**
   * The type of data source. Always `stored_completions`.
   */
  type: 'stored_completions';

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata?: Shared.Metadata | null;
}

/**
 * An Eval object with a data source config and testing criteria. An Eval
 * represents a task to be done for your LLM integration. Like:
 *
 * - Improve the quality of my chatbot
 * - See how well my chatbot handles customer support
 * - Check if o4-mini is better at my usecase than gpt-4o
 */
export interface EvalCreateResponse {
  /**
   * Unique identifier for the evaluation.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the eval was created.
   */
  created_at: number;

  /**
   * Configuration of data sources used in runs of the evaluation.
   */
  data_source_config:
    | EvalCustomDataSourceConfig
    | EvalCreateResponse.Logs
    | EvalStoredCompletionsDataSourceConfig;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata: Shared.Metadata | null;

  /**
   * The name of the evaluation.
   */
  name: string;

  /**
   * The object type.
   */
  object: 'eval';

  /**
   * A list of testing criteria.
   */
  testing_criteria: Array<
    | GraderModelsAPI.LabelModelGrader
    | GraderModelsAPI.StringCheckGrader
    | EvalCreateResponse.EvalGraderTextSimilarity
    | EvalCreateResponse.EvalGraderPython
    | EvalCreateResponse.EvalGraderScoreModel
  >;
}

export namespace EvalCreateResponse {
  /**
   * A LogsDataSourceConfig which specifies the metadata property of your logs query.
   * This is usually metadata like `usecase=chatbot` or `prompt-version=v2`, etc. The
   * schema returned by this data source config is used to defined what variables are
   * available in your evals. `item` and `sample` are both defined when using this
   * data source config.
   */
  export interface Logs {
    /**
     * The json schema for the run data source items. Learn how to build JSON schemas
     * [here](https://json-schema.org/).
     */
    schema: { [key: string]: unknown };

    /**
     * The type of data source. Always `logs`.
     */
    type: 'logs';

    /**
     * Set of 16 key-value pairs that can be attached to an object. This can be useful
     * for storing additional information about the object in a structured format, and
     * querying for objects via API or the dashboard.
     *
     * Keys are strings with a maximum length of 64 characters. Values are strings with
     * a maximum length of 512 characters.
     */
    metadata?: Shared.Metadata | null;
  }

  /**
   * A TextSimilarityGrader object which grades text based on similarity metrics.
   */
  export interface EvalGraderTextSimilarity extends GraderModelsAPI.TextSimilarityGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold: number;
  }

  /**
   * A PythonGrader object that runs a python script on the input.
   */
  export interface EvalGraderPython extends GraderModelsAPI.PythonGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }

  /**
   * A ScoreModelGrader object that uses a model to assign a score to the input.
   */
  export interface EvalGraderScoreModel extends GraderModelsAPI.ScoreModelGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }
}

/**
 * An Eval object with a data source config and testing criteria. An Eval
 * represents a task to be done for your LLM integration. Like:
 *
 * - Improve the quality of my chatbot
 * - See how well my chatbot handles customer support
 * - Check if o4-mini is better at my usecase than gpt-4o
 */
export interface EvalRetrieveResponse {
  /**
   * Unique identifier for the evaluation.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the eval was created.
   */
  created_at: number;

  /**
   * Configuration of data sources used in runs of the evaluation.
   */
  data_source_config:
    | EvalCustomDataSourceConfig
    | EvalRetrieveResponse.Logs
    | EvalStoredCompletionsDataSourceConfig;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata: Shared.Metadata | null;

  /**
   * The name of the evaluation.
   */
  name: string;

  /**
   * The object type.
   */
  object: 'eval';

  /**
   * A list of testing criteria.
   */
  testing_criteria: Array<
    | GraderModelsAPI.LabelModelGrader
    | GraderModelsAPI.StringCheckGrader
    | EvalRetrieveResponse.EvalGraderTextSimilarity
    | EvalRetrieveResponse.EvalGraderPython
    | EvalRetrieveResponse.EvalGraderScoreModel
  >;
}

export namespace EvalRetrieveResponse {
  /**
   * A LogsDataSourceConfig which specifies the metadata property of your logs query.
   * This is usually metadata like `usecase=chatbot` or `prompt-version=v2`, etc. The
   * schema returned by this data source config is used to defined what variables are
   * available in your evals. `item` and `sample` are both defined when using this
   * data source config.
   */
  export interface Logs {
    /**
     * The json schema for the run data source items. Learn how to build JSON schemas
     * [here](https://json-schema.org/).
     */
    schema: { [key: string]: unknown };

    /**
     * The type of data source. Always `logs`.
     */
    type: 'logs';

    /**
     * Set of 16 key-value pairs that can be attached to an object. This can be useful
     * for storing additional information about the object in a structured format, and
     * querying for objects via API or the dashboard.
     *
     * Keys are strings with a maximum length of 64 characters. Values are strings with
     * a maximum length of 512 characters.
     */
    metadata?: Shared.Metadata | null;
  }

  /**
   * A TextSimilarityGrader object which grades text based on similarity metrics.
   */
  export interface EvalGraderTextSimilarity extends GraderModelsAPI.TextSimilarityGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold: number;
  }

  /**
   * A PythonGrader object that runs a python script on the input.
   */
  export interface EvalGraderPython extends GraderModelsAPI.PythonGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }

  /**
   * A ScoreModelGrader object that uses a model to assign a score to the input.
   */
  export interface EvalGraderScoreModel extends GraderModelsAPI.ScoreModelGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }
}

/**
 * An Eval object with a data source config and testing criteria. An Eval
 * represents a task to be done for your LLM integration. Like:
 *
 * - Improve the quality of my chatbot
 * - See how well my chatbot handles customer support
 * - Check if o4-mini is better at my usecase than gpt-4o
 */
export interface EvalUpdateResponse {
  /**
   * Unique identifier for the evaluation.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the eval was created.
   */
  created_at: number;

  /**
   * Configuration of data sources used in runs of the evaluation.
   */
  data_source_config:
    | EvalCustomDataSourceConfig
    | EvalUpdateResponse.Logs
    | EvalStoredCompletionsDataSourceConfig;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata: Shared.Metadata | null;

  /**
   * The name of the evaluation.
   */
  name: string;

  /**
   * The object type.
   */
  object: 'eval';

  /**
   * A list of testing criteria.
   */
  testing_criteria: Array<
    | GraderModelsAPI.LabelModelGrader
    | GraderModelsAPI.StringCheckGrader
    | EvalUpdateResponse.EvalGraderTextSimilarity
    | EvalUpdateResponse.EvalGraderPython
    | EvalUpdateResponse.EvalGraderScoreModel
  >;
}

export namespace EvalUpdateResponse {
  /**
   * A LogsDataSourceConfig which specifies the metadata property of your logs query.
   * This is usually metadata like `usecase=chatbot` or `prompt-version=v2`, etc. The
   * schema returned by this data source config is used to defined what variables are
   * available in your evals. `item` and `sample` are both defined when using this
   * data source config.
   */
  export interface Logs {
    /**
     * The json schema for the run data source items. Learn how to build JSON schemas
     * [here](https://json-schema.org/).
     */
    schema: { [key: string]: unknown };

    /**
     * The type of data source. Always `logs`.
     */
    type: 'logs';

    /**
     * Set of 16 key-value pairs that can be attached to an object. This can be useful
     * for storing additional information about the object in a structured format, and
     * querying for objects via API or the dashboard.
     *
     * Keys are strings with a maximum length of 64 characters. Values are strings with
     * a maximum length of 512 characters.
     */
    metadata?: Shared.Metadata | null;
  }

  /**
   * A TextSimilarityGrader object which grades text based on similarity metrics.
   */
  export interface EvalGraderTextSimilarity extends GraderModelsAPI.TextSimilarityGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold: number;
  }

  /**
   * A PythonGrader object that runs a python script on the input.
   */
  export interface EvalGraderPython extends GraderModelsAPI.PythonGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }

  /**
   * A ScoreModelGrader object that uses a model to assign a score to the input.
   */
  export interface EvalGraderScoreModel extends GraderModelsAPI.ScoreModelGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }
}

/**
 * An Eval object with a data source config and testing criteria. An Eval
 * represents a task to be done for your LLM integration. Like:
 *
 * - Improve the quality of my chatbot
 * - See how well my chatbot handles customer support
 * - Check if o4-mini is better at my usecase than gpt-4o
 */
export interface EvalListResponse {
  /**
   * Unique identifier for the evaluation.
   */
  id: string;

  /**
   * The Unix timestamp (in seconds) for when the eval was created.
   */
  created_at: number;

  /**
   * Configuration of data sources used in runs of the evaluation.
   */
  data_source_config:
    | EvalCustomDataSourceConfig
    | EvalListResponse.Logs
    | EvalStoredCompletionsDataSourceConfig;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata: Shared.Metadata | null;

  /**
   * The name of the evaluation.
   */
  name: string;

  /**
   * The object type.
   */
  object: 'eval';

  /**
   * A list of testing criteria.
   */
  testing_criteria: Array<
    | GraderModelsAPI.LabelModelGrader
    | GraderModelsAPI.StringCheckGrader
    | EvalListResponse.EvalGraderTextSimilarity
    | EvalListResponse.EvalGraderPython
    | EvalListResponse.EvalGraderScoreModel
  >;
}

export namespace EvalListResponse {
  /**
   * A LogsDataSourceConfig which specifies the metadata property of your logs query.
   * This is usually metadata like `usecase=chatbot` or `prompt-version=v2`, etc. The
   * schema returned by this data source config is used to defined what variables are
   * available in your evals. `item` and `sample` are both defined when using this
   * data source config.
   */
  export interface Logs {
    /**
     * The json schema for the run data source items. Learn how to build JSON schemas
     * [here](https://json-schema.org/).
     */
    schema: { [key: string]: unknown };

    /**
     * The type of data source. Always `logs`.
     */
    type: 'logs';

    /**
     * Set of 16 key-value pairs that can be attached to an object. This can be useful
     * for storing additional information about the object in a structured format, and
     * querying for objects via API or the dashboard.
     *
     * Keys are strings with a maximum length of 64 characters. Values are strings with
     * a maximum length of 512 characters.
     */
    metadata?: Shared.Metadata | null;
  }

  /**
   * A TextSimilarityGrader object which grades text based on similarity metrics.
   */
  export interface EvalGraderTextSimilarity extends GraderModelsAPI.TextSimilarityGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold: number;
  }

  /**
   * A PythonGrader object that runs a python script on the input.
   */
  export interface EvalGraderPython extends GraderModelsAPI.PythonGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }

  /**
   * A ScoreModelGrader object that uses a model to assign a score to the input.
   */
  export interface EvalGraderScoreModel extends GraderModelsAPI.ScoreModelGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }
}

export interface EvalDeleteResponse {
  deleted: boolean;

  eval_id: string;

  object: string;
}

export interface EvalCreateParams {
  /**
   * The configuration for the data source used for the evaluation runs. Dictates the
   * schema of the data used in the evaluation.
   */
  data_source_config: EvalCreateParams.Custom | EvalCreateParams.Logs | EvalCreateParams.StoredCompletions;

  /**
   * A list of graders for all eval runs in this group. Graders can reference
   * variables in the data source using double curly braces notation, like
   * `{{item.variable_name}}`. To reference the model's output, use the `sample`
   * namespace (ie, `{{sample.output_text}}`).
   */
  testing_criteria: Array<
    | EvalCreateParams.LabelModel
    | GraderModelsAPI.StringCheckGrader
    | EvalCreateParams.TextSimilarity
    | EvalCreateParams.Python
    | EvalCreateParams.ScoreModel
  >;

  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata?: Shared.Metadata | null;

  /**
   * The name of the evaluation.
   */
  name?: string;
}

export namespace EvalCreateParams {
  /**
   * A CustomDataSourceConfig object that defines the schema for the data source used
   * for the evaluation runs. This schema is used to define the shape of the data
   * that will be:
   *
   * - Used to define your testing criteria and
   * - What data is required when creating a run
   */
  export interface Custom {
    /**
     * The json schema for each row in the data source.
     */
    item_schema: { [key: string]: unknown };

    /**
     * The type of data source. Always `custom`.
     */
    type: 'custom';

    /**
     * Whether the eval should expect you to populate the sample namespace (ie, by
     * generating responses off of your data source)
     */
    include_sample_schema?: boolean;
  }

  /**
   * A data source config which specifies the metadata property of your logs query.
   * This is usually metadata like `usecase=chatbot` or `prompt-version=v2`, etc.
   */
  export interface Logs {
    /**
     * The type of data source. Always `logs`.
     */
    type: 'logs';

    /**
     * Metadata filters for the logs data source.
     */
    metadata?: { [key: string]: unknown };
  }

  /**
   * @deprecated Deprecated in favor of LogsDataSourceConfig.
   */
  export interface StoredCompletions {
    /**
     * The type of data source. Always `stored_completions`.
     */
    type: 'stored_completions';

    /**
     * Metadata filters for the stored completions data source.
     */
    metadata?: { [key: string]: unknown };
  }

  /**
   * A LabelModelGrader object which uses a model to assign labels to each item in
   * the evaluation.
   */
  export interface LabelModel {
    /**
     * A list of chat messages forming the prompt or context. May include variable
     * references to the `item` namespace, ie {{item.name}}.
     */
    input: Array<LabelModel.SimpleInputMessage | LabelModel.EvalItem>;

    /**
     * The labels to classify to each item in the evaluation.
     */
    labels: Array<string>;

    /**
     * The model to use for the evaluation. Must support structured outputs.
     */
    model: string;

    /**
     * The name of the grader.
     */
    name: string;

    /**
     * The labels that indicate a passing result. Must be a subset of labels.
     */
    passing_labels: Array<string>;

    /**
     * The object type, which is always `label_model`.
     */
    type: 'label_model';
  }

  export namespace LabelModel {
    export interface SimpleInputMessage {
      /**
       * The content of the message.
       */
      content: string;

      /**
       * The role of the message (e.g. "system", "assistant", "user").
       */
      role: string;
    }

    /**
     * A message input to the model with a role indicating instruction following
     * hierarchy. Instructions given with the `developer` or `system` role take
     * precedence over instructions given with the `user` role. Messages with the
     * `assistant` role are presumed to have been generated by the model in previous
     * interactions.
     */
    export interface EvalItem {
      /**
       * Inputs to the model - can contain template strings. Supports text, output text,
       * input images, and input audio, either as a single item or an array of items.
       */
      content:
        | string
        | ResponsesAPI.ResponseInputText
        | EvalItem.OutputText
        | EvalItem.InputImage
        | ResponsesAPI.ResponseInputAudio
        | GraderModelsAPI.GraderInputs;

      /**
       * The role of the message input. One of `user`, `assistant`, `system`, or
       * `developer`.
       */
      role: 'user' | 'assistant' | 'system' | 'developer';

      /**
       * The type of the message input. Always `message`.
       */
      type?: 'message';
    }

    export namespace EvalItem {
      /**
       * A text output from the model.
       */
      export interface OutputText {
        /**
         * The text output from the model.
         */
        text: string;

        /**
         * The type of the output text. Always `output_text`.
         */
        type: 'output_text';
      }

      /**
       * An image input block used within EvalItem content arrays.
       */
      export interface InputImage {
        /**
         * The URL of the image input.
         */
        image_url: string;

        /**
         * The type of the image input. Always `input_image`.
         */
        type: 'input_image';

        /**
         * The detail level of the image to be sent to the model. One of `high`, `low`, or
         * `auto`. Defaults to `auto`.
         */
        detail?: string;
      }
    }
  }

  /**
   * A TextSimilarityGrader object which grades text based on similarity metrics.
   */
  export interface TextSimilarity extends GraderModelsAPI.TextSimilarityGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold: number;
  }

  /**
   * A PythonGrader object that runs a python script on the input.
   */
  export interface Python extends GraderModelsAPI.PythonGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }

  /**
   * A ScoreModelGrader object that uses a model to assign a score to the input.
   */
  export interface ScoreModel extends GraderModelsAPI.ScoreModelGrader {
    /**
     * The threshold for the score.
     */
    pass_threshold?: number;
  }
}

export interface EvalUpdateParams {
  /**
   * Set of 16 key-value pairs that can be attached to an object. This can be useful
   * for storing additional information about the object in a structured format, and
   * querying for objects via API or the dashboard.
   *
   * Keys are strings with a maximum length of 64 characters. Values are strings with
   * a maximum length of 512 characters.
   */
  metadata?: Shared.Metadata | null;

  /**
   * Rename the evaluation.
   */
  name?: string;
}

export interface EvalListParams extends CursorPageParams {
  /**
   * Sort order for evals by timestamp. Use `asc` for ascending order or `desc` for
   * descending order.
   */
  order?: 'asc' | 'desc';

  /**
   * Evals can be ordered by creation time or last updated time. Use `created_at` for
   * creation time or `updated_at` for last updated time.
   */
  order_by?: 'created_at' | 'updated_at';
}

Evals.Runs = Runs;

export declare namespace Evals {
  export {
    type EvalCustomDataSourceConfig as EvalCustomDataSourceConfig,
    type EvalStoredCompletionsDataSourceConfig as EvalStoredCompletionsDataSourceConfig,
    type EvalCreateResponse as EvalCreateResponse,
    type EvalRetrieveResponse as EvalRetrieveResponse,
    type EvalUpdateResponse as EvalUpdateResponse,
    type EvalListResponse as EvalListResponse,
    type EvalDeleteResponse as EvalDeleteResponse,
    type EvalListResponsesPage as EvalListResponsesPage,
    type EvalCreateParams as EvalCreateParams,
    type EvalUpdateParams as EvalUpdateParams,
    type EvalListParams as EvalListParams,
  };

  export {
    Runs as Runs,
    type CreateEvalCompletionsRunDataSource as CreateEvalCompletionsRunDataSource,
    type CreateEvalJSONLRunDataSource as CreateEvalJSONLRunDataSource,
    type EvalAPIError as EvalAPIError,
    type RunCreateResponse as RunCreateResponse,
    type RunRetrieveResponse as RunRetrieveResponse,
    type RunListResponse as RunListResponse,
    type RunDeleteResponse as RunDeleteResponse,
    type RunCancelResponse as RunCancelResponse,
    type RunListResponsesPage as RunListResponsesPage,
    type RunCreateParams as RunCreateParams,
    type RunRetrieveParams as RunRetrieveParams,
    type RunListParams as RunListParams,
    type RunDeleteParams as RunDeleteParams,
    type RunCancelParams as RunCancelParams,
  };
}
