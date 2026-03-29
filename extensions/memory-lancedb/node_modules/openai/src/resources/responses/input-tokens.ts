// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import * as Shared from '../shared';
import * as ResponsesAPI from './responses';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class InputTokens extends APIResource {
  /**
   * Returns input token counts of the request.
   *
   * Returns an object with `object` set to `response.input_tokens` and an
   * `input_tokens` count.
   *
   * @example
   * ```ts
   * const response = await client.responses.inputTokens.count();
   * ```
   */
  count(
    body: InputTokenCountParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<InputTokenCountResponse> {
    return this._client.post('/responses/input_tokens', { body, ...options });
  }
}

export interface InputTokenCountResponse {
  input_tokens: number;

  object: 'response.input_tokens';
}

export interface InputTokenCountParams {
  /**
   * The conversation that this response belongs to. Items from this conversation are
   * prepended to `input_items` for this response request. Input items and output
   * items from this response are automatically added to this conversation after this
   * response completes.
   */
  conversation?: string | ResponsesAPI.ResponseConversationParam | null;

  /**
   * Text, image, or file inputs to the model, used to generate a response
   */
  input?: string | Array<ResponsesAPI.ResponseInputItem> | null;

  /**
   * A system (or developer) message inserted into the model's context. When used
   * along with `previous_response_id`, the instructions from a previous response
   * will not be carried over to the next response. This makes it simple to swap out
   * system (or developer) messages in new responses.
   */
  instructions?: string | null;

  /**
   * Model ID used to generate the response, like `gpt-4o` or `o3`. OpenAI offers a
   * wide range of models with different capabilities, performance characteristics,
   * and price points. Refer to the
   * [model guide](https://platform.openai.com/docs/models) to browse and compare
   * available models.
   */
  model?: string | null;

  /**
   * Whether to allow the model to run tool calls in parallel.
   */
  parallel_tool_calls?: boolean | null;

  /**
   * The unique ID of the previous response to the model. Use this to create
   * multi-turn conversations. Learn more about
   * [conversation state](https://platform.openai.com/docs/guides/conversation-state).
   * Cannot be used in conjunction with `conversation`.
   */
  previous_response_id?: string | null;

  /**
   * **gpt-5 and o-series models only** Configuration options for
   * [reasoning models](https://platform.openai.com/docs/guides/reasoning).
   */
  reasoning?: Shared.Reasoning | null;

  /**
   * Configuration options for a text response from the model. Can be plain text or
   * structured JSON data. Learn more:
   *
   * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
   * - [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
   */
  text?: InputTokenCountParams.Text | null;

  /**
   * Controls which tool the model should use, if any.
   */
  tool_choice?:
    | ResponsesAPI.ToolChoiceOptions
    | ResponsesAPI.ToolChoiceAllowed
    | ResponsesAPI.ToolChoiceTypes
    | ResponsesAPI.ToolChoiceFunction
    | ResponsesAPI.ToolChoiceMcp
    | ResponsesAPI.ToolChoiceCustom
    | ResponsesAPI.ToolChoiceApplyPatch
    | ResponsesAPI.ToolChoiceShell
    | null;

  /**
   * An array of tools the model may call while generating a response. You can
   * specify which tool to use by setting the `tool_choice` parameter.
   */
  tools?: Array<ResponsesAPI.Tool> | null;

  /**
   * The truncation strategy to use for the model response. - `auto`: If the input to
   * this Response exceeds the model's context window size, the model will truncate
   * the response to fit the context window by dropping items from the beginning of
   * the conversation. - `disabled` (default): If the input size will exceed the
   * context window size for a model, the request will fail with a 400 error.
   */
  truncation?: 'auto' | 'disabled';
}

export namespace InputTokenCountParams {
  /**
   * Configuration options for a text response from the model. Can be plain text or
   * structured JSON data. Learn more:
   *
   * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
   * - [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
   */
  export interface Text {
    /**
     * An object specifying the format that the model must output.
     *
     * Configuring `{ "type": "json_schema" }` enables Structured Outputs, which
     * ensures the model will match your supplied JSON schema. Learn more in the
     * [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
     *
     * The default format is `{ "type": "text" }` with no additional options.
     *
     * **Not recommended for gpt-4o and newer models:**
     *
     * Setting to `{ "type": "json_object" }` enables the older JSON mode, which
     * ensures the message the model generates is valid JSON. Using `json_schema` is
     * preferred for models that support it.
     */
    format?: ResponsesAPI.ResponseFormatTextConfig;

    /**
     * Constrains the verbosity of the model's response. Lower values will result in
     * more concise responses, while higher values will result in more verbose
     * responses. Currently supported values are `low`, `medium`, and `high`.
     */
    verbosity?: 'low' | 'medium' | 'high' | null;
  }
}

export declare namespace InputTokens {
  export {
    type InputTokenCountResponse as InputTokenCountResponse,
    type InputTokenCountParams as InputTokenCountParams,
  };
}
