#!/usr/bin/env node
/**
 * Returns one-based line numbers containing merge conflict markers.
 */
export function findConflictMarkerLines(content: string): number[];
/**
 * Lists tracked files in the repository.
 */
export function listTrackedFiles(cwd?: string): string[];
/**
 * Scans files for merge conflict markers, skipping binary content and
 * oversized files to avoid unbounded memory use.
 */
export function findConflictMarkersInFiles(
  filePaths: string[],
  readFile?: (filePath: string) => Buffer | string,
  statSync?: (filePath: string) => { size: number },
  warn?: (message: string) => void,
  maxScanBytes?: number,
): {
  filePath: string;
  lines: number[];
}[];
/**
 * Finds merge conflict markers in tracked repository files.
 */
export function findConflictMarkersInTrackedFiles(cwd?: string): {
  filePath: string;
  lines: number[];
}[];
/**
 * Runs the merge conflict marker check.
 */
export function main(): Promise<void>;
