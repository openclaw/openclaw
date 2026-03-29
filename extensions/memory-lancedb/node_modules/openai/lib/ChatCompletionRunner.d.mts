import { type ChatCompletionMessageParam, type ChatCompletionCreateParamsNonStreaming } from "../resources/chat/completions.mjs";
import { type BaseFunctionsArgs, RunnableTools } from "./RunnableFunction.mjs";
import { AbstractChatCompletionRunner, AbstractChatCompletionRunnerEvents, RunnerOptions } from "./AbstractChatCompletionRunner.mjs";
import OpenAI from "../index.mjs";
import { AutoParseableTool } from "../lib/parser.mjs";
export interface ChatCompletionRunnerEvents extends AbstractChatCompletionRunnerEvents {
    content: (content: string) => void;
}
export type ChatCompletionToolRunnerParams<FunctionsArgs extends BaseFunctionsArgs> = Omit<ChatCompletionCreateParamsNonStreaming, 'tools'> & {
    tools: RunnableTools<FunctionsArgs> | AutoParseableTool<any, true>[];
};
export declare class ChatCompletionRunner<ParsedT = null> extends AbstractChatCompletionRunner<ChatCompletionRunnerEvents, ParsedT> {
    static runTools<ParsedT>(client: OpenAI, params: ChatCompletionToolRunnerParams<any[]>, options?: RunnerOptions): ChatCompletionRunner<ParsedT>;
    _addMessage(this: ChatCompletionRunner<ParsedT>, message: ChatCompletionMessageParam, emit?: boolean): void;
}
//# sourceMappingURL=ChatCompletionRunner.d.mts.map