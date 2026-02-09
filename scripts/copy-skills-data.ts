#!/usr/bin/env tsx
/**
 * Copy skills.json from src/agents/prompt-engine/data to dist/agents/prompt-engine/data
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const srcDataDir = path.join(projectRoot, "src", "agents", "prompt-engine", "data");
const distDataDir = path.join(projectRoot, "dist", "agents", "prompt-engine", "data");
const srcSkillsJson = path.join(srcDataDir, "skills.json");
const distSkillsJson = path.join(distDataDir, "skills.json");

function copySkillsData() {
  if (!fs.existsSync(srcSkillsJson)) {
    console.warn("[copy-skills-data] Source file not found:", srcSkillsJson);
    return;
  }

  if (!fs.existsSync(distDataDir)) {
    fs.mkdirSync(distDataDir, { recursive: true });
  }

  fs.copyFileSync(srcSkillsJson, distSkillsJson);
  console.log(`[copy-skills-data] Copied skills.json to ${distSkillsJson}`);
}

copySkillsData();
