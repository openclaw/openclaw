/**
 * Real-behavior proof: filterReadOnlyWorkspaceSkillMountsByBinds prevents Docker
 * "Duplicate mount point" errors when user binds overlap skill mount paths.
 *
 * Run from repo root: node scripts/demo-sandbox-bind-filter.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

// Import from the built/transpiled sources (pnpm build not needed for .ts; use tsx)
// For live proof we import the TS source via dynamic import with tsx
const workspaceMounts = await import(path.join(repoRoot, "src/agents/sandbox/workspace-mounts.ts"));

const { filterReadOnlyWorkspaceSkillMountsByBinds, resolveReadOnlyWorkspaceSkillMounts } =
  workspaceMounts;

// ── Setup: create a temp agent workspace with a skills/ directory ──────────
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-"));
fs.mkdirSync(path.join(agentDir, "skills", "demo"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "skills", "demo", "SKILL.md"), "# Demo skill\n");
console.log("Workspace:", agentDir);

// ── Step 1: resolve skill mounts (no binds) ───────────────────────────────
const mounts = resolveReadOnlyWorkspaceSkillMounts({
  workspaceDir: agentDir,
  agentWorkspaceDir: agentDir,
  workdir: "/workspace",
  workspaceAccess: "rw",
});
console.log("\nResolved skill mounts (no binds):");
for (const m of mounts) {
  console.log(`  ${m.hostPath} -> ${m.containerPath}`);
}

// ── Step 2: user config with a bind that targets the same container path ──
const userBinds = ["/host/custom-skills:/workspace/skills:rw"];
console.log("\nUser binds:", userBinds);

// ── Step 3: apply the filter ───────────────────────────────────────────────
const filtered = filterReadOnlyWorkspaceSkillMountsByBinds(mounts, userBinds);
console.log("\nFiltered skill mounts (after skipping conflicts):");
if (filtered.length === 0) {
  console.log("  (none — conflicting mount was filtered out)");
} else {
  for (const m of filtered) {
    console.log(`  ${m.hostPath} -> ${m.containerPath}`);
  }
}

// ── Step 4: format Docker -v args ──────────────────────────────────────────
console.log("\nDocker -v args that WOULD be generated (one per mount):");
for (const m of mounts) {
  console.log(`  -v ${m.hostPath}:${m.containerPath}:ro,z`);
}
console.log("\nDocker -v args that ARE generated (after filtering):");
for (const m of filtered) {
  console.log(`  -v ${m.hostPath}:${m.containerPath}:ro,z`);
}

// ── Step 5: verify ─────────────────────────────────────────────────────────
const conflictingContainerPath = "/workspace/skills";
const hasConflict = filtered.some((m) => m.containerPath === conflictingContainerPath);
console.log(
  `\nConflicting mount at ${conflictingContainerPath} in filtered output: ${hasConflict}`,
);
if (!hasConflict) {
  console.log(
    "✅ PASS: Conflicting skill mount filtered out — no Duplicate mount point from Docker",
  );
} else {
  console.log("❌ FAIL: Conflicting skill mount was NOT filtered");
  process.exit(1);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(agentDir, { recursive: true, force: true });
