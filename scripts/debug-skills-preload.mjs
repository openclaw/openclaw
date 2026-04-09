// Standalone diagnostic for the skills-preload hook.
// Imports from the bundled chunks the actual hook uses.
//
// Run from openclaw root: node scripts/debug-skills-preload.mjs

import fs from "node:fs";
import path from "node:path";
import { r as loadWorkspaceSkillEntries } from "../dist/workspace-DenIleUA.js";

const QUINN_WORKSPACE = "C:\\AI\\quinn-co\\workspace";

console.log("=== Quinn workspace skill scan ===\n");
console.log(`Workspace: ${QUINN_WORKSPACE}\n`);

let entries;
try {
  entries = loadWorkspaceSkillEntries(QUINN_WORKSPACE);
} catch (err) {
  console.error("loadWorkspaceSkillEntries threw:", err);
  process.exit(1);
}

console.log(`Total skills loaded: ${entries.length}\n`);

const preloadEntries = entries.filter((entry) => {
  const flatPreload = entry.frontmatter?.preload;
  const metaPreload = entry.metadata?.preload;
  return metaPreload === true || (typeof flatPreload === "string" && flatPreload.toLowerCase() === "true");
});

console.log(`Skills with preload=true: ${preloadEntries.length}\n`);

for (const entry of entries) {
  const name = entry.skill?.name ?? "(no name)";
  const filePath = entry.skill?.filePath ?? "(no filePath)";
  const baseDir = entry.skill?.baseDir ?? "(no baseDir)";
  const flatPreload = entry.frontmatter?.preload;
  const flatPreloadFiles = entry.frontmatter?.["preload-files"];
  const metaPreload = entry.metadata?.preload;
  const metaPreloadFiles = entry.metadata?.preloadFiles;
  console.log(`--- ${name} ---`);
  console.log(`  filePath: ${filePath}`);
  console.log(`  baseDir: ${baseDir}`);
  console.log(`  frontmatter.preload: ${JSON.stringify(flatPreload)}`);
  console.log(`  frontmatter["preload-files"]: ${JSON.stringify(flatPreloadFiles)}`);
  console.log(`  metadata.preload: ${JSON.stringify(metaPreload)}`);
  console.log(`  metadata.preloadFiles: ${JSON.stringify(metaPreloadFiles)}`);
  console.log(`  frontmatter keys: ${Object.keys(entry.frontmatter ?? {}).join(", ")}`);
  console.log("");
}
