#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function buildMaturityRendererArgs(args: readonly string[]): string[] {
  return [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/qa/render-maturity-docs.ts",
    "--check",
    ...args,
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = spawnSync(process.execPath, buildMaturityRendererArgs(process.argv.slice(2)), {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  await import("./report-maturity-inventory.mts");
}
