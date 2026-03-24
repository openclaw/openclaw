#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function runPackageScript(scriptName) {
  const execPath = process.env.npm_execpath;
  if (!execPath) {
    throw new Error("npm_execpath is not set");
  }
  return spawnSync(process.execPath, [execPath, scriptName], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function main(argv = process.argv.slice(2)) {
  const [scriptName, outputPath] = argv;
  if (!scriptName || !outputPath) {
    process.stderr.write(
      "Usage: node scripts/deadcode-report-ci.mjs <script-name> <output-path>\n",
    );
    return 2;
  }

  const absoluteOutputPath = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });

  const result = runPackageScript(scriptName);
  const sections = [];
  if (result.stdout) {
    sections.push(result.stdout.trimEnd());
  }
  if (result.stderr) {
    sections.push(result.stderr.trimEnd());
  }
  fs.writeFileSync(absoluteOutputPath, `${sections.filter(Boolean).join("\n")}\n`, "utf8");

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`${String(error.message ?? error)}\n`);
    process.exit(1);
  }
}
