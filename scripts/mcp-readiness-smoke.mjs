#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || !args.has("--verify-callable");
const root = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const mcporterHome = path.join(os.homedir(), ".mcporter", "mcporter.json");
const workspaces = fs.existsSync(root)
  ? fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("workspace"))
      .map((entry) => path.join(root, entry.name))
  : [];
const configPaths = [
  mcporterHome,
  ...workspaces.map((dir) => path.join(dir, "config", "mcporter.json")),
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listDeclaredServers(filePath) {
  const parsed = readJson(filePath);
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  return Object.keys(servers).toSorted();
}

function runMcporterConfigList(cwd) {
  const result = spawnSync("mcporter", ["config", "list", "--output", "json"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").slice(0, 500),
    stderr: (result.stderr || "").slice(0, 500),
  };
}

const rows = [];
for (const filePath of configPaths) {
  const declared = listDeclaredServers(filePath);
  if (declared.length === 0) {
    continue;
  }
  const workspaceDir = filePath.endsWith(path.join("config", "mcporter.json"))
    ? path.dirname(path.dirname(filePath))
    : root;
  const configList = dryRun ? undefined : runMcporterConfigList(workspaceDir);
  rows.push({
    config: filePath,
    workspaceDir,
    declared,
    dryRun,
    configList,
  });
}

console.log(
  JSON.stringify({ generated_at: new Date().toISOString(), dryRun, configs: rows }, null, 2),
);
if (rows.length === 0) {
  process.exitCode = 2;
}
