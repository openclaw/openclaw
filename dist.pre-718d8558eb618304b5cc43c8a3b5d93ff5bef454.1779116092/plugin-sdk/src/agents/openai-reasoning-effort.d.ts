export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type OpenAIApiReasoningEffort = OpenAIReasoningEffort | (string & {});
type OpenAIReasoningModel = {
    provider?: unknown;
    id?: unknown;
    api?: unknown;
    baseUrl?: unknown;
    compat?: unknown;
};
export declare function isOpenAIGpt54MiniModel(model: OpenAIReasoningModel): boolean;
export declare function normalizeOpenAIReasoningEffort(effort: string): string;
export declare function resolveOpenAISupportedReasoningEfforts(model: OpenAIReasoningModel): readonly OpenAIApiReasoningEffort[];
export declare function supportsOpenAIReasoningEffort(model: OpenAIReasoningModel, effort: string): boolean;
export declare function resolveOpenAIReasoningEffortForModel(params: {
    model: OpenAIReasoningModel;
    effort: string;
    fallbackMap?: Record<string, string>;
}): OpenAIApiReasoningEffort | undefined;
export {};
