import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai";
export declare function isLiveTestEnabled(extraEnvVars?: readonly string[], env?: NodeJS.ProcessEnv): boolean;
export declare function isLiveProfileKeyModeEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function createSingleUserPromptMessage(content?: string): {
    role: "user";
    content: string;
    timestamp: number;
}[];
export declare function extractNonEmptyAssistantText(content: Array<{
    type?: string;
    text?: string;
}>): string;
export type CompleteSimpleContent<TApi extends Api = Api> = Awaited<ReturnType<typeof completeSimple<TApi>>>["content"];
export declare function logLiveProgress(message: string): void;
export declare function completeSimpleWithTimeout<TApi extends Api>(model: Model<TApi>, context: Parameters<typeof completeSimple<TApi>>[1], options: Parameters<typeof completeSimple<TApi>>[2], timeoutMs: number): Promise<Awaited<ReturnType<typeof completeSimple<TApi>>>>;
