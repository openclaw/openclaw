import type { OpenClawConfig } from "../config/config.js";
import type { CommitmentCandidate, CommitmentExtractionItem, CommitmentRecord, CommitmentScope, CommitmentStatus, CommitmentStoreFile } from "./types.js";
export declare function resolveCommitmentStorePath(storePath?: string): string;
export declare function loadCommitmentStore(storePath?: string): Promise<CommitmentStoreFile>;
export declare function saveCommitmentStore(storePath: string | undefined, store: CommitmentStoreFile): Promise<void>;
export declare function listPendingCommitmentsForScope(params: {
    cfg?: OpenClawConfig;
    scope: CommitmentScope;
    nowMs?: number;
    limit?: number;
}): Promise<CommitmentRecord[]>;
export declare function upsertInferredCommitments(params: {
    cfg?: OpenClawConfig;
    item: CommitmentExtractionItem;
    candidates: Array<{
        candidate: CommitmentCandidate;
        earliestMs: number;
        latestMs: number;
        timezone: string;
    }>;
    nowMs?: number;
}): Promise<CommitmentRecord[]>;
export declare function listDueCommitmentsForSession(params: {
    cfg?: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    nowMs?: number;
    limit?: number;
}): Promise<CommitmentRecord[]>;
export declare function listDueCommitmentSessionKeys(params: {
    cfg?: OpenClawConfig;
    agentId: string;
    nowMs?: number;
    limit?: number;
}): Promise<string[]>;
export declare function markCommitmentsAttempted(params: {
    cfg?: OpenClawConfig;
    ids: string[];
    nowMs?: number;
}): Promise<void>;
export declare function markCommitmentsStatus(params: {
    cfg?: OpenClawConfig;
    ids: string[];
    status: Extract<CommitmentStatus, "sent" | "dismissed" | "expired">;
    nowMs?: number;
}): Promise<void>;
export declare function listCommitments(params?: {
    cfg?: OpenClawConfig;
    status?: CommitmentStatus;
    agentId?: string;
}): Promise<CommitmentRecord[]>;
