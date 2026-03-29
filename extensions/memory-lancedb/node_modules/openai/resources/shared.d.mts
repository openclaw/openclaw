export type AllModels = (string & {}) | ChatModel | 'o1-pro' | 'o1-pro-2025-03-19' | 'o3-pro' | 'o3-pro-2025-06-10' | 'o3-deep-research' | 'o3-deep-research-2025-06-26' | 'o4-mini-deep-research' | 'o4-mini-deep-research-2025-06-26' | 'computer-use-preview' | 'computer-use-preview-2025-03-11' | 'gpt-5-codex' | 'gpt-5-pro' | 'gpt-5-pro-2025-10-06' | 'gpt-5.1-codex-max';
export type ChatModel = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.4-nano' | 'gpt-5.4-mini-2026-03-17' | 'gpt-5.4-nano-2026-03-17' | 'gpt-5.3-chat-latest' | 'gpt-5.2' | 'gpt-5.2-2025-12-11' | 'gpt-5.2-chat-latest' | 'gpt-5.2-pro' | 'gpt-5.2-pro-2025-12-11' | 'gpt-5.1' | 'gpt-5.1-2025-11-13' | 'gpt-5.1-codex' | 'gpt-5.1-mini' | 'gpt-5.1-chat-latest' | 'gpt-5' | 'gpt-5-mini' | 'gpt-5-nano' | 'gpt-5-2025-08-07' | 'gpt-5-mini-2025-08-07' | 'gpt-5-nano-2025-08-07' | 'gpt-5-chat-latest' | 'gpt-4.1' | 'gpt-4.1-mini' | 'gpt-4.1-nano' | 'gpt-4.1-2025-04-14' | 'gpt-4.1-mini-2025-04-14' | 'gpt-4.1-nano-2025-04-14' | 'o4-mini' | 'o4-mini-2025-04-16' | 'o3' | 'o3-2025-04-16' | 'o3-mini' | 'o3-mini-2025-01-31' | 'o1' | 'o1-2024-12-17' | 'o1-preview' | 'o1-preview-2024-09-12' | 'o1-mini' | 'o1-mini-2024-09-12' | 'gpt-4o' | 'gpt-4o-2024-11-20' | 'gpt-4o-2024-08-06' | 'gpt-4o-2024-05-13' | 'gpt-4o-audio-preview' | 'gpt-4o-audio-preview-2024-10-01' | 'gpt-4o-audio-preview-2024-12-17' | 'gpt-4o-audio-preview-2025-06-03' | 'gpt-4o-mini-audio-preview' | 'gpt-4o-mini-audio-preview-2024-12-17' | 'gpt-4o-search-preview' | 'gpt-4o-mini-search-preview' | 'gpt-4o-search-preview-2025-03-11' | 'gpt-4o-mini-search-preview-2025-03-11' | 'chatgpt-4o-latest' | 'codex-mini-latest' | 'gpt-4o-mini' | 'gpt-4o-mini-2024-07-18' | 'gpt-4-turbo' | 'gpt-4-turbo-2024-04-09' | 'gpt-4-0125-preview' | 'gpt-4-turbo-preview' | 'gpt-4-1106-preview' | 'gpt-4-vision-preview' | 'gpt-4' | 'gpt-4-0314' | 'gpt-4-0613' | 'gpt-4-32k' | 'gpt-4-32k-0314' | 'gpt-4-32k-0613' | 'gpt-3.5-turbo' | 'gpt-3.5-turbo-16k' | 'gpt-3.5-turbo-0301' | 'gpt-3.5-turbo-0613' | 'gpt-3.5-turbo-1106' | 'gpt-3.5-turbo-0125' | 'gpt-3.5-turbo-16k-0613';
/**
 * A filter used to compare a specified attribute key to a given value using a
 * defined comparison operation.
 */
export interface ComparisonFilter {
    /**
     * The key to compare against the value.
     */
    key: string;
    /**
     * Specifies the comparison operator: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`,
     * `nin`.
     *
     * - `eq`: equals
     * - `ne`: not equal
     * - `gt`: greater than
     * - `gte`: greater than or equal
     * - `lt`: less than
     * - `lte`: less than or equal
     * - `in`: in
     * - `nin`: not in
     */
    type: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';
    /**
     * The value to compare against the attribute key; supports string, number, or
     * boolean types.
     */
    value: string | number | boolean | Array<string | number>;
}
/**
 * Combine multiple filters using `and` or `or`.
 */
export interface CompoundFilter {
    /**
     * Array of filters to combine. Items can be `ComparisonFilter` or
     * `CompoundFilter`.
     */
    filters: Array<ComparisonFilter | unknown>;
    /**
     * Type of operation: `and` or `or`.
     */
    type: 'and' | 'or';
}
/**
 * The input format for the custom tool. Default is unconstrained text.
 */
export type CustomToolInputFormat = CustomToolInputFormat.Text | CustomToolInputFormat.Grammar;
export declare namespace CustomToolInputFormat {
    /**
     * Unconstrained free-form text.
     */
    interface Text {
        /**
         * Unconstrained text format. Always `text`.
         */
        type: 'text';
    }
    /**
     * A grammar defined by the user.
     */
    interface Grammar {
        /**
         * The grammar definition.
         */
        definition: string;
        /**
         * The syntax of the grammar definition. One of `lark` or `regex`.
         */
        syntax: 'lark' | 'regex';
        /**
         * Grammar format. Always `grammar`.
         */
        type: 'grammar';
    }
}
export interface ErrorObject {
    code: string | null;
    message: string;
    param: string | null;
    type: string;
}
export interface FunctionDefinition {
    /**
     * The name of the function to be called. Must be a-z, A-Z, 0-9, or contain
     * underscores and dashes, with a maximum length of 64.
     */
    name: string;
    /**
     * A description of what the function does, used by the model to choose when and
     * how to call the function.
     */
    description?: string;
    /**
     * The parameters the functions accepts, described as a JSON Schema object. See the
     * [guide](https://platform.openai.com/docs/guides/function-calling) for examples,
     * and the
     * [JSON Schema reference](https://json-schema.org/understanding-json-schema/) for
     * documentation about the format.
     *
     * Omitting `parameters` defines a function with an empty parameter list.
     */
    parameters?: FunctionParameters;
    /**
     * Whether to enable strict schema adherence when generating the function call. If
     * set to true, the model will follow the exact schema defined in the `parameters`
     * field. Only a subset of JSON Schema is supported when `strict` is `true`. Learn
     * more about Structured Outputs in the
     * [function calling guide](https://platform.openai.com/docs/guides/function-calling).
     */
    strict?: boolean | null;
}
/**
 * The parameters the functions accepts, described as a JSON Schema object. See the
 * [guide](https://platform.openai.com/docs/guides/function-calling) for examples,
 * and the
 * [JSON Schema reference](https://json-schema.org/understanding-json-schema/) for
 * documentation about the format.
 *
 * Omitting `parameters` defines a function with an empty parameter list.
 */
export type FunctionParameters = {
    [key: string]: unknown;
};
/**
 * Set of 16 key-value pairs that can be attached to an object. This can be useful
 * for storing additional information about the object in a structured format, and
 * querying for objects via API or the dashboard.
 *
 * Keys are strings with a maximum length of 64 characters. Values are strings with
 * a maximum length of 512 characters.
 */
export type Metadata = {
    [key: string]: string;
};
/**
 * **gpt-5 and o-series models only**
 *
 * Configuration options for
 * [reasoning models](https://platform.openai.com/docs/guides/reasoning).
 */
export interface Reasoning {
    /**
     * Constrains effort on reasoning for
     * [reasoning models](https://platform.openai.com/docs/guides/reasoning). Currently
     * supported values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
     * Reducing reasoning effort can result in faster responses and fewer tokens used
     * on reasoning in a response.
     *
     * - `gpt-5.1` defaults to `none`, which does not perform reasoning. The supported
     *   reasoning values for `gpt-5.1` are `none`, `low`, `medium`, and `high`. Tool
     *   calls are supported for all reasoning values in gpt-5.1.
     * - All models before `gpt-5.1` default to `medium` reasoning effort, and do not
     *   support `none`.
     * - The `gpt-5-pro` model defaults to (and only supports) `high` reasoning effort.
     * - `xhigh` is supported for all models after `gpt-5.1-codex-max`.
     */
    effort?: ReasoningEffort | null;
    /**
     * @deprecated **Deprecated:** use `summary` instead.
     *
     * A summary of the reasoning performed by the model. This can be useful for
     * debugging and understanding the model's reasoning process. One of `auto`,
     * `concise`, or `detailed`.
     */
    generate_summary?: 'auto' | 'concise' | 'detailed' | null;
    /**
     * A summary of the reasoning performed by the model. This can be useful for
     * debugging and understanding the model's reasoning process. One of `auto`,
     * `concise`, or `detailed`.
     *
     * `concise` is supported for `computer-use-preview` models and all reasoning
     * models after `gpt-5`.
     */
    summary?: 'auto' | 'concise' | 'detailed' | null;
}
/**
 * Constrains effort on reasoning for
 * [reasoning models](https://platform.openai.com/docs/guides/reasoning). Currently
 * supported values are `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
 * Reducing reasoning effort can result in faster responses and fewer tokens used
 * on reasoning in a response.
 *
 * - `gpt-5.1` defaults to `none`, which does not perform reasoning. The supported
 *   reasoning values for `gpt-5.1` are `none`, `low`, `medium`, and `high`. Tool
 *   calls are supported for all reasoning values in gpt-5.1.
 * - All models before `gpt-5.1` default to `medium` reasoning effort, and do not
 *   support `none`.
 * - The `gpt-5-pro` model defaults to (and only supports) `high` reasoning effort.
 * - `xhigh` is supported for all models after `gpt-5.1-codex-max`.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
/**
 * JSON object response format. An older method of generating JSON responses. Using
 * `json_schema` is recommended for models that support it. Note that the model
 * will not generate JSON without a system or user message instructing it to do so.
 */
export interface ResponseFormatJSONObject {
    /**
     * The type of response format being defined. Always `json_object`.
     */
    type: 'json_object';
}
/**
 * JSON Schema response format. Used to generate structured JSON responses. Learn
 * more about
 * [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs).
 */
export interface ResponseFormatJSONSchema {
    /**
     * Structured Outputs configuration options, including a JSON Schema.
     */
    json_schema: ResponseFormatJSONSchema.JSONSchema;
    /**
     * The type of response format being defined. Always `json_schema`.
     */
    type: 'json_schema';
}
export declare namespace ResponseFormatJSONSchema {
    /**
     * Structured Outputs configuration options, including a JSON Schema.
     */
    interface JSONSchema {
        /**
         * The name of the response format. Must be a-z, A-Z, 0-9, or contain underscores
         * and dashes, with a maximum length of 64.
         */
        name: string;
        /**
         * A description of what the response format is for, used by the model to determine
         * how to respond in the format.
         */
        description?: string;
        /**
         * The schema for the response format, described as a JSON Schema object. Learn how
         * to build JSON schemas [here](https://json-schema.org/).
         */
        schema?: {
            [key: string]: unknown;
        };
        /**
         * Whether to enable strict schema adherence when generating the output. If set to
         * true, the model will always follow the exact schema defined in the `schema`
         * field. Only a subset of JSON Schema is supported when `strict` is `true`. To
         * learn more, read the
         * [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
         */
        strict?: boolean | null;
    }
}
/**
 * Default response format. Used to generate text responses.
 */
export interface ResponseFormatText {
    /**
     * The type of response format being defined. Always `text`.
     */
    type: 'text';
}
/**
 * A custom grammar for the model to follow when generating text. Learn more in the
 * [custom grammars guide](https://platform.openai.com/docs/guides/custom-grammars).
 */
export interface ResponseFormatTextGrammar {
    /**
     * The custom grammar for the model to follow.
     */
    grammar: string;
    /**
     * The type of response format being defined. Always `grammar`.
     */
    type: 'grammar';
}
/**
 * Configure the model to generate valid Python code. See the
 * [custom grammars guide](https://platform.openai.com/docs/guides/custom-grammars)
 * for more details.
 */
export interface ResponseFormatTextPython {
    /**
     * The type of response format being defined. Always `python`.
     */
    type: 'python';
}
export type ResponsesModel = (string & {}) | ChatModel | 'o1-pro' | 'o1-pro-2025-03-19' | 'o3-pro' | 'o3-pro-2025-06-10' | 'o3-deep-research' | 'o3-deep-research-2025-06-26' | 'o4-mini-deep-research' | 'o4-mini-deep-research-2025-06-26' | 'computer-use-preview' | 'computer-use-preview-2025-03-11' | 'gpt-5-codex' | 'gpt-5-pro' | 'gpt-5-pro-2025-10-06' | 'gpt-5.1-codex-max';
//# sourceMappingURL=shared.d.mts.map