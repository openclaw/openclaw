import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { Skill } from "../../skills/loading/skill-contract.js";
import { ensureWritableSkillDirectories } from "../../skills/loading/skill-directory-modes.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { cliBackendLog } from "./log.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";
const OPENCLAW_CLAUDE_PLUGIN_NAME = "openclaw-skills";
const NODE_SKILL_LOCATOR_PREFIX = "node://";
const REMOTE_SKILL_FILE_NAME = "SKILL.md";

function sanitizeSkillDirName(name: string, used: Set<string>): string {
  const base =
    name
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill";
  const safeBase = base.startsWith(".") ? `skill-${base.replace(/^\.+/, "") || "skill"}` : base;
  let candidate = safeBase;
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${safeBase}-${index}`;
  }
  used.add(candidate);
  return candidate;
}

async function linkOrCopySkillDir(params: { sourceDir: string; targetDir: string }) {
  try {
    await fs.symlink(
      params.sourceDir,
      params.targetDir,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch {
    // Symlinks are preferred to avoid copying skill trees, but Windows/TCC/filesystem policy can
    // reject them. Copying preserves the session-scoped plugin contract.
    await fs.cp(params.sourceDir, params.targetDir, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    await ensureWritableSkillDirectories(
      await root(path.dirname(params.targetDir)),
      path.basename(params.targetDir),
    );
  }
}

/**
 * Node-hosted skills advertise their instruction bytes because their `node://` locator is not a
 * Gateway filesystem path. Keep the node execution guidance with the materialized instructions so
 * relative scripts stay targeted at the publishing node instead of the Gateway.
 */
function renderRemoteSkillInstructions(skill: Skill): string | undefined {
  const content = skill.readContent?.trim();
  if (!content) {
    return undefined;
  }
  const locationNote = skill.locationNote?.trim();
  return locationNote ? `${content}\n\n${locationNote}\n` : `${content}\n`;
}

type PreparedPluginSkill = {
  skill: Skill;
  name: string;
  targetDirName: string;
} & ({ sourceDir: string } | { instructions: string });

async function deliverPluginSkill(params: {
  prepared: PreparedPluginSkill;
  skillsDir: string;
}): Promise<void> {
  const targetDir = path.join(params.skillsDir, params.prepared.targetDirName);
  if ("instructions" in params.prepared) {
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(targetDir, REMOTE_SKILL_FILE_NAME), params.prepared.instructions, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return;
  }
  await linkOrCopySkillDir({ sourceDir: params.prepared.sourceDir, targetDir });
}

export type ClaudeCliSkillsPlugin = {
  args: string[];
  cleanup: () => Promise<void>;
  pluginDir?: string;
  /** Claude's native Skill command name (`openclaw-skills:<dir>`) to the linked skill. */
  skillCommands?: ReadonlyMap<string, Skill>;
};

/** Prepares Claude CLI `--plugin-dir` args for the current session skill snapshot. */
export async function prepareClaudeCliSkillsPlugin(params: {
  backendId: string;
  skillsSnapshot?: SkillSnapshot;
}): Promise<ClaudeCliSkillsPlugin> {
  if (normalizeLowercaseStringOrEmpty(params.backendId) !== CLAUDE_CLI_BACKEND_ID) {
    return { args: [], cleanup: async () => {} };
  }
  // Library command identities are host-owned, not frontmatter names. Keep their
  // canonical catalog and immutable paths instead of registering colliding native aliases.
  if (params.skillsSnapshot?.librarySelections?.length) {
    return { args: [], cleanup: async () => {} };
  }

  const usedTargetNames = new Set<string>();
  const skills = (params.skillsSnapshot?.resolvedSkills ?? []).flatMap(
    (skill): PreparedPluginSkill[] => {
      const name = skill.name?.trim();
      const skillFilePath = skill.filePath?.trim();
      if (!name || !skillFilePath) {
        return [];
      }
      // Node-hosted skills are selected by the snapshot but live on a paired node; deliver the
      // advertised instructions instead of dropping them for an unreadable locator.
      if (skillFilePath.startsWith(NODE_SKILL_LOCATOR_PREFIX)) {
        const instructions = renderRemoteSkillInstructions(skill);
        if (instructions === undefined) {
          cliBackendLog.warn(
            `claude skill plugin skipped node skill without instructions: ${skillFilePath}`,
          );
          return [];
        }
        return [
          {
            skill,
            name,
            targetDirName: sanitizeSkillDirName(name, usedTargetNames),
            instructions,
          },
        ];
      }
      if (!existsSync(skillFilePath)) {
        cliBackendLog.warn(`claude skill plugin skipped missing skill file: ${skillFilePath}`);
        return [];
      }
      return [
        {
          skill,
          name,
          sourceDir: path.dirname(skillFilePath),
          targetDirName: sanitizeSkillDirName(name, usedTargetNames),
        },
      ];
    },
  );
  if (skills.length === 0) {
    return { args: [], cleanup: async () => {} };
  }

  const tempDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-claude-skills-"),
  );
  const cleanup = () => fs.rm(tempDir, { recursive: true, force: true });
  const pluginDir = path.join(tempDir, OPENCLAW_CLAUDE_PLUGIN_NAME);
  const manifestDir = path.join(pluginDir, ".claude-plugin");
  const skillsDir = path.join(pluginDir, "skills");
  try {
    await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(skillsDir, { recursive: true, mode: 0o700 });

    const manifest = {
      name: OPENCLAW_CLAUDE_PLUGIN_NAME,
      version: "0.0.0",
      description: "Session-scoped OpenClaw skills selected for this agent run.",
      skills: "./skills",
    };
    await fs.writeFile(
      path.join(manifestDir, "plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: "utf-8",
        mode: 0o600,
      },
    );

    const skillCommands = new Map<string, Skill>();
    for (const prepared of skills) {
      try {
        await deliverPluginSkill({ prepared, skillsDir });
        skillCommands.set(
          `${OPENCLAW_CLAUDE_PLUGIN_NAME}:${prepared.targetDirName}`,
          prepared.skill,
        );
      } catch (error) {
        cliBackendLog.warn(
          `claude skill plugin skipped ${prepared.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (skillCommands.size === 0) {
      await cleanup();
      return { args: [], cleanup: async () => {} };
    }

    return {
      args: ["--plugin-dir", pluginDir],
      pluginDir,
      skillCommands,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
