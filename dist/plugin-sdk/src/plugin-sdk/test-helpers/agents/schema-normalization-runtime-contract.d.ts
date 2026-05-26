export declare function createParameterFreeTool(name?: string): {
    name: string;
    description: string;
    parameters: {};
};
export declare function createStrictCompatibleTool(name?: string): {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            path: {
                type: string;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
};
export declare function createPermissiveTool(name?: string): {
    name: string;
    description: string;
    parameters: {
        type: string;
        properties: {
            action: {
                type: string;
            };
            cron: {
                type: string;
            };
        };
        required: string[];
        additionalProperties: boolean;
    };
};
export declare function createNativeOpenAIResponsesModel(): {
    id: string;
    name: string;
    api: string;
    provider: string;
    baseUrl: string;
    reasoning: boolean;
    input: string[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
};
export declare function createNativeOpenAICodexResponsesModel(): {
    id: string;
    name: string;
    api: string;
    provider: string;
    baseUrl: string;
    reasoning: boolean;
    input: string[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
};
export declare function createProxyOpenAIResponsesModel(): {
    id: string;
    name: string;
    api: string;
    provider: string;
    baseUrl: string;
    reasoning: boolean;
    input: string[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
};
export declare function normalizedParameterFreeSchema(): {
    type: string;
    properties: {};
    required: never[];
    additionalProperties: boolean;
};
