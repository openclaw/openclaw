#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), "..");
const discordDir = path.join(repoRoot, "extensions/discord");
const outputPath = path.join(repoRoot, "extensions/discord/assets/embedded-app-sdk.mjs");

/** Builds the browser SDK bundle without rewriting an identical generated asset. */
export async function buildDiscordActivitySdk(params = {}) {
  const buildImpl = params.build ?? build;
  const targetPath = params.outputPath ?? outputPath;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const result = await buildImpl({
    entryPoints: ["@discord/embedded-app-sdk"],
    absWorkingDir: discordDir,
    bundle: true,
    platform: "browser",
    target: "es2020",
    format: "esm",
    minify: true,
    legalComments: "none",
    outfile: targetPath,
    write: false,
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error("esbuild did not produce the Discord Embedded App SDK bundle");
  }

  const nextBundle = outputFile.text;
  let currentBundle = null;
  try {
    currentBundle = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (currentBundle === nextBundle) {
    return false;
  }
  await fs.writeFile(targetPath, nextBundle);
  return true;
}

if (process.argv[1] === modulePath) {
  await buildDiscordActivitySdk();
}
