// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as GraderModelsAPI from '../../graders/grader-models';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';

/**
 * Manage fine-tuning jobs to tailor a model to your specific training data.
 */
export class Graders extends APIResource {
  /**
   * Run a grader.
   *
   * @example
   * ```ts
   * const response = await client.fineTuning.alpha.graders.run({
   *   grader: {
   *     input: 'input',
   *     name: 'name',
   *     operation: 'eq',
   *     reference: 'reference',
   *     type: 'string_check',
   *   },
   *   model_sample: 'model_sample',
   * });
   * ```
   */
  run(body: GraderRunParams, options?: RequestOptions): APIPromise<GraderRunResponse> {
    return this._client.post('/fine_tuning/alpha/graders/run', { body, ...options });
  }

  /**
   * Validate a grader.
   *
   * @example
   * ```ts
   * const response =
   *   await client.fineTuning.alpha.graders.validate({
   *     grader: {
   *       input: 'input',
   *       name: 'name',
   *       operation: 'eq',
   *       reference: 'reference',
   *       type: 'string_check',
   *     },
   *   });
   * ```
   */
  validate(body: GraderValidateParams, options?: RequestOptions): APIPromise<GraderValidateResponse> {
    return this._client.post('/fine_tuning/alpha/graders/validate', { body, ...options });
  }
}

export interface GraderRunResponse {
  metadata: GraderRunResponse.Metadata;

  model_grader_token_usage_per_model: { [key: string]: unknown };

  reward: number;

  sub_rewards: { [key: string]: unknown };
}

export namespace GraderRunResponse {
  export interface Metadata {
    errors: Metadata.Errors;

    execution_time: number;

    name: string;

    sampled_model_name: string | null;

    scores: { [key: string]: unknown };

    token_usage: number | null;

    type: string;
  }

  export namespace Metadata {
    export interface Errors {
      formula_parse_error: boolean;

      invalid_variable_error: boolean;

      model_grader_parse_error: boolean;

      model_grader_refusal_error: boolean;

      model_grader_server_error: boolean;

      model_grader_server_error_details: string | null;

      other_error: boolean;

      python_grader_runtime_error: boolean;

      python_grader_runtime_error_details: string | null;

      python_grader_server_error: boolean;

      python_grader_server_error_type: string | null;

      sample_parse_error: boolean;

      truncated_observation_error: boolean;

      unresponsive_reward_error: boolean;
    }
  }
}

export interface GraderValidateResponse {
  /**
   * The grader used for the fine-tuning job.
   */
  grader?:
    | GraderModelsAPI.StringCheckGrader
    | GraderModelsAPI.TextSimilarityGrader
    | GraderModelsAPI.PythonGrader
    | GraderModelsAPI.ScoreModelGrader
    | GraderModelsAPI.MultiGrader;
}

export interface GraderRunParams {
  /**
   * The grader used for the fine-tuning job.
   */
  grader:
    | GraderModelsAPI.StringCheckGrader
    | GraderModelsAPI.TextSimilarityGrader
    | GraderModelsAPI.PythonGrader
    | GraderModelsAPI.ScoreModelGrader
    | GraderModelsAPI.MultiGrader;

  /**
   * The model sample to be evaluated. This value will be used to populate the
   * `sample` namespace. See
   * [the guide](https://platform.openai.com/docs/guides/graders) for more details.
   * The `output_json` variable will be populated if the model sample is a valid JSON
   * string.
   */
  model_sample: string;

  /**
   * The dataset item provided to the grader. This will be used to populate the
   * `item` namespace. See
   * [the guide](https://platform.openai.com/docs/guides/graders) for more details.
   */
  item?: unknown;
}

export interface GraderValidateParams {
  /**
   * The grader used for the fine-tuning job.
   */
  grader:
    | GraderModelsAPI.StringCheckGrader
    | GraderModelsAPI.TextSimilarityGrader
    | GraderModelsAPI.PythonGrader
    | GraderModelsAPI.ScoreModelGrader
    | GraderModelsAPI.MultiGrader;
}

export declare namespace Graders {
  export {
    type GraderRunResponse as GraderRunResponse,
    type GraderValidateResponse as GraderValidateResponse,
    type GraderRunParams as GraderRunParams,
    type GraderValidateParams as GraderValidateParams,
  };
}
