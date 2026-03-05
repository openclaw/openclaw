#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveSkillsRoot() {
  if (process.argv[2]) {
    return path.resolve(process.argv[2]);
  }

  return path.join(os.homedir(), ".agents", "skills");
}

function readDescription(markdown) {
  const lines = markdown.split(/\r?\n/);
  let index = 0;

  if (lines[0]?.trim() === "---") {
    index = 1;
    for (; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "---") {
        index += 1;
        break;
      }
      if (line.startsWith("description:")) {
        return line
          .slice("description:".length)
          .trim()
          .replace(/^['"]|['"]$/g, "");
      }
    }
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line === "---" || line.startsWith("#")) {
      continue;
    }
    return line.slice(0, 200);
  }

  return undefined;
}

const skillsRoot = resolveSkillsRoot();

if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) {
  console.error(`Skills directory not found: ${skillsRoot}`);
  process.exit(1);
}

const entries = fs
  .readdirSync(skillsRoot, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
  )
  .map((entry) => {
    const skillDir = path.join(skillsRoot, entry.name);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      return null;
    }

    const markdown = fs.readFileSync(skillMd, "utf-8");
    const description = readDescription(markdown);

    return {
      name: entry.name,
      path: entry.name,
      ...(description ? { description } : {}),
    };
  })
  .filter(Boolean)
  .toSorted((a, b) => a.name.localeCompare(b.name));

const index = {
  version: 1,
  generated: new Date().toISOString(),
  skills: entries,
};

const outputPath = path.join(skillsRoot, "skills-index.json");
fs.writeFileSync(outputPath, JSON.stringify(index, null, 2) + "\n");
console.log(`Wrote ${entries.length} skills to ${outputPath}`);
