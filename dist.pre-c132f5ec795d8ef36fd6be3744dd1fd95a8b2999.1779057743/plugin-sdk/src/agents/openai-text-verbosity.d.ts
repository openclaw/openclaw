/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export type OpenAITextVerbosity = "low" | "medium" | "high";
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function resolveOpenAITextVerbosity(extraParams: Record<string, unknown> | undefined): OpenAITextVerbosity | undefined;
