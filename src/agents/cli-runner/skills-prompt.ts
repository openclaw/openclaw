import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveSessionSkillExecutionWorkspace } from "../../skills/loading/workspace-skill-roots.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillUsagePath } from "../../skills/types.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "../embedded-agent-runner/sandbox-skills.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox.js";
import type { RunCliAgentParams } from "./types.js";

export async function resolveCliSkillsPrompt(params: {
  assertCurrent: () => void;
  agentId: string;
  config: RunCliAgentParams["config"];
  sessionKey: string;
  run: Pick<RunCliAgentParams, "skillsSnapshot" | "sessionEntry">;
  workspaceDir: string;
  executionWorkspaceDir: string;
}): Promise<{ prompt: string; usagePaths?: SkillUsagePath[] }> {
  params.assertCurrent();
  const agentWorkspaceDir = resolveAgentWorkspaceDir(params.config ?? {}, params.agentId);
  const executionWorkspace = resolveSessionSkillExecutionWorkspace(
    params.run.sessionEntry?.worktree?.canonicalWorkspaceDir,
    params.executionWorkspaceDir,
  );
  const skillsSnapshot =
    params.run.skillsSnapshot ??
    (
      await resolveReusableWorkspaceSkillSnapshot({
        assertCurrent: params.assertCurrent,
        workspaceDir: agentWorkspaceDir,
        ...executionWorkspace,
        config: params.config ?? {},
        agentId: params.agentId,
        watch: false,
      })
    ).snapshot;
  params.assertCurrent();
  const sandboxWorkspace = await ensureSandboxWorkspaceForSession({
    skillsSnapshot,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  params.assertCurrent();
  const {
    skillsEligibility,
    skillUsagePaths,
    skillsPromptWorkspaceDir,
    skillsSnapshot: skillsSnapshotForRun,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: sandboxWorkspace ? { ...sandboxWorkspace, enabled: true } : undefined,
    skillsAnchorWorkspace: sandboxWorkspace?.workspaceDir ?? agentWorkspaceDir,
    skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries, loadSkillEntries, preserveEntryOrder } =
    await resolveEmbeddedRunSkillEntries({
      assertCurrent: params.assertCurrent,
      workspaceDir: skillsWorkspaceDir,
      ...(sandboxWorkspace ? {} : executionWorkspace),
      config: params.config,
      agentId: params.agentId,
      eligibility: skillsEligibility,
      skillsSnapshot: skillsSnapshotForRun,
      workspaceOnly,
    });
  const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
    entries: shouldLoadSkillEntries ? skillEntries : undefined,
    skillsWorkspaceDir,
    skillsPromptWorkspaceDir,
  });
  return {
    ...(sandboxWorkspace ? { usagePaths: skillUsagePaths } : {}),
    prompt: await resolveSkillsPrompt({
      assertCurrent: params.assertCurrent,
      skillsSnapshot: skillsSnapshotForRun,
      entries: promptSkillEntries,
      ...(sandboxWorkspace ? {} : { loadEntries: loadSkillEntries }),
      workspaceDir: skillsPromptWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility: skillsEligibility,
      preserveEntryOrder,
    }),
  };
}
