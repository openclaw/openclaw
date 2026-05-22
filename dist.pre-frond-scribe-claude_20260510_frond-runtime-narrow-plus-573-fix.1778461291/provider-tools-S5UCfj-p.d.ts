import { a as ModelCompatConfig } from "./types.models-BbSYPJk1.js";
import { r as AnyAgentTool } from "./common-B0aZxYiS.js";
import { Gt as ProviderNormalizeToolSchemasContext, wn as ProviderToolSchemaDiagnostic } from "./types-BYigPDoy.js";
import { TSchema } from "typebox";

//#region src/agents/schema/clean-for-gemini.d.ts
declare const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS: Set<string>;
declare function cleanSchemaForGemini(schema: unknown): TSchema;
//#endregion
//#region src/plugin-sdk/provider-tools.d.ts
declare const XAI_TOOL_SCHEMA_PROFILE = "xai";
declare const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";
declare const XAI_UNSUPPORTED_SCHEMA_KEYWORDS: Set<string>;
declare function stripUnsupportedSchemaKeywords(schema: unknown, unsupportedKeywords: ReadonlySet<string>): unknown;
declare function stripXaiUnsupportedKeywords(schema: unknown): unknown;
declare function resolveXaiModelCompatPatch(): ModelCompatConfig;
declare function applyXaiModelCompat<T extends {
  compat?: unknown;
}>(model: T): T;
declare function findUnsupportedSchemaKeywords(schema: unknown, path: string, unsupportedKeywords: ReadonlySet<string>): string[];
declare function normalizeGeminiToolSchemas(ctx: ProviderNormalizeToolSchemasContext): AnyAgentTool[];
declare function inspectGeminiToolSchemas(ctx: ProviderNormalizeToolSchemasContext): ProviderToolSchemaDiagnostic[];
declare function normalizeOpenAIToolSchemas(ctx: ProviderNormalizeToolSchemasContext): AnyAgentTool[];
declare function findOpenAIStrictSchemaViolations(schema: unknown, path: string, options?: {
  requireObjectRoot?: boolean;
}): string[];
declare function inspectOpenAIToolSchemas(ctx: ProviderNormalizeToolSchemasContext): ProviderToolSchemaDiagnostic[];
type ProviderToolCompatFamily = "gemini" | "openai";
declare function buildProviderToolCompatFamilyHooks(family: ProviderToolCompatFamily): {
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[];
  inspectToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => ProviderToolSchemaDiagnostic[];
};
//#endregion
export { cleanSchemaForGemini as _, applyXaiModelCompat as a, findUnsupportedSchemaKeywords as c, normalizeGeminiToolSchemas as d, normalizeOpenAIToolSchemas as f, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS as g, stripXaiUnsupportedKeywords as h, XAI_UNSUPPORTED_SCHEMA_KEYWORDS as i, inspectGeminiToolSchemas as l, stripUnsupportedSchemaKeywords as m, ProviderToolCompatFamily as n, buildProviderToolCompatFamilyHooks as o, resolveXaiModelCompatPatch as p, XAI_TOOL_SCHEMA_PROFILE as r, findOpenAIStrictSchemaViolations as s, HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING as t, inspectOpenAIToolSchemas as u };