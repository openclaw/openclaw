export { resolveOpenAIStrictToolSetting, resolvesToNativeOpenAIStrictTools, } from "./openai-strict-tool-setting.js";
type ToolWithParameters = {
    name?: unknown;
    parameters: unknown;
};
export declare function normalizeStrictOpenAIJsonSchema(schema: unknown): unknown;
export declare function normalizeOpenAIStrictToolParameters<T>(schema: T, strict: boolean): T;
export declare function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean;
export type OpenAIStrictToolSchemaDiagnostic = {
    toolIndex: number;
    toolName?: string;
    violations: string[];
};
export declare function findOpenAIStrictToolSchemaDiagnostics(tools: readonly ToolWithParameters[]): OpenAIStrictToolSchemaDiagnostic[];
export declare function resolveOpenAIStrictToolFlagForInventory(tools: readonly ToolWithParameters[], strict: boolean | null | undefined): boolean | undefined;
