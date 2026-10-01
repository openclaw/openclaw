import {
  hasUnavailableSkillSecretOwners,
  isSkillSecretOwnerUnavailable,
} from "../skills/loading/config.js";
import type { SkillSnapshot } from "../skills/types.js";
import { resolveCodeModeSkills, type CodeModeSkillReader } from "./code-mode-skills.js";
import { MAX_SKILL_INSTRUCTION_BYTES, type InstalledSkill } from "./installed-skill-catalog.js";
import type { SandboxContext } from "./sandbox/types.js";
import { getAgentWorkspaceAccess, WorkspaceAccessUnavailableError } from "./workspace-access.js";

/** Bind already-admitted identities to the filesystem owner for this attempt. */
export function prepareInstalledSkillCatalog(params: {
  snapshot: SkillSnapshot | undefined;
  workspaceDir: string;
  sandbox?: SandboxContext | null;
  assertCurrent?: () => void;
}): InstalledSkill[] {
  const { snapshot, sandbox } = params;
  if (!snapshot) {
    return [];
  }
  const candidates = snapshot.discoverySkills ?? snapshot.resolvedSkills ?? [];
  const fallback = snapshot.discoverySkills
    ? undefined
    : new Set(
        resolveCodeModeSkills({ skillsPrompt: snapshot.prompt, candidates }).map(
          (skill) => skill.name,
        ),
      );
  const keys = new Map(snapshot.skills.map((skill) => [skill.name, skill.skillKey]));
  const unavailableOwners = hasUnavailableSkillSecretOwners();
  const workspace = !sandbox?.enabled
    ? getAgentWorkspaceAccess(params.workspaceDir, "loadSkills")
    : undefined;
  return candidates
    .filter(
      (skill) =>
        !skill.disableModelInvocation &&
        (!fallback || fallback.has(skill.name)) &&
        // Legacy snapshots cannot identify renamed secret owners reliably.
        (!unavailableOwners || keys.get(skill.name) !== undefined) &&
        !isSkillSecretOwnerUnavailable(keys.get(skill.name) ?? skill.name),
    )
    .map((skill) => {
      let reader: CodeModeSkillReader | undefined;
      if (sandbox?.enabled) {
        reader = async ({ location, signal }) => {
          params.assertCurrent?.();
          if (!sandbox.fsBridge) {
            throw new Error("Sandbox filesystem bridge is unavailable for skill reads.");
          }
          const content = await sandbox.fsBridge.readFile({
            filePath: location,
            cwd: sandbox.containerWorkdir,
            signal,
            maxBytes: MAX_SKILL_INSTRUCTION_BYTES,
          });
          params.assertCurrent?.();
          return content.toString("utf8");
        };
      } else if (
        workspace?.loadSkills &&
        (skill.fileHost === "workspace" ||
          (skill.fileHost !== "gateway" &&
            !snapshot.librarySelections?.some((selection) => selection.name === skill.name)))
      ) {
        reader = async ({ location, signal }) => {
          params.assertCurrent?.();
          if (!workspace.skillResources) {
            throw new WorkspaceAccessUnavailableError(
              "Remote workspace skill reads are unavailable",
            );
          }
          const content = await workspace.skillResources.readInstructions(location, { signal });
          params.assertCurrent?.();
          return content;
        };
      }
      return {
        name: skill.name,
        description: [skill.description, skill.locationNote].filter(Boolean).join("\n"),
        location: skill.filePath,
        source: {
          filePath: skill.filePath,
          readContent: sandbox?.enabled ? undefined : skill.readContent,
        },
        reader,
      };
    });
}
