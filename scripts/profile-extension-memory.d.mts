#!/usr/bin/env node
/* oxlint-disable typescript/no-redundant-type-constituents -- standalone declaration lint lacks the consuming Node type context */
/**
 * Parses extension memory profiler options after pnpm's optional separator.
 */
export function parseArgs(argv: unknown): {
  extensions: never[];
  concurrency: number;
  timeoutMs: number;
  combinedTimeoutMs: number;
  top: number;
  jsonPath: null;
  skipCombined: boolean;
};
/**
 * Runs one import scenario in a child process and captures bounded output plus RSS.
 */
export function runCase({
  repoRoot,
  env,
  hookPath,
  name,
  body,
  timeoutMs,
  shutdownGraceMs,
  spawnImpl,
}: {
  repoRoot: unknown;
  env: unknown;
  hookPath: unknown;
  name: unknown;
  body: unknown;
  timeoutMs: unknown;
  shutdownGraceMs?: number | undefined;
  spawnImpl?: typeof spawn | undefined;
}): Promise<unknown>;
import { spawn } from "node:child_process";
