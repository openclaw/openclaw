import { prepareSkillLibrarySelection } from "../../skills/library/selection.js";
import {
  buildSkillSnapshot,
  resolveSkillsPrompt,
} from "../../skills/loading/workspace-skill-prompt.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../skills/runtime/env-overrides.js";
import { resolveSkillResourceCandidates } from "../../skills/runtime/resource-candidates.js";
import { prepareInstalledSkillCatalog } from "../installed-skill-runtime.js";
import type { SandboxContext } from "../sandbox/types.js";
import { isToolExecutionAllowed } from "../tool-policy-shared.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import { prepareRuntimeSkillEntries } from "./skills-prompt.js";

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
      installedSkills: [],
    };
  }
  const {
    skillsEligibility,
    skillUsagePaths,
    skillsPromptWorkspaceDir,
    skillsSnapshot: preparedSnapshot,
    skillsWorkspaceDir,
    shouldLoadSkillEntries,
    skillEntries,
    loadSkillEntries,
    preserveEntryOrder,
    mapEntries,
  } = await prepareRuntimeSkillEntries({
    sandbox: params.sandbox,
    skillsAnchorWorkspace: params.attempt.bootstrapWorkspaceDir ?? params.effectiveWorkspace,
    skillsSnapshot: params.attempt.skillsSnapshot,
    assertCurrent: params.assertCurrent,
    config: params.attempt.config,
    agentId: params.sessionAgentId,
    executionWorkspaceDir: params.effectiveWorkspace,
  });
  let restoreSkillEnv = () => {};
  try {
    const promptSkillEntries = mapEntries(shouldLoadSkillEntries ? skillEntries : undefined);
    const skillsSnapshot =
      preparedSnapshot ??
      (await buildSkillSnapshot(skillsPromptWorkspaceDir, {
        entries: promptSkillEntries ?? [],
        config: params.attempt.config,
        agentId: params.sessionAgentId,
        eligibility: skillsEligibility,
        preserveEntryOrder,
        assertCurrent: params.assertCurrent,
      }));
    const skillsPrompt = await resolveSkillsPrompt({
      assertCurrent: params.assertCurrent,
      contextTokenBudget: params.attempt.contextTokenBudget,
      skillsSnapshot,
      entries: promptSkillEntries,
      loadEntries: async () => mapEntries(await loadSkillEntries()) ?? [],
      config: params.attempt.config,
      workspaceDir: skillsPromptWorkspaceDir,
      agentId: params.sessionAgentId,
      eligibility: skillsEligibility,
      preserveEntryOrder,
    });
    const libraryEntries = params.sandbox?.enabled
      ? []
      : await prepareSkillLibrarySelection(
          skillsSnapshot.librarySelections ?? [],
          {},
          params.assertCurrent ?? (() => {}),
        );
    params.assertCurrent?.();
    // Preparation may yield to abort/revocation. Apply process-wide overrides only
    // once all filesystem work has settled and this caller can take custody.
    restoreSkillEnv =
      params.applySkillEnvironment === false
        ? () => {}
        : preparedSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: preparedSnapshot,
              config: params.attempt.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries,
              config: params.attempt.config,
            });
    const installedSkills = prepareInstalledSkillCatalog({
      snapshot: skillsSnapshot,
      workspaceDir: skillsWorkspaceDir,
      sandbox: params.sandbox,
      assertCurrent: params.assertCurrent,
    });
    const codeModeSkills = params.includeCodeModeSkills ? installedSkills : [];
    // Host read exceptions use exact eligible resources without changing model visibility.
    // Sandboxes keep their existing materialized paths; never resolve host library pins there.
    const skillReadResources = params.sandbox?.enabled
      ? undefined
      : resolveSkillResourceCandidates(skillsSnapshot, libraryEntries);
    return {
      restoreSkillEnv,
      skillReadResources,
      skillUsagePaths,
      skillsPrompt,
      skillsSnapshotForRun: skillsSnapshot,
      codeModeSkills,
      installedSkills,
    };
  } catch (error) {
    restoreSkillEnv();
    throw error;
  }
}
