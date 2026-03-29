import { type ChatCompletionChunk, type ChatCompletionCreateParamsStreaming } from "../resources/chat/completions.mjs";
import { RunnerOptions, type AbstractChatCompletionRunnerEvents } from "./AbstractChatCompletionRunner.mjs";
import { type ReadableStream } from "../internal/shim-types.mjs";
import { RunnableTools, type BaseFunctionsArgs } from "./RunnableFunction.mjs";
import { ChatCompletionSnapshot, ChatCompletionStream } from "./ChatCompletionStream.mjs";
import OpenAI from "../index.mjs";
import { AutoParseableTool } from "../lib/parser.mjs";
export interface ChatCompletionStreamEvents extends AbstractChatCompletionRunnerEvents {
    content: (contentDelta: string, contentSnapshot: string) => void;
    chunk: (chunk: ChatCompletionChunk, snapshot: ChatCompletionSnapshot) => void;
}
export type ChatCompletionStreamingToolRunnerParams<FunctionsArgs extends BaseFunctionsArgs> = Omit<ChatCompletionCreateParamsStreaming, 'tools'> & {
    tools: RunnableTools<FunctionsArgs> | AutoParseableTool<any, true>[];
};
export declare class ChatCompletionStreamingRunner<ParsedT = null> extends ChatCompletionStream<ParsedT> implements AsyncIterable<ChatCompletionChunk> {
    static fromReadableStream(stream: ReadableStream): ChatCompletionStreamingRunner<null>;
    static runTools<T extends (string | object)[], ParsedT = null>(client: OpenAI, params: ChatCompletionStreamingToolRunnerParams<T>, options?: RunnerOptions): ChatCompletionStreamingRunner<ParsedT>;
}
//# sourceMappingURL=ChatCompletionStreamingRunner.d.mts.map