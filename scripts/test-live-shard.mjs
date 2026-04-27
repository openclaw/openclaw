#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";

const LIVE_TEST_SUFFIX = ".live.test.ts";

export const LIVE_TEST_SHARDS = Object.freeze([
  "native-live-src-agents",
  "native-live-src-gateway",
  "native-live-test",
  "native-live-extensions-a-k",
  "native-live-extensions-l-z",
]);

function walkFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) {
    return files;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "vendor" ||
          entry.name === "fixtures"
        ) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export function collectAllLiveTestFiles(repoRoot = process.cwd()) {
  return ["src", "test", "extensions"]
    .flatMap((dir) => walkFiles(path.join(repoRoot, dir)))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .filter((file) => file.endsWith(LIVE_TEST_SUFFIX))
    .sort((a, b) => a.localeCompare(b));
}

function extensionKey(file) {
  const relative = file.slice("extensions/".length);
  return relative.split("/", 1)[0]?.toLowerCase() ?? "";
}

function isExtensionInRange(file, start, end) {
  if (!file.startsWith("extensions/")) {
    return false;
  }
  const key = extensionKey(file);
  if (!key) {
    return false;
  }
  const first = key[0];
  return first >= start && first <= end;
}

export function selectLiveShardFiles(shard, files = collectAllLiveTestFiles()) {
  switch (shard) {
    case "native-live-src-agents":
      return files.filter((file) => file.startsWith("src/agents/"));
    case "native-live-src-gateway":
      return files.filter(
        (file) => file.startsWith("src/gateway/") || file.startsWith("src/crestodian/"),
      );
    case "native-live-test":
      return files.filter((file) => file.startsWith("test/"));
    case "native-live-extensions-a-k":
      return files.filter((file) => isExtensionInRange(file, "a", "k"));
    case "native-live-extensions-l-z":
      return files.filter((file) => isExtensionInRange(file, "l", "z"));
    default:
      throw new Error(
        `Unknown live test shard '${shard}'. Expected one of: ${LIVE_TEST_SHARDS.join(", ")}`,
      );
  }
}

function usage() {
  console.error(`Usage: node scripts/test-live-shard.mjs <${LIVE_TEST_SHARDS.join("|")}> [--list]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const shard = args.find((arg) => !arg.startsWith("-"));
  const listOnly = args.includes("--list");
  if (!shard) {
    usage();
    process.exit(2);
  }

  let files;
  try {
    files = selectLiveShardFiles(shard);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`Live test shard '${shard}' selected no files.`);
    process.exit(2);
  }

  if (listOnly) {
    for (const file of files) {
      console.log(file);
    }
    process.exit(0);
  }

  console.log(`[test:live:shard] ${shard}: ${files.length} file(s)`);
  const child = spawnPnpmRunner({
    stdio: "inherit",
    pnpmArgs: ["test:live", "--", ...files],
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
}
