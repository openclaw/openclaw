#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  target: string;
  sourceRepo: string;
  sourceSha: string;
  clawhubRepo: string;
  clawhubSourceRepo: string;
  clawhubSourceSha: string;
};
/**
 * Resolves the local ClawHub repository path used for docs mirroring.
 */
export function resolveClawHubRepoPath(value?: string, options?: Record<string, unknown>): string;
/**
 * Deletes localized docs that no longer have a matching English source file.
 */
export function pruneOrphanLocaleDocs(targetDocsDir: unknown): void;
/**
 * Mirrors ClawHub docs into the target docs tree.
 */
export function syncClawHubDocsTree(
  targetDocsDir: unknown,
  options?: Record<string, unknown>,
): {
  repository: unknown;
  sha: unknown;
  path: string;
  files: number;
};
