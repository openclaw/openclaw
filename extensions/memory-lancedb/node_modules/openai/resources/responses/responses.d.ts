import { type ExtractParsedContentFromParams, type ResponseCreateParamsWithTools } from "../../lib/ResponsesParser.js";
import { ResponseStream, ResponseStreamParams } from "../../lib/responses/ResponseStream.js";
import { APIResource } from "../../core/resource.js";
import * as ResponsesAPI from "./responses.js";
import * as Shared from "../shared.js";
import * as InputItemsAPI from "./input-items.js";
import { InputItemListParams, InputItems, ResponseItemList } from "./input-items.js";
import * as InputTokensAPI from "./input-tokens.js";
import { InputTokenCountParams, InputTokenCountResponse, InputTokens } from "./input-tokens.js";
import { APIPromise } from "../../core/api-promise.js";
import { CursorPage } from "../../core/pagination.js";
import { Stream } from "../../core/streaming.js";
import { RequestOptions } from "../../internal/request-options.js";
export interface ParsedResponseOutputText<ParsedT> extends ResponseOutputText {
    parsed: ParsedT | null;
}
export type ParsedContent<ParsedT> = ParsedResponseOutputText<ParsedT> | ResponseOutputRefusal;
export interface ParsedResponseOutputMessage<ParsedT> extends ResponseOutputMessage {
    content: ParsedContent<ParsedT>[];
}
export interface ParsedResponseFunctionToolCall extends ResponseFunctionToolCall {
    parsed_arguments: any;
}
export type ParsedResponseOutputItem<ParsedT> = ParsedResponseOutputMessage<ParsedT> | ParsedResponseFunctionToolCall | ResponseFileSearchToolCall | ResponseFunctionToolCallOutputItem | ResponseFunctionWebSearch | ResponseComputerToolCall | ResponseComputerToolCallOutputItem | ResponseToolSearchCall | ResponseToolSearchOutputItem | ResponseReasoningItem | ResponseCompactionItem | ResponseOutputItem.ImageGenerationCall | ResponseCodeInterpreterToolCall | ResponseOutputItem.LocalShellCall | ResponseOutputItem.LocalShellCallOutput | ResponseFunctionShellToolCall | ResponseFunctionShellToolCallOutput | ResponseApplyPatchToolCall | ResponseApplyPatchToolCallOutput | ResponseOutputItem.McpCall | ResponseOutputItem.McpListTools | ResponseOutputItem.McpApprovalRequest | ResponseOutputItem.McpApprovalResponse | ResponseCustomToolCall | ResponseCustomToolCallOutputItem;
export interface ParsedResponse<ParsedT> extends Response {
    output: Array<ParsedResponseOutputItem<ParsedT>>;
    output_parsed: ParsedT | null;
}
export type ResponseParseParams = ResponseCreateParamsNonStreaming;
export declare class Responses extends APIResource {
    inputItems: InputItemsAPI.InputItems;
    inputTokens: InputTokensAPI.InputTokens;
    /**
     * Creates a model response. Provide
     * [text](https://platform.openai.com/docs/guides/text) or
     * [image](https://platform.openai.com/docs/guides/images) inputs to generate
     * [text](https://platform.openai.com/docs/guides/text) or
     * [JSON](https://platform.openai.com/docs/guides/structured-outputs) outputs. Have
     * the model call your own
     * [custom code](https://platform.openai.com/docs/guides/function-calling) or use
     * built-in [tools](https://platform.openai.com/docs/guides/tools) like
     * [web search](https://platform.openai.com/docs/guides/tools-web-search) or
     * [file search](https://platform.openai.com/docs/guides/tools-file-search) to use
     * your own data as input for the model's response.
     *
     * @example
     * ```ts
     * const response = await client.responses.create();
     * ```
     */
    create(body: ResponseCreateParamsNonStreaming, options?: RequestOptions): APIPromise<Response>;
    create(body: ResponseCreateParamsStreaming, options?: RequestOptions): APIPromise<Stream<ResponseStreamEvent>>;
    create(body: ResponseCreateParamsBase, options?: RequestOptions): APIPromise<Stream<ResponseStreamEvent> | Response>;
    /**
     * Retrieves a model response with the given ID.
     *
     * @example
     * ```ts
     * const response = await client.responses.retrieve(
     *   'resp_677efb5139a88190b512bc3fef8e535d',
     * );
     * ```
     */
    retrieve(responseID: string, query?: ResponseRetrieveParamsNonStreaming, options?: RequestOptions): APIPromise<Response>;
    retrieve(responseID: string, query: ResponseRetrieveParamsStreaming, options?: RequestOptions): APIPromise<Stream<ResponseStreamEvent>>;
    retrieve(responseID: string, query?: ResponseRetrieveParamsBase | undefined, options?: RequestOptions): APIPromise<Stream<ResponseStreamEvent> | Response>;
    /**
     * Deletes a model response with the given ID.
     *
     * @example
     * ```ts
     * await client.responses.delete(
     *   'resp_677efb5139a88190b512bc3fef8e535d',
     * );
     * ```
     */
    delete(responseID: string, options?: RequestOptions): APIPromise<void>;
    parse<Params extends ResponseCreateParamsWithTools, ParsedT = ExtractParsedContentFromParams<Params>>(body: Params, options?: RequestOptions): APIPromise<ParsedResponse<ParsedT>>;
    /**
     * Creates a model response stream
     */
    stream<Params extends ResponseStreamParams, ParsedT = ExtractParsedContentFromParams<Params>>(body: Params, options?: RequestOptions): ResponseStream<ParsedT>;
    /**
     * Cancels a model response with the given ID. Only responses created with the
     * `background` parameter set to `true` can be cancelled.
     * [Learn more](https://platform.openai.com/docs/guides/background).
     *
     * @example
     * ```ts
     * const response = await client.responses.cancel(
     *   'resp_677efb5139a88190b512bc3fef8e535d',
     * );
     * ```
     */
    cancel(responseID: string, options?: RequestOptions): APIPromise<Response>;
    /**
     * Compact a conversation. Returns a compacted response object.
     *
     * Learn when and how to compact long-running conversations in the
     * [conversation state guide](https://platform.openai.com/docs/guides/conversation-state#managing-the-context-window).
     * For ZDR-compatible compaction details, see
     * [Compaction (advanced)](https://platform.openai.com/docs/guides/conversation-state#compaction-advanced).
     *
     * @example
     * ```ts
     * const compactedResponse = await client.responses.compact({
     *   model: 'gpt-5.4',
     * });
     * ```
     */
    compact(body: ResponseCompactParams, options?: RequestOptions): APIPromise<CompactedResponse>;
}
export type ResponseItemsPage = CursorPage<ResponseItem>;
/**
 * Allows the assistant to create, delete, or update files using unified diffs.
 */
export interface ApplyPatchTool {
    /**
     * The type of the tool. Always `apply_patch`.
     */
    type: 'apply_patch';
}
export interface CompactedResponse {
    /**
     * The unique identifier for the compacted response.
     */
    id: string;
    /**
     * Unix timestamp (in seconds) when the compacted conversation was created.
     */
    created_at: number;
    /**
     * The object type. Always `response.compaction`.
     */
    object: 'response.compaction';
    /**
     * The compacted list of output items. This is a list of all user messages,
     * followed by a single compaction item.
     */
    output: Array<ResponseOutputItem>;
    /**
     * Token accounting for the compaction pass, including cached, reasoning, and total
     * tokens.
     */
    usage: ResponseUsage;
}
/**
 * A click action.
 */
export type ComputerAction = ComputerAction.Click | ComputerAction.DoubleClick | ComputerAction.Drag | ComputerAction.Keypress | ComputerAction.Move | ComputerAction.Screenshot | ComputerAction.Scroll | ComputerAction.Type | ComputerAction.Wait;
export declare namespace ComputerAction {
    /**
     * A click action.
     */
    interface Click {
        /**
         * Indicates which mouse button was pressed during the click. One of `left`,
         * `right`, `wheel`, `back`, or `forward`.
         */
        button: 'left' | 'right' | 'wheel' | 'back' | 'forward';
        /**
         * Specifies the event type. For a click action, this property is always `click`.
         */
        type: 'click';
        /**
         * The x-coordinate where the click occurred.
         */
        x: number;
        /**
         * The y-coordinate where the click occurred.
         */
        y: number;
        /**
         * The keys being held while clicking.
         */
        keys?: Array<string> | null;
    }
    /**
     * A double click action.
     */
    interface DoubleClick {
        /**
         * The keys being held while double-clicking.
         */
        keys: Array<string> | null;
        /**
         * Specifies the event type. For a double click action, this property is always set
         * to `double_click`.
         */
        type: 'double_click';
        /**
         * The x-coordinate where the double click occurred.
         */
        x: number;
        /**
         * The y-coordinate where the double click occurred.
         */
        y: number;
    }
    /**
     * A drag action.
     */
    interface Drag {
        /**
         * An array of coordinates representing the path of the drag action. Coordinates
         * will appear as an array of objects, eg
         *
         * ```
         * [
         *   { x: 100, y: 200 },
         *   { x: 200, y: 300 }
         * ]
         * ```
         */
        path: Array<Drag.Path>;
        /**
         * Specifies the event type. For a drag action, this property is always set to
         * `drag`.
         */
        type: 'drag';
        /**
         * The keys being held while dragging the mouse.
         */
        keys?: Array<string> | null;
    }
    namespace Drag {
        /**
         * An x/y coordinate pair, e.g. `{ x: 100, y: 200 }`.
         */
        interface Path {
            /**
             * The x-coordinate.
             */
            x: number;
            /**
             * The y-coordinate.
             */
            y: number;
        }
    }
    /**
     * A collection of keypresses the model would like to perform.
     */
    interface Keypress {
        /**
         * The combination of keys the model is requesting to be pressed. This is an array
         * of strings, each representing a key.
         */
        keys: Array<string>;
        /**
         * Specifies the event type. For a keypress action, this property is always set to
         * `keypress`.
         */
        type: 'keypress';
    }
    /**
     * A mouse move action.
     */
    interface Move {
        /**
         * Specifies the event type. For a move action, this property is always set to
         * `move`.
         */
        type: 'move';
        /**
         * The x-coordinate to move to.
         */
        x: number;
        /**
         * The y-coordinate to move to.
         */
        y: number;
        /**
         * The keys being held while moving the mouse.
         */
        keys?: Array<string> | null;
    }
    /**
     * A screenshot action.
     */
    interface Screenshot {
        /**
         * Specifies the event type. For a screenshot action, this property is always set
         * to `screenshot`.
         */
        type: 'screenshot';
    }
    /**
     * A scroll action.
     */
    interface Scroll {
        /**
         * The horizontal scroll distance.
         */
        scroll_x: number;
        /**
         * The vertical scroll distance.
         */
        scroll_y: number;
        /**
         * Specifies the event type. For a scroll action, this property is always set to
         * `scroll`.
         */
        type: 'scroll';
        /**
         * The x-coordinate where the scroll occurred.
         */
        x: number;
        /**
         * The y-coordinate where the scroll occurred.
         */
        y: number;
        /**
         * The keys being held while scrolling.
         */
        keys?: Array<string> | null;
    }
    /**
     * An action to type in text.
     */
    interface Type {
        /**
         * The text to type.
         */
        text: string;
        /**
         * Specifies the event type. For a type action, this property is always set to
         * `type`.
         */
        type: 'type';
    }
    /**
     * A wait action.
     */
    interface Wait {
        /**
         * Specifies the event type. For a wait action, this property is always set to
         * `wait`.
         */
        type: 'wait';
    }
}
/**
 * Flattened batched actions for `computer_use`. Each action includes an `type`
 * discriminator and action-specific fields.
 */
export type ComputerActionList = Array<ComputerAction>;
/**
 * A tool that controls a virtual computer. Learn more about the
 * [computer tool](https://platform.openai.com/docs/guides/tools-computer-use).
 */
export interface ComputerTool {
    /**
     * The type of the computer tool. Always `computer`.
     */
    type: 'computer';
}
/**
 * A tool that controls a virtual computer. Learn more about the
 * [computer tool](https://platform.openai.com/docs/guides/tools-computer-use).
 */
export interface ComputerUsePreviewTool {
    /**
     * The height of the computer display.
     */
    display_height: number;
    /**
     * The width of the computer display.
     */
    display_width: number;
    /**
     * The type of computer environment to control.
     */
    environment: 'windows' | 'mac' | 'linux' | 'ubuntu' | 'browser';
    /**
     * The type of the computer use tool. Always `computer_use_preview`.
     */
    type: 'computer_use_preview';
}
export interface ContainerAuto {
    /**
     * Automatically creates a container for this request
     */
    type: 'container_auto';
    /**
     * An optional list of uploaded files to make available to your code.
     */
    file_ids?: Array<string>;
    /**
     * The memory limit for the container.
     */
    memory_limit?: '1g' | '4g' | '16g' | '64g' | null;
    /**
     * Network access policy for the container.
     */
    network_policy?: ContainerNetworkPolicyDisabled | ContainerNetworkPolicyAllowlist;
    /**
     * An optional list of skills referenced by id or inline data.
     */
    skills?: Array<SkillReference | InlineSkill>;
}
export interface ContainerNetworkPolicyAllowlist {
    /**
     * A list of allowed domains when type is `allowlist`.
     */
    allowed_domains: Array<string>;
    /**
     * Allow outbound network access only to specified domains. Always `allowlist`.
     */
    type: 'allowlist';
    /**
     * Optional domain-scoped secrets for allowlisted domains.
     */
    domain_secrets?: Array<ContainerNetworkPolicyDomainSecret>;
}
export interface ContainerNetworkPolicyDisabled {
    /**
     * Disable outbound network access. Always `disabled`.
     */
    type: 'disabled';
}
export interface ContainerNetworkPolicyDomainSecret {
    /**
     * The domain associated with the secret.
     */
    domain: string;
    /**
     * The name of the secret to inject for the domain.
     */
    name: string;
    /**
     * The secret value to inject for the domain.
     */
    value: string;
}
export interface ContainerReference {
    /**
     * The ID of the referenced container.
     */
    container_id: string;
    /**
     * References a container created with the /v1/containers endpoint
     */
    type: 'container_reference';
}
/**
 * A custom tool that processes input using a specified format. Learn more about
 * [custom tools](https://platform.openai.com/docs/guides/function-calling#custom-tools)
 */
export interface CustomTool {
    /**
     * The name of the custom tool, used to identify it in tool calls.
     */
    name: string;
    /**
     * The type of the custom tool. Always `custom`.
     */
    type: 'custom';
    /**
     * Whether this tool should be deferred and discovered via tool search.
     */
    defer_loading?: boolean;
    /**
     * Optional description of the custom tool, used to provide more context.
     */
    description?: string;
    /**
     * The input format for the custom tool. Default is unconstrained text.
     */
    format?: Shared.CustomToolInputFormat;
}
/**
 * A message input to the model with a role indicating instruction following
 * hierarchy. Instructions given with the `developer` or `system` role take
 * precedence over instructions given with the `user` role. Messages with the
 * `assistant` role are presumed to have been generated by the model in previous
 * interactions.
 */
export interface EasyInputMessage {
    /**
     * Text, image, or audio input to the model, used to generate a response. Can also
     * contain previous assistant responses.
     */
    content: string | ResponseInputMessageContentList;
    /**
     * The role of the message input. One of `user`, `assistant`, `system`, or
     * `developer`.
     */
    role: 'user' | 'assistant' | 'system' | 'developer';
    /**
     * Labels an `assistant` message as intermediate commentary (`commentary`) or the
     * final answer (`final_answer`). For models like `gpt-5.3-codex` and beyond, when
     * sending follow-up requests, preserve and resend phase on all assistant messages
     * — dropping it can degrade performance. Not used for user messages.
     */
    phase?: 'commentary' | 'final_answer' | null;
    /**
     * The type of the message input. Always `message`.
     */
    type?: 'message';
}
/**
 * A tool that searches for relevant content from uploaded files. Learn more about
 * the
 * [file search tool](https://platform.openai.com/docs/guides/tools-file-search).
 */
export interface FileSearchTool {
    /**
     * The type of the file search tool. Always `file_search`.
     */
    type: 'file_search';
    /**
     * The IDs of the vector stores to search.
     */
    vector_store_ids: Array<string>;
    /**
     * A filter to apply.
     */
    filters?: Shared.ComparisonFilter | Shared.CompoundFilter | null;
    /**
     * The maximum number of results to return. This number should be between 1 and 50
     * inclusive.
     */
    max_num_results?: number;
    /**
     * Ranking options for search.
     */
    ranking_options?: FileSearchTool.RankingOptions;
}
export declare namespace FileSearchTool {
    /**
     * Ranking options for search.
     */
    interface RankingOptions {
        /**
         * Weights that control how reciprocal rank fusion balances semantic embedding
         * matches versus sparse keyword matches when hybrid search is enabled.
         */
        hybrid_search?: RankingOptions.HybridSearch;
        /**
         * The ranker to use for the file search.
         */
        ranker?: 'auto' | 'default-2024-11-15';
        /**
         * The score threshold for the file search, a number between 0 and 1. Numbers
         * closer to 1 will attempt to return only the most relevant results, but may
         * return fewer results.
         */
        score_threshold?: number;
    }
    namespace RankingOptions {
        /**
         * Weights that control how reciprocal rank fusion balances semantic embedding
         * matches versus sparse keyword matches when hybrid search is enabled.
         */
        interface HybridSearch {
            /**
             * The weight of the embedding in the reciprocal ranking fusion.
             */
            embedding_weight: number;
            /**
             * The weight of the text in the reciprocal ranking fusion.
             */
            text_weight: number;
        }
    }
}
/**
 * A tool that allows the model to execute shell commands.
 */
export interface FunctionShellTool {
    /**
     * The type of the shell tool. Always `shell`.
     */
    type: 'shell';
    environment?: ContainerAuto | LocalEnvironment | ContainerReference | null;
}
/**
 * Defines a function in your own code the model can choose to call. Learn more
 * about
 * [function calling](https://platform.openai.com/docs/guides/function-calling).
 */
export interface FunctionTool {
    /**
     * The name of the function to call.
     */
    name: string;
    /**
     * A JSON schema object describing the parameters of the function.
     */
    parameters: {
        [key: string]: unknown;
    } | null;
    /**
     * Whether to enforce strict parameter validation. Default `true`.
     */
    strict: boolean | null;
    /**
     * The type of the function tool. Always `function`.
     */
    type: 'function';
    /**
     * Whether this function is deferred and loaded via tool search.
     */
    defer_loading?: boolean;
    /**
     * A description of the function. Used by the model to determine whether or not to
     * call the function.
     */
    description?: string | null;
}
export interface InlineSkill {
    /**
     * The description of the skill.
     */
    description: string;
    /**
     * The name of the skill.
     */
    name: string;
    /**
     * Inline skill payload
     */
    source: InlineSkillSource;
    /**
     * Defines an inline skill for this request.
     */
    type: 'inline';
}
/**
 * Inline skill payload
 */
export interface InlineSkillSource {
    /**
     * Base64-encoded skill zip bundle.
     */
    data: string;
    /**
     * The media type of the inline skill payload. Must be `application/zip`.
     */
    media_type: 'application/zip';
    /**
     * The type of the inline skill source. Must be `base64`.
     */
    type: 'base64';
}
export interface LocalEnvironment {
    /**
     * Use a local computer environment.
     */
    type: 'local';
    /**
     * An optional list of skills.
     */
    skills?: Array<LocalSkill>;
}
export interface LocalSkill {
    /**
     * The description of the skill.
     */
    description: string;
    /**
     * The name of the skill.
     */
    name: string;
    /**
     * The path to the directory containing the skill.
     */
    path: string;
}
/**
 * Groups function/custom tools under a shared namespace.
 */
export interface NamespaceTool {
    /**
     * A description of the namespace shown to the model.
     */
    description: string;
    /**
     * The namespace name used in tool calls (for example, `crm`).
     */
    name: string;
    /**
     * The function/custom tools available inside this namespace.
     */
    tools: Array<NamespaceTool.Function | CustomTool>;
    /**
     * The type of the tool. Always `namespace`.
     */
    type: 'namespace';
}
export declare namespace NamespaceTool {
    interface Function {
        name: string;
        type: 'function';
        /**
         * Whether this function should be deferred and discovered via tool search.
         */
        defer_loading?: boolean;
        description?: string | null;
        parameters?: unknown | null;
        strict?: boolean | null;
    }
}
export interface Response {
    /**
     * Unique identifier for this Response.
     */
    id: string;
    /**
     * Unix timestamp (in seconds) of when this Response was created.
     */
    created_at: number;
    output_text: string;
    /**
     * An error object returned when the model fails to generate a Response.
     */
    error: ResponseError | null;
    /**
     * Details about why the response is incomplete.
     */
    incomplete_details: Response.IncompleteDetails | null;
    /**
     * A system (or developer) message inserted into the model's context.
     *
     * When using along with `previous_response_id`, the instructions from a previous
     * response will not be carried over to the next response. This makes it simple to
     * swap out system (or developer) messages in new responses.
     */
    instructions: string | Array<ResponseInputItem> | null;
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
     * Model ID used to generate the response, like `gpt-4o` or `o3`. OpenAI offers a
     * wide range of models with different capabilities, performance characteristics,
     * and price points. Refer to the
     * [model guide](https://platform.openai.com/docs/models) to browse and compare
     * available models.
     */
    model: Shared.ResponsesModel;
    /**
     * The object type of this resource - always set to `response`.
     */
    object: 'response';
    /**
     * An array of content items generated by the model.
     *
     * - The length and order of items in the `output` array is dependent on the
     *   model's response.
     * - Rather than accessing the first item in the `output` array and assuming it's
     *   an `assistant` message with the content generated by the model, you might
     *   consider using the `output_text` property where supported in SDKs.
     */
    output: Array<ResponseOutputItem>;
    /**
     * Whether to allow the model to run tool calls in parallel.
     */
    parallel_tool_calls: boolean;
    /**
     * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will
     * make the output more random, while lower values like 0.2 will make it more
     * focused and deterministic. We generally recommend altering this or `top_p` but
     * not both.
     */
    temperature: number | null;
    /**
     * How the model should select which tool (or tools) to use when generating a
     * response. See the `tools` parameter to see how to specify which tools the model
     * can call.
     */
    tool_choice: ToolChoiceOptions | ToolChoiceAllowed | ToolChoiceTypes | ToolChoiceFunction | ToolChoiceMcp | ToolChoiceCustom | ToolChoiceApplyPatch | ToolChoiceShell;
    /**
     * An array of tools the model may call while generating a response. You can
     * specify which tool to use by setting the `tool_choice` parameter.
     *
     * We support the following categories of tools:
     *
     * - **Built-in tools**: Tools that are provided by OpenAI that extend the model's
     *   capabilities, like
     *   [web search](https://platform.openai.com/docs/guides/tools-web-search) or
     *   [file search](https://platform.openai.com/docs/guides/tools-file-search).
     *   Learn more about
     *   [built-in tools](https://platform.openai.com/docs/guides/tools).
     * - **MCP Tools**: Integrations with third-party systems via custom MCP servers or
     *   predefined connectors such as Google Drive and SharePoint. Learn more about
     *   [MCP Tools](https://platform.openai.com/docs/guides/tools-connectors-mcp).
     * - **Function calls (custom tools)**: Functions that are defined by you, enabling
     *   the model to call your own code with strongly typed arguments and outputs.
     *   Learn more about
     *   [function calling](https://platform.openai.com/docs/guides/function-calling).
     *   You can also use custom tools to call your own code.
     */
    tools: Array<Tool>;
    /**
     * An alternative to sampling with temperature, called nucleus sampling, where the
     * model considers the results of the tokens with top_p probability mass. So 0.1
     * means only the tokens comprising the top 10% probability mass are considered.
     *
     * We generally recommend altering this or `temperature` but not both.
     */
    top_p: number | null;
    /**
     * Whether to run the model response in the background.
     * [Learn more](https://platform.openai.com/docs/guides/background).
     */
    background?: boolean | null;
    /**
     * Unix timestamp (in seconds) of when this Response was completed. Only present
     * when the status is `completed`.
     */
    completed_at?: number | null;
    /**
     * The conversation that this response belonged to. Input items and output items
     * from this response were automatically added to this conversation.
     */
    conversation?: Response.Conversation | null;
    /**
     * An upper bound for the number of tokens that can be generated for a response,
     * including visible output tokens and
     * [reasoning tokens](https://platform.openai.com/docs/guides/reasoning).
     */
    max_output_tokens?: number | null;
    /**
     * The unique ID of the previous response to the model. Use this to create
     * multi-turn conversations. Learn more about
     * [conversation state](https://platform.openai.com/docs/guides/conversation-state).
     * Cannot be used in conjunction with `conversation`.
     */
    previous_response_id?: string | null;
    /**
     * Reference to a prompt template and its variables.
     * [Learn more](https://platform.openai.com/docs/guides/text?api-mode=responses#reusable-prompts).
     */
    prompt?: ResponsePrompt | null;
    /**
     * Used by OpenAI to cache responses for similar requests to optimize your cache
     * hit rates. Replaces the `user` field.
     * [Learn more](https://platform.openai.com/docs/guides/prompt-caching).
     */
    prompt_cache_key?: string;
    /**
     * The retention policy for the prompt cache. Set to `24h` to enable extended
     * prompt caching, which keeps cached prefixes active for longer, up to a maximum
     * of 24 hours.
     * [Learn more](https://platform.openai.com/docs/guides/prompt-caching#prompt-cache-retention).
     */
    prompt_cache_retention?: 'in-memory' | '24h' | null;
    /**
     * **gpt-5 and o-series models only**
     *
     * Configuration options for
     * [reasoning models](https://platform.openai.com/docs/guides/reasoning).
     */
    reasoning?: Shared.Reasoning | null;
    /**
     * A stable identifier used to help detect users of your application that may be
     * violating OpenAI's usage policies. The IDs should be a string that uniquely
     * identifies each user, with a maximum length of 64 characters. We recommend
     * hashing their username or email address, in order to avoid sending us any
     * identifying information.
     * [Learn more](https://platform.openai.com/docs/guides/safety-best-practices#safety-identifiers).
     */
    safety_identifier?: string;
    /**
     * Specifies the latency tier to use for processing the request. This parameter is
     * relevant for customers subscribed to the scale tier service:
     *
     * - If set to 'auto', then the request will be processed with the service tier
     *   configured in the Project settings. Unless otherwise configured, the Project
     *   will use 'default'.
     * - If set to 'default', then the request will be processed with the standard
     *   pricing and performance for the selected model.
     * - If set to '[flex](https://platform.openai.com/docs/guides/flex-processing)' or
     *   '[priority](https://openai.com/api-priority-processing/)', then the request
     *   will be processed with the corresponding service tier.
     * - When not set, the default behavior is 'auto'.
     *
     * When this parameter is set, the response body will include the `service_tier`
     * utilized.
     */
    service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null;
    /**
     * The status of the response generation. One of `completed`, `failed`,
     * `in_progress`, `cancelled`, `queued`, or `incomplete`.
     */
    status?: ResponseStatus;
    /**
     * Configuration options for a text response from the model. Can be plain text or
     * structured JSON data. Learn more:
     *
     * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
     * - [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
     */
    text?: ResponseTextConfig;
    /**
     * The truncation strategy to use for the model response.
     *
     * - `auto`: If the input to this Response exceeds the model's context window size,
     *   the model will truncate the response to fit the context window by dropping
     *   items from the beginning of the conversation.
     * - `disabled` (default): If the input size will exceed the context window size
     *   for a model, the request will fail with a 400 error.
     */
    truncation?: 'auto' | 'disabled' | null;
    /**
     * Represents token usage details including input tokens, output tokens, a
     * breakdown of output tokens, and the total tokens used.
     */
    usage?: ResponseUsage;
    /**
     * @deprecated This field is being replaced by `safety_identifier` and
     * `prompt_cache_key`. Use `prompt_cache_key` instead to maintain caching
     * optimizations. A stable identifier for your end-users. Used to boost cache hit
     * rates by better bucketing similar requests and to help OpenAI detect and prevent
     * abuse.
     * [Learn more](https://platform.openai.com/docs/guides/safety-best-practices#safety-identifiers).
     */
    user?: string;
}
export declare namespace Response {
    /**
     * Details about why the response is incomplete.
     */
    interface IncompleteDetails {
        /**
         * The reason why the response is incomplete.
         */
        reason?: 'max_output_tokens' | 'content_filter';
    }
    /**
     * The conversation that this response belonged to. Input items and output items
     * from this response were automatically added to this conversation.
     */
    interface Conversation {
        /**
         * The unique ID of the conversation that this response was associated with.
         */
        id: string;
    }
}
/**
 * A tool call that applies file diffs by creating, deleting, or updating files.
 */
export interface ResponseApplyPatchToolCall {
    /**
     * The unique ID of the apply patch tool call. Populated when this item is returned
     * via API.
     */
    id: string;
    /**
     * The unique ID of the apply patch tool call generated by the model.
     */
    call_id: string;
    /**
     * One of the create_file, delete_file, or update_file operations applied via
     * apply_patch.
     */
    operation: ResponseApplyPatchToolCall.CreateFile | ResponseApplyPatchToolCall.DeleteFile | ResponseApplyPatchToolCall.UpdateFile;
    /**
     * The status of the apply patch tool call. One of `in_progress` or `completed`.
     */
    status: 'in_progress' | 'completed';
    /**
     * The type of the item. Always `apply_patch_call`.
     */
    type: 'apply_patch_call';
    /**
     * The ID of the entity that created this tool call.
     */
    created_by?: string;
}
export declare namespace ResponseApplyPatchToolCall {
    /**
     * Instruction describing how to create a file via the apply_patch tool.
     */
    interface CreateFile {
        /**
         * Diff to apply.
         */
        diff: string;
        /**
         * Path of the file to create.
         */
        path: string;
        /**
         * Create a new file with the provided diff.
         */
        type: 'create_file';
    }
    /**
     * Instruction describing how to delete a file via the apply_patch tool.
     */
    interface DeleteFile {
        /**
         * Path of the file to delete.
         */
        path: string;
        /**
         * Delete the specified file.
         */
        type: 'delete_file';
    }
    /**
     * Instruction describing how to update a file via the apply_patch tool.
     */
    interface UpdateFile {
        /**
         * Diff to apply.
         */
        diff: string;
        /**
         * Path of the file to update.
         */
        path: string;
        /**
         * Update an existing file with the provided diff.
         */
        type: 'update_file';
    }
}
/**
 * The output emitted by an apply patch tool call.
 */
export interface ResponseApplyPatchToolCallOutput {
    /**
     * The unique ID of the apply patch tool call output. Populated when this item is
     * returned via API.
     */
    id: string;
    /**
     * The unique ID of the apply patch tool call generated by the model.
     */
    call_id: string;
    /**
     * The status of the apply patch tool call output. One of `completed` or `failed`.
     */
    status: 'completed' | 'failed';
    /**
     * The type of the item. Always `apply_patch_call_output`.
     */
    type: 'apply_patch_call_output';
    /**
     * The ID of the entity that created this tool call output.
     */
    created_by?: string;
    /**
     * Optional textual output returned by the apply patch tool.
     */
    output?: string | null;
}
/**
 * Emitted when there is a partial audio response.
 */
export interface ResponseAudioDeltaEvent {
    /**
     * A chunk of Base64 encoded response audio bytes.
     */
    delta: string;
    /**
     * A sequence number for this chunk of the stream response.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.audio.delta`.
     */
    type: 'response.audio.delta';
}
/**
 * Emitted when the audio response is complete.
 */
export interface ResponseAudioDoneEvent {
    /**
     * The sequence number of the delta.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.audio.done`.
     */
    type: 'response.audio.done';
}
/**
 * Emitted when there is a partial transcript of audio.
 */
export interface ResponseAudioTranscriptDeltaEvent {
    /**
     * The partial transcript of the audio response.
     */
    delta: string;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.audio.transcript.delta`.
     */
    type: 'response.audio.transcript.delta';
}
/**
 * Emitted when the full audio transcript is completed.
 */
export interface ResponseAudioTranscriptDoneEvent {
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.audio.transcript.done`.
     */
    type: 'response.audio.transcript.done';
}
/**
 * Emitted when a partial code snippet is streamed by the code interpreter.
 */
export interface ResponseCodeInterpreterCallCodeDeltaEvent {
    /**
     * The partial code snippet being streamed by the code interpreter.
     */
    delta: string;
    /**
     * The unique identifier of the code interpreter tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response for which the code is being
     * streamed.
     */
    output_index: number;
    /**
     * The sequence number of this event, used to order streaming events.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.code_interpreter_call_code.delta`.
     */
    type: 'response.code_interpreter_call_code.delta';
}
/**
 * Emitted when the code snippet is finalized by the code interpreter.
 */
export interface ResponseCodeInterpreterCallCodeDoneEvent {
    /**
     * The final code snippet output by the code interpreter.
     */
    code: string;
    /**
     * The unique identifier of the code interpreter tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response for which the code is finalized.
     */
    output_index: number;
    /**
     * The sequence number of this event, used to order streaming events.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.code_interpreter_call_code.done`.
     */
    type: 'response.code_interpreter_call_code.done';
}
/**
 * Emitted when the code interpreter call is completed.
 */
export interface ResponseCodeInterpreterCallCompletedEvent {
    /**
     * The unique identifier of the code interpreter tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response for which the code interpreter call
     * is completed.
     */
    output_index: number;
    /**
     * The sequence number of this event, used to order streaming events.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.code_interpreter_call.completed`.
     */
    type: 'response.code_interpreter_call.completed';
}
/**
 * Emitted when a code interpreter call is in progress.
 */
export interface ResponseCodeInterpreterCallInProgressEvent {
    /**
     * The unique identifier of the code interpreter tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response for which the code interpreter call
     * is in progress.
     */
    output_index: number;
    /**
     * The sequence number of this event, used to order streaming events.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.code_interpreter_call.in_progress`.
     */
    type: 'response.code_interpreter_call.in_progress';
}
/**
 * Emitted when the code interpreter is actively interpreting the code snippet.
 */
export interface ResponseCodeInterpreterCallInterpretingEvent {
    /**
     * The unique identifier of the code interpreter tool call item.
     */
    item_id: string;
    /**
     * The index of the output item in the response for which the code interpreter is
     * interpreting code.
     */
    output_index: number;
    /**
     * The sequence number of this event, used to order streaming events.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.code_interpreter_call.interpreting`.
     */
    type: 'response.code_interpreter_call.interpreting';
}
/**
 * A tool call to run code.
 */
export interface ResponseCodeInterpreterToolCall {
    /**
     * The unique ID of the code interpreter tool call.
     */
    id: string;
    /**
     * The code to run, or null if not available.
     */
    code: string | null;
    /**
     * The ID of the container used to run the code.
     */
    container_id: string;
    /**
     * The outputs generated by the code interpreter, such as logs or images. Can be
     * null if no outputs are available.
     */
    outputs: Array<ResponseCodeInterpreterToolCall.Logs | ResponseCodeInterpreterToolCall.Image> | null;
    /**
     * The status of the code interpreter tool call. Valid values are `in_progress`,
     * `completed`, `incomplete`, `interpreting`, and `failed`.
     */
    status: 'in_progress' | 'completed' | 'incomplete' | 'interpreting' | 'failed';
    /**
     * The type of the code interpreter tool call. Always `code_interpreter_call`.
     */
    type: 'code_interpreter_call';
}
export declare namespace ResponseCodeInterpreterToolCall {
    /**
     * The logs output from the code interpreter.
     */
    interface Logs {
        /**
         * The logs output from the code interpreter.
         */
        logs: string;
        /**
         * The type of the output. Always `logs`.
         */
        type: 'logs';
    }
    /**
     * The image output from the code interpreter.
     */
    interface Image {
        /**
         * The type of the output. Always `image`.
         */
        type: 'image';
        /**
         * The URL of the image output from the code interpreter.
         */
        url: string;
    }
}
/**
 * A compaction item generated by the
 * [`v1/responses/compact` API](https://platform.openai.com/docs/api-reference/responses/compact).
 */
export interface ResponseCompactionItem {
    /**
     * The unique ID of the compaction item.
     */
    id: string;
    /**
     * The encrypted content that was produced by compaction.
     */
    encrypted_content: string;
    /**
     * The type of the item. Always `compaction`.
     */
    type: 'compaction';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
/**
 * A compaction item generated by the
 * [`v1/responses/compact` API](https://platform.openai.com/docs/api-reference/responses/compact).
 */
export interface ResponseCompactionItemParam {
    /**
     * The encrypted content of the compaction summary.
     */
    encrypted_content: string;
    /**
     * The type of the item. Always `compaction`.
     */
    type: 'compaction';
    /**
     * The ID of the compaction item.
     */
    id?: string | null;
}
/**
 * Emitted when the model response is complete.
 */
export interface ResponseCompletedEvent {
    /**
     * Properties of the completed response.
     */
    response: Response;
    /**
     * The sequence number for this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.completed`.
     */
    type: 'response.completed';
}
/**
 * A tool call to a computer use tool. See the
 * [computer use guide](https://platform.openai.com/docs/guides/tools-computer-use)
 * for more information.
 */
export interface ResponseComputerToolCall {
    /**
     * The unique ID of the computer call.
     */
    id: string;
    /**
     * An identifier used when responding to the tool call with output.
     */
    call_id: string;
    /**
     * The pending safety checks for the computer call.
     */
    pending_safety_checks: Array<ResponseComputerToolCall.PendingSafetyCheck>;
    /**
     * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The type of the computer call. Always `computer_call`.
     */
    type: 'computer_call';
    /**
     * A click action.
     */
    action?: ResponseComputerToolCall.Click | ResponseComputerToolCall.DoubleClick | ResponseComputerToolCall.Drag | ResponseComputerToolCall.Keypress | ResponseComputerToolCall.Move | ResponseComputerToolCall.Screenshot | ResponseComputerToolCall.Scroll | ResponseComputerToolCall.Type | ResponseComputerToolCall.Wait;
    /**
     * Flattened batched actions for `computer_use`. Each action includes an `type`
     * discriminator and action-specific fields.
     */
    actions?: ComputerActionList;
}
export declare namespace ResponseComputerToolCall {
    /**
     * A pending safety check for the computer call.
     */
    interface PendingSafetyCheck {
        /**
         * The ID of the pending safety check.
         */
        id: string;
        /**
         * The type of the pending safety check.
         */
        code?: string | null;
        /**
         * Details about the pending safety check.
         */
        message?: string | null;
    }
    /**
     * A click action.
     */
    interface Click {
        /**
         * Indicates which mouse button was pressed during the click. One of `left`,
         * `right`, `wheel`, `back`, or `forward`.
         */
        button: 'left' | 'right' | 'wheel' | 'back' | 'forward';
        /**
         * Specifies the event type. For a click action, this property is always `click`.
         */
        type: 'click';
        /**
         * The x-coordinate where the click occurred.
         */
        x: number;
        /**
         * The y-coordinate where the click occurred.
         */
        y: number;
        /**
         * The keys being held while clicking.
         */
        keys?: Array<string> | null;
    }
    /**
     * A double click action.
     */
    interface DoubleClick {
        /**
         * The keys being held while double-clicking.
         */
        keys: Array<string> | null;
        /**
         * Specifies the event type. For a double click action, this property is always set
         * to `double_click`.
         */
        type: 'double_click';
        /**
         * The x-coordinate where the double click occurred.
         */
        x: number;
        /**
         * The y-coordinate where the double click occurred.
         */
        y: number;
    }
    /**
     * A drag action.
     */
    interface Drag {
        /**
         * An array of coordinates representing the path of the drag action. Coordinates
         * will appear as an array of objects, eg
         *
         * ```
         * [
         *   { x: 100, y: 200 },
         *   { x: 200, y: 300 }
         * ]
         * ```
         */
        path: Array<Drag.Path>;
        /**
         * Specifies the event type. For a drag action, this property is always set to
         * `drag`.
         */
        type: 'drag';
        /**
         * The keys being held while dragging the mouse.
         */
        keys?: Array<string> | null;
    }
    namespace Drag {
        /**
         * An x/y coordinate pair, e.g. `{ x: 100, y: 200 }`.
         */
        interface Path {
            /**
             * The x-coordinate.
             */
            x: number;
            /**
             * The y-coordinate.
             */
            y: number;
        }
    }
    /**
     * A collection of keypresses the model would like to perform.
     */
    interface Keypress {
        /**
         * The combination of keys the model is requesting to be pressed. This is an array
         * of strings, each representing a key.
         */
        keys: Array<string>;
        /**
         * Specifies the event type. For a keypress action, this property is always set to
         * `keypress`.
         */
        type: 'keypress';
    }
    /**
     * A mouse move action.
     */
    interface Move {
        /**
         * Specifies the event type. For a move action, this property is always set to
         * `move`.
         */
        type: 'move';
        /**
         * The x-coordinate to move to.
         */
        x: number;
        /**
         * The y-coordinate to move to.
         */
        y: number;
        /**
         * The keys being held while moving the mouse.
         */
        keys?: Array<string> | null;
    }
    /**
     * A screenshot action.
     */
    interface Screenshot {
        /**
         * Specifies the event type. For a screenshot action, this property is always set
         * to `screenshot`.
         */
        type: 'screenshot';
    }
    /**
     * A scroll action.
     */
    interface Scroll {
        /**
         * The horizontal scroll distance.
         */
        scroll_x: number;
        /**
         * The vertical scroll distance.
         */
        scroll_y: number;
        /**
         * Specifies the event type. For a scroll action, this property is always set to
         * `scroll`.
         */
        type: 'scroll';
        /**
         * The x-coordinate where the scroll occurred.
         */
        x: number;
        /**
         * The y-coordinate where the scroll occurred.
         */
        y: number;
        /**
         * The keys being held while scrolling.
         */
        keys?: Array<string> | null;
    }
    /**
     * An action to type in text.
     */
    interface Type {
        /**
         * The text to type.
         */
        text: string;
        /**
         * Specifies the event type. For a type action, this property is always set to
         * `type`.
         */
        type: 'type';
    }
    /**
     * A wait action.
     */
    interface Wait {
        /**
         * Specifies the event type. For a wait action, this property is always set to
         * `wait`.
         */
        type: 'wait';
    }
}
export interface ResponseComputerToolCallOutputItem {
    /**
     * The unique ID of the computer call tool output.
     */
    id: string;
    /**
     * The ID of the computer tool call that produced the output.
     */
    call_id: string;
    /**
     * A computer screenshot image used with the computer use tool.
     */
    output: ResponseComputerToolCallOutputScreenshot;
    /**
     * The status of the message input. One of `in_progress`, `completed`, or
     * `incomplete`. Populated when input items are returned via API.
     */
    status: 'completed' | 'incomplete' | 'failed' | 'in_progress';
    /**
     * The type of the computer tool call output. Always `computer_call_output`.
     */
    type: 'computer_call_output';
    /**
     * The safety checks reported by the API that have been acknowledged by the
     * developer.
     */
    acknowledged_safety_checks?: Array<ResponseComputerToolCallOutputItem.AcknowledgedSafetyCheck>;
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
export declare namespace ResponseComputerToolCallOutputItem {
    /**
     * A pending safety check for the computer call.
     */
    interface AcknowledgedSafetyCheck {
        /**
         * The ID of the pending safety check.
         */
        id: string;
        /**
         * The type of the pending safety check.
         */
        code?: string | null;
        /**
         * Details about the pending safety check.
         */
        message?: string | null;
    }
}
/**
 * A computer screenshot image used with the computer use tool.
 */
export interface ResponseComputerToolCallOutputScreenshot {
    /**
     * Specifies the event type. For a computer screenshot, this property is always set
     * to `computer_screenshot`.
     */
    type: 'computer_screenshot';
    /**
     * The identifier of an uploaded file that contains the screenshot.
     */
    file_id?: string;
    /**
     * The URL of the screenshot image.
     */
    image_url?: string;
}
/**
 * Represents a container created with /v1/containers.
 */
export interface ResponseContainerReference {
    container_id: string;
    /**
     * The environment type. Always `container_reference`.
     */
    type: 'container_reference';
}
/**
 * Multi-modal input and output contents.
 */
export type ResponseContent = ResponseInputText | ResponseInputImage | ResponseInputFile | ResponseOutputText | ResponseOutputRefusal | ResponseContent.ReasoningTextContent;
export declare namespace ResponseContent {
    /**
     * Reasoning text from the model.
     */
    interface ReasoningTextContent {
        /**
         * The reasoning text from the model.
         */
        text: string;
        /**
         * The type of the reasoning text. Always `reasoning_text`.
         */
        type: 'reasoning_text';
    }
}
/**
 * Emitted when a new content part is added.
 */
export interface ResponseContentPartAddedEvent {
    /**
     * The index of the content part that was added.
     */
    content_index: number;
    /**
     * The ID of the output item that the content part was added to.
     */
    item_id: string;
    /**
     * The index of the output item that the content part was added to.
     */
    output_index: number;
    /**
     * The content part that was added.
     */
    part: ResponseOutputText | ResponseOutputRefusal | ResponseContentPartAddedEvent.ReasoningText;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.content_part.added`.
     */
    type: 'response.content_part.added';
}
export declare namespace ResponseContentPartAddedEvent {
    /**
     * Reasoning text from the model.
     */
    interface ReasoningText {
        /**
         * The reasoning text from the model.
         */
        text: string;
        /**
         * The type of the reasoning text. Always `reasoning_text`.
         */
        type: 'reasoning_text';
    }
}
/**
 * Emitted when a content part is done.
 */
export interface ResponseContentPartDoneEvent {
    /**
     * The index of the content part that is done.
     */
    content_index: number;
    /**
     * The ID of the output item that the content part was added to.
     */
    item_id: string;
    /**
     * The index of the output item that the content part was added to.
     */
    output_index: number;
    /**
     * The content part that is done.
     */
    part: ResponseOutputText | ResponseOutputRefusal | ResponseContentPartDoneEvent.ReasoningText;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.content_part.done`.
     */
    type: 'response.content_part.done';
}
export declare namespace ResponseContentPartDoneEvent {
    /**
     * Reasoning text from the model.
     */
    interface ReasoningText {
        /**
         * The reasoning text from the model.
         */
        text: string;
        /**
         * The type of the reasoning text. Always `reasoning_text`.
         */
        type: 'reasoning_text';
    }
}
/**
 * The conversation that this response belongs to.
 */
export interface ResponseConversationParam {
    /**
     * The unique ID of the conversation.
     */
    id: string;
}
/**
 * An event that is emitted when a response is created.
 */
export interface ResponseCreatedEvent {
    /**
     * The response that was created.
     */
    response: Response;
    /**
     * The sequence number for this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.created`.
     */
    type: 'response.created';
}
/**
 * A call to a custom tool created by the model.
 */
export interface ResponseCustomToolCall {
    /**
     * An identifier used to map this custom tool call to a tool call output.
     */
    call_id: string;
    /**
     * The input for the custom tool call generated by the model.
     */
    input: string;
    /**
     * The name of the custom tool being called.
     */
    name: string;
    /**
     * The type of the custom tool call. Always `custom_tool_call`.
     */
    type: 'custom_tool_call';
    /**
     * The unique ID of the custom tool call in the OpenAI platform.
     */
    id?: string;
    /**
     * The namespace of the custom tool being called.
     */
    namespace?: string;
}
/**
 * Event representing a delta (partial update) to the input of a custom tool call.
 */
export interface ResponseCustomToolCallInputDeltaEvent {
    /**
     * The incremental input data (delta) for the custom tool call.
     */
    delta: string;
    /**
     * Unique identifier for the API item associated with this event.
     */
    item_id: string;
    /**
     * The index of the output this delta applies to.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The event type identifier.
     */
    type: 'response.custom_tool_call_input.delta';
}
/**
 * Event indicating that input for a custom tool call is complete.
 */
export interface ResponseCustomToolCallInputDoneEvent {
    /**
     * The complete input data for the custom tool call.
     */
    input: string;
    /**
     * Unique identifier for the API item associated with this event.
     */
    item_id: string;
    /**
     * The index of the output this event applies to.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The event type identifier.
     */
    type: 'response.custom_tool_call_input.done';
}
/**
 * A call to a custom tool created by the model.
 */
export interface ResponseCustomToolCallItem extends ResponseCustomToolCall {
    /**
     * The unique ID of the custom tool call item.
     */
    id: string;
    /**
     * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
/**
 * The output of a custom tool call from your code, being sent back to the model.
 */
export interface ResponseCustomToolCallOutput {
    /**
     * The call ID, used to map this custom tool call output to a custom tool call.
     */
    call_id: string;
    /**
     * The output from the custom tool call generated by your code. Can be a string or
     * an list of output content.
     */
    output: string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;
    /**
     * The type of the custom tool call output. Always `custom_tool_call_output`.
     */
    type: 'custom_tool_call_output';
    /**
     * The unique ID of the custom tool call output in the OpenAI platform.
     */
    id?: string;
}
/**
 * The output of a custom tool call from your code, being sent back to the model.
 */
export interface ResponseCustomToolCallOutputItem extends ResponseCustomToolCallOutput {
    /**
     * The unique ID of the custom tool call output item.
     */
    id: string;
    /**
     * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
/**
 * An error object returned when the model fails to generate a Response.
 */
export interface ResponseError {
    /**
     * The error code for the response.
     */
    code: 'server_error' | 'rate_limit_exceeded' | 'invalid_prompt' | 'vector_store_timeout' | 'invalid_image' | 'invalid_image_format' | 'invalid_base64_image' | 'invalid_image_url' | 'image_too_large' | 'image_too_small' | 'image_parse_error' | 'image_content_policy_violation' | 'invalid_image_mode' | 'image_file_too_large' | 'unsupported_image_media_type' | 'empty_image_file' | 'failed_to_download_image' | 'image_file_not_found';
    /**
     * A human-readable description of the error.
     */
    message: string;
}
/**
 * Emitted when an error occurs.
 */
export interface ResponseErrorEvent {
    /**
     * The error code.
     */
    code: string | null;
    /**
     * The error message.
     */
    message: string;
    /**
     * The error parameter.
     */
    param: string | null;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `error`.
     */
    type: 'error';
}
/**
 * An event that is emitted when a response fails.
 */
export interface ResponseFailedEvent {
    /**
     * The response that failed.
     */
    response: Response;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.failed`.
     */
    type: 'response.failed';
}
/**
 * Emitted when a file search call is completed (results found).
 */
export interface ResponseFileSearchCallCompletedEvent {
    /**
     * The ID of the output item that the file search call is initiated.
     */
    item_id: string;
    /**
     * The index of the output item that the file search call is initiated.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.file_search_call.completed`.
     */
    type: 'response.file_search_call.completed';
}
/**
 * Emitted when a file search call is initiated.
 */
export interface ResponseFileSearchCallInProgressEvent {
    /**
     * The ID of the output item that the file search call is initiated.
     */
    item_id: string;
    /**
     * The index of the output item that the file search call is initiated.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.file_search_call.in_progress`.
     */
    type: 'response.file_search_call.in_progress';
}
/**
 * Emitted when a file search is currently searching.
 */
export interface ResponseFileSearchCallSearchingEvent {
    /**
     * The ID of the output item that the file search call is initiated.
     */
    item_id: string;
    /**
     * The index of the output item that the file search call is searching.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.file_search_call.searching`.
     */
    type: 'response.file_search_call.searching';
}
/**
 * The results of a file search tool call. See the
 * [file search guide](https://platform.openai.com/docs/guides/tools-file-search)
 * for more information.
 */
export interface ResponseFileSearchToolCall {
    /**
     * The unique ID of the file search tool call.
     */
    id: string;
    /**
     * The queries used to search for files.
     */
    queries: Array<string>;
    /**
     * The status of the file search tool call. One of `in_progress`, `searching`,
     * `incomplete` or `failed`,
     */
    status: 'in_progress' | 'searching' | 'completed' | 'incomplete' | 'failed';
    /**
     * The type of the file search tool call. Always `file_search_call`.
     */
    type: 'file_search_call';
    /**
     * The results of the file search tool call.
     */
    results?: Array<ResponseFileSearchToolCall.Result> | null;
}
export declare namespace ResponseFileSearchToolCall {
    interface Result {
        /**
         * Set of 16 key-value pairs that can be attached to an object. This can be useful
         * for storing additional information about the object in a structured format, and
         * querying for objects via API or the dashboard. Keys are strings with a maximum
         * length of 64 characters. Values are strings with a maximum length of 512
         * characters, booleans, or numbers.
         */
        attributes?: {
            [key: string]: string | number | boolean;
        } | null;
        /**
         * The unique ID of the file.
         */
        file_id?: string;
        /**
         * The name of the file.
         */
        filename?: string;
        /**
         * The relevance score of the file - a value between 0 and 1.
         */
        score?: number;
        /**
         * The text that was retrieved from the file.
         */
        text?: string;
    }
}
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
export type ResponseFormatTextConfig = Shared.ResponseFormatText | ResponseFormatTextJSONSchemaConfig | Shared.ResponseFormatJSONObject;
/**
 * JSON Schema response format. Used to generate structured JSON responses. Learn
 * more about
 * [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs).
 */
export interface ResponseFormatTextJSONSchemaConfig {
    /**
     * The name of the response format. Must be a-z, A-Z, 0-9, or contain underscores
     * and dashes, with a maximum length of 64.
     */
    name: string;
    /**
     * The schema for the response format, described as a JSON Schema object. Learn how
     * to build JSON schemas [here](https://json-schema.org/).
     */
    schema: {
        [key: string]: unknown;
    };
    /**
     * The type of response format being defined. Always `json_schema`.
     */
    type: 'json_schema';
    /**
     * A description of what the response format is for, used by the model to determine
     * how to respond in the format.
     */
    description?: string;
    /**
     * Whether to enable strict schema adherence when generating the output. If set to
     * true, the model will always follow the exact schema defined in the `schema`
     * field. Only a subset of JSON Schema is supported when `strict` is `true`. To
     * learn more, read the
     * [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs).
     */
    strict?: boolean | null;
}
/**
 * Emitted when there is a partial function-call arguments delta.
 */
export interface ResponseFunctionCallArgumentsDeltaEvent {
    /**
     * The function-call arguments delta that is added.
     */
    delta: string;
    /**
     * The ID of the output item that the function-call arguments delta is added to.
     */
    item_id: string;
    /**
     * The index of the output item that the function-call arguments delta is added to.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.function_call_arguments.delta`.
     */
    type: 'response.function_call_arguments.delta';
}
/**
 * Emitted when function-call arguments are finalized.
 */
export interface ResponseFunctionCallArgumentsDoneEvent {
    /**
     * The function-call arguments.
     */
    arguments: string;
    /**
     * The ID of the item.
     */
    item_id: string;
    /**
     * The name of the function that was called.
     */
    name: string;
    /**
     * The index of the output item.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    type: 'response.function_call_arguments.done';
}
/**
 * A piece of message content, such as text, an image, or a file.
 */
export type ResponseFunctionCallOutputItem = ResponseInputTextContent | ResponseInputImageContent | ResponseInputFileContent;
/**
 * An array of content outputs (text, image, file) for the function tool call.
 */
export type ResponseFunctionCallOutputItemList = Array<ResponseFunctionCallOutputItem>;
/**
 * Captured stdout and stderr for a portion of a shell tool call output.
 */
export interface ResponseFunctionShellCallOutputContent {
    /**
     * The exit or timeout outcome associated with this shell call.
     */
    outcome: ResponseFunctionShellCallOutputContent.Timeout | ResponseFunctionShellCallOutputContent.Exit;
    /**
     * Captured stderr output for the shell call.
     */
    stderr: string;
    /**
     * Captured stdout output for the shell call.
     */
    stdout: string;
}
export declare namespace ResponseFunctionShellCallOutputContent {
    /**
     * Indicates that the shell call exceeded its configured time limit.
     */
    interface Timeout {
        /**
         * The outcome type. Always `timeout`.
         */
        type: 'timeout';
    }
    /**
     * Indicates that the shell commands finished and returned an exit code.
     */
    interface Exit {
        /**
         * The exit code returned by the shell process.
         */
        exit_code: number;
        /**
         * The outcome type. Always `exit`.
         */
        type: 'exit';
    }
}
/**
 * A tool call that executes one or more shell commands in a managed environment.
 */
export interface ResponseFunctionShellToolCall {
    /**
     * The unique ID of the shell tool call. Populated when this item is returned via
     * API.
     */
    id: string;
    /**
     * The shell commands and limits that describe how to run the tool call.
     */
    action: ResponseFunctionShellToolCall.Action;
    /**
     * The unique ID of the shell tool call generated by the model.
     */
    call_id: string;
    /**
     * Represents the use of a local environment to perform shell actions.
     */
    environment: ResponseLocalEnvironment | ResponseContainerReference | null;
    /**
     * The status of the shell call. One of `in_progress`, `completed`, or
     * `incomplete`.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The type of the item. Always `shell_call`.
     */
    type: 'shell_call';
    /**
     * The ID of the entity that created this tool call.
     */
    created_by?: string;
}
export declare namespace ResponseFunctionShellToolCall {
    /**
     * The shell commands and limits that describe how to run the tool call.
     */
    interface Action {
        commands: Array<string>;
        /**
         * Optional maximum number of characters to return from each command.
         */
        max_output_length: number | null;
        /**
         * Optional timeout in milliseconds for the commands.
         */
        timeout_ms: number | null;
    }
}
/**
 * The output of a shell tool call that was emitted.
 */
export interface ResponseFunctionShellToolCallOutput {
    /**
     * The unique ID of the shell call output. Populated when this item is returned via
     * API.
     */
    id: string;
    /**
     * The unique ID of the shell tool call generated by the model.
     */
    call_id: string;
    /**
     * The maximum length of the shell command output. This is generated by the model
     * and should be passed back with the raw output.
     */
    max_output_length: number | null;
    /**
     * An array of shell call output contents
     */
    output: Array<ResponseFunctionShellToolCallOutput.Output>;
    /**
     * The status of the shell call output. One of `in_progress`, `completed`, or
     * `incomplete`.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The type of the shell call output. Always `shell_call_output`.
     */
    type: 'shell_call_output';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
export declare namespace ResponseFunctionShellToolCallOutput {
    /**
     * The content of a shell tool call output that was emitted.
     */
    interface Output {
        /**
         * Represents either an exit outcome (with an exit code) or a timeout outcome for a
         * shell call output chunk.
         */
        outcome: Output.Timeout | Output.Exit;
        /**
         * The standard error output that was captured.
         */
        stderr: string;
        /**
         * The standard output that was captured.
         */
        stdout: string;
        /**
         * The identifier of the actor that created the item.
         */
        created_by?: string;
    }
    namespace Output {
        /**
         * Indicates that the shell call exceeded its configured time limit.
         */
        interface Timeout {
            /**
             * The outcome type. Always `timeout`.
             */
            type: 'timeout';
        }
        /**
         * Indicates that the shell commands finished and returned an exit code.
         */
        interface Exit {
            /**
             * Exit code from the shell process.
             */
            exit_code: number;
            /**
             * The outcome type. Always `exit`.
             */
            type: 'exit';
        }
    }
}
/**
 * A tool call to run a function. See the
 * [function calling guide](https://platform.openai.com/docs/guides/function-calling)
 * for more information.
 */
export interface ResponseFunctionToolCall {
    /**
     * A JSON string of the arguments to pass to the function.
     */
    arguments: string;
    /**
     * The unique ID of the function tool call generated by the model.
     */
    call_id: string;
    /**
     * The name of the function to run.
     */
    name: string;
    /**
     * The type of the function tool call. Always `function_call`.
     */
    type: 'function_call';
    /**
     * The unique ID of the function tool call.
     */
    id?: string;
    /**
     * The namespace of the function to run.
     */
    namespace?: string;
    /**
     * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status?: 'in_progress' | 'completed' | 'incomplete';
}
/**
 * A tool call to run a function. See the
 * [function calling guide](https://platform.openai.com/docs/guides/function-calling)
 * for more information.
 */
export interface ResponseFunctionToolCallItem extends ResponseFunctionToolCall {
    /**
     * The unique ID of the function tool call.
     */
    id: string;
    /**
     * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
export interface ResponseFunctionToolCallOutputItem {
    /**
     * The unique ID of the function call tool output.
     */
    id: string;
    /**
     * The unique ID of the function tool call generated by the model.
     */
    call_id: string;
    /**
     * The output from the function call generated by your code. Can be a string or an
     * list of output content.
     */
    output: string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>;
    /**
     * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The type of the function tool call output. Always `function_call_output`.
     */
    type: 'function_call_output';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
/**
 * The results of a web search tool call. See the
 * [web search guide](https://platform.openai.com/docs/guides/tools-web-search) for
 * more information.
 */
export interface ResponseFunctionWebSearch {
    /**
     * The unique ID of the web search tool call.
     */
    id: string;
    /**
     * An object describing the specific action taken in this web search call. Includes
     * details on how the model used the web (search, open_page, find_in_page).
     */
    action: ResponseFunctionWebSearch.Search | ResponseFunctionWebSearch.OpenPage | ResponseFunctionWebSearch.Find;
    /**
     * The status of the web search tool call.
     */
    status: 'in_progress' | 'searching' | 'completed' | 'failed';
    /**
     * The type of the web search tool call. Always `web_search_call`.
     */
    type: 'web_search_call';
}
export declare namespace ResponseFunctionWebSearch {
    /**
     * Action type "search" - Performs a web search query.
     */
    interface Search {
        /**
         * [DEPRECATED] The search query.
         */
        query: string;
        /**
         * The action type.
         */
        type: 'search';
        /**
         * The search queries.
         */
        queries?: Array<string>;
        /**
         * The sources used in the search.
         */
        sources?: Array<Search.Source>;
    }
    namespace Search {
        /**
         * A source used in the search.
         */
        interface Source {
            /**
             * The type of source. Always `url`.
             */
            type: 'url';
            /**
             * The URL of the source.
             */
            url: string;
        }
    }
    /**
     * Action type "open_page" - Opens a specific URL from search results.
     */
    interface OpenPage {
        /**
         * The action type.
         */
        type: 'open_page';
        /**
         * The URL opened by the model.
         */
        url?: string | null;
    }
    /**
     * Action type "find_in_page": Searches for a pattern within a loaded page.
     */
    interface Find {
        /**
         * The pattern or text to search for within the page.
         */
        pattern: string;
        /**
         * The action type.
         */
        type: 'find_in_page';
        /**
         * The URL of the page searched for the pattern.
         */
        url: string;
    }
}
/**
 * Emitted when an image generation tool call has completed and the final image is
 * available.
 */
export interface ResponseImageGenCallCompletedEvent {
    /**
     * The unique identifier of the image generation item being processed.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.image_generation_call.completed'.
     */
    type: 'response.image_generation_call.completed';
}
/**
 * Emitted when an image generation tool call is actively generating an image
 * (intermediate state).
 */
export interface ResponseImageGenCallGeneratingEvent {
    /**
     * The unique identifier of the image generation item being processed.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * The sequence number of the image generation item being processed.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.image_generation_call.generating'.
     */
    type: 'response.image_generation_call.generating';
}
/**
 * Emitted when an image generation tool call is in progress.
 */
export interface ResponseImageGenCallInProgressEvent {
    /**
     * The unique identifier of the image generation item being processed.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * The sequence number of the image generation item being processed.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.image_generation_call.in_progress'.
     */
    type: 'response.image_generation_call.in_progress';
}
/**
 * Emitted when a partial image is available during image generation streaming.
 */
export interface ResponseImageGenCallPartialImageEvent {
    /**
     * The unique identifier of the image generation item being processed.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * Base64-encoded partial image data, suitable for rendering as an image.
     */
    partial_image_b64: string;
    /**
     * 0-based index for the partial image (backend is 1-based, but this is 0-based for
     * the user).
     */
    partial_image_index: number;
    /**
     * The sequence number of the image generation item being processed.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.image_generation_call.partial_image'.
     */
    type: 'response.image_generation_call.partial_image';
}
/**
 * Emitted when the response is in progress.
 */
export interface ResponseInProgressEvent {
    /**
     * The response that is in progress.
     */
    response: Response;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.in_progress`.
     */
    type: 'response.in_progress';
}
/**
 * Specify additional output data to include in the model response. Currently
 * supported values are:
 *
 * - `web_search_call.action.sources`: Include the sources of the web search tool
 *   call.
 * - `code_interpreter_call.outputs`: Includes the outputs of python code execution
 *   in code interpreter tool call items.
 * - `computer_call_output.output.image_url`: Include image urls from the computer
 *   call output.
 * - `file_search_call.results`: Include the search results of the file search tool
 *   call.
 * - `message.input_image.image_url`: Include image urls from the input message.
 * - `computer_call_output.output.image_url`: Include image urls from the computer
 *   call output.
 * - `reasoning.encrypted_content`: Includes an encrypted version of reasoning
 *   tokens in reasoning item outputs. This enables reasoning items to be used in
 *   multi-turn conversations when using the Responses API statelessly (like when
 *   the `store` parameter is set to `false`, or when an organization is enrolled
 *   in the zero data retention program).
 * - `code_interpreter_call.outputs`: Includes the outputs of python code execution
 *   in code interpreter tool call items.
 */
export type ResponseIncludable = 'file_search_call.results' | 'web_search_call.results' | 'web_search_call.action.sources' | 'message.input_image.image_url' | 'computer_call_output.output.image_url' | 'code_interpreter_call.outputs' | 'reasoning.encrypted_content' | 'message.output_text.logprobs';
/**
 * An event that is emitted when a response finishes as incomplete.
 */
export interface ResponseIncompleteEvent {
    /**
     * The response that was incomplete.
     */
    response: Response;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.incomplete`.
     */
    type: 'response.incomplete';
}
/**
 * A list of one or many input items to the model, containing different content
 * types.
 */
export type ResponseInput = Array<ResponseInputItem>;
/**
 * An audio input to the model.
 */
export interface ResponseInputAudio {
    input_audio: ResponseInputAudio.InputAudio;
    /**
     * The type of the input item. Always `input_audio`.
     */
    type: 'input_audio';
}
export declare namespace ResponseInputAudio {
    interface InputAudio {
        /**
         * Base64-encoded audio data.
         */
        data: string;
        /**
         * The format of the audio data. Currently supported formats are `mp3` and `wav`.
         */
        format: 'mp3' | 'wav';
    }
}
/**
 * A text input to the model.
 */
export type ResponseInputContent = ResponseInputText | ResponseInputImage | ResponseInputFile;
/**
 * A file input to the model.
 */
export interface ResponseInputFile {
    /**
     * The type of the input item. Always `input_file`.
     */
    type: 'input_file';
    /**
     * The content of the file to be sent to the model.
     */
    file_data?: string;
    /**
     * The ID of the file to be sent to the model.
     */
    file_id?: string | null;
    /**
     * The URL of the file to be sent to the model.
     */
    file_url?: string;
    /**
     * The name of the file to be sent to the model.
     */
    filename?: string;
}
/**
 * A file input to the model.
 */
export interface ResponseInputFileContent {
    /**
     * The type of the input item. Always `input_file`.
     */
    type: 'input_file';
    /**
     * The base64-encoded data of the file to be sent to the model.
     */
    file_data?: string | null;
    /**
     * The ID of the file to be sent to the model.
     */
    file_id?: string | null;
    /**
     * The URL of the file to be sent to the model.
     */
    file_url?: string | null;
    /**
     * The name of the file to be sent to the model.
     */
    filename?: string | null;
}
/**
 * An image input to the model. Learn about
 * [image inputs](https://platform.openai.com/docs/guides/vision).
 */
export interface ResponseInputImage {
    /**
     * The detail level of the image to be sent to the model. One of `high`, `low`,
     * `auto`, or `original`. Defaults to `auto`.
     */
    detail: 'low' | 'high' | 'auto' | 'original';
    /**
     * The type of the input item. Always `input_image`.
     */
    type: 'input_image';
    /**
     * The ID of the file to be sent to the model.
     */
    file_id?: string | null;
    /**
     * The URL of the image to be sent to the model. A fully qualified URL or base64
     * encoded image in a data URL.
     */
    image_url?: string | null;
}
/**
 * An image input to the model. Learn about
 * [image inputs](https://platform.openai.com/docs/guides/vision)
 */
export interface ResponseInputImageContent {
    /**
     * The type of the input item. Always `input_image`.
     */
    type: 'input_image';
    /**
     * The detail level of the image to be sent to the model. One of `high`, `low`,
     * `auto`, or `original`. Defaults to `auto`.
     */
    detail?: 'low' | 'high' | 'auto' | 'original' | null;
    /**
     * The ID of the file to be sent to the model.
     */
    file_id?: string | null;
    /**
     * The URL of the image to be sent to the model. A fully qualified URL or base64
     * encoded image in a data URL.
     */
    image_url?: string | null;
}
/**
 * A message input to the model with a role indicating instruction following
 * hierarchy. Instructions given with the `developer` or `system` role take
 * precedence over instructions given with the `user` role. Messages with the
 * `assistant` role are presumed to have been generated by the model in previous
 * interactions.
 */
export type ResponseInputItem = EasyInputMessage | ResponseInputItem.Message | ResponseOutputMessage | ResponseFileSearchToolCall | ResponseComputerToolCall | ResponseInputItem.ComputerCallOutput | ResponseFunctionWebSearch | ResponseFunctionToolCall | ResponseInputItem.FunctionCallOutput | ResponseInputItem.ToolSearchCall | ResponseToolSearchOutputItemParam | ResponseReasoningItem | ResponseCompactionItemParam | ResponseInputItem.ImageGenerationCall | ResponseCodeInterpreterToolCall | ResponseInputItem.LocalShellCall | ResponseInputItem.LocalShellCallOutput | ResponseInputItem.ShellCall | ResponseInputItem.ShellCallOutput | ResponseInputItem.ApplyPatchCall | ResponseInputItem.ApplyPatchCallOutput | ResponseInputItem.McpListTools | ResponseInputItem.McpApprovalRequest | ResponseInputItem.McpApprovalResponse | ResponseInputItem.McpCall | ResponseCustomToolCallOutput | ResponseCustomToolCall | ResponseInputItem.ItemReference;
export declare namespace ResponseInputItem {
    /**
     * A message input to the model with a role indicating instruction following
     * hierarchy. Instructions given with the `developer` or `system` role take
     * precedence over instructions given with the `user` role.
     */
    interface Message {
        /**
         * A list of one or many input items to the model, containing different content
         * types.
         */
        content: ResponsesAPI.ResponseInputMessageContentList;
        /**
         * The role of the message input. One of `user`, `system`, or `developer`.
         */
        role: 'user' | 'system' | 'developer';
        /**
         * The status of item. One of `in_progress`, `completed`, or `incomplete`.
         * Populated when items are returned via API.
         */
        status?: 'in_progress' | 'completed' | 'incomplete';
        /**
         * The type of the message input. Always set to `message`.
         */
        type?: 'message';
    }
    /**
     * The output of a computer tool call.
     */
    interface ComputerCallOutput {
        /**
         * The ID of the computer tool call that produced the output.
         */
        call_id: string;
        /**
         * A computer screenshot image used with the computer use tool.
         */
        output: ResponsesAPI.ResponseComputerToolCallOutputScreenshot;
        /**
         * The type of the computer tool call output. Always `computer_call_output`.
         */
        type: 'computer_call_output';
        /**
         * The ID of the computer tool call output.
         */
        id?: string | null;
        /**
         * The safety checks reported by the API that have been acknowledged by the
         * developer.
         */
        acknowledged_safety_checks?: Array<ComputerCallOutput.AcknowledgedSafetyCheck> | null;
        /**
         * The status of the message input. One of `in_progress`, `completed`, or
         * `incomplete`. Populated when input items are returned via API.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    namespace ComputerCallOutput {
        /**
         * A pending safety check for the computer call.
         */
        interface AcknowledgedSafetyCheck {
            /**
             * The ID of the pending safety check.
             */
            id: string;
            /**
             * The type of the pending safety check.
             */
            code?: string | null;
            /**
             * Details about the pending safety check.
             */
            message?: string | null;
        }
    }
    /**
     * The output of a function tool call.
     */
    interface FunctionCallOutput {
        /**
         * The unique ID of the function tool call generated by the model.
         */
        call_id: string;
        /**
         * Text, image, or file output of the function tool call.
         */
        output: string | ResponsesAPI.ResponseFunctionCallOutputItemList;
        /**
         * The type of the function tool call output. Always `function_call_output`.
         */
        type: 'function_call_output';
        /**
         * The unique ID of the function tool call output. Populated when this item is
         * returned via API.
         */
        id?: string | null;
        /**
         * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
         * Populated when items are returned via API.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    interface ToolSearchCall {
        /**
         * The arguments supplied to the tool search call.
         */
        arguments: unknown;
        /**
         * The item type. Always `tool_search_call`.
         */
        type: 'tool_search_call';
        /**
         * The unique ID of this tool search call.
         */
        id?: string | null;
        /**
         * The unique ID of the tool search call generated by the model.
         */
        call_id?: string | null;
        /**
         * Whether tool search was executed by the server or by the client.
         */
        execution?: 'server' | 'client';
        /**
         * The status of the tool search call.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    /**
     * An image generation request made by the model.
     */
    interface ImageGenerationCall {
        /**
         * The unique ID of the image generation call.
         */
        id: string;
        /**
         * The generated image encoded in base64.
         */
        result: string | null;
        /**
         * The status of the image generation call.
         */
        status: 'in_progress' | 'completed' | 'generating' | 'failed';
        /**
         * The type of the image generation call. Always `image_generation_call`.
         */
        type: 'image_generation_call';
    }
    /**
     * A tool call to run a command on the local shell.
     */
    interface LocalShellCall {
        /**
         * The unique ID of the local shell call.
         */
        id: string;
        /**
         * Execute a shell command on the server.
         */
        action: LocalShellCall.Action;
        /**
         * The unique ID of the local shell tool call generated by the model.
         */
        call_id: string;
        /**
         * The status of the local shell call.
         */
        status: 'in_progress' | 'completed' | 'incomplete';
        /**
         * The type of the local shell call. Always `local_shell_call`.
         */
        type: 'local_shell_call';
    }
    namespace LocalShellCall {
        /**
         * Execute a shell command on the server.
         */
        interface Action {
            /**
             * The command to run.
             */
            command: Array<string>;
            /**
             * Environment variables to set for the command.
             */
            env: {
                [key: string]: string;
            };
            /**
             * The type of the local shell action. Always `exec`.
             */
            type: 'exec';
            /**
             * Optional timeout in milliseconds for the command.
             */
            timeout_ms?: number | null;
            /**
             * Optional user to run the command as.
             */
            user?: string | null;
            /**
             * Optional working directory to run the command in.
             */
            working_directory?: string | null;
        }
    }
    /**
     * The output of a local shell tool call.
     */
    interface LocalShellCallOutput {
        /**
         * The unique ID of the local shell tool call generated by the model.
         */
        id: string;
        /**
         * A JSON string of the output of the local shell tool call.
         */
        output: string;
        /**
         * The type of the local shell tool call output. Always `local_shell_call_output`.
         */
        type: 'local_shell_call_output';
        /**
         * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    /**
     * A tool representing a request to execute one or more shell commands.
     */
    interface ShellCall {
        /**
         * The shell commands and limits that describe how to run the tool call.
         */
        action: ShellCall.Action;
        /**
         * The unique ID of the shell tool call generated by the model.
         */
        call_id: string;
        /**
         * The type of the item. Always `shell_call`.
         */
        type: 'shell_call';
        /**
         * The unique ID of the shell tool call. Populated when this item is returned via
         * API.
         */
        id?: string | null;
        /**
         * The environment to execute the shell commands in.
         */
        environment?: ResponsesAPI.LocalEnvironment | ResponsesAPI.ContainerReference | null;
        /**
         * The status of the shell call. One of `in_progress`, `completed`, or
         * `incomplete`.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    namespace ShellCall {
        /**
         * The shell commands and limits that describe how to run the tool call.
         */
        interface Action {
            /**
             * Ordered shell commands for the execution environment to run.
             */
            commands: Array<string>;
            /**
             * Maximum number of UTF-8 characters to capture from combined stdout and stderr
             * output.
             */
            max_output_length?: number | null;
            /**
             * Maximum wall-clock time in milliseconds to allow the shell commands to run.
             */
            timeout_ms?: number | null;
        }
    }
    /**
     * The streamed output items emitted by a shell tool call.
     */
    interface ShellCallOutput {
        /**
         * The unique ID of the shell tool call generated by the model.
         */
        call_id: string;
        /**
         * Captured chunks of stdout and stderr output, along with their associated
         * outcomes.
         */
        output: Array<ResponsesAPI.ResponseFunctionShellCallOutputContent>;
        /**
         * The type of the item. Always `shell_call_output`.
         */
        type: 'shell_call_output';
        /**
         * The unique ID of the shell tool call output. Populated when this item is
         * returned via API.
         */
        id?: string | null;
        /**
         * The maximum number of UTF-8 characters captured for this shell call's combined
         * output.
         */
        max_output_length?: number | null;
        /**
         * The status of the shell call output.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    /**
     * A tool call representing a request to create, delete, or update files using diff
     * patches.
     */
    interface ApplyPatchCall {
        /**
         * The unique ID of the apply patch tool call generated by the model.
         */
        call_id: string;
        /**
         * The specific create, delete, or update instruction for the apply_patch tool
         * call.
         */
        operation: ApplyPatchCall.CreateFile | ApplyPatchCall.DeleteFile | ApplyPatchCall.UpdateFile;
        /**
         * The status of the apply patch tool call. One of `in_progress` or `completed`.
         */
        status: 'in_progress' | 'completed';
        /**
         * The type of the item. Always `apply_patch_call`.
         */
        type: 'apply_patch_call';
        /**
         * The unique ID of the apply patch tool call. Populated when this item is returned
         * via API.
         */
        id?: string | null;
    }
    namespace ApplyPatchCall {
        /**
         * Instruction for creating a new file via the apply_patch tool.
         */
        interface CreateFile {
            /**
             * Unified diff content to apply when creating the file.
             */
            diff: string;
            /**
             * Path of the file to create relative to the workspace root.
             */
            path: string;
            /**
             * The operation type. Always `create_file`.
             */
            type: 'create_file';
        }
        /**
         * Instruction for deleting an existing file via the apply_patch tool.
         */
        interface DeleteFile {
            /**
             * Path of the file to delete relative to the workspace root.
             */
            path: string;
            /**
             * The operation type. Always `delete_file`.
             */
            type: 'delete_file';
        }
        /**
         * Instruction for updating an existing file via the apply_patch tool.
         */
        interface UpdateFile {
            /**
             * Unified diff content to apply to the existing file.
             */
            diff: string;
            /**
             * Path of the file to update relative to the workspace root.
             */
            path: string;
            /**
             * The operation type. Always `update_file`.
             */
            type: 'update_file';
        }
    }
    /**
     * The streamed output emitted by an apply patch tool call.
     */
    interface ApplyPatchCallOutput {
        /**
         * The unique ID of the apply patch tool call generated by the model.
         */
        call_id: string;
        /**
         * The status of the apply patch tool call output. One of `completed` or `failed`.
         */
        status: 'completed' | 'failed';
        /**
         * The type of the item. Always `apply_patch_call_output`.
         */
        type: 'apply_patch_call_output';
        /**
         * The unique ID of the apply patch tool call output. Populated when this item is
         * returned via API.
         */
        id?: string | null;
        /**
         * Optional human-readable log text from the apply patch tool (e.g., patch results
         * or errors).
         */
        output?: string | null;
    }
    /**
     * A list of tools available on an MCP server.
     */
    interface McpListTools {
        /**
         * The unique ID of the list.
         */
        id: string;
        /**
         * The label of the MCP server.
         */
        server_label: string;
        /**
         * The tools available on the server.
         */
        tools: Array<McpListTools.Tool>;
        /**
         * The type of the item. Always `mcp_list_tools`.
         */
        type: 'mcp_list_tools';
        /**
         * Error message if the server could not list tools.
         */
        error?: string | null;
    }
    namespace McpListTools {
        /**
         * A tool available on an MCP server.
         */
        interface Tool {
            /**
             * The JSON schema describing the tool's input.
             */
            input_schema: unknown;
            /**
             * The name of the tool.
             */
            name: string;
            /**
             * Additional annotations about the tool.
             */
            annotations?: unknown | null;
            /**
             * The description of the tool.
             */
            description?: string | null;
        }
    }
    /**
     * A request for human approval of a tool invocation.
     */
    interface McpApprovalRequest {
        /**
         * The unique ID of the approval request.
         */
        id: string;
        /**
         * A JSON string of arguments for the tool.
         */
        arguments: string;
        /**
         * The name of the tool to run.
         */
        name: string;
        /**
         * The label of the MCP server making the request.
         */
        server_label: string;
        /**
         * The type of the item. Always `mcp_approval_request`.
         */
        type: 'mcp_approval_request';
    }
    /**
     * A response to an MCP approval request.
     */
    interface McpApprovalResponse {
        /**
         * The ID of the approval request being answered.
         */
        approval_request_id: string;
        /**
         * Whether the request was approved.
         */
        approve: boolean;
        /**
         * The type of the item. Always `mcp_approval_response`.
         */
        type: 'mcp_approval_response';
        /**
         * The unique ID of the approval response
         */
        id?: string | null;
        /**
         * Optional reason for the decision.
         */
        reason?: string | null;
    }
    /**
     * An invocation of a tool on an MCP server.
     */
    interface McpCall {
        /**
         * The unique ID of the tool call.
         */
        id: string;
        /**
         * A JSON string of the arguments passed to the tool.
         */
        arguments: string;
        /**
         * The name of the tool that was run.
         */
        name: string;
        /**
         * The label of the MCP server running the tool.
         */
        server_label: string;
        /**
         * The type of the item. Always `mcp_call`.
         */
        type: 'mcp_call';
        /**
         * Unique identifier for the MCP tool call approval request. Include this value in
         * a subsequent `mcp_approval_response` input to approve or reject the
         * corresponding tool call.
         */
        approval_request_id?: string | null;
        /**
         * The error from the tool call, if any.
         */
        error?: string | null;
        /**
         * The output from the tool call.
         */
        output?: string | null;
        /**
         * The status of the tool call. One of `in_progress`, `completed`, `incomplete`,
         * `calling`, or `failed`.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
    }
    /**
     * An internal identifier for an item to reference.
     */
    interface ItemReference {
        /**
         * The ID of the item to reference.
         */
        id: string;
        /**
         * The type of item to reference. Always `item_reference`.
         */
        type?: 'item_reference' | null;
    }
}
/**
 * A list of one or many input items to the model, containing different content
 * types.
 */
export type ResponseInputMessageContentList = Array<ResponseInputContent>;
export interface ResponseInputMessageItem {
    /**
     * The unique ID of the message input.
     */
    id: string;
    /**
     * A list of one or many input items to the model, containing different content
     * types.
     */
    content: ResponseInputMessageContentList;
    /**
     * The role of the message input. One of `user`, `system`, or `developer`.
     */
    role: 'user' | 'system' | 'developer';
    /**
     * The type of the message input. Always set to `message`.
     */
    type: 'message';
    /**
     * The status of item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status?: 'in_progress' | 'completed' | 'incomplete';
}
/**
 * A text input to the model.
 */
export interface ResponseInputText {
    /**
     * The text input to the model.
     */
    text: string;
    /**
     * The type of the input item. Always `input_text`.
     */
    type: 'input_text';
}
/**
 * A text input to the model.
 */
export interface ResponseInputTextContent {
    /**
     * The text input to the model.
     */
    text: string;
    /**
     * The type of the input item. Always `input_text`.
     */
    type: 'input_text';
}
/**
 * Content item used to generate a response.
 */
export type ResponseItem = ResponseInputMessageItem | ResponseOutputMessage | ResponseFileSearchToolCall | ResponseComputerToolCall | ResponseComputerToolCallOutputItem | ResponseFunctionWebSearch | ResponseFunctionToolCallItem | ResponseFunctionToolCallOutputItem | ResponseToolSearchCall | ResponseToolSearchOutputItem | ResponseReasoningItem | ResponseCompactionItem | ResponseItem.ImageGenerationCall | ResponseCodeInterpreterToolCall | ResponseItem.LocalShellCall | ResponseItem.LocalShellCallOutput | ResponseFunctionShellToolCall | ResponseFunctionShellToolCallOutput | ResponseApplyPatchToolCall | ResponseApplyPatchToolCallOutput | ResponseItem.McpListTools | ResponseItem.McpApprovalRequest | ResponseItem.McpApprovalResponse | ResponseItem.McpCall | ResponseCustomToolCallItem | ResponseCustomToolCallOutputItem;
export declare namespace ResponseItem {
    /**
     * An image generation request made by the model.
     */
    interface ImageGenerationCall {
        /**
         * The unique ID of the image generation call.
         */
        id: string;
        /**
         * The generated image encoded in base64.
         */
        result: string | null;
        /**
         * The status of the image generation call.
         */
        status: 'in_progress' | 'completed' | 'generating' | 'failed';
        /**
         * The type of the image generation call. Always `image_generation_call`.
         */
        type: 'image_generation_call';
    }
    /**
     * A tool call to run a command on the local shell.
     */
    interface LocalShellCall {
        /**
         * The unique ID of the local shell call.
         */
        id: string;
        /**
         * Execute a shell command on the server.
         */
        action: LocalShellCall.Action;
        /**
         * The unique ID of the local shell tool call generated by the model.
         */
        call_id: string;
        /**
         * The status of the local shell call.
         */
        status: 'in_progress' | 'completed' | 'incomplete';
        /**
         * The type of the local shell call. Always `local_shell_call`.
         */
        type: 'local_shell_call';
    }
    namespace LocalShellCall {
        /**
         * Execute a shell command on the server.
         */
        interface Action {
            /**
             * The command to run.
             */
            command: Array<string>;
            /**
             * Environment variables to set for the command.
             */
            env: {
                [key: string]: string;
            };
            /**
             * The type of the local shell action. Always `exec`.
             */
            type: 'exec';
            /**
             * Optional timeout in milliseconds for the command.
             */
            timeout_ms?: number | null;
            /**
             * Optional user to run the command as.
             */
            user?: string | null;
            /**
             * Optional working directory to run the command in.
             */
            working_directory?: string | null;
        }
    }
    /**
     * The output of a local shell tool call.
     */
    interface LocalShellCallOutput {
        /**
         * The unique ID of the local shell tool call generated by the model.
         */
        id: string;
        /**
         * A JSON string of the output of the local shell tool call.
         */
        output: string;
        /**
         * The type of the local shell tool call output. Always `local_shell_call_output`.
         */
        type: 'local_shell_call_output';
        /**
         * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    /**
     * A list of tools available on an MCP server.
     */
    interface McpListTools {
        /**
         * The unique ID of the list.
         */
        id: string;
        /**
         * The label of the MCP server.
         */
        server_label: string;
        /**
         * The tools available on the server.
         */
        tools: Array<McpListTools.Tool>;
        /**
         * The type of the item. Always `mcp_list_tools`.
         */
        type: 'mcp_list_tools';
        /**
         * Error message if the server could not list tools.
         */
        error?: string | null;
    }
    namespace McpListTools {
        /**
         * A tool available on an MCP server.
         */
        interface Tool {
            /**
             * The JSON schema describing the tool's input.
             */
            input_schema: unknown;
            /**
             * The name of the tool.
             */
            name: string;
            /**
             * Additional annotations about the tool.
             */
            annotations?: unknown | null;
            /**
             * The description of the tool.
             */
            description?: string | null;
        }
    }
    /**
     * A request for human approval of a tool invocation.
     */
    interface McpApprovalRequest {
        /**
         * The unique ID of the approval request.
         */
        id: string;
        /**
         * A JSON string of arguments for the tool.
         */
        arguments: string;
        /**
         * The name of the tool to run.
         */
        name: string;
        /**
         * The label of the MCP server making the request.
         */
        server_label: string;
        /**
         * The type of the item. Always `mcp_approval_request`.
         */
        type: 'mcp_approval_request';
    }
    /**
     * A response to an MCP approval request.
     */
    interface McpApprovalResponse {
        /**
         * The unique ID of the approval response
         */
        id: string;
        /**
         * The ID of the approval request being answered.
         */
        approval_request_id: string;
        /**
         * Whether the request was approved.
         */
        approve: boolean;
        /**
         * The type of the item. Always `mcp_approval_response`.
         */
        type: 'mcp_approval_response';
        /**
         * Optional reason for the decision.
         */
        reason?: string | null;
    }
    /**
     * An invocation of a tool on an MCP server.
     */
    interface McpCall {
        /**
         * The unique ID of the tool call.
         */
        id: string;
        /**
         * A JSON string of the arguments passed to the tool.
         */
        arguments: string;
        /**
         * The name of the tool that was run.
         */
        name: string;
        /**
         * The label of the MCP server running the tool.
         */
        server_label: string;
        /**
         * The type of the item. Always `mcp_call`.
         */
        type: 'mcp_call';
        /**
         * Unique identifier for the MCP tool call approval request. Include this value in
         * a subsequent `mcp_approval_response` input to approve or reject the
         * corresponding tool call.
         */
        approval_request_id?: string | null;
        /**
         * The error from the tool call, if any.
         */
        error?: string | null;
        /**
         * The output from the tool call.
         */
        output?: string | null;
        /**
         * The status of the tool call. One of `in_progress`, `completed`, `incomplete`,
         * `calling`, or `failed`.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
    }
}
/**
 * Represents the use of a local environment to perform shell actions.
 */
export interface ResponseLocalEnvironment {
    /**
     * The environment type. Always `local`.
     */
    type: 'local';
}
/**
 * Emitted when there is a delta (partial update) to the arguments of an MCP tool
 * call.
 */
export interface ResponseMcpCallArgumentsDeltaEvent {
    /**
     * A JSON string containing the partial update to the arguments for the MCP tool
     * call.
     */
    delta: string;
    /**
     * The unique identifier of the MCP tool call item being processed.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_call_arguments.delta'.
     */
    type: 'response.mcp_call_arguments.delta';
}
/**
 * Emitted when the arguments for an MCP tool call are finalized.
 */
export interface ResponseMcpCallArgumentsDoneEvent {
    /**
     * A JSON string containing the finalized arguments for the MCP tool call.
     */
    arguments: string;
    /**
     * The unique identifier of the MCP tool call item being processed.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_call_arguments.done'.
     */
    type: 'response.mcp_call_arguments.done';
}
/**
 * Emitted when an MCP tool call has completed successfully.
 */
export interface ResponseMcpCallCompletedEvent {
    /**
     * The ID of the MCP tool call item that completed.
     */
    item_id: string;
    /**
     * The index of the output item that completed.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_call.completed'.
     */
    type: 'response.mcp_call.completed';
}
/**
 * Emitted when an MCP tool call has failed.
 */
export interface ResponseMcpCallFailedEvent {
    /**
     * The ID of the MCP tool call item that failed.
     */
    item_id: string;
    /**
     * The index of the output item that failed.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_call.failed'.
     */
    type: 'response.mcp_call.failed';
}
/**
 * Emitted when an MCP tool call is in progress.
 */
export interface ResponseMcpCallInProgressEvent {
    /**
     * The unique identifier of the MCP tool call item being processed.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_call.in_progress'.
     */
    type: 'response.mcp_call.in_progress';
}
/**
 * Emitted when the list of available MCP tools has been successfully retrieved.
 */
export interface ResponseMcpListToolsCompletedEvent {
    /**
     * The ID of the MCP tool call item that produced this output.
     */
    item_id: string;
    /**
     * The index of the output item that was processed.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_list_tools.completed'.
     */
    type: 'response.mcp_list_tools.completed';
}
/**
 * Emitted when the attempt to list available MCP tools has failed.
 */
export interface ResponseMcpListToolsFailedEvent {
    /**
     * The ID of the MCP tool call item that failed.
     */
    item_id: string;
    /**
     * The index of the output item that failed.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_list_tools.failed'.
     */
    type: 'response.mcp_list_tools.failed';
}
/**
 * Emitted when the system is in the process of retrieving the list of available
 * MCP tools.
 */
export interface ResponseMcpListToolsInProgressEvent {
    /**
     * The ID of the MCP tool call item that is being processed.
     */
    item_id: string;
    /**
     * The index of the output item that is being processed.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.mcp_list_tools.in_progress'.
     */
    type: 'response.mcp_list_tools.in_progress';
}
/**
 * An audio output from the model.
 */
export interface ResponseOutputAudio {
    /**
     * Base64-encoded audio data from the model.
     */
    data: string;
    /**
     * The transcript of the audio data from the model.
     */
    transcript: string;
    /**
     * The type of the output audio. Always `output_audio`.
     */
    type: 'output_audio';
}
/**
 * An output message from the model.
 */
export type ResponseOutputItem = ResponseOutputMessage | ResponseFileSearchToolCall | ResponseFunctionToolCall | ResponseFunctionToolCallOutputItem | ResponseFunctionWebSearch | ResponseComputerToolCall | ResponseComputerToolCallOutputItem | ResponseReasoningItem | ResponseToolSearchCall | ResponseToolSearchOutputItem | ResponseCompactionItem | ResponseOutputItem.ImageGenerationCall | ResponseCodeInterpreterToolCall | ResponseOutputItem.LocalShellCall | ResponseOutputItem.LocalShellCallOutput | ResponseFunctionShellToolCall | ResponseFunctionShellToolCallOutput | ResponseApplyPatchToolCall | ResponseApplyPatchToolCallOutput | ResponseOutputItem.McpCall | ResponseOutputItem.McpListTools | ResponseOutputItem.McpApprovalRequest | ResponseOutputItem.McpApprovalResponse | ResponseCustomToolCall | ResponseCustomToolCallOutputItem;
export declare namespace ResponseOutputItem {
    /**
     * An image generation request made by the model.
     */
    interface ImageGenerationCall {
        /**
         * The unique ID of the image generation call.
         */
        id: string;
        /**
         * The generated image encoded in base64.
         */
        result: string | null;
        /**
         * The status of the image generation call.
         */
        status: 'in_progress' | 'completed' | 'generating' | 'failed';
        /**
         * The type of the image generation call. Always `image_generation_call`.
         */
        type: 'image_generation_call';
    }
    /**
     * A tool call to run a command on the local shell.
     */
    interface LocalShellCall {
        /**
         * The unique ID of the local shell call.
         */
        id: string;
        /**
         * Execute a shell command on the server.
         */
        action: LocalShellCall.Action;
        /**
         * The unique ID of the local shell tool call generated by the model.
         */
        call_id: string;
        /**
         * The status of the local shell call.
         */
        status: 'in_progress' | 'completed' | 'incomplete';
        /**
         * The type of the local shell call. Always `local_shell_call`.
         */
        type: 'local_shell_call';
    }
    namespace LocalShellCall {
        /**
         * Execute a shell command on the server.
         */
        interface Action {
            /**
             * The command to run.
             */
            command: Array<string>;
            /**
             * Environment variables to set for the command.
             */
            env: {
                [key: string]: string;
            };
            /**
             * The type of the local shell action. Always `exec`.
             */
            type: 'exec';
            /**
             * Optional timeout in milliseconds for the command.
             */
            timeout_ms?: number | null;
            /**
             * Optional user to run the command as.
             */
            user?: string | null;
            /**
             * Optional working directory to run the command in.
             */
            working_directory?: string | null;
        }
    }
    /**
     * The output of a local shell tool call.
     */
    interface LocalShellCallOutput {
        /**
         * The unique ID of the local shell tool call generated by the model.
         */
        id: string;
        /**
         * A JSON string of the output of the local shell tool call.
         */
        output: string;
        /**
         * The type of the local shell tool call output. Always `local_shell_call_output`.
         */
        type: 'local_shell_call_output';
        /**
         * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | null;
    }
    /**
     * An invocation of a tool on an MCP server.
     */
    interface McpCall {
        /**
         * The unique ID of the tool call.
         */
        id: string;
        /**
         * A JSON string of the arguments passed to the tool.
         */
        arguments: string;
        /**
         * The name of the tool that was run.
         */
        name: string;
        /**
         * The label of the MCP server running the tool.
         */
        server_label: string;
        /**
         * The type of the item. Always `mcp_call`.
         */
        type: 'mcp_call';
        /**
         * Unique identifier for the MCP tool call approval request. Include this value in
         * a subsequent `mcp_approval_response` input to approve or reject the
         * corresponding tool call.
         */
        approval_request_id?: string | null;
        /**
         * The error from the tool call, if any.
         */
        error?: string | null;
        /**
         * The output from the tool call.
         */
        output?: string | null;
        /**
         * The status of the tool call. One of `in_progress`, `completed`, `incomplete`,
         * `calling`, or `failed`.
         */
        status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
    }
    /**
     * A list of tools available on an MCP server.
     */
    interface McpListTools {
        /**
         * The unique ID of the list.
         */
        id: string;
        /**
         * The label of the MCP server.
         */
        server_label: string;
        /**
         * The tools available on the server.
         */
        tools: Array<McpListTools.Tool>;
        /**
         * The type of the item. Always `mcp_list_tools`.
         */
        type: 'mcp_list_tools';
        /**
         * Error message if the server could not list tools.
         */
        error?: string | null;
    }
    namespace McpListTools {
        /**
         * A tool available on an MCP server.
         */
        interface Tool {
            /**
             * The JSON schema describing the tool's input.
             */
            input_schema: unknown;
            /**
             * The name of the tool.
             */
            name: string;
            /**
             * Additional annotations about the tool.
             */
            annotations?: unknown | null;
            /**
             * The description of the tool.
             */
            description?: string | null;
        }
    }
    /**
     * A request for human approval of a tool invocation.
     */
    interface McpApprovalRequest {
        /**
         * The unique ID of the approval request.
         */
        id: string;
        /**
         * A JSON string of arguments for the tool.
         */
        arguments: string;
        /**
         * The name of the tool to run.
         */
        name: string;
        /**
         * The label of the MCP server making the request.
         */
        server_label: string;
        /**
         * The type of the item. Always `mcp_approval_request`.
         */
        type: 'mcp_approval_request';
    }
    /**
     * A response to an MCP approval request.
     */
    interface McpApprovalResponse {
        /**
         * The unique ID of the approval response
         */
        id: string;
        /**
         * The ID of the approval request being answered.
         */
        approval_request_id: string;
        /**
         * Whether the request was approved.
         */
        approve: boolean;
        /**
         * The type of the item. Always `mcp_approval_response`.
         */
        type: 'mcp_approval_response';
        /**
         * Optional reason for the decision.
         */
        reason?: string | null;
    }
}
/**
 * Emitted when a new output item is added.
 */
export interface ResponseOutputItemAddedEvent {
    /**
     * The output item that was added.
     */
    item: ResponseOutputItem;
    /**
     * The index of the output item that was added.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.output_item.added`.
     */
    type: 'response.output_item.added';
}
/**
 * Emitted when an output item is marked done.
 */
export interface ResponseOutputItemDoneEvent {
    /**
     * The output item that was marked done.
     */
    item: ResponseOutputItem;
    /**
     * The index of the output item that was marked done.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.output_item.done`.
     */
    type: 'response.output_item.done';
}
/**
 * An output message from the model.
 */
export interface ResponseOutputMessage {
    /**
     * The unique ID of the output message.
     */
    id: string;
    /**
     * The content of the output message.
     */
    content: Array<ResponseOutputText | ResponseOutputRefusal>;
    /**
     * The role of the output message. Always `assistant`.
     */
    role: 'assistant';
    /**
     * The status of the message input. One of `in_progress`, `completed`, or
     * `incomplete`. Populated when input items are returned via API.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The type of the output message. Always `message`.
     */
    type: 'message';
    /**
     * Labels an `assistant` message as intermediate commentary (`commentary`) or the
     * final answer (`final_answer`). For models like `gpt-5.3-codex` and beyond, when
     * sending follow-up requests, preserve and resend phase on all assistant messages
     * — dropping it can degrade performance. Not used for user messages.
     */
    phase?: 'commentary' | 'final_answer' | null;
}
/**
 * A refusal from the model.
 */
export interface ResponseOutputRefusal {
    /**
     * The refusal explanation from the model.
     */
    refusal: string;
    /**
     * The type of the refusal. Always `refusal`.
     */
    type: 'refusal';
}
/**
 * A text output from the model.
 */
export interface ResponseOutputText {
    /**
     * The annotations of the text output.
     */
    annotations: Array<ResponseOutputText.FileCitation | ResponseOutputText.URLCitation | ResponseOutputText.ContainerFileCitation | ResponseOutputText.FilePath>;
    /**
     * The text output from the model.
     */
    text: string;
    /**
     * The type of the output text. Always `output_text`.
     */
    type: 'output_text';
    logprobs?: Array<ResponseOutputText.Logprob>;
}
export declare namespace ResponseOutputText {
    /**
     * A citation to a file.
     */
    interface FileCitation {
        /**
         * The ID of the file.
         */
        file_id: string;
        /**
         * The filename of the file cited.
         */
        filename: string;
        /**
         * The index of the file in the list of files.
         */
        index: number;
        /**
         * The type of the file citation. Always `file_citation`.
         */
        type: 'file_citation';
    }
    /**
     * A citation for a web resource used to generate a model response.
     */
    interface URLCitation {
        /**
         * The index of the last character of the URL citation in the message.
         */
        end_index: number;
        /**
         * The index of the first character of the URL citation in the message.
         */
        start_index: number;
        /**
         * The title of the web resource.
         */
        title: string;
        /**
         * The type of the URL citation. Always `url_citation`.
         */
        type: 'url_citation';
        /**
         * The URL of the web resource.
         */
        url: string;
    }
    /**
     * A citation for a container file used to generate a model response.
     */
    interface ContainerFileCitation {
        /**
         * The ID of the container file.
         */
        container_id: string;
        /**
         * The index of the last character of the container file citation in the message.
         */
        end_index: number;
        /**
         * The ID of the file.
         */
        file_id: string;
        /**
         * The filename of the container file cited.
         */
        filename: string;
        /**
         * The index of the first character of the container file citation in the message.
         */
        start_index: number;
        /**
         * The type of the container file citation. Always `container_file_citation`.
         */
        type: 'container_file_citation';
    }
    /**
     * A path to a file.
     */
    interface FilePath {
        /**
         * The ID of the file.
         */
        file_id: string;
        /**
         * The index of the file in the list of files.
         */
        index: number;
        /**
         * The type of the file path. Always `file_path`.
         */
        type: 'file_path';
    }
    /**
     * The log probability of a token.
     */
    interface Logprob {
        token: string;
        bytes: Array<number>;
        logprob: number;
        top_logprobs: Array<Logprob.TopLogprob>;
    }
    namespace Logprob {
        /**
         * The top log probability of a token.
         */
        interface TopLogprob {
            token: string;
            bytes: Array<number>;
            logprob: number;
        }
    }
}
/**
 * Emitted when an annotation is added to output text content.
 */
export interface ResponseOutputTextAnnotationAddedEvent {
    /**
     * The annotation object being added. (See annotation schema for details.)
     */
    annotation: unknown;
    /**
     * The index of the annotation within the content part.
     */
    annotation_index: number;
    /**
     * The index of the content part within the output item.
     */
    content_index: number;
    /**
     * The unique identifier of the item to which the annotation is being added.
     */
    item_id: string;
    /**
     * The index of the output item in the response's output array.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.output_text.annotation.added'.
     */
    type: 'response.output_text.annotation.added';
}
/**
 * Reference to a prompt template and its variables.
 * [Learn more](https://platform.openai.com/docs/guides/text?api-mode=responses#reusable-prompts).
 */
export interface ResponsePrompt {
    /**
     * The unique identifier of the prompt template to use.
     */
    id: string;
    /**
     * Optional map of values to substitute in for variables in your prompt. The
     * substitution values can either be strings, or other Response input types like
     * images or files.
     */
    variables?: {
        [key: string]: string | ResponseInputText | ResponseInputImage | ResponseInputFile;
    } | null;
    /**
     * Optional version of the prompt template.
     */
    version?: string | null;
}
/**
 * Emitted when a response is queued and waiting to be processed.
 */
export interface ResponseQueuedEvent {
    /**
     * The full response object that is queued.
     */
    response: Response;
    /**
     * The sequence number for this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always 'response.queued'.
     */
    type: 'response.queued';
}
/**
 * A description of the chain of thought used by a reasoning model while generating
 * a response. Be sure to include these items in your `input` to the Responses API
 * for subsequent turns of a conversation if you are manually
 * [managing context](https://platform.openai.com/docs/guides/conversation-state).
 */
export interface ResponseReasoningItem {
    /**
     * The unique identifier of the reasoning content.
     */
    id: string;
    /**
     * Reasoning summary content.
     */
    summary: Array<ResponseReasoningItem.Summary>;
    /**
     * The type of the object. Always `reasoning`.
     */
    type: 'reasoning';
    /**
     * Reasoning text content.
     */
    content?: Array<ResponseReasoningItem.Content>;
    /**
     * The encrypted content of the reasoning item - populated when a response is
     * generated with `reasoning.encrypted_content` in the `include` parameter.
     */
    encrypted_content?: string | null;
    /**
     * The status of the item. One of `in_progress`, `completed`, or `incomplete`.
     * Populated when items are returned via API.
     */
    status?: 'in_progress' | 'completed' | 'incomplete';
}
export declare namespace ResponseReasoningItem {
    /**
     * A summary text from the model.
     */
    interface Summary {
        /**
         * A summary of the reasoning output from the model so far.
         */
        text: string;
        /**
         * The type of the object. Always `summary_text`.
         */
        type: 'summary_text';
    }
    /**
     * Reasoning text from the model.
     */
    interface Content {
        /**
         * The reasoning text from the model.
         */
        text: string;
        /**
         * The type of the reasoning text. Always `reasoning_text`.
         */
        type: 'reasoning_text';
    }
}
/**
 * Emitted when a new reasoning summary part is added.
 */
export interface ResponseReasoningSummaryPartAddedEvent {
    /**
     * The ID of the item this summary part is associated with.
     */
    item_id: string;
    /**
     * The index of the output item this summary part is associated with.
     */
    output_index: number;
    /**
     * The summary part that was added.
     */
    part: ResponseReasoningSummaryPartAddedEvent.Part;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The index of the summary part within the reasoning summary.
     */
    summary_index: number;
    /**
     * The type of the event. Always `response.reasoning_summary_part.added`.
     */
    type: 'response.reasoning_summary_part.added';
}
export declare namespace ResponseReasoningSummaryPartAddedEvent {
    /**
     * The summary part that was added.
     */
    interface Part {
        /**
         * The text of the summary part.
         */
        text: string;
        /**
         * The type of the summary part. Always `summary_text`.
         */
        type: 'summary_text';
    }
}
/**
 * Emitted when a reasoning summary part is completed.
 */
export interface ResponseReasoningSummaryPartDoneEvent {
    /**
     * The ID of the item this summary part is associated with.
     */
    item_id: string;
    /**
     * The index of the output item this summary part is associated with.
     */
    output_index: number;
    /**
     * The completed summary part.
     */
    part: ResponseReasoningSummaryPartDoneEvent.Part;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The index of the summary part within the reasoning summary.
     */
    summary_index: number;
    /**
     * The type of the event. Always `response.reasoning_summary_part.done`.
     */
    type: 'response.reasoning_summary_part.done';
}
export declare namespace ResponseReasoningSummaryPartDoneEvent {
    /**
     * The completed summary part.
     */
    interface Part {
        /**
         * The text of the summary part.
         */
        text: string;
        /**
         * The type of the summary part. Always `summary_text`.
         */
        type: 'summary_text';
    }
}
/**
 * Emitted when a delta is added to a reasoning summary text.
 */
export interface ResponseReasoningSummaryTextDeltaEvent {
    /**
     * The text delta that was added to the summary.
     */
    delta: string;
    /**
     * The ID of the item this summary text delta is associated with.
     */
    item_id: string;
    /**
     * The index of the output item this summary text delta is associated with.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The index of the summary part within the reasoning summary.
     */
    summary_index: number;
    /**
     * The type of the event. Always `response.reasoning_summary_text.delta`.
     */
    type: 'response.reasoning_summary_text.delta';
}
/**
 * Emitted when a reasoning summary text is completed.
 */
export interface ResponseReasoningSummaryTextDoneEvent {
    /**
     * The ID of the item this summary text is associated with.
     */
    item_id: string;
    /**
     * The index of the output item this summary text is associated with.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The index of the summary part within the reasoning summary.
     */
    summary_index: number;
    /**
     * The full text of the completed reasoning summary.
     */
    text: string;
    /**
     * The type of the event. Always `response.reasoning_summary_text.done`.
     */
    type: 'response.reasoning_summary_text.done';
}
/**
 * Emitted when a delta is added to a reasoning text.
 */
export interface ResponseReasoningTextDeltaEvent {
    /**
     * The index of the reasoning content part this delta is associated with.
     */
    content_index: number;
    /**
     * The text delta that was added to the reasoning content.
     */
    delta: string;
    /**
     * The ID of the item this reasoning text delta is associated with.
     */
    item_id: string;
    /**
     * The index of the output item this reasoning text delta is associated with.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.reasoning_text.delta`.
     */
    type: 'response.reasoning_text.delta';
}
/**
 * Emitted when a reasoning text is completed.
 */
export interface ResponseReasoningTextDoneEvent {
    /**
     * The index of the reasoning content part.
     */
    content_index: number;
    /**
     * The ID of the item this reasoning text is associated with.
     */
    item_id: string;
    /**
     * The index of the output item this reasoning text is associated with.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The full text of the completed reasoning content.
     */
    text: string;
    /**
     * The type of the event. Always `response.reasoning_text.done`.
     */
    type: 'response.reasoning_text.done';
}
/**
 * Emitted when there is a partial refusal text.
 */
export interface ResponseRefusalDeltaEvent {
    /**
     * The index of the content part that the refusal text is added to.
     */
    content_index: number;
    /**
     * The refusal text that is added.
     */
    delta: string;
    /**
     * The ID of the output item that the refusal text is added to.
     */
    item_id: string;
    /**
     * The index of the output item that the refusal text is added to.
     */
    output_index: number;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.refusal.delta`.
     */
    type: 'response.refusal.delta';
}
/**
 * Emitted when refusal text is finalized.
 */
export interface ResponseRefusalDoneEvent {
    /**
     * The index of the content part that the refusal text is finalized.
     */
    content_index: number;
    /**
     * The ID of the output item that the refusal text is finalized.
     */
    item_id: string;
    /**
     * The index of the output item that the refusal text is finalized.
     */
    output_index: number;
    /**
     * The refusal text that is finalized.
     */
    refusal: string;
    /**
     * The sequence number of this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.refusal.done`.
     */
    type: 'response.refusal.done';
}
/**
 * The status of the response generation. One of `completed`, `failed`,
 * `in_progress`, `cancelled`, `queued`, or `incomplete`.
 */
export type ResponseStatus = 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
/**
 * Emitted when there is a partial audio response.
 */
export type ResponseStreamEvent = ResponseAudioDeltaEvent | ResponseAudioDoneEvent | ResponseAudioTranscriptDeltaEvent | ResponseAudioTranscriptDoneEvent | ResponseCodeInterpreterCallCodeDeltaEvent | ResponseCodeInterpreterCallCodeDoneEvent | ResponseCodeInterpreterCallCompletedEvent | ResponseCodeInterpreterCallInProgressEvent | ResponseCodeInterpreterCallInterpretingEvent | ResponseCompletedEvent | ResponseContentPartAddedEvent | ResponseContentPartDoneEvent | ResponseCreatedEvent | ResponseErrorEvent | ResponseFileSearchCallCompletedEvent | ResponseFileSearchCallInProgressEvent | ResponseFileSearchCallSearchingEvent | ResponseFunctionCallArgumentsDeltaEvent | ResponseFunctionCallArgumentsDoneEvent | ResponseInProgressEvent | ResponseFailedEvent | ResponseIncompleteEvent | ResponseOutputItemAddedEvent | ResponseOutputItemDoneEvent | ResponseReasoningSummaryPartAddedEvent | ResponseReasoningSummaryPartDoneEvent | ResponseReasoningSummaryTextDeltaEvent | ResponseReasoningSummaryTextDoneEvent | ResponseReasoningTextDeltaEvent | ResponseReasoningTextDoneEvent | ResponseRefusalDeltaEvent | ResponseRefusalDoneEvent | ResponseTextDeltaEvent | ResponseTextDoneEvent | ResponseWebSearchCallCompletedEvent | ResponseWebSearchCallInProgressEvent | ResponseWebSearchCallSearchingEvent | ResponseImageGenCallCompletedEvent | ResponseImageGenCallGeneratingEvent | ResponseImageGenCallInProgressEvent | ResponseImageGenCallPartialImageEvent | ResponseMcpCallArgumentsDeltaEvent | ResponseMcpCallArgumentsDoneEvent | ResponseMcpCallCompletedEvent | ResponseMcpCallFailedEvent | ResponseMcpCallInProgressEvent | ResponseMcpListToolsCompletedEvent | ResponseMcpListToolsFailedEvent | ResponseMcpListToolsInProgressEvent | ResponseOutputTextAnnotationAddedEvent | ResponseQueuedEvent | ResponseCustomToolCallInputDeltaEvent | ResponseCustomToolCallInputDoneEvent;
/**
 * Configuration options for a text response from the model. Can be plain text or
 * structured JSON data. Learn more:
 *
 * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
 * - [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
 */
export interface ResponseTextConfig {
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
    format?: ResponseFormatTextConfig;
    /**
     * Constrains the verbosity of the model's response. Lower values will result in
     * more concise responses, while higher values will result in more verbose
     * responses. Currently supported values are `low`, `medium`, and `high`.
     */
    verbosity?: 'low' | 'medium' | 'high' | null;
}
/**
 * Emitted when there is an additional text delta.
 */
export interface ResponseTextDeltaEvent {
    /**
     * The index of the content part that the text delta was added to.
     */
    content_index: number;
    /**
     * The text delta that was added.
     */
    delta: string;
    /**
     * The ID of the output item that the text delta was added to.
     */
    item_id: string;
    /**
     * The log probabilities of the tokens in the delta.
     */
    logprobs: Array<ResponseTextDeltaEvent.Logprob>;
    /**
     * The index of the output item that the text delta was added to.
     */
    output_index: number;
    /**
     * The sequence number for this event.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.output_text.delta`.
     */
    type: 'response.output_text.delta';
}
export declare namespace ResponseTextDeltaEvent {
    /**
     * A logprob is the logarithmic probability that the model assigns to producing a
     * particular token at a given position in the sequence. Less-negative (higher)
     * logprob values indicate greater model confidence in that token choice.
     */
    interface Logprob {
        /**
         * A possible text token.
         */
        token: string;
        /**
         * The log probability of this token.
         */
        logprob: number;
        /**
         * The log probability of the top 20 most likely tokens.
         */
        top_logprobs?: Array<Logprob.TopLogprob>;
    }
    namespace Logprob {
        interface TopLogprob {
            /**
             * A possible text token.
             */
            token?: string;
            /**
             * The log probability of this token.
             */
            logprob?: number;
        }
    }
}
/**
 * Emitted when text content is finalized.
 */
export interface ResponseTextDoneEvent {
    /**
     * The index of the content part that the text content is finalized.
     */
    content_index: number;
    /**
     * The ID of the output item that the text content is finalized.
     */
    item_id: string;
    /**
     * The log probabilities of the tokens in the delta.
     */
    logprobs: Array<ResponseTextDoneEvent.Logprob>;
    /**
     * The index of the output item that the text content is finalized.
     */
    output_index: number;
    /**
     * The sequence number for this event.
     */
    sequence_number: number;
    /**
     * The text content that is finalized.
     */
    text: string;
    /**
     * The type of the event. Always `response.output_text.done`.
     */
    type: 'response.output_text.done';
}
export declare namespace ResponseTextDoneEvent {
    /**
     * A logprob is the logarithmic probability that the model assigns to producing a
     * particular token at a given position in the sequence. Less-negative (higher)
     * logprob values indicate greater model confidence in that token choice.
     */
    interface Logprob {
        /**
         * A possible text token.
         */
        token: string;
        /**
         * The log probability of this token.
         */
        logprob: number;
        /**
         * The log probability of the top 20 most likely tokens.
         */
        top_logprobs?: Array<Logprob.TopLogprob>;
    }
    namespace Logprob {
        interface TopLogprob {
            /**
             * A possible text token.
             */
            token?: string;
            /**
             * The log probability of this token.
             */
            logprob?: number;
        }
    }
}
export interface ResponseToolSearchCall {
    /**
     * The unique ID of the tool search call item.
     */
    id: string;
    /**
     * Arguments used for the tool search call.
     */
    arguments: unknown;
    /**
     * The unique ID of the tool search call generated by the model.
     */
    call_id: string | null;
    /**
     * Whether tool search was executed by the server or by the client.
     */
    execution: 'server' | 'client';
    /**
     * The status of the tool search call item that was recorded.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The type of the item. Always `tool_search_call`.
     */
    type: 'tool_search_call';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
export interface ResponseToolSearchOutputItem {
    /**
     * The unique ID of the tool search output item.
     */
    id: string;
    /**
     * The unique ID of the tool search call generated by the model.
     */
    call_id: string | null;
    /**
     * Whether tool search was executed by the server or by the client.
     */
    execution: 'server' | 'client';
    /**
     * The status of the tool search output item that was recorded.
     */
    status: 'in_progress' | 'completed' | 'incomplete';
    /**
     * The loaded tool definitions returned by tool search.
     */
    tools: Array<Tool>;
    /**
     * The type of the item. Always `tool_search_output`.
     */
    type: 'tool_search_output';
    /**
     * The identifier of the actor that created the item.
     */
    created_by?: string;
}
export interface ResponseToolSearchOutputItemParam {
    /**
     * The loaded tool definitions returned by the tool search output.
     */
    tools: Array<Tool>;
    /**
     * The item type. Always `tool_search_output`.
     */
    type: 'tool_search_output';
    /**
     * The unique ID of this tool search output.
     */
    id?: string | null;
    /**
     * The unique ID of the tool search call generated by the model.
     */
    call_id?: string | null;
    /**
     * Whether tool search was executed by the server or by the client.
     */
    execution?: 'server' | 'client';
    /**
     * The status of the tool search output.
     */
    status?: 'in_progress' | 'completed' | 'incomplete' | null;
}
/**
 * Represents token usage details including input tokens, output tokens, a
 * breakdown of output tokens, and the total tokens used.
 */
export interface ResponseUsage {
    /**
     * The number of input tokens.
     */
    input_tokens: number;
    /**
     * A detailed breakdown of the input tokens.
     */
    input_tokens_details: ResponseUsage.InputTokensDetails;
    /**
     * The number of output tokens.
     */
    output_tokens: number;
    /**
     * A detailed breakdown of the output tokens.
     */
    output_tokens_details: ResponseUsage.OutputTokensDetails;
    /**
     * The total number of tokens used.
     */
    total_tokens: number;
}
export declare namespace ResponseUsage {
    /**
     * A detailed breakdown of the input tokens.
     */
    interface InputTokensDetails {
        /**
         * The number of tokens that were retrieved from the cache.
         * [More on prompt caching](https://platform.openai.com/docs/guides/prompt-caching).
         */
        cached_tokens: number;
    }
    /**
     * A detailed breakdown of the output tokens.
     */
    interface OutputTokensDetails {
        /**
         * The number of reasoning tokens.
         */
        reasoning_tokens: number;
    }
}
/**
 * Emitted when a web search call is completed.
 */
export interface ResponseWebSearchCallCompletedEvent {
    /**
     * Unique ID for the output item associated with the web search call.
     */
    item_id: string;
    /**
     * The index of the output item that the web search call is associated with.
     */
    output_index: number;
    /**
     * The sequence number of the web search call being processed.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.web_search_call.completed`.
     */
    type: 'response.web_search_call.completed';
}
/**
 * Emitted when a web search call is initiated.
 */
export interface ResponseWebSearchCallInProgressEvent {
    /**
     * Unique ID for the output item associated with the web search call.
     */
    item_id: string;
    /**
     * The index of the output item that the web search call is associated with.
     */
    output_index: number;
    /**
     * The sequence number of the web search call being processed.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.web_search_call.in_progress`.
     */
    type: 'response.web_search_call.in_progress';
}
/**
 * Emitted when a web search call is executing.
 */
export interface ResponseWebSearchCallSearchingEvent {
    /**
     * Unique ID for the output item associated with the web search call.
     */
    item_id: string;
    /**
     * The index of the output item that the web search call is associated with.
     */
    output_index: number;
    /**
     * The sequence number of the web search call being processed.
     */
    sequence_number: number;
    /**
     * The type of the event. Always `response.web_search_call.searching`.
     */
    type: 'response.web_search_call.searching';
}
export interface ResponsesClientEvent {
    /**
     * The type of the client event. Always `response.create`.
     */
    type: 'response.create';
    /**
     * Whether to run the model response in the background.
     * [Learn more](https://platform.openai.com/docs/guides/background).
     */
    background?: boolean | null;
    /**
     * Context management configuration for this request.
     */
    context_management?: Array<ResponsesClientEvent.ContextManagement> | null;
    /**
     * The conversation that this response belongs to. Items from this conversation are
     * prepended to `input_items` for this response request. Input items and output
     * items from this response are automatically added to this conversation after this
     * response completes.
     */
    conversation?: string | ResponseConversationParam | null;
    /**
     * Specify additional output data to include in the model response. Currently
     * supported values are:
     *
     * - `web_search_call.action.sources`: Include the sources of the web search tool
     *   call.
     * - `code_interpreter_call.outputs`: Includes the outputs of python code execution
     *   in code interpreter tool call items.
     * - `computer_call_output.output.image_url`: Include image urls from the computer
     *   call output.
     * - `file_search_call.results`: Include the search results of the file search tool
     *   call.
     * - `message.input_image.image_url`: Include image urls from the input message.
     * - `message.output_text.logprobs`: Include logprobs with assistant messages.
     * - `reasoning.encrypted_content`: Includes an encrypted version of reasoning
     *   tokens in reasoning item outputs. This enables reasoning items to be used in
     *   multi-turn conversations when using the Responses API statelessly (like when
     *   the `store` parameter is set to `false`, or when an organization is enrolled
     *   in the zero data retention program).
     */
    include?: Array<ResponseIncludable> | null;
    /**
     * Text, image, or file inputs to the model, used to generate a response.
     *
     * Learn more:
     *
     * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
     * - [Image inputs](https://platform.openai.com/docs/guides/images)
     * - [File inputs](https://platform.openai.com/docs/guides/pdf-files)
     * - [Conversation state](https://platform.openai.com/docs/guides/conversation-state)
     * - [Function calling](https://platform.openai.com/docs/guides/function-calling)
     */
    input?: string | ResponseInput;
    /**
     * A system (or developer) message inserted into the model's context.
     *
     * When using along with `previous_response_id`, the instructions from a previous
     * response will not be carried over to the next response. This makes it simple to
     * swap out system (or developer) messages in new responses.
     */
    instructions?: string | null;
    /**
     * An upper bound for the number of tokens that can be generated for a response,
     * including visible output tokens and
     * [reasoning tokens](https://platform.openai.com/docs/guides/reasoning).
     */
    max_output_tokens?: number | null;
    /**
     * The maximum number of total calls to built-in tools that can be processed in a
     * response. This maximum number applies across all built-in tool calls, not per
     * individual tool. Any further attempts to call a tool by the model will be
     * ignored.
     */
    max_tool_calls?: number | null;
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
     * Model ID used to generate the response, like `gpt-4o` or `o3`. OpenAI offers a
     * wide range of models with different capabilities, performance characteristics,
     * and price points. Refer to the
     * [model guide](https://platform.openai.com/docs/models) to browse and compare
     * available models.
     */
    model?: Shared.ResponsesModel;
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
     * Reference to a prompt template and its variables.
     * [Learn more](https://platform.openai.com/docs/guides/text?api-mode=responses#reusable-prompts).
     */
    prompt?: ResponsePrompt | null;
    /**
     * Used by OpenAI to cache responses for similar requests to optimize your cache
     * hit rates. Replaces the `user` field.
     * [Learn more](https://platform.openai.com/docs/guides/prompt-caching).
     */
    prompt_cache_key?: string;
    /**
     * The retention policy for the prompt cache. Set to `24h` to enable extended
     * prompt caching, which keeps cached prefixes active for longer, up to a maximum
     * of 24 hours.
     * [Learn more](https://platform.openai.com/docs/guides/prompt-caching#prompt-cache-retention).
     */
    prompt_cache_retention?: 'in-memory' | '24h' | null;
    /**
     * **gpt-5 and o-series models only**
     *
     * Configuration options for
     * [reasoning models](https://platform.openai.com/docs/guides/reasoning).
     */
    reasoning?: Shared.Reasoning | null;
    /**
     * A stable identifier used to help detect users of your application that may be
     * violating OpenAI's usage policies. The IDs should be a string that uniquely
     * identifies each user, with a maximum length of 64 characters. We recommend
     * hashing their username or email address, in order to avoid sending us any
     * identifying information.
     * [Learn more](https://platform.openai.com/docs/guides/safety-best-practices#safety-identifiers).
     */
    safety_identifier?: string;
    /**
     * Specifies the processing type used for serving the request.
     *
     * - If set to 'auto', then the request will be processed with the service tier
     *   configured in the Project settings. Unless otherwise configured, the Project
     *   will use 'default'.
     * - If set to 'default', then the request will be processed with the standard
     *   pricing and performance for the selected model.
     * - If set to '[flex](https://platform.openai.com/docs/guides/flex-processing)' or
     *   '[priority](https://openai.com/api-priority-processing/)', then the request
     *   will be processed with the corresponding service tier.
     * - When not set, the default behavior is 'auto'.
     *
     * When the `service_tier` parameter is set, the response body will include the
     * `service_tier` value based on the processing mode actually used to serve the
     * request. This response value may be different from the value set in the
     * parameter.
     */
    service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null;
    /**
     * Whether to store the generated model response for later retrieval via API.
     */
    store?: boolean | null;
    /**
     * If set to true, the model response data will be streamed to the client as it is
     * generated using
     * [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
     * See the
     * [Streaming section below](https://platform.openai.com/docs/api-reference/responses-streaming)
     * for more information.
     */
    stream?: boolean | null;
    /**
     * Options for streaming responses. Only set this when you set `stream: true`.
     */
    stream_options?: ResponsesClientEvent.StreamOptions | null;
    /**
     * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will
     * make the output more random, while lower values like 0.2 will make it more
     * focused and deterministic. We generally recommend altering this or `top_p` but
     * not both.
     */
    temperature?: number | null;
    /**
     * Configuration options for a text response from the model. Can be plain text or
     * structured JSON data. Learn more:
     *
     * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
     * - [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
     */
    text?: ResponseTextConfig;
    /**
     * How the model should select which tool (or tools) to use when generating a
     * response. See the `tools` parameter to see how to specify which tools the model
     * can call.
     */
    tool_choice?: ToolChoiceOptions | ToolChoiceAllowed | ToolChoiceTypes | ToolChoiceFunction | ToolChoiceMcp | ToolChoiceCustom | ToolChoiceApplyPatch | ToolChoiceShell;
    /**
     * An array of tools the model may call while generating a response. You can
     * specify which tool to use by setting the `tool_choice` parameter.
     *
     * We support the following categories of tools:
     *
     * - **Built-in tools**: Tools that are provided by OpenAI that extend the model's
     *   capabilities, like
     *   [web search](https://platform.openai.com/docs/guides/tools-web-search) or
     *   [file search](https://platform.openai.com/docs/guides/tools-file-search).
     *   Learn more about
     *   [built-in tools](https://platform.openai.com/docs/guides/tools).
     * - **MCP Tools**: Integrations with third-party systems via custom MCP servers or
     *   predefined connectors such as Google Drive and SharePoint. Learn more about
     *   [MCP Tools](https://platform.openai.com/docs/guides/tools-connectors-mcp).
     * - **Function calls (custom tools)**: Functions that are defined by you, enabling
     *   the model to call your own code with strongly typed arguments and outputs.
     *   Learn more about
     *   [function calling](https://platform.openai.com/docs/guides/function-calling).
     *   You can also use custom tools to call your own code.
     */
    tools?: Array<Tool>;
    /**
     * An integer between 0 and 20 specifying the number of most likely tokens to
     * return at each token position, each with an associated log probability.
     */
    top_logprobs?: number | null;
    /**
     * An alternative to sampling with temperature, called nucleus sampling, where the
     * model considers the results of the tokens with top_p probability mass. So 0.1
     * means only the tokens comprising the top 10% probability mass are considered.
     *
     * We generally recommend altering this or `temperature` but not both.
     */
    top_p?: number | null;
    /**
     * The truncation strategy to use for the model response.
     *
     * - `auto`: If the input to this Response exceeds the model's context window size,
     *   the model will truncate the response to fit the context window by dropping
     *   items from the beginning of the conversation.
     * - `disabled` (default): If the input size will exceed the context window size
     *   for a model, the request will fail with a 400 error.
     */
    truncation?: 'auto' | 'disabled' | null;
    /**
     * @deprecated This field is being replaced by `safety_identifier` and
     * `prompt_cache_key`. Use `prompt_cache_key` instead to maintain caching
     * optimizations. A stable identifier for your end-users. Used to boost cache hit
     * rates by better bucketing similar requests and to help OpenAI detect and prevent
     * abuse.
     * [Learn more](https://platform.openai.com/docs/guides/safety-best-practices#safety-identifiers).
     */
    user?: string;
}
export declare namespace ResponsesClientEvent {
    interface ContextManagement {
        /**
         * The context management entry type. Currently only 'compaction' is supported.
         */
        type: string;
        /**
         * Token threshold at which compaction should be triggered for this entry.
         */
        compact_threshold?: number | null;
    }
    /**
     * Options for streaming responses. Only set this when you set `stream: true`.
     */
    interface StreamOptions {
        /**
         * When true, stream obfuscation will be enabled. Stream obfuscation adds random
         * characters to an `obfuscation` field on streaming delta events to normalize
         * payload sizes as a mitigation to certain side-channel attacks. These obfuscation
         * fields are included by default, but add a small amount of overhead to the data
         * stream. You can set `include_obfuscation` to false to optimize for bandwidth if
         * you trust the network links between your application and the OpenAI API.
         */
        include_obfuscation?: boolean;
    }
}
/**
 * Server events emitted by the Responses WebSocket server.
 */
export type ResponsesServerEvent = ResponseAudioDeltaEvent | ResponseAudioDoneEvent | ResponseAudioTranscriptDeltaEvent | ResponseAudioTranscriptDoneEvent | ResponseCodeInterpreterCallCodeDeltaEvent | ResponseCodeInterpreterCallCodeDoneEvent | ResponseCodeInterpreterCallCompletedEvent | ResponseCodeInterpreterCallInProgressEvent | ResponseCodeInterpreterCallInterpretingEvent | ResponseCompletedEvent | ResponseContentPartAddedEvent | ResponseContentPartDoneEvent | ResponseCreatedEvent | ResponseErrorEvent | ResponseFileSearchCallCompletedEvent | ResponseFileSearchCallInProgressEvent | ResponseFileSearchCallSearchingEvent | ResponseFunctionCallArgumentsDeltaEvent | ResponseFunctionCallArgumentsDoneEvent | ResponseInProgressEvent | ResponseFailedEvent | ResponseIncompleteEvent | ResponseOutputItemAddedEvent | ResponseOutputItemDoneEvent | ResponseReasoningSummaryPartAddedEvent | ResponseReasoningSummaryPartDoneEvent | ResponseReasoningSummaryTextDeltaEvent | ResponseReasoningSummaryTextDoneEvent | ResponseReasoningTextDeltaEvent | ResponseReasoningTextDoneEvent | ResponseRefusalDeltaEvent | ResponseRefusalDoneEvent | ResponseTextDeltaEvent | ResponseTextDoneEvent | ResponseWebSearchCallCompletedEvent | ResponseWebSearchCallInProgressEvent | ResponseWebSearchCallSearchingEvent | ResponseImageGenCallCompletedEvent | ResponseImageGenCallGeneratingEvent | ResponseImageGenCallInProgressEvent | ResponseImageGenCallPartialImageEvent | ResponseMcpCallArgumentsDeltaEvent | ResponseMcpCallArgumentsDoneEvent | ResponseMcpCallCompletedEvent | ResponseMcpCallFailedEvent | ResponseMcpCallInProgressEvent | ResponseMcpListToolsCompletedEvent | ResponseMcpListToolsFailedEvent | ResponseMcpListToolsInProgressEvent | ResponseOutputTextAnnotationAddedEvent | ResponseQueuedEvent | ResponseCustomToolCallInputDeltaEvent | ResponseCustomToolCallInputDoneEvent;
export interface SkillReference {
    /**
     * The ID of the referenced skill.
     */
    skill_id: string;
    /**
     * References a skill created with the /v1/skills endpoint.
     */
    type: 'skill_reference';
    /**
     * Optional skill version. Use a positive integer or 'latest'. Omit for default.
     */
    version?: string;
}
/**
 * A tool that can be used to generate a response.
 */
export type Tool = FunctionTool | FileSearchTool | ComputerTool | ComputerUsePreviewTool | WebSearchTool | Tool.Mcp | Tool.CodeInterpreter | Tool.ImageGeneration | Tool.LocalShell | FunctionShellTool | CustomTool | NamespaceTool | ToolSearchTool | WebSearchPreviewTool | ApplyPatchTool;
export declare namespace Tool {
    /**
     * Give the model access to additional tools via remote Model Context Protocol
     * (MCP) servers.
     * [Learn more about MCP](https://platform.openai.com/docs/guides/tools-remote-mcp).
     */
    interface Mcp {
        /**
         * A label for this MCP server, used to identify it in tool calls.
         */
        server_label: string;
        /**
         * The type of the MCP tool. Always `mcp`.
         */
        type: 'mcp';
        /**
         * List of allowed tool names or a filter object.
         */
        allowed_tools?: Array<string> | Mcp.McpToolFilter | null;
        /**
         * An OAuth access token that can be used with a remote MCP server, either with a
         * custom MCP server URL or a service connector. Your application must handle the
         * OAuth authorization flow and provide the token here.
         */
        authorization?: string;
        /**
         * Identifier for service connectors, like those available in ChatGPT. One of
         * `server_url` or `connector_id` must be provided. Learn more about service
         * connectors
         * [here](https://platform.openai.com/docs/guides/tools-remote-mcp#connectors).
         *
         * Currently supported `connector_id` values are:
         *
         * - Dropbox: `connector_dropbox`
         * - Gmail: `connector_gmail`
         * - Google Calendar: `connector_googlecalendar`
         * - Google Drive: `connector_googledrive`
         * - Microsoft Teams: `connector_microsoftteams`
         * - Outlook Calendar: `connector_outlookcalendar`
         * - Outlook Email: `connector_outlookemail`
         * - SharePoint: `connector_sharepoint`
         */
        connector_id?: 'connector_dropbox' | 'connector_gmail' | 'connector_googlecalendar' | 'connector_googledrive' | 'connector_microsoftteams' | 'connector_outlookcalendar' | 'connector_outlookemail' | 'connector_sharepoint';
        /**
         * Whether this MCP tool is deferred and discovered via tool search.
         */
        defer_loading?: boolean;
        /**
         * Optional HTTP headers to send to the MCP server. Use for authentication or other
         * purposes.
         */
        headers?: {
            [key: string]: string;
        } | null;
        /**
         * Specify which of the MCP server's tools require approval.
         */
        require_approval?: Mcp.McpToolApprovalFilter | 'always' | 'never' | null;
        /**
         * Optional description of the MCP server, used to provide more context.
         */
        server_description?: string;
        /**
         * The URL for the MCP server. One of `server_url` or `connector_id` must be
         * provided.
         */
        server_url?: string;
    }
    namespace Mcp {
        /**
         * A filter object to specify which tools are allowed.
         */
        interface McpToolFilter {
            /**
             * Indicates whether or not a tool modifies data or is read-only. If an MCP server
             * is
             * [annotated with `readOnlyHint`](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations-readonlyhint),
             * it will match this filter.
             */
            read_only?: boolean;
            /**
             * List of allowed tool names.
             */
            tool_names?: Array<string>;
        }
        /**
         * Specify which of the MCP server's tools require approval. Can be `always`,
         * `never`, or a filter object associated with tools that require approval.
         */
        interface McpToolApprovalFilter {
            /**
             * A filter object to specify which tools are allowed.
             */
            always?: McpToolApprovalFilter.Always;
            /**
             * A filter object to specify which tools are allowed.
             */
            never?: McpToolApprovalFilter.Never;
        }
        namespace McpToolApprovalFilter {
            /**
             * A filter object to specify which tools are allowed.
             */
            interface Always {
                /**
                 * Indicates whether or not a tool modifies data or is read-only. If an MCP server
                 * is
                 * [annotated with `readOnlyHint`](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations-readonlyhint),
                 * it will match this filter.
                 */
                read_only?: boolean;
                /**
                 * List of allowed tool names.
                 */
                tool_names?: Array<string>;
            }
            /**
             * A filter object to specify which tools are allowed.
             */
            interface Never {
                /**
                 * Indicates whether or not a tool modifies data or is read-only. If an MCP server
                 * is
                 * [annotated with `readOnlyHint`](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations-readonlyhint),
                 * it will match this filter.
                 */
                read_only?: boolean;
                /**
                 * List of allowed tool names.
                 */
                tool_names?: Array<string>;
            }
        }
    }
    /**
     * A tool that runs Python code to help generate a response to a prompt.
     */
    interface CodeInterpreter {
        /**
         * The code interpreter container. Can be a container ID or an object that
         * specifies uploaded file IDs to make available to your code, along with an
         * optional `memory_limit` setting.
         */
        container: string | CodeInterpreter.CodeInterpreterToolAuto;
        /**
         * The type of the code interpreter tool. Always `code_interpreter`.
         */
        type: 'code_interpreter';
    }
    namespace CodeInterpreter {
        /**
         * Configuration for a code interpreter container. Optionally specify the IDs of
         * the files to run the code on.
         */
        interface CodeInterpreterToolAuto {
            /**
             * Always `auto`.
             */
            type: 'auto';
            /**
             * An optional list of uploaded files to make available to your code.
             */
            file_ids?: Array<string>;
            /**
             * The memory limit for the code interpreter container.
             */
            memory_limit?: '1g' | '4g' | '16g' | '64g' | null;
            /**
             * Network access policy for the container.
             */
            network_policy?: ResponsesAPI.ContainerNetworkPolicyDisabled | ResponsesAPI.ContainerNetworkPolicyAllowlist;
        }
    }
    /**
     * A tool that generates images using the GPT image models.
     */
    interface ImageGeneration {
        /**
         * The type of the image generation tool. Always `image_generation`.
         */
        type: 'image_generation';
        /**
         * Whether to generate a new image or edit an existing image. Default: `auto`.
         */
        action?: 'generate' | 'edit' | 'auto';
        /**
         * Background type for the generated image. One of `transparent`, `opaque`, or
         * `auto`. Default: `auto`.
         */
        background?: 'transparent' | 'opaque' | 'auto';
        /**
         * Control how much effort the model will exert to match the style and features,
         * especially facial features, of input images. This parameter is only supported
         * for `gpt-image-1` and `gpt-image-1.5` and later models, unsupported for
         * `gpt-image-1-mini`. Supports `high` and `low`. Defaults to `low`.
         */
        input_fidelity?: 'high' | 'low' | null;
        /**
         * Optional mask for inpainting. Contains `image_url` (string, optional) and
         * `file_id` (string, optional).
         */
        input_image_mask?: ImageGeneration.InputImageMask;
        /**
         * The image generation model to use. Default: `gpt-image-1`.
         */
        model?: (string & {}) | 'gpt-image-1' | 'gpt-image-1-mini' | 'gpt-image-1.5';
        /**
         * Moderation level for the generated image. Default: `auto`.
         */
        moderation?: 'auto' | 'low';
        /**
         * Compression level for the output image. Default: 100.
         */
        output_compression?: number;
        /**
         * The output format of the generated image. One of `png`, `webp`, or `jpeg`.
         * Default: `png`.
         */
        output_format?: 'png' | 'webp' | 'jpeg';
        /**
         * Number of partial images to generate in streaming mode, from 0 (default value)
         * to 3.
         */
        partial_images?: number;
        /**
         * The quality of the generated image. One of `low`, `medium`, `high`, or `auto`.
         * Default: `auto`.
         */
        quality?: 'low' | 'medium' | 'high' | 'auto';
        /**
         * The size of the generated image. One of `1024x1024`, `1024x1536`, `1536x1024`,
         * or `auto`. Default: `auto`.
         */
        size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
    }
    namespace ImageGeneration {
        /**
         * Optional mask for inpainting. Contains `image_url` (string, optional) and
         * `file_id` (string, optional).
         */
        interface InputImageMask {
            /**
             * File ID for the mask image.
             */
            file_id?: string;
            /**
             * Base64-encoded mask image.
             */
            image_url?: string;
        }
    }
    /**
     * A tool that allows the model to execute shell commands in a local environment.
     */
    interface LocalShell {
        /**
         * The type of the local shell tool. Always `local_shell`.
         */
        type: 'local_shell';
    }
}
/**
 * Constrains the tools available to the model to a pre-defined set.
 */
export interface ToolChoiceAllowed {
    /**
     * Constrains the tools available to the model to a pre-defined set.
     *
     * `auto` allows the model to pick from among the allowed tools and generate a
     * message.
     *
     * `required` requires the model to call one or more of the allowed tools.
     */
    mode: 'auto' | 'required';
    /**
     * A list of tool definitions that the model should be allowed to call.
     *
     * For the Responses API, the list of tool definitions might look like:
     *
     * ```json
     * [
     *   { "type": "function", "name": "get_weather" },
     *   { "type": "mcp", "server_label": "deepwiki" },
     *   { "type": "image_generation" }
     * ]
     * ```
     */
    tools: Array<{
        [key: string]: unknown;
    }>;
    /**
     * Allowed tool configuration type. Always `allowed_tools`.
     */
    type: 'allowed_tools';
}
/**
 * Forces the model to call the apply_patch tool when executing a tool call.
 */
export interface ToolChoiceApplyPatch {
    /**
     * The tool to call. Always `apply_patch`.
     */
    type: 'apply_patch';
}
/**
 * Use this option to force the model to call a specific custom tool.
 */
export interface ToolChoiceCustom {
    /**
     * The name of the custom tool to call.
     */
    name: string;
    /**
     * For custom tool calling, the type is always `custom`.
     */
    type: 'custom';
}
/**
 * Use this option to force the model to call a specific function.
 */
export interface ToolChoiceFunction {
    /**
     * The name of the function to call.
     */
    name: string;
    /**
     * For function calling, the type is always `function`.
     */
    type: 'function';
}
/**
 * Use this option to force the model to call a specific tool on a remote MCP
 * server.
 */
export interface ToolChoiceMcp {
    /**
     * The label of the MCP server to use.
     */
    server_label: string;
    /**
     * For MCP tools, the type is always `mcp`.
     */
    type: 'mcp';
    /**
     * The name of the tool to call on the server.
     */
    name?: string | null;
}
/**
 * Controls which (if any) tool is called by the model.
 *
 * `none` means the model will not call any tool and instead generates a message.
 *
 * `auto` means the model can pick between generating a message or calling one or
 * more tools.
 *
 * `required` means the model must call one or more tools.
 */
export type ToolChoiceOptions = 'none' | 'auto' | 'required';
/**
 * Forces the model to call the shell tool when a tool call is required.
 */
export interface ToolChoiceShell {
    /**
     * The tool to call. Always `shell`.
     */
    type: 'shell';
}
/**
 * Indicates that the model should use a built-in tool to generate a response.
 * [Learn more about built-in tools](https://platform.openai.com/docs/guides/tools).
 */
export interface ToolChoiceTypes {
    /**
     * The type of hosted tool the model should to use. Learn more about
     * [built-in tools](https://platform.openai.com/docs/guides/tools).
     *
     * Allowed values are:
     *
     * - `file_search`
     * - `web_search_preview`
     * - `computer`
     * - `computer_use_preview`
     * - `computer_use`
     * - `code_interpreter`
     * - `mcp`
     * - `image_generation`
     */
    type: 'file_search' | 'web_search_preview' | 'computer' | 'computer_use_preview' | 'computer_use' | 'web_search_preview_2025_03_11' | 'image_generation' | 'code_interpreter' | 'mcp';
}
/**
 * Hosted or BYOT tool search configuration for deferred tools.
 */
export interface ToolSearchTool {
    /**
     * The type of the tool. Always `tool_search`.
     */
    type: 'tool_search';
    /**
     * Description shown to the model for a client-executed tool search tool.
     */
    description?: string | null;
    /**
     * Whether tool search is executed by the server or by the client.
     */
    execution?: 'server' | 'client';
    /**
     * Parameter schema for a client-executed tool search tool.
     */
    parameters?: unknown | null;
}
/**
 * This tool searches the web for relevant results to use in a response. Learn more
 * about the
 * [web search tool](https://platform.openai.com/docs/guides/tools-web-search).
 */
export interface WebSearchPreviewTool {
    /**
     * The type of the web search tool. One of `web_search_preview` or
     * `web_search_preview_2025_03_11`.
     */
    type: 'web_search_preview' | 'web_search_preview_2025_03_11';
    search_content_types?: Array<'text' | 'image'>;
    /**
     * High level guidance for the amount of context window space to use for the
     * search. One of `low`, `medium`, or `high`. `medium` is the default.
     */
    search_context_size?: 'low' | 'medium' | 'high';
    /**
     * The user's location.
     */
    user_location?: WebSearchPreviewTool.UserLocation | null;
}
export declare namespace WebSearchPreviewTool {
    /**
     * The user's location.
     */
    interface UserLocation {
        /**
         * The type of location approximation. Always `approximate`.
         */
        type: 'approximate';
        /**
         * Free text input for the city of the user, e.g. `San Francisco`.
         */
        city?: string | null;
        /**
         * The two-letter [ISO country code](https://en.wikipedia.org/wiki/ISO_3166-1) of
         * the user, e.g. `US`.
         */
        country?: string | null;
        /**
         * Free text input for the region of the user, e.g. `California`.
         */
        region?: string | null;
        /**
         * The [IANA timezone](https://timeapi.io/documentation/iana-timezones) of the
         * user, e.g. `America/Los_Angeles`.
         */
        timezone?: string | null;
    }
}
/**
 * Search the Internet for sources related to the prompt. Learn more about the
 * [web search tool](https://platform.openai.com/docs/guides/tools-web-search).
 */
export interface WebSearchTool {
    /**
     * The type of the web search tool. One of `web_search` or `web_search_2025_08_26`.
     */
    type: 'web_search' | 'web_search_2025_08_26';
    /**
     * Filters for the search.
     */
    filters?: WebSearchTool.Filters | null;
    /**
     * High level guidance for the amount of context window space to use for the
     * search. One of `low`, `medium`, or `high`. `medium` is the default.
     */
    search_context_size?: 'low' | 'medium' | 'high';
    /**
     * The approximate location of the user.
     */
    user_location?: WebSearchTool.UserLocation | null;
}
export declare namespace WebSearchTool {
    /**
     * Filters for the search.
     */
    interface Filters {
        /**
         * Allowed domains for the search. If not provided, all domains are allowed.
         * Subdomains of the provided domains are allowed as well.
         *
         * Example: `["pubmed.ncbi.nlm.nih.gov"]`
         */
        allowed_domains?: Array<string> | null;
    }
    /**
     * The approximate location of the user.
     */
    interface UserLocation {
        /**
         * Free text input for the city of the user, e.g. `San Francisco`.
         */
        city?: string | null;
        /**
         * The two-letter [ISO country code](https://en.wikipedia.org/wiki/ISO_3166-1) of
         * the user, e.g. `US`.
         */
        country?: string | null;
        /**
         * Free text input for the region of the user, e.g. `California`.
         */
        region?: string | null;
        /**
         * The [IANA timezone](https://timeapi.io/documentation/iana-timezones) of the
         * user, e.g. `America/Los_Angeles`.
         */
        timezone?: string | null;
        /**
         * The type of location approximation. Always `approximate`.
         */
        type?: 'approximate';
    }
}
export type ResponseCreateParams = ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming;
export interface ResponseCreateParamsBase {
    /**
     * Whether to run the model response in the background.
     * [Learn more](https://platform.openai.com/docs/guides/background).
     */
    background?: boolean | null;
    /**
     * Context management configuration for this request.
     */
    context_management?: Array<ResponseCreateParams.ContextManagement> | null;
    /**
     * The conversation that this response belongs to. Items from this conversation are
     * prepended to `input_items` for this response request. Input items and output
     * items from this response are automatically added to this conversation after this
     * response completes.
     */
    conversation?: string | ResponseConversationParam | null;
    /**
     * Specify additional output data to include in the model response. Currently
     * supported values are:
     *
     * - `web_search_call.action.sources`: Include the sources of the web search tool
     *   call.
     * - `code_interpreter_call.outputs`: Includes the outputs of python code execution
     *   in code interpreter tool call items.
     * - `computer_call_output.output.image_url`: Include image urls from the computer
     *   call output.
     * - `file_search_call.results`: Include the search results of the file search tool
     *   call.
     * - `message.input_image.image_url`: Include image urls from the input message.
     * - `computer_call_output.output.image_url`: Include image urls from the computer
     *   call output.
     * - `reasoning.encrypted_content`: Includes an encrypted version of reasoning
     *   tokens in reasoning item outputs. This enables reasoning items to be used in
     *   multi-turn conversations when using the Responses API statelessly (like when
     *   the `store` parameter is set to `false`, or when an organization is enrolled
     *   in the zero data retention program).
     * - `code_interpreter_call.outputs`: Includes the outputs of python code execution
     *   in code interpreter tool call items.
     */
    include?: Array<ResponseIncludable> | null;
    /**
     * Text, image, or file inputs to the model, used to generate a response.
     *
     * Learn more:
     *
     * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
     * - [Image inputs](https://platform.openai.com/docs/guides/images)
     * - [File inputs](https://platform.openai.com/docs/guides/pdf-files)
     * - [Conversation state](https://platform.openai.com/docs/guides/conversation-state)
     * - [Function calling](https://platform.openai.com/docs/guides/function-calling)
     */
    input?: string | ResponseInput;
    /**
     * A system (or developer) message inserted into the model's context.
     *
     * When using along with `previous_response_id`, the instructions from a previous
     * response will not be carried over to the next response. This makes it simple to
     * swap out system (or developer) messages in new responses.
     */
    instructions?: string | null;
    /**
     * An upper bound for the number of tokens that can be generated for a response,
     * including visible output tokens and
     * [reasoning tokens](https://platform.openai.com/docs/guides/reasoning).
     */
    max_output_tokens?: number | null;
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
     * Model ID used to generate the response, like `gpt-4o` or `o3`. OpenAI offers a
     * wide range of models with different capabilities, performance characteristics,
     * and price points. Refer to the
     * [model guide](https://platform.openai.com/docs/models) to browse and compare
     * available models.
     */
    model?: Shared.ResponsesModel;
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
     * Reference to a prompt template and its variables.
     * [Learn more](https://platform.openai.com/docs/guides/text?api-mode=responses#reusable-prompts).
     */
    prompt?: ResponsePrompt | null;
    /**
     * Used by OpenAI to cache responses for similar requests to optimize your cache
     * hit rates. Replaces the `user` field.
     * [Learn more](https://platform.openai.com/docs/guides/prompt-caching).
     */
    prompt_cache_key?: string;
    /**
     * The retention policy for the prompt cache. Set to `24h` to enable extended
     * prompt caching, which keeps cached prefixes active for longer, up to a maximum
     * of 24 hours.
     * [Learn more](https://platform.openai.com/docs/guides/prompt-caching#prompt-cache-retention).
     */
    prompt_cache_retention?: 'in-memory' | '24h' | null;
    /**
     * **gpt-5 and o-series models only**
     *
     * Configuration options for
     * [reasoning models](https://platform.openai.com/docs/guides/reasoning).
     */
    reasoning?: Shared.Reasoning | null;
    /**
     * A stable identifier used to help detect users of your application that may be
     * violating OpenAI's usage policies. The IDs should be a string that uniquely
     * identifies each user, with a maximum length of 64 characters. We recommend
     * hashing their username or email address, in order to avoid sending us any
     * identifying information.
     * [Learn more](https://platform.openai.com/docs/guides/safety-best-practices#safety-identifiers).
     */
    safety_identifier?: string;
    /**
     * Specifies the latency tier to use for processing the request. This parameter is
     * relevant for customers subscribed to the scale tier service:
     *
     * - If set to 'auto', then the request will be processed with the service tier
     *   configured in the Project settings. Unless otherwise configured, the Project
     *   will use 'default'.
     * - If set to 'default', then the request will be processed with the standard
     *   pricing and performance for the selected model.
     * - If set to '[flex](https://platform.openai.com/docs/guides/flex-processing)' or
     *   '[priority](https://openai.com/api-priority-processing/)', then the request
     *   will be processed with the corresponding service tier.
     * - When not set, the default behavior is 'auto'.
     *
     * When this parameter is set, the response body will include the `service_tier`
     * utilized.
     */
    service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null;
    /**
     * Whether to store the generated model response for later retrieval via API.
     */
    store?: boolean | null;
    /**
     * If set to true, the model response data will be streamed to the client as it is
     * generated using
     * [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
     * See the
     * [Streaming section below](https://platform.openai.com/docs/api-reference/responses-streaming)
     * for more information.
     */
    stream?: boolean | null;
    /**
     * Options for streaming responses. Only set this when you set `stream: true`.
     */
    stream_options?: ResponseCreateParams.StreamOptions | null;
    /**
     * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will
     * make the output more random, while lower values like 0.2 will make it more
     * focused and deterministic. We generally recommend altering this or `top_p` but
     * not both.
     */
    temperature?: number | null;
    /**
     * Configuration options for a text response from the model. Can be plain text or
     * structured JSON data. Learn more:
     *
     * - [Text inputs and outputs](https://platform.openai.com/docs/guides/text)
     * - [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
     */
    text?: ResponseTextConfig;
    /**
     * How the model should select which tool (or tools) to use when generating a
     * response. See the `tools` parameter to see how to specify which tools the model
     * can call.
     */
    tool_choice?: ToolChoiceOptions | ToolChoiceAllowed | ToolChoiceTypes | ToolChoiceFunction | ToolChoiceMcp | ToolChoiceCustom | ToolChoiceApplyPatch | ToolChoiceShell;
    /**
     * An array of tools the model may call while generating a response. You can
     * specify which tool to use by setting the `tool_choice` parameter.
     *
     * We support the following categories of tools:
     *
     * - **Built-in tools**: Tools that are provided by OpenAI that extend the model's
     *   capabilities, like
     *   [web search](https://platform.openai.com/docs/guides/tools-web-search) or
     *   [file search](https://platform.openai.com/docs/guides/tools-file-search).
     *   Learn more about
     *   [built-in tools](https://platform.openai.com/docs/guides/tools).
     * - **MCP Tools**: Integrations with third-party systems via custom MCP servers or
     *   predefined connectors such as Google Drive and SharePoint. Learn more about
     *   [MCP Tools](https://platform.openai.com/docs/guides/tools-connectors-mcp).
     * - **Function calls (custom tools)**: Functions that are defined by you, enabling
     *   the model to call your own code with strongly typed arguments and outputs.
     *   Learn more about
     *   [function calling](https://platform.openai.com/docs/guides/function-calling).
     *   You can also use custom tools to call your own code.
     */
    tools?: Array<Tool>;
    /**
     * An alternative to sampling with temperature, called nucleus sampling, where the
     * model considers the results of the tokens with top_p probability mass. So 0.1
     * means only the tokens comprising the top 10% probability mass are considered.
     *
     * We generally recommend altering this or `temperature` but not both.
     */
    top_p?: number | null;
    /**
     * The truncation strategy to use for the model response.
     *
     * - `auto`: If the input to this Response exceeds the model's context window size,
     *   the model will truncate the response to fit the context window by dropping
     *   items from the beginning of the conversation.
     * - `disabled` (default): If the input size will exceed the context window size
     *   for a model, the request will fail with a 400 error.
     */
    truncation?: 'auto' | 'disabled' | null;
    /**
     * @deprecated This field is being replaced by `safety_identifier` and
     * `prompt_cache_key`. Use `prompt_cache_key` instead to maintain caching
     * optimizations. A stable identifier for your end-users. Used to boost cache hit
     * rates by better bucketing similar requests and to help OpenAI detect and prevent
     * abuse.
     * [Learn more](https://platform.openai.com/docs/guides/safety-best-practices#safety-identifiers).
     */
    user?: string;
}
export declare namespace ResponseCreateParams {
    interface ContextManagement {
        /**
         * The context management entry type. Currently only 'compaction' is supported.
         */
        type: string;
        /**
         * Token threshold at which compaction should be triggered for this entry.
         */
        compact_threshold?: number | null;
    }
    /**
     * Options for streaming responses. Only set this when you set `stream: true`.
     */
    interface StreamOptions {
        /**
         * When true, stream obfuscation will be enabled. Stream obfuscation adds random
         * characters to an `obfuscation` field on streaming delta events to normalize
         * payload sizes as a mitigation to certain side-channel attacks. These obfuscation
         * fields are included by default, but add a small amount of overhead to the data
         * stream. You can set `include_obfuscation` to false to optimize for bandwidth if
         * you trust the network links between your application and the OpenAI API.
         */
        include_obfuscation?: boolean;
    }
    type ResponseCreateParamsNonStreaming = ResponsesAPI.ResponseCreateParamsNonStreaming;
    type ResponseCreateParamsStreaming = ResponsesAPI.ResponseCreateParamsStreaming;
}
export interface ResponseCreateParamsNonStreaming extends ResponseCreateParamsBase {
    /**
     * If set to true, the model response data will be streamed to the client as it is
     * generated using
     * [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
     * See the
     * [Streaming section below](https://platform.openai.com/docs/api-reference/responses-streaming)
     * for more information.
     */
    stream?: false | null;
}
export interface ResponseCreateParamsStreaming extends ResponseCreateParamsBase {
    /**
     * If set to true, the model response data will be streamed to the client as it is
     * generated using
     * [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
     * See the
     * [Streaming section below](https://platform.openai.com/docs/api-reference/responses-streaming)
     * for more information.
     */
    stream: true;
}
export type ResponseRetrieveParams = ResponseRetrieveParamsNonStreaming | ResponseRetrieveParamsStreaming;
export interface ResponseRetrieveParamsBase {
    /**
     * Additional fields to include in the response. See the `include` parameter for
     * Response creation above for more information.
     */
    include?: Array<ResponseIncludable>;
    /**
     * When true, stream obfuscation will be enabled. Stream obfuscation adds random
     * characters to an `obfuscation` field on streaming delta events to normalize
     * payload sizes as a mitigation to certain side-channel attacks. These obfuscation
     * fields are included by default, but add a small amount of overhead to the data
     * stream. You can set `include_obfuscation` to false to optimize for bandwidth if
     * you trust the network links between your application and the OpenAI API.
     */
    include_obfuscation?: boolean;
    /**
     * The sequence number of the event after which to start streaming.
     */
    starting_after?: number;
    /**
     * If set to true, the model response data will be streamed to the client as it is
     * generated using
     * [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
     * See the
     * [Streaming section below](https://platform.openai.com/docs/api-reference/responses-streaming)
     * for more information.
     */
    stream?: boolean;
}
export declare namespace ResponseRetrieveParams {
    type ResponseRetrieveParamsNonStreaming = ResponsesAPI.ResponseRetrieveParamsNonStreaming;
    type ResponseRetrieveParamsStreaming = ResponsesAPI.ResponseRetrieveParamsStreaming;
}
export interface ResponseRetrieveParamsNonStreaming extends ResponseRetrieveParamsBase {
    /**
     * If set to true, the model response data will be streamed to the client as it is
     * generated using
     * [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
     * See the
     * [Streaming section below](https://platform.openai.com/docs/api-reference/responses-streaming)
     * for more information.
     */
    stream?: false;
}
export interface ResponseRetrieveParamsStreaming extends ResponseRetrieveParamsBase {
    /**
     * If set to true, the model response data will be streamed to the client as it is
     * generated using
     * [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format).
     * See the
     * [Streaming section below](https://platform.openai.com/docs/api-reference/responses-streaming)
     * for more information.
     */
    stream: true;
}
export interface ResponseCompactParams {
    /**
     * Model ID used to generate the response, like `gpt-5` or `o3`. OpenAI offers a
     * wide range of models with different capabilities, performance characteristics,
     * and price points. Refer to the
     * [model guide](https://platform.openai.com/docs/models) to browse and compare
     * available models.
     */
    model: 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.4-nano' | 'gpt-5.4-mini-2026-03-17' | 'gpt-5.4-nano-2026-03-17' | 'gpt-5.3-chat-latest' | 'gpt-5.2' | 'gpt-5.2-2025-12-11' | 'gpt-5.2-chat-latest' | 'gpt-5.2-pro' | 'gpt-5.2-pro-2025-12-11' | 'gpt-5.1' | 'gpt-5.1-2025-11-13' | 'gpt-5.1-codex' | 'gpt-5.1-mini' | 'gpt-5.1-chat-latest' | 'gpt-5' | 'gpt-5-mini' | 'gpt-5-nano' | 'gpt-5-2025-08-07' | 'gpt-5-mini-2025-08-07' | 'gpt-5-nano-2025-08-07' | 'gpt-5-chat-latest' | 'gpt-4.1' | 'gpt-4.1-mini' | 'gpt-4.1-nano' | 'gpt-4.1-2025-04-14' | 'gpt-4.1-mini-2025-04-14' | 'gpt-4.1-nano-2025-04-14' | 'o4-mini' | 'o4-mini-2025-04-16' | 'o3' | 'o3-2025-04-16' | 'o3-mini' | 'o3-mini-2025-01-31' | 'o1' | 'o1-2024-12-17' | 'o1-preview' | 'o1-preview-2024-09-12' | 'o1-mini' | 'o1-mini-2024-09-12' | 'gpt-4o' | 'gpt-4o-2024-11-20' | 'gpt-4o-2024-08-06' | 'gpt-4o-2024-05-13' | 'gpt-4o-audio-preview' | 'gpt-4o-audio-preview-2024-10-01' | 'gpt-4o-audio-preview-2024-12-17' | 'gpt-4o-audio-preview-2025-06-03' | 'gpt-4o-mini-audio-preview' | 'gpt-4o-mini-audio-preview-2024-12-17' | 'gpt-4o-search-preview' | 'gpt-4o-mini-search-preview' | 'gpt-4o-search-preview-2025-03-11' | 'gpt-4o-mini-search-preview-2025-03-11' | 'chatgpt-4o-latest' | 'codex-mini-latest' | 'gpt-4o-mini' | 'gpt-4o-mini-2024-07-18' | 'gpt-4-turbo' | 'gpt-4-turbo-2024-04-09' | 'gpt-4-0125-preview' | 'gpt-4-turbo-preview' | 'gpt-4-1106-preview' | 'gpt-4-vision-preview' | 'gpt-4' | 'gpt-4-0314' | 'gpt-4-0613' | 'gpt-4-32k' | 'gpt-4-32k-0314' | 'gpt-4-32k-0613' | 'gpt-3.5-turbo' | 'gpt-3.5-turbo-16k' | 'gpt-3.5-turbo-0301' | 'gpt-3.5-turbo-0613' | 'gpt-3.5-turbo-1106' | 'gpt-3.5-turbo-0125' | 'gpt-3.5-turbo-16k-0613' | 'o1-pro' | 'o1-pro-2025-03-19' | 'o3-pro' | 'o3-pro-2025-06-10' | 'o3-deep-research' | 'o3-deep-research-2025-06-26' | 'o4-mini-deep-research' | 'o4-mini-deep-research-2025-06-26' | 'computer-use-preview' | 'computer-use-preview-2025-03-11' | 'gpt-5-codex' | 'gpt-5-pro' | 'gpt-5-pro-2025-10-06' | 'gpt-5.1-codex-max' | (string & {}) | null;
    /**
     * Text, image, or file inputs to the model, used to generate a response
     */
    input?: string | Array<ResponseInputItem> | null;
    /**
     * A system (or developer) message inserted into the model's context. When used
     * along with `previous_response_id`, the instructions from a previous response
     * will not be carried over to the next response. This makes it simple to swap out
     * system (or developer) messages in new responses.
     */
    instructions?: string | null;
    /**
     * The unique ID of the previous response to the model. Use this to create
     * multi-turn conversations. Learn more about
     * [conversation state](https://platform.openai.com/docs/guides/conversation-state).
     * Cannot be used in conjunction with `conversation`.
     */
    previous_response_id?: string | null;
    /**
     * A key to use when reading from or writing to the prompt cache.
     */
    prompt_cache_key?: string | null;
}
export declare namespace Responses {
    export { type ApplyPatchTool as ApplyPatchTool, type CompactedResponse as CompactedResponse, type ComputerAction as ComputerAction, type ComputerActionList as ComputerActionList, type ComputerTool as ComputerTool, type ComputerUsePreviewTool as ComputerUsePreviewTool, type ContainerAuto as ContainerAuto, type ContainerNetworkPolicyAllowlist as ContainerNetworkPolicyAllowlist, type ContainerNetworkPolicyDisabled as ContainerNetworkPolicyDisabled, type ContainerNetworkPolicyDomainSecret as ContainerNetworkPolicyDomainSecret, type ContainerReference as ContainerReference, type CustomTool as CustomTool, type EasyInputMessage as EasyInputMessage, type FileSearchTool as FileSearchTool, type FunctionShellTool as FunctionShellTool, type FunctionTool as FunctionTool, type InlineSkill as InlineSkill, type InlineSkillSource as InlineSkillSource, type LocalEnvironment as LocalEnvironment, type LocalSkill as LocalSkill, type NamespaceTool as NamespaceTool, type Response as Response, type ResponseApplyPatchToolCall as ResponseApplyPatchToolCall, type ResponseApplyPatchToolCallOutput as ResponseApplyPatchToolCallOutput, type ResponseAudioDeltaEvent as ResponseAudioDeltaEvent, type ResponseAudioDoneEvent as ResponseAudioDoneEvent, type ResponseAudioTranscriptDeltaEvent as ResponseAudioTranscriptDeltaEvent, type ResponseAudioTranscriptDoneEvent as ResponseAudioTranscriptDoneEvent, type ResponseCodeInterpreterCallCodeDeltaEvent as ResponseCodeInterpreterCallCodeDeltaEvent, type ResponseCodeInterpreterCallCodeDoneEvent as ResponseCodeInterpreterCallCodeDoneEvent, type ResponseCodeInterpreterCallCompletedEvent as ResponseCodeInterpreterCallCompletedEvent, type ResponseCodeInterpreterCallInProgressEvent as ResponseCodeInterpreterCallInProgressEvent, type ResponseCodeInterpreterCallInterpretingEvent as ResponseCodeInterpreterCallInterpretingEvent, type ResponseCodeInterpreterToolCall as ResponseCodeInterpreterToolCall, type ResponseCompactionItem as ResponseCompactionItem, type ResponseCompactionItemParam as ResponseCompactionItemParam, type ResponseCompletedEvent as ResponseCompletedEvent, type ResponseComputerToolCall as ResponseComputerToolCall, type ResponseComputerToolCallOutputItem as ResponseComputerToolCallOutputItem, type ResponseComputerToolCallOutputScreenshot as ResponseComputerToolCallOutputScreenshot, type ResponseContainerReference as ResponseContainerReference, type ResponseContent as ResponseContent, type ResponseContentPartAddedEvent as ResponseContentPartAddedEvent, type ResponseContentPartDoneEvent as ResponseContentPartDoneEvent, type ResponseConversationParam as ResponseConversationParam, type ResponseCreatedEvent as ResponseCreatedEvent, type ResponseCustomToolCall as ResponseCustomToolCall, type ResponseCustomToolCallInputDeltaEvent as ResponseCustomToolCallInputDeltaEvent, type ResponseCustomToolCallInputDoneEvent as ResponseCustomToolCallInputDoneEvent, type ResponseCustomToolCallItem as ResponseCustomToolCallItem, type ResponseCustomToolCallOutput as ResponseCustomToolCallOutput, type ResponseCustomToolCallOutputItem as ResponseCustomToolCallOutputItem, type ResponseError as ResponseError, type ResponseErrorEvent as ResponseErrorEvent, type ResponseFailedEvent as ResponseFailedEvent, type ResponseFileSearchCallCompletedEvent as ResponseFileSearchCallCompletedEvent, type ResponseFileSearchCallInProgressEvent as ResponseFileSearchCallInProgressEvent, type ResponseFileSearchCallSearchingEvent as ResponseFileSearchCallSearchingEvent, type ResponseFileSearchToolCall as ResponseFileSearchToolCall, type ResponseFormatTextConfig as ResponseFormatTextConfig, type ResponseFormatTextJSONSchemaConfig as ResponseFormatTextJSONSchemaConfig, type ResponseFunctionCallArgumentsDeltaEvent as ResponseFunctionCallArgumentsDeltaEvent, type ResponseFunctionCallArgumentsDoneEvent as ResponseFunctionCallArgumentsDoneEvent, type ResponseFunctionCallOutputItem as ResponseFunctionCallOutputItem, type ResponseFunctionCallOutputItemList as ResponseFunctionCallOutputItemList, type ResponseFunctionShellCallOutputContent as ResponseFunctionShellCallOutputContent, type ResponseFunctionShellToolCall as ResponseFunctionShellToolCall, type ResponseFunctionShellToolCallOutput as ResponseFunctionShellToolCallOutput, type ResponseFunctionToolCall as ResponseFunctionToolCall, type ResponseFunctionToolCallItem as ResponseFunctionToolCallItem, type ResponseFunctionToolCallOutputItem as ResponseFunctionToolCallOutputItem, type ResponseFunctionWebSearch as ResponseFunctionWebSearch, type ResponseImageGenCallCompletedEvent as ResponseImageGenCallCompletedEvent, type ResponseImageGenCallGeneratingEvent as ResponseImageGenCallGeneratingEvent, type ResponseImageGenCallInProgressEvent as ResponseImageGenCallInProgressEvent, type ResponseImageGenCallPartialImageEvent as ResponseImageGenCallPartialImageEvent, type ResponseInProgressEvent as ResponseInProgressEvent, type ResponseIncludable as ResponseIncludable, type ResponseIncompleteEvent as ResponseIncompleteEvent, type ResponseInput as ResponseInput, type ResponseInputAudio as ResponseInputAudio, type ResponseInputContent as ResponseInputContent, type ResponseInputFile as ResponseInputFile, type ResponseInputFileContent as ResponseInputFileContent, type ResponseInputImage as ResponseInputImage, type ResponseInputImageContent as ResponseInputImageContent, type ResponseInputItem as ResponseInputItem, type ResponseInputMessageContentList as ResponseInputMessageContentList, type ResponseInputMessageItem as ResponseInputMessageItem, type ResponseInputText as ResponseInputText, type ResponseInputTextContent as ResponseInputTextContent, type ResponseItem as ResponseItem, type ResponseLocalEnvironment as ResponseLocalEnvironment, type ResponseMcpCallArgumentsDeltaEvent as ResponseMcpCallArgumentsDeltaEvent, type ResponseMcpCallArgumentsDoneEvent as ResponseMcpCallArgumentsDoneEvent, type ResponseMcpCallCompletedEvent as ResponseMcpCallCompletedEvent, type ResponseMcpCallFailedEvent as ResponseMcpCallFailedEvent, type ResponseMcpCallInProgressEvent as ResponseMcpCallInProgressEvent, type ResponseMcpListToolsCompletedEvent as ResponseMcpListToolsCompletedEvent, type ResponseMcpListToolsFailedEvent as ResponseMcpListToolsFailedEvent, type ResponseMcpListToolsInProgressEvent as ResponseMcpListToolsInProgressEvent, type ResponseOutputAudio as ResponseOutputAudio, type ResponseOutputItem as ResponseOutputItem, type ResponseOutputItemAddedEvent as ResponseOutputItemAddedEvent, type ResponseOutputItemDoneEvent as ResponseOutputItemDoneEvent, type ResponseOutputMessage as ResponseOutputMessage, type ResponseOutputRefusal as ResponseOutputRefusal, type ResponseOutputText as ResponseOutputText, type ResponseOutputTextAnnotationAddedEvent as ResponseOutputTextAnnotationAddedEvent, type ResponsePrompt as ResponsePrompt, type ResponseQueuedEvent as ResponseQueuedEvent, type ResponseReasoningItem as ResponseReasoningItem, type ResponseReasoningSummaryPartAddedEvent as ResponseReasoningSummaryPartAddedEvent, type ResponseReasoningSummaryPartDoneEvent as ResponseReasoningSummaryPartDoneEvent, type ResponseReasoningSummaryTextDeltaEvent as ResponseReasoningSummaryTextDeltaEvent, type ResponseReasoningSummaryTextDoneEvent as ResponseReasoningSummaryTextDoneEvent, type ResponseReasoningTextDeltaEvent as ResponseReasoningTextDeltaEvent, type ResponseReasoningTextDoneEvent as ResponseReasoningTextDoneEvent, type ResponseRefusalDeltaEvent as ResponseRefusalDeltaEvent, type ResponseRefusalDoneEvent as ResponseRefusalDoneEvent, type ResponseStatus as ResponseStatus, type ResponseStreamEvent as ResponseStreamEvent, type ResponseTextConfig as ResponseTextConfig, type ResponseTextDeltaEvent as ResponseTextDeltaEvent, type ResponseTextDoneEvent as ResponseTextDoneEvent, type ResponseToolSearchCall as ResponseToolSearchCall, type ResponseToolSearchOutputItem as ResponseToolSearchOutputItem, type ResponseToolSearchOutputItemParam as ResponseToolSearchOutputItemParam, type ResponseUsage as ResponseUsage, type ResponseWebSearchCallCompletedEvent as ResponseWebSearchCallCompletedEvent, type ResponseWebSearchCallInProgressEvent as ResponseWebSearchCallInProgressEvent, type ResponseWebSearchCallSearchingEvent as ResponseWebSearchCallSearchingEvent, type ResponsesClientEvent as ResponsesClientEvent, type ResponsesServerEvent as ResponsesServerEvent, type SkillReference as SkillReference, type Tool as Tool, type ToolChoiceAllowed as ToolChoiceAllowed, type ToolChoiceApplyPatch as ToolChoiceApplyPatch, type ToolChoiceCustom as ToolChoiceCustom, type ToolChoiceFunction as ToolChoiceFunction, type ToolChoiceMcp as ToolChoiceMcp, type ToolChoiceOptions as ToolChoiceOptions, type ToolChoiceShell as ToolChoiceShell, type ToolChoiceTypes as ToolChoiceTypes, type ToolSearchTool as ToolSearchTool, type WebSearchPreviewTool as WebSearchPreviewTool, type WebSearchTool as WebSearchTool, type ResponseCreateParams as ResponseCreateParams, type ResponseCreateParamsNonStreaming as ResponseCreateParamsNonStreaming, type ResponseCreateParamsStreaming as ResponseCreateParamsStreaming, type ResponseRetrieveParams as ResponseRetrieveParams, type ResponseRetrieveParamsNonStreaming as ResponseRetrieveParamsNonStreaming, type ResponseRetrieveParamsStreaming as ResponseRetrieveParamsStreaming, type ResponseCompactParams as ResponseCompactParams, };
    export { InputItems as InputItems, type ResponseItemList as ResponseItemList, type InputItemListParams as InputItemListParams, };
    export { InputTokens as InputTokens, type InputTokenCountResponse as InputTokenCountResponse, type InputTokenCountParams as InputTokenCountParams, };
}
//# sourceMappingURL=responses.d.ts.map