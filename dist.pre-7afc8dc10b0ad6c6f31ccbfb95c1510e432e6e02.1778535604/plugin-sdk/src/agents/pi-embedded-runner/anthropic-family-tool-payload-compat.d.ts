import type { StreamFn } from "@mariozechner/pi-agent-core";
type AnthropicToolSchemaMode = "openai-functions";
type AnthropicToolChoiceMode = "openai-string-modes";
type AnthropicToolPayloadCompatibilityOptions = {
    toolSchemaMode?: AnthropicToolSchemaMode;
    toolChoiceMode?: AnthropicToolChoiceMode;
};
export declare function createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined, options?: AnthropicToolPayloadCompatibilityOptions): StreamFn;
export declare function createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export {};
