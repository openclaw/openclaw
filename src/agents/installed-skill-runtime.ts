import {
  hasUnavailableSkillSecretOwners,
  isSkillSecretOwnerUnavailable,
} from "../skills/loading/config.js";
import { resolveSkillFileHost } from "../skills/skill-file-host.js";
import type { SkillSnapshot } from "../skills/types.js";
import { resolveSkillReadPath } from "../skills/workspace-skill-read-path.js";
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
  const promptListed = new Set(
    resolveCodeModeSkills({ skillsPrompt: snapshot.prompt, candidates }).map((skill) => skill.name),
  );
  const fallback = snapshot.discoverySkills ? undefined : promptListed;
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
      let readSearchContent: InstalledSkill["readSearchContent"];
      if (sandbox?.enabled) {
        const readInstructions = async (maxBytes: number | undefined, signal?: AbortSignal) => {
          params.assertCurrent?.();
          if (!sandbox.fsBridge) {
            throw new Error("Sandbox filesystem bridge is unavailable for skill reads.");
          }
          const content = await sandbox.fsBridge.readFile({
            filePath: skill.filePath,
            cwd: sandbox.containerWorkdir,
            signal,
            maxBytes,
          });
          params.assertCurrent?.();
          return content.toString("utf8");
        };
        reader = ({ signal }) =>
          readInstructions(
            promptListed.has(skill.name) ? undefined : MAX_SKILL_INSTRUCTION_BYTES,
            signal,
          );
        readSearchContent = readInstructions;
      } else if (
        workspace?.loadSkills &&
        (resolveSkillFileHost(skill) === "workspace" ||
          (resolveSkillFileHost(skill) !== "gateway" &&
            !snapshot.librarySelections?.some((selection) => selection.name === skill.name)))
      ) {
        reader = async ({ signal }) => {
          params.assertCurrent?.();
          if (!workspace.skillResources) {
            throw new WorkspaceAccessUnavailableError(
              "Remote workspace skill reads are unavailable",
            );
          }
          const content = await workspace.skillResources.readInstructions(skill.filePath, {
            signal,
          });
          params.assertCurrent?.();
          return content;
        };
        // This resource owner supports whole reads only. Its document bridge
        // is not a substitute for bounded skill-resource authority.
      }
      return {
        name: skill.name,
        promptListed: promptListed.has(skill.name),
        description: [skill.description, skill.locationNote].filter(Boolean).join("\n"),
        location: resolveSkillReadPath(skill),
        source: {
          filePath: skill.filePath,
          readContent: sandbox?.enabled ? undefined : skill.readContent,
        },
        reader,
        assertCurrent: params.assertCurrent,
        readSearchContent,
      };
    });
}
