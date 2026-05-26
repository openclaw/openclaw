import type { StreamFn } from "@earendil-works/pi-agent-core";
type AnthropicToolSchemaMode = "openai-functions";
type AnthropicToolChoiceMode = "openai-string-modes";
type AnthropicToolPayloadCompatibilityOptions = {
    toolSchemaMode?: AnthropicToolSchemaMode;
    toolChoiceMode?: AnthropicToolChoiceMode;
};
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export declare function createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined, options?: AnthropicToolPayloadCompatibilityOptions): StreamFn;
/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export declare function createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export {};
