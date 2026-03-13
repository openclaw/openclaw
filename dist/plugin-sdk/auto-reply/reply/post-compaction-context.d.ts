import type { OpenClawConfig } from "../../config/config.js";
/**
 * Read critical sections from workspace AGENTS.md for post-compaction injection.
 * Returns formatted system event text, or null if no AGENTS.md or no relevant sections.
 * Substitutes YYYY-MM-DD placeholders with the real date so agents read the correct
 * daily memory files instead of guessing based on training cutoff.
 */
export declare function readPostCompactionContext(workspaceDir: string, cfg?: OpenClawConfig, nowMs?: number): Promise<string | null>;
/**
 * Extract named sections from markdown content.
 * Matches H2 (##) or H3 (###) headings case-insensitively.
 * Skips content inside fenced code blocks.
 * Captures until the next heading of same or higher level, or end of string.
 */
export declare function extractSections(content: string, sectionNames: string[], foundNames?: string[]): string[];
