/**
 * VibeClaw Skill Installer
 * Downloads SKILL.md from GitHub and places it in ~/.openclaw/skills/
 * so OpenClaw automatically loads it on next session.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = process.env.OPENCLAW_STATE_DIR
  ?? process.env.CLAWDBOT_STATE_DIR
  ?? path.join(os.homedir(), ".openclaw");

const SKILLS_DIR = path.join(CONFIG_DIR, "skills");

/**
 * Validate and sanitize a skill name to prevent path traversal.
 * Only allows alphanumeric characters, hyphens, underscores, and dots.
 */
function sanitizeSkillName(name: string): string | null {
  const sanitized = name.replace(/[^a-zA-Z0-9\-_.]/g, "");
  if (!sanitized || sanitized.includes("..") || sanitized.startsWith(".")) {
    return null;
  }
  // Ensure the resolved path stays within SKILLS_DIR
  const resolved = path.resolve(SKILLS_DIR, sanitized);
  if (!resolved.startsWith(SKILLS_DIR + path.sep)) {
    return null;
  }
  return sanitized;
}

/**
 * Possible paths where SKILL.md might live in a GitHub repo.
 * We try each in order until one succeeds.
 */
function getSkillMdUrls(owner: string, repo: string, skillName: string): string[] {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}`;
  return [
    // Most common: skills/<name>/SKILL.md
    `${base}/main/skills/${skillName}/SKILL.md`,
    `${base}/master/skills/${skillName}/SKILL.md`,
    // Repo root SKILL.md (single-skill repos)
    `${base}/main/SKILL.md`,
    `${base}/master/SKILL.md`,
    // Some repos use src/skills/
    `${base}/main/src/skills/${skillName}/SKILL.md`,
    `${base}/master/src/skills/${skillName}/SKILL.md`,
  ];
}

/**
 * Download SKILL.md content from GitHub
 */
async function downloadSkillMd(
  owner: string,
  repo: string,
  skillName: string,
): Promise<{ content: string; url: string } | null> {
  const urls = getSkillMdUrls(owner, repo, skillName);

  for (const url of urls) {
    try {
      const response = await globalThis.fetch(url, {
        headers: { "User-Agent": "VibeClaw/0.1.0" },
      });
      if (response.ok) {
        const content = await response.text();
        // Validate it looks like a SKILL.md: must have YAML frontmatter (--- delimited) with a name field
        if (content.startsWith("---") && content.indexOf("---", 3) > 3 && content.includes("name:")) {
          return { content, url };
        }
      }
    } catch {
      // Try next URL
    }
  }

  return null;
}

export interface InstallResult {
  success: boolean;
  skillName: string;
  installPath?: string;
  sourceUrl?: string;
  error?: string;
  alreadyInstalled?: boolean;
}

/**
 * Install a skill by downloading SKILL.md from GitHub to ~/.openclaw/skills/<name>/
 */
export async function installSkillFromGitHub(
  owner: string,
  repo: string,
  skillName: string,
  opts?: { force?: boolean },
): Promise<InstallResult> {
  const safeName = sanitizeSkillName(skillName);
  if (!safeName) {
    return {
      success: false,
      skillName,
      error: `Invalid skill name "${skillName}". Names must be alphanumeric with hyphens/underscores only.`,
    };
  }

  const skillDir = path.join(SKILLS_DIR, safeName);
  const skillFile = path.join(skillDir, "SKILL.md");

  // Check if already installed
  try {
    await fs.access(skillFile);
    if (!opts?.force) {
      return {
        success: true,
        skillName,
        installPath: skillDir,
        alreadyInstalled: true,
      };
    }
  } catch {
    // Not installed yet — proceed
  }

  // Download SKILL.md
  const result = await downloadSkillMd(owner, repo, skillName);
  if (!result) {
    return {
      success: false,
      skillName,
      error: `Could not find SKILL.md for "${skillName}" in ${owner}/${repo}. Tried multiple paths.`,
    };
  }

  // Ensure directory exists
  await fs.mkdir(skillDir, { recursive: true });

  // Write SKILL.md
  await fs.writeFile(skillFile, result.content, "utf-8");

  // Write metadata for tracking
  const meta = {
    installedBy: "vibeclaw",
    installedAt: new Date().toISOString(),
    source: `github:${owner}/${repo}`,
    sourceUrl: result.url,
    skillName,
  };
  await fs.writeFile(
    path.join(skillDir, ".vibeclaw.json"),
    JSON.stringify(meta, null, 2),
    "utf-8",
  );

  return {
    success: true,
    skillName,
    installPath: skillDir,
    sourceUrl: result.url,
  };
}

/**
 * List all VibeClaw-installed skills
 */
export async function listInstalledSkills(): Promise<string[]> {
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const installed: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const metaPath = path.join(SKILLS_DIR, entry.name, ".vibeclaw.json");
        try {
          await fs.access(metaPath);
          installed.push(entry.name);
        } catch {
          // Not a VibeClaw-installed skill
        }
      }
    }
    return installed;
  } catch {
    return [];
  }
}

/**
 * Get metadata for a VibeClaw-installed skill
 */
export async function getInstalledSkillMeta(skillName: string): Promise<{
  installedBy: string;
  installedAt: string;
  source: string;
  sourceUrl: string;
  skillName: string;
} | null> {
  const safeName = sanitizeSkillName(skillName);
  if (!safeName) return null;
  const metaPath = path.join(SKILLS_DIR, safeName, ".vibeclaw.json");
  try {
    const content = await fs.readFile(metaPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Uninstall a VibeClaw-installed skill
 */
export async function uninstallSkill(skillName: string): Promise<boolean> {
  const safeName = sanitizeSkillName(skillName);
  if (!safeName) return false;
  const skillDir = path.join(SKILLS_DIR, safeName);
  const metaPath = path.join(skillDir, ".vibeclaw.json");

  try {
    await fs.access(metaPath);
    await fs.rm(skillDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
