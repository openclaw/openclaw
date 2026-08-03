#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  base: string;
  head: string;
};
export function createGitRunner(options?: {
  timeoutMs?: number;
  killGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): (args: string[]) => Promise<string>;
export function readGitFile(
  base: string,
  relPath: string,
  git?: (args: string[]) => Promise<string>,
): Promise<string>;
export type TermMatch = {
  file: string;
  line: number;
  kind: "title" | "link label";
  term: string;
};
