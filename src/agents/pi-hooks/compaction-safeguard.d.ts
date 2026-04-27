import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasMeaningfulConversationContent, isRealConversationMessage } from "../compaction-real-conversation.js";
import { computeAdaptiveChunkRatio, isOversizedForSummary, summarizeInStages } from "../compaction.js";
import { appendSummarySection, auditSummaryQuality, buildCompactionStructureInstructions, buildStructuredFallbackSummary, extractOpaqueIdentifiers } from "./compaction-safeguard-quality.js";
declare function prependPreviousSummaryForRedistill(params: {
    messages: AgentMessage[];
    previousSummary?: string;
}): AgentMessage[];
type ToolFailure = {
    toolCallId: string;
    toolName: string;
    summary: string;
    meta?: string;
};
declare function resolveRecentTurnsPreserve(value: unknown): number;
declare function resolveQualityGuardMaxRetries(value: unknown): number;
declare function collectToolFailures(messages: AgentMessage[]): ToolFailure[];
declare function formatToolFailuresSection(failures: ToolFailure[]): string;
declare function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string;
declare function capCompactionSummary(summary: string, maxChars?: number): string;
declare function capCompactionSummaryPreservingSuffix(summaryBody: string, suffix: string, maxChars?: number): string;
declare function splitPreservedRecentTurns(params: {
    messages: AgentMessage[];
    recentTurnsPreserve: number;
}): {
    summarizableMessages: AgentMessage[];
    preservedMessages: AgentMessage[];
};
declare function formatPreservedTurnsSection(messages: AgentMessage[]): string;
declare function formatSplitTurnContextSection(messages: AgentMessage[]): string;
/**
 * Read and format critical workspace context for compaction summary.
 * Extracts "Session Startup" and "Red Lines" from AGENTS.md.
 * Falls back to legacy names "Every Session" and "Safety".
 * Limited to 2000 chars to avoid bloating the summary.
 */
declare function readWorkspaceContextForSummary(): Promise<string>;
export default function compactionSafeguardExtension(api: ExtensionAPI): void;
export declare const __testing: {
    readonly setSummarizeInStagesForTest: (next?: typeof summarizeInStages) => void;
    readonly collectToolFailures: typeof collectToolFailures;
    readonly formatToolFailuresSection: typeof formatToolFailuresSection;
    readonly splitPreservedRecentTurns: typeof splitPreservedRecentTurns;
    readonly formatPreservedTurnsSection: typeof formatPreservedTurnsSection;
    readonly formatSplitTurnContextSection: typeof formatSplitTurnContextSection;
    readonly buildCompactionStructureInstructions: typeof buildCompactionStructureInstructions;
    readonly buildStructuredFallbackSummary: typeof buildStructuredFallbackSummary;
    readonly prependPreviousSummaryForRedistill: typeof prependPreviousSummaryForRedistill;
    readonly appendSummarySection: typeof appendSummarySection;
    readonly resolveRecentTurnsPreserve: typeof resolveRecentTurnsPreserve;
    readonly resolveQualityGuardMaxRetries: typeof resolveQualityGuardMaxRetries;
    readonly extractOpaqueIdentifiers: typeof extractOpaqueIdentifiers;
    readonly auditSummaryQuality: typeof auditSummaryQuality;
    readonly capCompactionSummary: typeof capCompactionSummary;
    readonly capCompactionSummaryPreservingSuffix: typeof capCompactionSummaryPreservingSuffix;
    readonly formatFileOperations: typeof formatFileOperations;
    readonly computeAdaptiveChunkRatio: typeof computeAdaptiveChunkRatio;
    readonly isOversizedForSummary: typeof isOversizedForSummary;
    readonly readWorkspaceContextForSummary: typeof readWorkspaceContextForSummary;
    readonly hasMeaningfulConversationContent: typeof hasMeaningfulConversationContent;
    readonly isRealConversationMessage: typeof isRealConversationMessage;
    readonly BASE_CHUNK_RATIO: 0.4;
    readonly MIN_CHUNK_RATIO: 0.15;
    readonly SAFETY_MARGIN: 1.2;
    readonly MAX_COMPACTION_SUMMARY_CHARS: 16000;
    readonly MAX_FILE_OPS_SECTION_CHARS: 2000;
    readonly MAX_FILE_OPS_LIST_CHARS: 900;
    readonly SUMMARY_TRUNCATED_MARKER: "\n\n[Compaction summary truncated to fit budget]";
};
export {};
