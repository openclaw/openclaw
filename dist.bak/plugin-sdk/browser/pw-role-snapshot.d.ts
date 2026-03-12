export type RoleRef = {
    role: string;
    name?: string;
    /** Index used only when role+name duplicates exist. */
    nth?: number;
};
export type RoleRefMap = Record<string, RoleRef>;
export type RoleSnapshotStats = {
    lines: number;
    chars: number;
    refs: number;
    interactive: number;
};
export type RoleSnapshotOptions = {
    /** Only include interactive elements (buttons, links, inputs, etc.). */
    interactive?: boolean;
    /** Maximum depth to include (0 = root only). */
    maxDepth?: number;
    /** Remove unnamed structural elements and empty branches. */
    compact?: boolean;
};
export declare function getRoleSnapshotStats(snapshot: string, refs: RoleRefMap): RoleSnapshotStats;
export declare function parseRoleRef(raw: string): string | null;
export declare function buildRoleSnapshotFromAriaSnapshot(ariaSnapshot: string, options?: RoleSnapshotOptions): {
    snapshot: string;
    refs: RoleRefMap;
};
/**
 * Build a role snapshot from Playwright's AI snapshot output while preserving Playwright's own
 * aria-ref ids (e.g. ref=e13). This makes the refs self-resolving across calls.
 */
export declare function buildRoleSnapshotFromAiSnapshot(aiSnapshot: string, options?: RoleSnapshotOptions): {
    snapshot: string;
    refs: RoleRefMap;
};
