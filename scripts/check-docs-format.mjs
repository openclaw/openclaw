#!/usr/bin/env node
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const DOC_GLOBS = ["docs/**/*.md", "docs/**/*.mdx", "README.md"];
const CHUNK_SIZE = 100;

async function listTrackedDocs() {
  const { stdout } = await execFile("git", ["ls-files", ...DOC_GLOBS], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function runOxfmt(files) {
  return new Promise((resolve, reject) => {
    const child = spawn("oxfmt", ["--check", ...files], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`oxfmt exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const files = await listTrackedDocs();
  if (files.length === 0) {
    console.log("No tracked docs found, skipping oxfmt check.");
    return;
  }
  for (const group of chunk(files, CHUNK_SIZE)) {
    await runOxfmt(group);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
