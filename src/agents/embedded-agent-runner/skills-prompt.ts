import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import type { SkillEntry } from "../../skills/types.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

type RuntimeSkillsPromptParams = Parameters<typeof resolveSandboxSkillRuntimeInputs>[0] &
  Pick<
    Parameters<typeof resolveEmbeddedRunSkillEntries>[0],
    "config" | "agentId" | "assertCurrent" | "executionWorkspaceDir" | "executionWorkspaceFileHost"
  >;

export async function prepareRuntimeSkillEntries(params: RuntimeSkillsPromptParams) {
  const inputs = resolveSandboxSkillRuntimeInputs(params);
  const preparedEntries = await resolveEmbeddedRunSkillEntries({
    assertCurrent: params.assertCurrent,
    workspaceDir: inputs.skillsWorkspaceDir,
    // Sandbox fallbacks stay inside their materialized skill workspace;
    // host execution skills are not mounted there.
    ...(params.sandbox?.enabled === true
      ? {}
      : {
          executionWorkspaceDir: params.executionWorkspaceDir,
          executionWorkspaceFileHost: params.executionWorkspaceFileHost,
        }),
    config: params.config,
    agentId: params.agentId,
    eligibility: inputs.skillsEligibility,
    skillsSnapshot: inputs.skillsSnapshot,
    workspaceOnly: inputs.workspaceOnly,
  });
  return {
    ...inputs,
    ...preparedEntries,
    mapEntries: (entries: SkillEntry[] | undefined) =>
      mapSandboxSkillEntriesForPrompt({
        entries,
        skillsWorkspaceDir: inputs.skillsWorkspaceDir,
        skillsPromptWorkspaceDir: inputs.skillsPromptWorkspaceDir,
      }),
  };
}

export async function resolveRuntimeSkillsPrompt(params: RuntimeSkillsPromptParams) {
  const prepared = await prepareRuntimeSkillEntries(params);
  const promptSkillEntries = prepared.mapEntries(
    prepared.shouldLoadSkillEntries ? prepared.skillEntries : undefined,
  );
  return {
    ...(params.sandbox ? { usagePaths: prepared.skillUsagePaths } : {}),
    prompt: await resolveSkillsPrompt({
      assertCurrent: params.assertCurrent,
      skillsSnapshot: prepared.skillsSnapshot,
      entries: promptSkillEntries,
      ...(params.sandbox ? {} : { loadEntries: prepared.loadSkillEntries }),
      workspaceDir: prepared.skillsPromptWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility: prepared.skillsEligibility,
      preserveEntryOrder: prepared.preserveEntryOrder,
    }),
  };
}
