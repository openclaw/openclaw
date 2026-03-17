#!/usr/bin/env node
import fs from "node:fs/promises";

const rawArgs = process.argv.slice(2);
const files = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

if (files.length === 0) {
  process.stderr.write("usage: format-json.mjs -- <files...>\n");
  process.exit(2);
}

let hadError = false;

for (const file of files) {
  try {
    const input = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(input);
    const formatted = `${JSON.stringify(parsed, null, 2)}\n`;
    if (formatted !== input) {
      await fs.writeFile(file, formatted, "utf8");
    }
  } catch (error) {
    hadError = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`format-json.mjs: ${file}: ${message}\n`);
  }
}

if (hadError) {
  process.exit(1);
}
