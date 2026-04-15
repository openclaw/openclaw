#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist");
const runMainEntry = readdirSync(distDir).find((name) => /^run-main-.*\.js$/u.test(name));

if (!runMainEntry) {
  throw new Error(`openclaw: missing run-main entry in ${distDir}`);
}

const { runCli } = await import(pathToFileURL(join(distDir, runMainEntry)).href);
if (typeof runCli !== "function") {
  throw new Error(`openclaw: ${runMainEntry} does not export runCli()`);
}

process.env.OPENCLAW_CLI = "1";
await runCli(process.argv);
process.exit(process.exitCode ?? 0);
