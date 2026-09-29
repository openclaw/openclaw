import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../skills/runtime/env-overrides.js";
import { resolveSkillResourceCandidates } from "../../skills/runtime/resource-candidates.js";
import { resolveCodeModeSkills, type CodeModeSkillReader } from "../code-mode-skills.js";
import type { SandboxContext } from "../sandbox/types.js";
import { isToolExecutionAllowed } from "../tool-policy-shared.js";
import { getAgentWorkspaceAccess, WorkspaceAccessUnavailableError } from "../workspace-access.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

/** Prepares readable skills and owns environment rollback until the caller takes custody. */
export async function prepareEmbeddedSkills(params: {
  /** Prompt-only callers can skip process-wide environment overrides. */
  applySkillEnvironment?: boolean;
  assertCurrent?: () => void;
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "config"
    | "bootstrapWorkspaceDir"
    | "skillsSnapshot"
    | "contextTokenBudget"
    | "toolExecutionAllow"
    | "operation"
  >;
  effectiveWorkspace: string;
  sandbox: SandboxContext | null | undefined;
  sessionAgentId: string;
  includeCodeModeSkills: boolean;
}) {
  const executionAllow = params.attempt.toolExecutionAllow;
  // Retained schemas are not execution permission. An unreadable skill catalog
  // creates impossible prerequisites and exposes an ungated Code Mode reader.
  if (
    params.attempt.operation === "settled-tool-finalization" ||
    (executionAllow && !isToolExecutionAllowed(executionAllow, "read"))
  ) {
    return {
      restoreSkillEnv: () => {},
      skillUsagePaths: undefined,
      skillsPrompt: "",
      skillsSnapshotForRun: undefined,
      skillReadResources: undefined,
      codeModeSkills: [],
    };
  }
  const {
    skillsEligibility,
    skillUsagePaths,
    skillsPromptWorkspaceDir,
    skillsSnapshot,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: params.sandbox,
    skillsAnchorWorkspace: params.attempt.bootstrapWorkspaceDir ?? params.effectiveWorkspace,
    skillsSnapshot: params.attempt.skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries, loadSkillEntries, preserveEntryOrder } =
    await resolveEmbeddedRunSkillEntries({
      assertCurrent: params.assertCurrent,
      workspaceDir: skillsWorkspaceDir,
      config: params.attempt.config,
      agentId: params.sessionAgentId,
      eligibility: skillsEligibility,
      skillsSnapshot,
      // Sandbox fallbacks stay inside their sandbox skill workspace;
      // host execution skills are not mounted there.
      ...(params.sandbox?.enabled === true
        ? {}
        : { executionWorkspaceDir: params.effectiveWorkspace }),
      workspaceOnly,
    });
  let restoreSkillEnv = () => {};
  try {
    const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsWorkspaceDir,
      skillsPromptWorkspaceDir,
    });
    const skillsPrompt = await resolveSkillsPrompt({
      assertCurrent: params.assertCurrent,
      contextTokenBudget: params.attempt.contextTokenBudget,
      skillsSnapshot,
      entries: promptSkillEntries,
      loadEntries: async () =>
        mapSandboxSkillEntriesForPrompt({
          entries: await loadSkillEntries(),
          skillsWorkspaceDir,
          skillsPromptWorkspaceDir,
        }) ?? [],
      config: params.attempt.config,
      workspaceDir: skillsPromptWorkspaceDir,
      agentId: params.sessionAgentId,
      eligibility: skillsEligibility,
      preserveEntryOrder,
    });
    params.assertCurrent?.();
    // Preparation may yield to abort/revocation. Apply process-wide overrides only
    // once all filesystem work has settled and this caller can take custody.
    restoreSkillEnv =
      params.applySkillEnvironment === false
        ? () => {}
        : skillsSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: skillsSnapshot,
              config: params.attempt.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries,
              config: params.attempt.config,
            });
    const sandbox = params.sandbox;
    const sandboxSkillReader: CodeModeSkillReader | undefined = sandbox?.enabled
      ? async ({ location, signal }) => {
          const bridge = sandbox.fsBridge;
          if (!bridge) {
            throw new Error("Sandbox filesystem bridge is unavailable for skill reads.");
          }
          return (
            await bridge.readFile({
              filePath: location,
              cwd: sandbox.containerWorkdir,
              signal,
            })
          ).toString("utf8");
        }
      : undefined;
    const workspaceAccess =
      params.includeCodeModeSkills && !sandbox?.enabled
        ? getAgentWorkspaceAccess(skillsWorkspaceDir, "loadSkills")
        : undefined;
    const workspaceSkillReader: CodeModeSkillReader | undefined = workspaceAccess?.loadSkills
      ? async ({ location, signal }) => {
          if (!workspaceAccess.skillResources) {
            throw new WorkspaceAccessUnavailableError(
              "Remote workspace skill reads are unavailable",
            );
          }
          return await workspaceAccess.skillResources.readInstructions(location, { signal });
        }
      : undefined;
    const candidates = skillsSnapshot?.resolvedSkills ?? skillEntries.map((entry) => entry.skill);
    const codeModeSkills = params.includeCodeModeSkills
      ? resolveCodeModeSkills({
          skillsPrompt,
          candidates,
          reader: sandboxSkillReader,
        })
      : [];
    // Host read exceptions use exact eligible resources without changing model visibility.
    // Sandboxes keep their existing materialized paths; never resolve host library pins there.
    const skillReadResources = params.sandbox?.enabled
      ? undefined
      : resolveSkillResourceCandidates(skillsSnapshot);
    if (workspaceSkillReader) {
      for (const skill of codeModeSkills) {
        const candidate = candidates.find((entry) => entry.filePath === skill.source.filePath);
        // Resolved ownership wins over a same-name Library pin that was filtered out.
        if (
          candidate?.fileHost === "workspace" ||
          (candidate?.fileHost !== "gateway" &&
            !skillsSnapshot?.librarySelections?.some((selection) => selection.name === skill.name))
        ) {
          skill.reader = ({ signal }) =>
            workspaceSkillReader({ location: skill.source.filePath, signal });
        }
      }
    }
    return {
      restoreSkillEnv,
      skillReadResources,
      skillUsagePaths,
      skillsPrompt,
      skillsSnapshotForRun: skillsSnapshot,
      codeModeSkills,
    };
  } catch (error) {
    restoreSkillEnv();
    throw error;
  }
}
