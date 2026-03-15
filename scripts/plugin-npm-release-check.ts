#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from "node:url";
import {
  collectChangedExtensionIdsFromGitRange,
  collectPublishablePluginPackages,
  parsePluginReleaseSelection,
  resolveChangedPublishablePluginPackages,
  resolveSelectedPublishablePluginPackages,
} from "./lib/plugin-npm-release.ts";

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

export function runPluginNpmReleaseCheck(argv: string[]) {
  const { selection, baseRef, headRef } = parseArgs(argv);
  const publishable = collectPublishablePluginPackages();
  const selected =
    selection.length > 0
      ? resolveSelectedPublishablePluginPackages({
          plugins: publishable,
          selection,
        })
      : baseRef && headRef
        ? resolveChangedPublishablePluginPackages({
            plugins: publishable,
            changedExtensionIds: collectChangedExtensionIdsFromGitRange({
              gitRange: { baseRef, headRef },
            }),
          })
        : publishable;

  console.log("plugin-npm-release-check: publishable plugin metadata looks OK.");
  if (baseRef && headRef && selected.length === 0) {
    console.log(
      `  - no publishable plugin package changes detected between ${baseRef} and ${headRef}`,
    );
  }
  for (const plugin of selected) {
    console.log(
      `  - ${plugin.packageName}@${plugin.version} (${plugin.channel}, ${plugin.extensionId})`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPluginNpmReleaseCheck(process.argv.slice(2));
}
