#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const requiredEntries = ["package/qa/scenarios/index.md"];

let tarballName = "";
try {
  tarballName = execFileSync("npm", ["pack", "--silent", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (!tarballName) {
    throw new Error("npm pack did not return a tarball filename");
  }
  const tarballPath = path.join(repoRoot, tarballName);
  const archiveEntries = execFileSync("tar", ["-tf", tarballPath], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
    .split(/\r?\n/)
    .filter(Boolean);

  const archiveEntrySet = new Set(archiveEntries);
  const missingEntries = requiredEntries.filter((entry) => !archiveEntrySet.has(entry));
  if (missingEntries.length > 0) {
    console.error(
      `npm pack tarball ${tarballName} is missing required QA scenario entries:\n${missingEntries
        .map((entry) => `- ${entry}`)
        .join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`npm pack tarball ${tarballName} contains required QA scenario entries.`);
  }
} finally {
  if (tarballName) {
    const tarballPath = path.join(repoRoot, tarballName);
    if (fs.existsSync(tarballPath)) {
      fs.unlinkSync(tarballPath);
    }
  }
}
