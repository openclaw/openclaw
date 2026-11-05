#!/usr/bin/env -S node --import tsx

import { pathToFileURL } from "node:url";
import {
  collectPluginClawHubReleasePlan,
  parsePluginReleaseArgs,
} from "./lib/plugin-clawhub-release.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { selection, selectionMode, baseRef, headRef } = parsePluginReleaseArgs(
    process.argv.slice(2),
  );
  const plan = await collectPluginClawHubReleasePlan({
    selection,
    selectionMode,
    gitRange: baseRef && headRef ? { baseRef, headRef } : undefined,
  });
  console.log(JSON.stringify(plan, null, 2));
}
