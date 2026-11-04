import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { WorkshopChange } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { resolveSkillWorkshopConfig } from "./config.js";
import {
  SKILL_WORKSHOP_CHANGE_NOTICE_TYPE,
  type SkillWorkshopChangeNotice,
  type SkillWorkshopChangeNoticeSkill,
  type SkillWorkshopNoticeAction,
} from "./notice.js";
import { workshopReviewIdOf } from "./review-undo.js";
import { getWorkshopRuntime, workshopLog } from "./runtime.js";

/** The reviewed session generation a notice belongs to. */
export type WorkshopSessionGeneration = Parameters<
  PluginRuntime["system"]["postSessionNotice"]
>[0]["generation"];

const ACTION_VERB: Record<WorkshopChange["action"], SkillWorkshopNoticeAction> = {
  create: "created",
  patch: "updated",
  write_file: "updated",
  remove_file: "updated",
  archive: "archived",
  restore: "restored",
};

/** The notice keeps a creation or latest edit; undo keeps the version before the first edit. */
function formatWorkshopChangeNotice(
  agentId: string,
  runId: string,
  changes: readonly WorkshopChange[],
) {
  const bySkill = new Map<string, { first: WorkshopChange; notice: WorkshopChange }>();
  for (const change of changes.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
    const group = bySkill.get(change.skillName);
    if (!group) {
      bySkill.set(change.skillName, { first: change, notice: change });
    } else if (group.notice.action !== "create") {
      group.notice = change;
    }
  }
  const skills = [...bySkill.values()].map(({ notice: change }) => {
    const skill: SkillWorkshopChangeNoticeSkill = {
      name: change.skillName,
      action: ACTION_VERB[change.action],
    };
    const summary = change.summary.trim();
    if (summary) {
      skill.summary = summary;
    }
    return skill;
  });
  const parts = skills.map(
    ({ name, action, summary }) => `${action} \`${name}\`${summary ? ` (${summary})` : ""}`,
  );
  const text = `💾 Learned: ${parts.join("; ")}. Say "undo" to revert this skill change.`;
  // No prior version means the review created the skill, so undo archives it.
  const reverts = [...bySkill.values()].map(({ first: { skillName, versionId } }) =>
    versionId
      ? `skill_workshop action=restore name=${skillName} version=${versionId}`
      : `skill_workshop action=archive name=${skillName} reason="undo"`,
  );
  const reviewId = workshopReviewIdOf(runId);
  const presentation: MessagePresentation | undefined = reviewId
    ? {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Undo", action: { type: "command", command: `/learn undo ${reviewId}` } },
            ],
          },
        ],
      }
    : undefined;
  const data: SkillWorkshopChangeNotice = { agentId, runId, skills };
  return {
    text,
    presentation,
    data,
    undoContext: `A background skill review just changed your learned skills: ${text} If the user asks to undo or revert it, call ${reverts.join("; then ")}.`,
  };
}

/**
 * Opted-in, supported channels except Slack also get a durable send; every session gets the
 * Learned row. The next foreground turn also gets a system event naming the exact revert call,
 * because an assistant line the model did not write is weak evidence that "undo" means it.
 * A conversation reset or replaced since the review started gets none of it.
 */
export async function postWorkshopChangeNotice(params: {
  config: OpenClawConfig;
  /** The reviewed session generation; the notice belongs to it, not to a later reset. */
  generation: WorkshopSessionGeneration;
  runId: string;
  changes: readonly WorkshopChange[];
}): Promise<void> {
  if (params.changes.length === 0) {
    return;
  }
  const { text, presentation, data, undoContext } = formatWorkshopChangeNotice(
    params.generation.agentId,
    params.runId,
    params.changes,
  );
  const result = await getWorkshopRuntime().system.postSessionNotice({
    generation: params.generation,
    notice: { type: SKILL_WORKSHOP_CHANGE_NOTICE_TYPE, text, data, presentation },
    idempotencyKey: `skill-workshop-notice:${params.runId}`,
    systemEvent: undoContext,
    // Slack never gets a channel message (owner decision).
    ...(resolveSkillWorkshopConfig(params.config).autonomous.channelNotices
      ? { deliver: { skipChannels: ["slack"] } }
      : {}),
  });
  if (result.status === "skipped") {
    workshopLog().debug(
      `skill workshop notice skipped: session ${params.generation.sessionKey} was reset`,
    );
  } else if (result.status === "failed") {
    // The system event still carries the change to the next turn.
    workshopLog().warn(`skill workshop notice ${result.stage} failed: ${result.error}`);
  }
}
