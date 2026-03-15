#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from "node:url";
import { collectPluginReleasePlan, parsePluginReleaseSelection } from "./lib/plugin-npm-release.ts";

function parseArgs(argv: string[]): {
  selection: string[];
  baseRef?: string;
  headRef?: string;
} {
  let selection: string[] = [];
  let baseRef: string | undefined;
  let headRef: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--plugins") {
      selection = parsePluginReleaseSelection(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--base-ref") {
      baseRef = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--head-ref") {
      headRef = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (selection.length > 0 && (baseRef || headRef)) {
    throw new Error("Use either --plugins or --base-ref/--head-ref, not both.");
  }
  if ((baseRef && !headRef) || (!baseRef && headRef)) {
    throw new Error("Both --base-ref and --head-ref are required together.");
  }

  return { selection, baseRef, headRef };
}

export function collectPluginNpmReleasePlan(argv: string[]) {
  const { selection, baseRef, headRef } = parseArgs(argv);
  return collectPluginReleasePlan({
    selection,
    gitRange: baseRef && headRef ? { baseRef, headRef } : undefined,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const plan = collectPluginNpmReleasePlan(process.argv.slice(2));
  console.log(JSON.stringify(plan, null, 2));
}
