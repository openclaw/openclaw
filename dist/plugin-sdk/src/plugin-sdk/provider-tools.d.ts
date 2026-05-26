import { cleanSchemaForGemini, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS } from "../agents/schema/clean-for-gemini.js";
import type { AnyAgentTool, ProviderNormalizeToolSchemasContext, ProviderToolSchemaDiagnostic } from "./plugin-entry.js";
export { cleanSchemaForGemini, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS };
export declare function stripUnsupportedSchemaKeywords(schema: unknown, unsupportedKeywords: ReadonlySet<string>): unknown;
export declare function findUnsupportedSchemaKeywords(schema: unknown, path: string, unsupportedKeywords: ReadonlySet<string>): string[];
export declare function normalizeGeminiToolSchemas(ctx: ProviderNormalizeToolSchemasContext): AnyAgentTool[];
export declare function inspectGeminiToolSchemas(ctx: ProviderNormalizeToolSchemasContext): ProviderToolSchemaDiagnostic[];
export declare function normalizeOpenAIToolSchemas(ctx: ProviderNormalizeToolSchemasContext): AnyAgentTool[];
export declare function findOpenAIStrictSchemaViolations(schema: unknown, path: string, options?: {
    requireObjectRoot?: boolean;
}): string[];
export declare function inspectOpenAIToolSchemas(ctx: ProviderNormalizeToolSchemasContext): ProviderToolSchemaDiagnostic[];
export declare const DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS: Set<string>;
export declare function normalizeDeepSeekToolSchemas(ctx: ProviderNormalizeToolSchemasContext): AnyAgentTool[];
export declare function inspectDeepSeekToolSchemas(ctx: ProviderNormalizeToolSchemasContext): ProviderToolSchemaDiagnostic[];
export type ProviderToolCompatFamily = "deepseek" | "gemini" | "openai";
export declare function buildProviderToolCompatFamilyHooks(family: ProviderToolCompatFamily): {
    normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[];
    inspectToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => ProviderToolSchemaDiagnostic[];
};
