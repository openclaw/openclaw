import { APIResource } from "../../../core/resource.mjs";
import * as RunsAPI from "./runs.mjs";
import { APIPromise } from "../../../core/api-promise.mjs";
import { CursorPage, type CursorPageParams, PagePromise } from "../../../core/pagination.mjs";
import { RequestOptions } from "../../../internal/request-options.mjs";
/**
 * Manage and run evals in the OpenAI platform.
 */
export declare class OutputItems extends APIResource {
    /**
     * Get an evaluation run output item by ID.
     */
    retrieve(outputItemID: string, params: OutputItemRetrieveParams, options?: RequestOptions): APIPromise<OutputItemRetrieveResponse>;
    /**
     * Get a list of output items for an evaluation run.
     */
    list(runID: string, params: OutputItemListParams, options?: RequestOptions): PagePromise<OutputItemListResponsesPage, OutputItemListResponse>;
}
export type OutputItemListResponsesPage = CursorPage<OutputItemListResponse>;
/**
 * A schema representing an evaluation run output item.
 */
export interface OutputItemRetrieveResponse {
    /**
     * Unique identifier for the evaluation run output item.
     */
    id: string;
    /**
     * Unix timestamp (in seconds) when the evaluation run was created.
     */
    created_at: number;
    /**
     * Details of the input data source item.
     */
    datasource_item: {
        [key: string]: unknown;
    };
    /**
     * The identifier for the data source item.
     */
    datasource_item_id: number;
    /**
     * The identifier of the evaluation group.
     */
    eval_id: string;
    /**
     * The type of the object. Always "eval.run.output_item".
     */
    object: 'eval.run.output_item';
    /**
     * A list of grader results for this output item.
     */
    results: Array<OutputItemRetrieveResponse.Result>;
    /**
     * The identifier of the evaluation run associated with this output item.
     */
    run_id: string;
    /**
     * A sample containing the input and output of the evaluation run.
     */
    sample: OutputItemRetrieveResponse.Sample;
    /**
     * The status of the evaluation run.
     */
    status: string;
}
export declare namespace OutputItemRetrieveResponse {
    /**
     * A single grader result for an evaluation run output item.
     */
    interface Result {
        /**
         * The name of the grader.
         */
        name: string;
        /**
         * Whether the grader considered the output a pass.
         */
        passed: boolean;
        /**
         * The numeric score produced by the grader.
         */
        score: number;
        /**
         * Optional sample or intermediate data produced by the grader.
         */
        sample?: {
            [key: string]: unknown;
        } | null;
        /**
         * The grader type (for example, "string-check-grader").
         */
        type?: string;
        [k: string]: unknown;
    }
    /**
     * A sample containing the input and output of the evaluation run.
     */
    interface Sample {
        /**
         * An object representing an error response from the Eval API.
         */
        error: RunsAPI.EvalAPIError;
        /**
         * The reason why the sample generation was finished.
         */
        finish_reason: string;
        /**
         * An array of input messages.
         */
        input: Array<Sample.Input>;
        /**
         * The maximum number of tokens allowed for completion.
         */
        max_completion_tokens: number;
        /**
         * The model used for generating the sample.
         */
        model: string;
        /**
         * An array of output messages.
         */
        output: Array<Sample.Output>;
        /**
         * The seed used for generating the sample.
         */
        seed: number;
        /**
         * The sampling temperature used.
         */
        temperature: number;
        /**
         * The top_p value used for sampling.
         */
        top_p: number;
        /**
         * Token usage details for the sample.
         */
        usage: Sample.Usage;
    }
    namespace Sample {
        /**
         * An input message.
         */
        interface Input {
            /**
             * The content of the message.
             */
            content: string;
            /**
             * The role of the message sender (e.g., system, user, developer).
             */
            role: string;
        }
        interface Output {
            /**
             * The content of the message.
             */
            content?: string;
            /**
             * The role of the message (e.g. "system", "assistant", "user").
             */
            role?: string;
        }
        /**
         * Token usage details for the sample.
         */
        interface Usage {
            /**
             * The number of tokens retrieved from cache.
             */
            cached_tokens: number;
            /**
             * The number of completion tokens generated.
             */
            completion_tokens: number;
            /**
             * The number of prompt tokens used.
             */
            prompt_tokens: number;
            /**
             * The total number of tokens used.
             */
            total_tokens: number;
        }
    }
}
/**
 * A schema representing an evaluation run output item.
 */
export interface OutputItemListResponse {
    /**
     * Unique identifier for the evaluation run output item.
     */
    id: string;
    /**
     * Unix timestamp (in seconds) when the evaluation run was created.
     */
    created_at: number;
    /**
     * Details of the input data source item.
     */
    datasource_item: {
        [key: string]: unknown;
    };
    /**
     * The identifier for the data source item.
     */
    datasource_item_id: number;
    /**
     * The identifier of the evaluation group.
     */
    eval_id: string;
    /**
     * The type of the object. Always "eval.run.output_item".
     */
    object: 'eval.run.output_item';
    /**
     * A list of grader results for this output item.
     */
    results: Array<OutputItemListResponse.Result>;
    /**
     * The identifier of the evaluation run associated with this output item.
     */
    run_id: string;
    /**
     * A sample containing the input and output of the evaluation run.
     */
    sample: OutputItemListResponse.Sample;
    /**
     * The status of the evaluation run.
     */
    status: string;
}
export declare namespace OutputItemListResponse {
    /**
     * A single grader result for an evaluation run output item.
     */
    interface Result {
        /**
         * The name of the grader.
         */
        name: string;
        /**
         * Whether the grader considered the output a pass.
         */
        passed: boolean;
        /**
         * The numeric score produced by the grader.
         */
        score: number;
        /**
         * Optional sample or intermediate data produced by the grader.
         */
        sample?: {
            [key: string]: unknown;
        } | null;
        /**
         * The grader type (for example, "string-check-grader").
         */
        type?: string;
        [k: string]: unknown;
    }
    /**
     * A sample containing the input and output of the evaluation run.
     */
    interface Sample {
        /**
         * An object representing an error response from the Eval API.
         */
        error: RunsAPI.EvalAPIError;
        /**
         * The reason why the sample generation was finished.
         */
        finish_reason: string;
        /**
         * An array of input messages.
         */
        input: Array<Sample.Input>;
        /**
         * The maximum number of tokens allowed for completion.
         */
        max_completion_tokens: number;
        /**
         * The model used for generating the sample.
         */
        model: string;
        /**
         * An array of output messages.
         */
        output: Array<Sample.Output>;
        /**
         * The seed used for generating the sample.
         */
        seed: number;
        /**
         * The sampling temperature used.
         */
        temperature: number;
        /**
         * The top_p value used for sampling.
         */
        top_p: number;
        /**
         * Token usage details for the sample.
         */
        usage: Sample.Usage;
    }
    namespace Sample {
        /**
         * An input message.
         */
        interface Input {
            /**
             * The content of the message.
             */
            content: string;
            /**
             * The role of the message sender (e.g., system, user, developer).
             */
            role: string;
        }
        interface Output {
            /**
             * The content of the message.
             */
            content?: string;
            /**
             * The role of the message (e.g. "system", "assistant", "user").
             */
            role?: string;
        }
        /**
         * Token usage details for the sample.
         */
        interface Usage {
            /**
             * The number of tokens retrieved from cache.
             */
            cached_tokens: number;
            /**
             * The number of completion tokens generated.
             */
            completion_tokens: number;
            /**
             * The number of prompt tokens used.
             */
            prompt_tokens: number;
            /**
             * The total number of tokens used.
             */
            total_tokens: number;
        }
    }
}
export interface OutputItemRetrieveParams {
    /**
     * The ID of the evaluation to retrieve runs for.
     */
    eval_id: string;
    /**
     * The ID of the run to retrieve.
     */
    run_id: string;
}
export interface OutputItemListParams extends CursorPageParams {
    /**
     * Path param: The ID of the evaluation to retrieve runs for.
     */
    eval_id: string;
    /**
     * Query param: Sort order for output items by timestamp. Use `asc` for ascending
     * order or `desc` for descending order. Defaults to `asc`.
     */
    order?: 'asc' | 'desc';
    /**
     * Query param: Filter output items by status. Use `failed` to filter by failed
     * output items or `pass` to filter by passed output items.
     */
    status?: 'fail' | 'pass';
}
export declare namespace OutputItems {
    export { type OutputItemRetrieveResponse as OutputItemRetrieveResponse, type OutputItemListResponse as OutputItemListResponse, type OutputItemListResponsesPage as OutputItemListResponsesPage, type OutputItemRetrieveParams as OutputItemRetrieveParams, type OutputItemListParams as OutputItemListParams, };
}
//# sourceMappingURL=output-items.d.mts.map