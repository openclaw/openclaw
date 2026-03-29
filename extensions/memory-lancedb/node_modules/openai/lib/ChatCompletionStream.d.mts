import OpenAI from "../index.mjs";
import { RequestOptions } from "../internal/request-options.mjs";
import { type ReadableStream } from "../internal/shim-types.mjs";
import { ParsedChatCompletion } from "../resources/chat/completions.mjs";
import { ChatCompletionTokenLogprob, type ChatCompletion, type ChatCompletionChunk, type ChatCompletionCreateParams, type ChatCompletionCreateParamsBase, type ChatCompletionRole } from "../resources/chat/completions/completions.mjs";
import { AbstractChatCompletionRunner, type AbstractChatCompletionRunnerEvents } from "./AbstractChatCompletionRunner.mjs";
export interface ContentDeltaEvent {
    delta: string;
    snapshot: string;
    parsed: unknown | null;
}
export interface ContentDoneEvent<ParsedT = null> {
    content: string;
    parsed: ParsedT | null;
}
export interface RefusalDeltaEvent {
    delta: string;
    snapshot: string;
}
export interface RefusalDoneEvent {
    refusal: string;
}
export interface FunctionToolCallArgumentsDeltaEvent {
    name: string;
    index: number;
    arguments: string;
    parsed_arguments: unknown;
    arguments_delta: string;
}
export interface FunctionToolCallArgumentsDoneEvent {
    name: string;
    index: number;
    arguments: string;
    parsed_arguments: unknown;
}
export interface LogProbsContentDeltaEvent {
    content: Array<ChatCompletionTokenLogprob>;
    snapshot: Array<ChatCompletionTokenLogprob>;
}
export interface LogProbsContentDoneEvent {
    content: Array<ChatCompletionTokenLogprob>;
}
export interface LogProbsRefusalDeltaEvent {
    refusal: Array<ChatCompletionTokenLogprob>;
    snapshot: Array<ChatCompletionTokenLogprob>;
}
export interface LogProbsRefusalDoneEvent {
    refusal: Array<ChatCompletionTokenLogprob>;
}
export interface ChatCompletionStreamEvents<ParsedT = null> extends AbstractChatCompletionRunnerEvents {
    content: (contentDelta: string, contentSnapshot: string) => void;
    chunk: (chunk: ChatCompletionChunk, snapshot: ChatCompletionSnapshot) => void;
    'content.delta': (props: ContentDeltaEvent) => void;
    'content.done': (props: ContentDoneEvent<ParsedT>) => void;
    'refusal.delta': (props: RefusalDeltaEvent) => void;
    'refusal.done': (props: RefusalDoneEvent) => void;
    'tool_calls.function.arguments.delta': (props: FunctionToolCallArgumentsDeltaEvent) => void;
    'tool_calls.function.arguments.done': (props: FunctionToolCallArgumentsDoneEvent) => void;
    'logprobs.content.delta': (props: LogProbsContentDeltaEvent) => void;
    'logprobs.content.done': (props: LogProbsContentDoneEvent) => void;
    'logprobs.refusal.delta': (props: LogProbsRefusalDeltaEvent) => void;
    'logprobs.refusal.done': (props: LogProbsRefusalDoneEvent) => void;
}
export type ChatCompletionStreamParams = Omit<ChatCompletionCreateParamsBase, 'stream'> & {
    stream?: true;
};
export declare class ChatCompletionStream<ParsedT = null> extends AbstractChatCompletionRunner<ChatCompletionStreamEvents<ParsedT>, ParsedT> implements AsyncIterable<ChatCompletionChunk> {
    #private;
    constructor(params: ChatCompletionCreateParams | null);
    get currentChatCompletionSnapshot(): ChatCompletionSnapshot | undefined;
    /**
     * Intended for use on the frontend, consuming a stream produced with
     * `.toReadableStream()` on the backend.
     *
     * Note that messages sent to the model do not appear in `.on('message')`
     * in this context.
     */
    static fromReadableStream(stream: ReadableStream): ChatCompletionStream<null>;
    static createChatCompletion<ParsedT>(client: OpenAI, params: ChatCompletionStreamParams, options?: RequestOptions): ChatCompletionStream<ParsedT>;
    protected _createChatCompletion(client: OpenAI, params: ChatCompletionCreateParams, options?: RequestOptions): Promise<ParsedChatCompletion<ParsedT>>;
    protected _fromReadableStream(readableStream: ReadableStream, options?: RequestOptions): Promise<ChatCompletion>;
    [Symbol.asyncIterator](this: ChatCompletionStream<ParsedT>): AsyncIterator<ChatCompletionChunk>;
    toReadableStream(): ReadableStream;
}
/**
 * Represents a streamed chunk of a chat completion response returned by model,
 * based on the provided input.
 */
export interface ChatCompletionSnapshot {
    /**
     * A unique identifier for the chat completion.
     */
    id: string;
    /**
     * A list of chat completion choices. Can be more than one if `n` is greater
     * than 1.
     */
    choices: Array<ChatCompletionSnapshot.Choice>;
    /**
     * The Unix timestamp (in seconds) of when the chat completion was created.
     */
    created: number;
    /**
     * The model to generate the completion.
     */
    model: string;
    /**
     * This fingerprint represents the backend configuration that the model runs with.
     *
     * Can be used in conjunction with the `seed` request parameter to understand when
     * backend changes have been made that might impact determinism.
     */
    system_fingerprint?: string;
}
export declare namespace ChatCompletionSnapshot {
    interface Choice {
        /**
         * A chat completion delta generated by streamed model responses.
         */
        message: Choice.Message;
        /**
         * The reason the model stopped generating tokens. This will be `stop` if the model
         * hit a natural stop point or a provided stop sequence, `length` if the maximum
         * number of tokens specified in the request was reached, `content_filter` if
         * content was omitted due to a flag from our content filters, or `function_call`
         * if the model called a function.
         */
        finish_reason: ChatCompletion.Choice['finish_reason'] | null;
        /**
         * Log probability information for the choice.
         */
        logprobs: ChatCompletion.Choice.Logprobs | null;
        /**
         * The index of the choice in the list of choices.
         */
        index: number;
    }
    namespace Choice {
        /**
         * A chat completion delta generated by streamed model responses.
         */
        interface Message {
            /**
             * The contents of the chunk message.
             */
            content?: string | null;
            refusal?: string | null;
            parsed?: unknown | null;
            /**
             * The name and arguments of a function that should be called, as generated by the
             * model.
             */
            function_call?: Message.FunctionCall;
            tool_calls?: Array<Message.ToolCall>;
            /**
             * The role of the author of this message.
             */
            role?: ChatCompletionRole;
        }
        namespace Message {
            interface ToolCall {
                /**
                 * The ID of the tool call.
                 */
                id: string;
                function: ToolCall.Function;
                /**
                 * The type of the tool.
                 */
                type: 'function';
            }
            namespace ToolCall {
                interface Function {
                    /**
                     * The arguments to call the function with, as generated by the model in JSON
                     * format. Note that the model does not always generate valid JSON, and may
                     * hallucinate parameters not defined by your function schema. Validate the
                     * arguments in your code before calling your function.
                     */
                    arguments: string;
                    parsed_arguments?: unknown;
                    /**
                     * The name of the function to call.
                     */
                    name: string;
                }
            }
            /**
             * The name and arguments of a function that should be called, as generated by the
             * model.
             */
            interface FunctionCall {
                /**
                 * The arguments to call the function with, as generated by the model in JSON
                 * format. Note that the model does not always generate valid JSON, and may
                 * hallucinate parameters not defined by your function schema. Validate the
                 * arguments in your code before calling your function.
                 */
                arguments?: string;
                /**
                 * The name of the function to call.
                 */
                name?: string;
            }
        }
    }
}
//# sourceMappingURL=ChatCompletionStream.d.mts.map