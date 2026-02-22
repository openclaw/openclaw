#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(process.cwd());

function normalizeRel(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceRoot() {
  const fromEnv = process.env.OPENCLAW_WORKSPACE_ROOT?.trim();
  if (fromEnv) {return path.resolve(fromEnv);}

  const parent = path.dirname(repoRoot);
  const markers = [
    path.join(parent, "openclaw-mission-control"),
    path.join(parent, "openclaw-fresh"),
    path.join(parent, "openclaw-platform"),
  ];
  const hasAnyMarker = (await Promise.all(markers.map(pathExists))).some(Boolean);
  return hasAnyMarker ? parent : repoRoot;
}

const skipDirNames = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".cache",
  ".pnpm-store",
]);

async function findPackageJsonFiles(root) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) {continue;}
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {continue;}
      if (entry.name === "package.json") {out.push(full);}
    }
  }
  await walk(root);
  return out;
}

function isDashboardPackage(name) {
  return /(dashboard|control-ui|mission-control)/i.test(name);
}

function readJsonSafe(raw, filePath) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`, { cause: error });
  }
}

const allowedDashboardPackageGlobs = new Set([
  "openclaw-mission-control/package.json",
  "openclaw-fresh/openclaw-main/ui/package.json",
  "openclaw-main/ui/package.json",
]);

function isAllowedDashboardPackage(relPath) {
  if (allowedDashboardPackageGlobs.has(relPath)) {return true;}
  // When running from the mission-control repo alone, allow local package.
  if (relPath === "package.json") {return true;}
  return false;
}

async function main() {
  const workspaceRoot = await resolveWorkspaceRoot();
  const packageJsonFiles = await findPackageJsonFiles(workspaceRoot);

  const dashboardPackages = [];
  for (const filePath of packageJsonFiles) {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = readJsonSafe(raw, filePath);
    const name = typeof parsed.name === "string" ? parsed.name : "";
    if (!isDashboardPackage(name)) {continue;}
    const rel = normalizeRel(workspaceRoot, filePath);
    dashboardPackages.push({ rel, name });
  }

  const violations = dashboardPackages.filter((entry) => !isAllowedDashboardPackage(entry.rel));

  console.log(`[dashboard-guard] workspace root: ${workspaceRoot}`);
  if (dashboardPackages.length === 0) {
    console.log("[dashboard-guard] No dashboard/control-ui packages found.");
    return;
  }

  console.log("[dashboard-guard] detected dashboard/control-ui packages:");
  for (const pkg of dashboardPackages) {
    const marker = violations.some((v) => v.rel === pkg.rel) ? "x" : "ok";
    console.log(`  [${marker}] ${pkg.rel} (${pkg.name})`);
  }

  if (violations.length > 0) {
    console.error("");
    console.error(
      "[dashboard-guard] Non-canonical dashboards detected. Allowed dashboards are Mission Control + built-in OpenClaw UI."
    );
    console.error(
      "[dashboard-guard] Remove/archive the listed packages or set OPENCLAW_WORKSPACE_ROOT to a narrower scope for isolated checks."
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    `[dashboard-guard] Failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
