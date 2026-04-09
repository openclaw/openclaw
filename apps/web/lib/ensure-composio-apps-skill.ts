import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveDenchPackageRoot } from "@/lib/project-root";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import { discoverWorkspaceDirs, MANAGED_SKILLS, seedSkill } from "@/lib/workspace-seed";

const integrationsSkillEntry = MANAGED_SKILLS.find((s) => s.name === "dench-integrations");

function sha256File(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/**
 * Copy `skills/dench-integrations` from the shipped package into each configured
 * workspace when missing or when the bundled skill has changed since the last
 * sync (upgrades / dev installs without re-running CLI sync).
 */
export function ensureComposioAppsSkillInWorkspaces(): void {
  if (!integrationsSkillEntry) {
    return;
  }
  const packageRoot = resolveDenchPackageRoot();
  if (!packageRoot) {
    return;
  }
  const stateDir = resolveOpenClawStateDir();
  const sourceSkillFile = join(packageRoot, "skills", "dench-integrations", "SKILL.md");
  const sourceHash = sha256File(sourceSkillFile);
  if (!sourceHash) {
    return;
  }
  for (const workspaceDir of discoverWorkspaceDirs(stateDir)) {
    const skillFile = join(workspaceDir, "skills", "dench-integrations", "SKILL.md");
    const targetHash = sha256File(skillFile);
    if (targetHash !== sourceHash) {
      seedSkill({ workspaceDir, packageRoot }, integrationsSkillEntry);
    }
  }
}
