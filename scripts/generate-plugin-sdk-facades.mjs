#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatGeneratedModule } from "./lib/format-generated-module.mjs";
import { writeGeneratedOutput } from "./lib/generated-output-utils.mjs";
import {
  GENERATED_PLUGIN_SDK_FACADES,
  GENERATED_PLUGIN_SDK_FACADES_LABEL,
  buildPluginSdkFacadeModule,
} from "./lib/plugin-sdk-facades.mjs";

function parseArgs(argv) {
  const check = argv.includes("--check");
  const write = argv.includes("--write");
  if (check === write) {
    throw new Error("Use exactly one of --check or --write.");
  }
  return { check };
}

export function generatePluginSdkFacades(params) {
  const results = [];
  for (const entry of GENERATED_PLUGIN_SDK_FACADES) {
    const outputPath = `src/plugin-sdk/${entry.subpath}.ts`;
    const next = formatGeneratedModule(
      buildPluginSdkFacadeModule(entry, { repoRoot: params.repoRoot }),
      {
        repoRoot: params.repoRoot,
        outputPath,
        errorLabel: `${GENERATED_PLUGIN_SDK_FACADES_LABEL}:${entry.subpath}`,
      },
    );
    results.push(
      writeGeneratedOutput({
        repoRoot: params.repoRoot,
        outputPath,
        next,
        check: params.check,
      }),
    );
  }
  return results;
}

async function main(argv = process.argv.slice(2)) {
  const { check } = parseArgs(argv);
  const repoRoot = process.cwd();
  const results = generatePluginSdkFacades({ repoRoot, check });
  const changed = results.filter((entry) => entry.changed);

  if (changed.length === 0) {
    console.log(`[${GENERATED_PLUGIN_SDK_FACADES_LABEL}] up to date`);
    return;
  }

  if (check) {
    for (const result of changed) {
      console.error(
        `[${GENERATED_PLUGIN_SDK_FACADES_LABEL}] stale generated output at ${path.relative(repoRoot, result.outputPath)}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  for (const result of changed) {
    console.log(
      `[${GENERATED_PLUGIN_SDK_FACADES_LABEL}] wrote ${path.relative(repoRoot, result.outputPath)}`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
