#!/usr/bin/env -S node --import tsx
// Emits dry-run stable plugin/core backport plans.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  generateStablePluginBackportPlan,
  parseAffectedPluginIds,
  parseStablePluginBackportPlanManifest,
} from "./lib/stable-plugin-backport-plan.ts";

type ParsedArgs = {
  sourcePr?: string;
  sourceSha?: string;
  stableLine?: string;
  eligibilityReason?: string;
  affectedPluginIds?: string[];
  manifestPath?: string;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseStablePluginBackportPlanArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-pr") {
      parsed.sourcePr = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--source-sha") {
      parsed.sourceSha = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--stable-line") {
      parsed.stableLine = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--eligibility-reason") {
      parsed.eligibilityReason = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--affected-plugin-ids") {
      parsed.affectedPluginIds = parseAffectedPluginIds(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      parsed.manifestPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

export function collectStablePluginBackportPlan(argv: string[]) {
  const args = parseStablePluginBackportPlanArgs(argv);
  if (!args.manifestPath) {
    throw new Error("--manifest is required.");
  }
  return generateStablePluginBackportPlan({
    ...(args.sourcePr ? { sourcePr: args.sourcePr } : {}),
    ...(args.sourceSha ? { sourceSha: args.sourceSha } : {}),
    stableLine: args.stableLine ?? "",
    eligibilityReason: args.eligibilityReason ?? "",
    affectedPluginIds: args.affectedPluginIds ?? [],
    manifestPath: args.manifestPath,
    manifest: parseStablePluginBackportPlanManifest(readJson(args.manifestPath)),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(JSON.stringify(collectStablePluginBackportPlan(process.argv.slice(2)), null, 2));
}
