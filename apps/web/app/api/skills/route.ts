import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureComposioAppsSkillInWorkspaces } from "@/lib/ensure-composio-apps-skill";
import { parseSkillFrontmatter, readSkillsLock, type SkillsLock } from "@/lib/skills";
import { resolveOpenClawStateDir, resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const PROTECTED_SKILLS = ["crm", "browser", "app-builder", "gstack", "dench-integrations"];

type SkillEntry = {
  name: string;
  slug: string;
  description: string;
  emoji?: string;
  source: string;
  filePath: string;
  protected: boolean;
};

function scanSkillDir(dir: string, source: string, skillsLock: SkillsLock = {}): SkillEntry[] {
  const skills: SkillEntry[] = [];
  if (!existsSync(dir)) return skills;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, "utf-8");
        const meta = parseSkillFrontmatter(content);
        const slug = entry.name;
        const sourceLabel = source === "workspace" && skillsLock[slug]?.installedFrom === "skills.sh"
          ? "skills.sh"
          : source;
        skills.push({
          name: meta.name ?? entry.name,
          slug,
          description: meta.description ?? "",
          emoji: meta.emoji,
          source: sourceLabel,
          filePath: skillMdPath,
          protected: sourceLabel === "managed" || PROTECTED_SKILLS.includes(slug),
        });
      } catch {
        // skip unreadable skill files
      }
    }
  } catch {
    // dir unreadable
  }

  return skills;
}

export async function GET() {
  const stateDir = resolveOpenClawStateDir();
  ensureComposioAppsSkillInWorkspaces();
  const workspaceRoot = resolveWorkspaceRoot();

  const managedSkills = scanSkillDir(join(stateDir, "skills"), "managed");
  if (!workspaceRoot) {
    return Response.json({ skills: managedSkills });
  }

  const workspaceSkillsDir = join(workspaceRoot, "skills");
  const skillsLock = readSkillsLock(workspaceRoot);
  const workspaceSkills = scanSkillDir(workspaceSkillsDir, "workspace", skillsLock);
  const missingLockedSkills = Object.values(skillsLock)
    .filter((entry) => !workspaceSkills.some((skill) => skill.slug === entry.slug))
    .filter((entry) => existsSync(join(workspaceSkillsDir, entry.slug)))
    .map((entry) => ({
      name: entry.slug,
      slug: entry.slug,
      description: `Installed from ${entry.source}`,
      source: entry.installedFrom,
      filePath: join(workspaceSkillsDir, entry.slug, "SKILL.md"),
      protected: PROTECTED_SKILLS.includes(entry.slug),
    } satisfies SkillEntry));

  const allSkills = [...workspaceSkills, ...missingLockedSkills, ...managedSkills];
  allSkills.sort((a, b) => a.name.localeCompare(b.name));

  return Response.json({ skills: allSkills });
}
