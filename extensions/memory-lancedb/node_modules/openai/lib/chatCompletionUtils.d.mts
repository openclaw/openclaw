import { type ChatCompletionAssistantMessageParam, type ChatCompletionMessageParam, type ChatCompletionToolMessageParam } from "../resources.mjs";
export declare const isAssistantMessage: (message: ChatCompletionMessageParam | null | undefined) => message is ChatCompletionAssistantMessageParam;
export declare const isToolMessage: (message: ChatCompletionMessageParam | null | undefined) => message is ChatCompletionToolMessageParam;
export declare function isPresent<T>(obj: T | null | undefined): obj is T;
//# sourceMappingURL=chatCompletionUtils.d.mts.map