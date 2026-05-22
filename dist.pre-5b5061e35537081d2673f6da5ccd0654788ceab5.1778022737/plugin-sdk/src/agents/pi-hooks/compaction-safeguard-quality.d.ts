import type { CompactionSummarizationInstructions } from "../compaction.js";
export declare function wrapUntrustedInstructionBlock(label: string, text: string): string;
export declare function buildCompactionStructureInstructions(customInstructions?: string, summarizationInstructions?: CompactionSummarizationInstructions): string;
export declare function buildStructuredFallbackSummary(previousSummary: string | undefined, _summarizationInstructions?: CompactionSummarizationInstructions): string;
export declare function appendSummarySection(summary: string, section: string): string;
export declare function extractOpaqueIdentifiers(text: string): string[];
export declare function auditSummaryQuality(params: {
    summary: string;
    identifiers: string[];
    latestAsk: string | null;
    identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): {
    ok: boolean;
    reasons: string[];
};
