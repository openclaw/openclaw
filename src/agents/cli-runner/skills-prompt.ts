import { resolveSessionSkillExecutionWorkspace } from "../../skills/loading/workspace-skill-roots.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillUsagePath } from "../../skills/types.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { resolveRuntimeSkillsPrompt } from "../embedded-agent-runner/skills-prompt.js";
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
  return resolveRuntimeSkillsPrompt({
    sandbox: sandboxWorkspace ? { ...sandboxWorkspace, enabled: true } : undefined,
    skillsAnchorWorkspace: sandboxWorkspace?.workspaceDir ?? agentWorkspaceDir,
    skillsSnapshot,
    assertCurrent: params.assertCurrent,
    ...executionWorkspace,
    config: params.config,
    agentId: params.agentId,
  });
}
