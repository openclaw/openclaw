#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
}

export function main() {
  const oxfmtEntry = path.join(process.cwd(), "node_modules", "oxfmt", "bin", "oxfmt");
  const formatResult = run(process.execPath, [oxfmtEntry, "--write"]);
  if ((formatResult.status ?? 1) !== 0) {
    return formatResult.status ?? 1;
  }

  const diffResult = run("git", ["--no-pager", "diff"]);
  return diffResult.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
