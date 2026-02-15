#!/usr/bin/env node
import path from "node:path";
import { scanDirectoryWithSummary } from "../src/security/skill-scanner.js";

async function main() {
  const target = process.argv[2] ?? process.cwd();
  const resolved = path.resolve(target);
  try {
    const summary = await scanDirectoryWithSummary(resolved, { maxFiles: 2000 });
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error("Scan failed:", err);
    process.exit(2);
  }
}

void main();
