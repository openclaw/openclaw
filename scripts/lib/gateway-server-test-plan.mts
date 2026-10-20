// Bounds the non-isolated Gateway server project before its shared module graph
// exhausts memory on Node or Bun.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isGatewayServerTestFile } from "../../test/vitest/vitest.gateway-server-paths.mjs";
import { matchesVitestCliSelection } from "../../test/vitest/vitest.pattern-file.ts";
import {
  collectVitestFileFilters,
  hasNonRunVitestSubcommand,
  resolveExplicitVitestMode,
} from "./vitest-cli-mode.mts";

// Two workers with at most 16 files per process peaked at 10.94 GiB on four CPUs.
const GATEWAY_SERVER_TEST_FILE_LIMIT = 16;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function listRepoFilesRecursive(root: string, cwd: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listRepoFilesRecursive(absolute, cwd);
    }
    return entry.isFile() ? [normalizePath(path.relative(cwd, absolute))] : [];
  });
}

function listGatewayFilesFromGit(cwd: string): string[] | null {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src/gateway"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\0")
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);
}

function listGatewayServerTestTargets(cwd = process.cwd()): string[] {
  const gatewayDir = path.join(cwd, "src/gateway");
  if (!fs.existsSync(gatewayDir)) {
    return [];
  }
  return (listGatewayFilesFromGit(cwd) ?? listRepoFilesRecursive(gatewayDir, cwd))
    .filter(isGatewayServerTestFile)
    .toSorted((a, b) => a.localeCompare(b));
}

export function splitTestTargetChunks(targets: string[], chunkCount: number): string[][] {
  if (targets.length === 0) {
    return [];
  }
  const normalizedChunkCount = Math.min(chunkCount, targets.length);
  const baseSize = Math.floor(targets.length / normalizedChunkCount);
  const remainder = targets.length % normalizedChunkCount;
  const chunks: string[][] = [];
  let offset = 0;
  for (let index = 0; index < normalizedChunkCount; index += 1) {
    const chunkSize = baseSize + (index < remainder ? 1 : 0);
    chunks.push(targets.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

export function createGatewayServerTestTargetChunks(
  cwd = process.cwd(),
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
  includePatterns?: readonly string[] | null,
): string[][] {
  // Native sharding must see the whole selection before runtime filtering.
  // Stateful/output modifiers likewise retain their single-invocation semantics.
  if (
    hasNonRunVitestSubcommand(args) ||
    resolveExplicitVitestMode(args) === "watch" ||
    collectVitestFileFilters(args).some((filter) => /:\d+$/u.test(filter)) ||
    args.some(
      (arg, index) =>
        /^(?:-[rhv]|--(?:shard|changed|bail|coverage|mergeReports|outputFile|reporters?|project|root|dir|no-run|listTags|clearCache|standalone|help|version))(?:[.=]|$)/u.test(
          arg,
        ) ||
        arg === "--run=false" ||
        (arg === "--run" && args[index + 1] === "false"),
    )
  ) {
    return [];
  }
  const targets = listGatewayServerTestTargets(cwd).filter((file) =>
    matchesVitestCliSelection(file, [file], args, "src/gateway", env, includePatterns),
  );
  return splitTestTargetChunks(targets, Math.ceil(targets.length / GATEWAY_SERVER_TEST_FILE_LIMIT));
}
