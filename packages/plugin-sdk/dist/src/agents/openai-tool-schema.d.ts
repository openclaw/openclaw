export { resolveOpenAIStrictToolSetting } from "./openai-strict-tool-setting.js";
type ToolSchemaCompatInput = {
    unsupportedToolSchemaKeywords?: unknown;
    omitEmptyArrayItems?: unknown;
};
type ToolWithParameters = {
    name?: unknown;
    parameters: unknown;
};
export declare function normalizeStrictOpenAIJsonSchema(schema: unknown, modelCompat?: ToolSchemaCompatInput | null): unknown;
export declare function normalizeOpenAIStrictToolParameters<T>(schema: T, strict: boolean, modelCompat?: ToolSchemaCompatInput | null): T;
export declare function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean;
type OpenAIStrictToolSchemaDiagnostic = {
    toolIndex: number;
    toolName?: string;
    violations: string[];
};
export declare function findOpenAIStrictToolSchemaDiagnostics(tools: readonly ToolWithParameters[]): OpenAIStrictToolSchemaDiagnostic[];
export declare function resolveOpenAIStrictToolFlagForInventory(tools: readonly ToolWithParameters[], strict: boolean | null | undefined): boolean | undefined;
