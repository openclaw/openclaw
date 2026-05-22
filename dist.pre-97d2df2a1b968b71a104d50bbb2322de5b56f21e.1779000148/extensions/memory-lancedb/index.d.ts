import { E as OpenClawPluginDefinition, T as OpenClawPluginConfigSchema } from "../../types-9OpM7mYQ.js";
import { i as MemoryCategory } from "../../config-BbfTSIQB.js";

//#region extensions/memory-lancedb/index.d.ts
declare function normalizeRecallQuery(text: string, maxChars?: number): string;
declare function normalizeEmbeddingVector(value: unknown): number[];
declare function looksLikePromptInjection(text: string): boolean;
declare function escapeMemoryForPrompt(text: string): string;
declare function formatRelevantMemoriesContext(memories: Array<{
  category: MemoryCategory;
  text: string;
}>): string;
declare function shouldCapture(text: string, options?: {
  customTriggers?: string[];
  maxChars?: number;
}): boolean;
declare function detectCategory(text: string): MemoryCategory;
declare const _default: {
  id: string;
  name: string;
  description: string;
  configSchema: OpenClawPluginConfigSchema;
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
//#endregion
export { _default as default, detectCategory, escapeMemoryForPrompt, formatRelevantMemoriesContext, looksLikePromptInjection, normalizeEmbeddingVector, normalizeRecallQuery, shouldCapture };