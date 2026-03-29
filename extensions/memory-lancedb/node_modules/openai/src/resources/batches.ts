// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import * as BatchesAPI from './batches';
import * as Shared from './shared';
import { APIPromise } from '../core/api-promise';
import { CursorPage, type CursorPageParams, PagePromise } from '../core/pagination';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

/**
 * Create large batches of API requests to run asynchronously.
 */
export class Batches extends APIResource {
  /**
   * Creates and executes a batch from an uploaded file of requests
   */
  create(body: BatchCreateParams, options?: RequestOptions): APIPromise<Batch> {
    return this._client.post('/batches', { body, ...options });
  }

  /**
   * Retrieves a batch.
   */
  retrieve(batchID: string, options?: RequestOptions): APIPromise<Batch> {
    return this._client.get(path`/batches/${batchID}`, options);
  }

  /**
   * List your organization's batches.
   */
  list(
    query: BatchListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<BatchesPage, Batch> {
    return this._client.getAPIList('/batches', CursorPage<Batch>, { query, ...options });
  }

  /**
   * Cancels an in-progress batch. The batch will be in status `cancelling` for up to
   * 10 minutes, before changing to `cancelled`, where it will have partial results
   * (if any) available in the output file.
   */
  cancel(batchID: string, options?: RequestOptions): APIPromise<Batch> {
    return this._client.post(path`/batches/${batchID}/cancel`, options);
  }
}

export type BatchesPage = CursorPage<Batch>;

export interface Batch {
  id: string;

  /**
   * The time frame within which the batch should be processed.
   */
  completion_window: string;

  /**
   * The Unix timestamp (in seconds) for when the batch was created.
   */
  created_at: number;

  /**
   * The OpenAI API endpoint used by the batch.
   */
  endpoint: string;

  /**
   * The ID of the input file for the batch.
   */
  input_file_id: string;

  /**
   * The object type, which is always `batch`.
   */
  object: 'batch';

  /**
   * The current status of the batch.
   */
  status:
    | 'validating'
    | 'failed'
    | 'in_progress'
    | 'finalizing'
    | 'completed'
    | 'expired'
    | 'cancelling'
    | 'cancelled';

  /**
   * The Unix timestamp (in seconds) for when the batch was cancelled.
   */
  cancelled_at?: number;

  /**
   * The Unix timestamp (in seconds) for when the batch started cancelling.
   */
  cancelling_at?: number;

  /**
   * The Unix timestamp (in seconds) for when the batch was completed.
   */
  completed_at?: number;

  /**
   * The ID of the file containing the outputs of requests with errors.
   */
  error_file_id?: string;

  errors?: Batch.Errors;

  /**
   * The Unix timestamp (in seconds) for when the batch expired.
   */
  expired_at?: number;

  /**
   * The Unix timestamp (in seconds) for when the batch will expire.
   */
  expires_at?: number;

  /**
   * The Unix timestamp (in seconds) for when the batch failed.
   */
  failed_at?: number;

  /**
   * The Unix timestamp (in seconds) for when the batch started finalizing.
   */
  finalizing_at?: number;

  /**
   * The Unix timestamp (in seconds) for when the batch started processing.
   */
  in_progress_at?: number;

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
   * Model ID used to process the batch, like `gpt-5-2025-08-07`. OpenAI offers a
   * wide range of models with different capabilities, performance characteristics,
   * and price points. Refer to the
   * [model guide](https://platform.openai.com/docs/models) to browse and compare
   * available models.
   */
  model?: string;

  /**
   * The ID of the file containing the outputs of successfully executed requests.
   */
  output_file_id?: string;

  /**
   * The request counts for different statuses within the batch.
   */
  request_counts?: BatchRequestCounts;

  /**
   * Represents token usage details including input tokens, output tokens, a
   * breakdown of output tokens, and the total tokens used. Only populated on batches
   * created after September 7, 2025.
   */
  usage?: BatchUsage;
}

export namespace Batch {
  export interface Errors {
    data?: Array<BatchesAPI.BatchError>;

    /**
     * The object type, which is always `list`.
     */
    object?: string;
  }
}

export interface BatchError {
  /**
   * An error code identifying the error type.
   */
  code?: string;

  /**
   * The line number of the input file where the error occurred, if applicable.
   */
  line?: number | null;

  /**
   * A human-readable message providing more details about the error.
   */
  message?: string;

  /**
   * The name of the parameter that caused the error, if applicable.
   */
  param?: string | null;
}

/**
 * The request counts for different statuses within the batch.
 */
export interface BatchRequestCounts {
  /**
   * Number of requests that have been completed successfully.
   */
  completed: number;

  /**
   * Number of requests that have failed.
   */
  failed: number;

  /**
   * Total number of requests in the batch.
   */
  total: number;
}

/**
 * Represents token usage details including input tokens, output tokens, a
 * breakdown of output tokens, and the total tokens used. Only populated on batches
 * created after September 7, 2025.
 */
export interface BatchUsage {
  /**
   * The number of input tokens.
   */
  input_tokens: number;

  /**
   * A detailed breakdown of the input tokens.
   */
  input_tokens_details: BatchUsage.InputTokensDetails;

  /**
   * The number of output tokens.
   */
  output_tokens: number;

  /**
   * A detailed breakdown of the output tokens.
   */
  output_tokens_details: BatchUsage.OutputTokensDetails;

  /**
   * The total number of tokens used.
   */
  total_tokens: number;
}

export namespace BatchUsage {
  /**
   * A detailed breakdown of the input tokens.
   */
  export interface InputTokensDetails {
    /**
     * The number of tokens that were retrieved from the cache.
     * [More on prompt caching](https://platform.openai.com/docs/guides/prompt-caching).
     */
    cached_tokens: number;
  }

  /**
   * A detailed breakdown of the output tokens.
   */
  export interface OutputTokensDetails {
    /**
     * The number of reasoning tokens.
     */
    reasoning_tokens: number;
  }
}

export interface BatchCreateParams {
  /**
   * The time frame within which the batch should be processed. Currently only `24h`
   * is supported.
   */
  completion_window: '24h';

  /**
   * The endpoint to be used for all requests in the batch. Currently
   * `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/completions`,
   * `/v1/moderations`, `/v1/images/generations`, `/v1/images/edits`, and
   * `/v1/videos` are supported. Note that `/v1/embeddings` batches are also
   * restricted to a maximum of 50,000 embedding inputs across all requests in the
   * batch.
   */
  endpoint:
    | '/v1/responses'
    | '/v1/chat/completions'
    | '/v1/embeddings'
    | '/v1/completions'
    | '/v1/moderations'
    | '/v1/images/generations'
    | '/v1/images/edits'
    | '/v1/videos';

  /**
   * The ID of an uploaded file that contains requests for the new batch.
   *
   * See [upload file](https://platform.openai.com/docs/api-reference/files/create)
   * for how to upload a file.
   *
   * Your input file must be formatted as a
   * [JSONL file](https://platform.openai.com/docs/api-reference/batch/request-input),
   * and must be uploaded with the purpose `batch`. The file can contain up to 50,000
   * requests, and can be up to 200 MB in size.
   */
  input_file_id: string;

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
   * The expiration policy for the output and/or error file that are generated for a
   * batch.
   */
  output_expires_after?: BatchCreateParams.OutputExpiresAfter;
}

export namespace BatchCreateParams {
  /**
   * The expiration policy for the output and/or error file that are generated for a
   * batch.
   */
  export interface OutputExpiresAfter {
    /**
     * Anchor timestamp after which the expiration policy applies. Supported anchors:
     * `created_at`. Note that the anchor is the file creation time, not the time the
     * batch is created.
     */
    anchor: 'created_at';

    /**
     * The number of seconds after the anchor time that the file will expire. Must be
     * between 3600 (1 hour) and 2592000 (30 days).
     */
    seconds: number;
  }
}

export interface BatchListParams extends CursorPageParams {}

export declare namespace Batches {
  export {
    type Batch as Batch,
    type BatchError as BatchError,
    type BatchRequestCounts as BatchRequestCounts,
    type BatchUsage as BatchUsage,
    type BatchesPage as BatchesPage,
    type BatchCreateParams as BatchCreateParams,
    type BatchListParams as BatchListParams,
  };
}
