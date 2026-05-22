type OpenAIReasoningCompatModel = {
    provider?: string | null;
    id?: string | null;
    compat?: unknown;
};
export declare function resolveOpenAIReasoningEffortMap(model: OpenAIReasoningCompatModel, fallbackMap?: Record<string, string>): Record<string, string>;
export declare function mapOpenAIReasoningEffortForModel(params: {
    model: OpenAIReasoningCompatModel;
    effort?: string;
    fallbackMap?: Record<string, string>;
}): string | undefined;
export {};
