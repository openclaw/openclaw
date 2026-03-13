import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type CompactionSummarizationInstructions, computeAdaptiveChunkRatio, isOversizedForSummary } from "../compaction.js";
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
declare function splitPreservedRecentTurns(params: {
    messages: AgentMessage[];
    recentTurnsPreserve: number;
}): {
    summarizableMessages: AgentMessage[];
    preservedMessages: AgentMessage[];
};
declare function formatPreservedTurnsSection(messages: AgentMessage[]): string;
declare function buildCompactionStructureInstructions(customInstructions?: string, summarizationInstructions?: CompactionSummarizationInstructions): string;
declare function buildStructuredFallbackSummary(previousSummary: string | undefined, _summarizationInstructions?: CompactionSummarizationInstructions): string;
declare function appendSummarySection(summary: string, section: string): string;
declare function extractOpaqueIdentifiers(text: string): string[];
declare function auditSummaryQuality(params: {
    summary: string;
    identifiers: string[];
    latestAsk: string | null;
    identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): {
    ok: boolean;
    reasons: string[];
};
/**
 * Read and format critical workspace context for compaction summary.
 * Extracts "Session Startup" and "Red Lines" from AGENTS.md.
 * Falls back to legacy names "Every Session" and "Safety".
 * Limited to 2000 chars to avoid bloating the summary.
 */
declare function readWorkspaceContextForSummary(): Promise<string>;
export default function compactionSafeguardExtension(api: ExtensionAPI): void;
export declare const __testing: {
    readonly collectToolFailures: typeof collectToolFailures;
    readonly formatToolFailuresSection: typeof formatToolFailuresSection;
    readonly splitPreservedRecentTurns: typeof splitPreservedRecentTurns;
    readonly formatPreservedTurnsSection: typeof formatPreservedTurnsSection;
    readonly buildCompactionStructureInstructions: typeof buildCompactionStructureInstructions;
    readonly buildStructuredFallbackSummary: typeof buildStructuredFallbackSummary;
    readonly appendSummarySection: typeof appendSummarySection;
    readonly resolveRecentTurnsPreserve: typeof resolveRecentTurnsPreserve;
    readonly resolveQualityGuardMaxRetries: typeof resolveQualityGuardMaxRetries;
    readonly extractOpaqueIdentifiers: typeof extractOpaqueIdentifiers;
    readonly auditSummaryQuality: typeof auditSummaryQuality;
    readonly computeAdaptiveChunkRatio: typeof computeAdaptiveChunkRatio;
    readonly isOversizedForSummary: typeof isOversizedForSummary;
    readonly readWorkspaceContextForSummary: typeof readWorkspaceContextForSummary;
    readonly BASE_CHUNK_RATIO: 0.4;
    readonly MIN_CHUNK_RATIO: 0.15;
    readonly SAFETY_MARGIN: 1.2;
};
export {};
