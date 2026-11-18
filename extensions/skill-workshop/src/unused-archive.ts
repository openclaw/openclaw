import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  canonicalizePath,
  listWorkshopChanges,
  readCronPayloadText,
  resolveAgentSandboxMode,
  resolveEffectiveAgentRuntime,
  type WorkshopChange,
} from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { resolveSkillWorkshopConfig } from "./config.js";
import { archiveWorkshopSkill, listWorkshopSkills, WorkshopWriteError } from "./library.js";
import { getWorkshopRuntime, readWorkshopRuntimeConfig, workshopLog } from "./runtime.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const UNUSED_ARCHIVE_MS = 30 * 24 * 60 * 60_000;
const UNUSED_ARCHIVE_REASON = "unused for 30 days";
// listWorkshopChanges caps at the feed's per-agent retention.
const CHANGE_FEED_LIMIT = 500;

function mentionsSkill(text: string, name: string): boolean {
  return new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`).test(text);
}

/**
 * Archives an agent's learned skills with no activity for 30 days. Activity is the latest of:
 * recorded use (a file read or a foreground skill_workshop view, via skill_usage), the skill's
 * last change row, and its files' mtime/ctime. ctime never predates the file, so a skill copied
 * in with old mtimes still counts as young. A skill named in any cron job is kept: scheduled
 * work can run less often than the cutoff. Archive is the normal versioned, undoable archive.
 */
export async function archiveUnusedWorkshopSkills(
  config: OpenClawConfig,
  agentId: string,
  nowMs = Date.now(),
): Promise<WorkshopChange[]> {
  // Fail closed where reads go unrecorded: only the Gateway persists skill.used, and only the
  // embedded openclaw harness reports SKILL.md reads (its read tool runs the before-tool-call
  // wrapper; Code Mode `skills.read` reports through the same owner). Codex app-server reads
  // skills through its native shell; the native hook relay never matches those reads to a
  // skill, so only foreground skill_workshop views would count there, and every skill read
  // with `cat` would look unused. Sandboxed runs read skills from paths rewritten by sandbox
  // preparation, so their recorded usage never matches the workshop path looked up here.
  // Accepted risk: an `exec` shell read (`cat SKILL.md`) on the openclaw harness is not
  // recorded either; archive is versioned and undoable.
  const runtime = getWorkshopRuntime();
  if ((await resolveAgentSandboxMode(config, agentId)) !== "off") {
    return [];
  }
  const model = runtime.modelConfig.resolveDefaultModelForAgent({ cfg: config, agentId });
  const agentRuntime = resolveEffectiveAgentRuntime({
    cfg: config,
    provider: model.provider,
    modelId: model.model,
    agentId,
  });
  if (agentRuntime !== "openclaw") {
    return [];
  }
  const skills = await listWorkshopSkills(config, agentId);
  if (skills.length === 0) {
    return [];
  }
  const root = resolveWorkshopSkillsDir(config, agentId);
  const entries = skills.map((skill) => ({
    skill,
    skillFile: canonicalizePath(path.join(root, skill.name, "SKILL.md")),
  }));
  const [{ tracked, usage }, changes, cronText] = await Promise.all([
    runtime.skills.readUsage({ skillFiles: entries.map((entry) => entry.skillFile) }),
    listWorkshopChanges(agentId, { limit: CHANGE_FEED_LIMIT }),
    readCronPayloadText(config),
  ]);
  // Without persisted skill use, an absent usage row is no evidence the skill went unused.
  if (!tracked) {
    return [];
  }
  // The feed is newest first, so the first row per skill is its last change.
  const lastChangeMs = new Map<string, number>();
  for (const change of changes) {
    if (!lastChangeMs.has(change.skillName)) {
      lastChangeMs.set(change.skillName, change.createdAtMs);
    }
  }
  const cutoffMs = nowMs - UNUSED_ARCHIVE_MS;
  const archived: WorkshopChange[] = [];
  // The pass was admitted under the turn's config; the operator may switch Learning Off since.
  const learningOn = () =>
    resolveSkillWorkshopConfig(readWorkshopRuntimeConfig()).autonomous.mode === "auto";
  const assertLive = () => {
    if (!learningOn()) {
      throw new WorkshopWriteError("Learning is off.");
    }
  };
  for (const { skill, skillFile } of entries) {
    const stat = await fs.stat(skillFile).catch(() => undefined);
    const lastActivityMs = Math.max(
      skill.updatedAtMs,
      stat ? Math.max(stat.mtimeMs, stat.ctimeMs) : nowMs,
      lastChangeMs.get(skill.name) ?? 0,
      usage.get(skillFile)?.lastUsedAtMs ?? 0,
    );
    if (lastActivityMs > cutoffMs || mentionsSkill(cronText, skill.name)) {
      continue;
    }
    if (!learningOn()) {
      break;
    }
    try {
      archived.push(
        await archiveWorkshopSkill(
          { config, agentId, actor: "curator", assertLive },
          { name: skill.name, reason: UNUSED_ARCHIVE_REASON },
        ),
      );
    } catch (error) {
      workshopLog().warn(
        `unused skill archive failed: skill=${skill.name} ${formatErrorMessage(error)}`,
      );
    }
  }
  return archived;
}
