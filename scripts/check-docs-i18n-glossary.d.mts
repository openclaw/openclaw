#!/usr/bin/env node
export function parseArgs(argv: unknown): {
  base: string;
  head: string;
};
export function createGitRunner(options?: {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): (args: string[]) => string;
export type TermMatch = {
  file: string;
  line: number;
  kind: "title" | "link label";
  term: string;
};
