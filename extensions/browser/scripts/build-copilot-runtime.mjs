#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeGeneratedTextAsset } from "../../../scripts/lib/generated-text-asset.mjs";

const modulePath = fileURLToPath(import.meta.url);
const pluginDir = path.resolve(path.dirname(modulePath), "..");
const repoRoot = path.resolve(pluginDir, "../..");
const outfile = path.join(pluginDir, "chrome-extension", "modules", "copilot-runtime.js");

/** Builds the copilot runtime without rewriting an identical generated asset. */
export async function buildCopilotRuntime(params = {}) {
  const buildImpl = params.build ?? build;
  const outputPath = params.outputPath ?? outfile;
  const result = await buildImpl({
    entryPoints: [path.join(pluginDir, "scripts", "copilot-runtime-entry.ts")],
    outfile: outputPath,
    bundle: true,
    format: "esm",
    legalComments: "inline",
    minify: true,
    platform: "browser",
    target: "chrome125",
    tsconfig: path.join(repoRoot, "tsconfig.json"),
    write: false,
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error("esbuild did not produce the Browser copilot runtime bundle");
  }

  return writeGeneratedTextAsset(outputPath, outputFile.text);
}

if (process.argv[1] === modulePath) {
  await buildCopilotRuntime();
}
