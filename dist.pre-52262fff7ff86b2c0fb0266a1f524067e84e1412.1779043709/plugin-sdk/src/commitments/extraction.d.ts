import type { OpenClawConfig } from "../config/config.js";
import type { CommitmentCandidate, CommitmentExtractionBatchResult, CommitmentExtractionItem } from "./types.js";
export declare function parseCommitmentExtractionOutput(raw: string): CommitmentExtractionBatchResult;
export declare function hydrateCommitmentExtractionItem(params: {
    cfg?: OpenClawConfig;
    item: Omit<CommitmentExtractionItem, "existingPending">;
}): Promise<CommitmentExtractionItem>;
export declare function buildCommitmentExtractionPrompt(params: {
    cfg?: OpenClawConfig;
    items: CommitmentExtractionItem[];
}): string;
export declare function validateCommitmentCandidates(params: {
    cfg?: OpenClawConfig;
    items: CommitmentExtractionItem[];
    result: CommitmentExtractionBatchResult;
    nowMs?: number;
}): Array<{
    item: CommitmentExtractionItem;
    candidate: CommitmentCandidate;
    earliestMs: number;
    latestMs: number;
    timezone: string;
}>;
export declare function persistCommitmentExtractionResult(params: {
    cfg?: OpenClawConfig;
    items: CommitmentExtractionItem[];
    result: CommitmentExtractionBatchResult;
    nowMs?: number;
}): Promise<import("./types.js").CommitmentRecord[]>;
