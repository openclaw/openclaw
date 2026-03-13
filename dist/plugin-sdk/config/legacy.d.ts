import type { LegacyConfigIssue } from "./types.js";
export declare function findLegacyConfigIssues(raw: unknown, sourceRaw?: unknown): LegacyConfigIssue[];
export declare function applyLegacyMigrations(raw: unknown): {
    next: Record<string, unknown> | null;
    changes: string[];
};
