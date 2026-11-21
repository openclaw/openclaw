import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { isPathInside } from "../../infra/path-guards.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyRuntimeNamedExport } from "../../shared/lazy-runtime.js";
import { prepareSandboxMountSources } from "../../skills/runtime/refresh.js";
import { prepareRemoteSkillConnections } from "../../skills/runtime/remote-skills.js";
import type { SkillEligibilityContext, SkillSnapshot, SkillUsagePath } from "../../skills/types.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import { runWorkspaceFilesystemOperation } from "../workspace-filesystem.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { ensureSandboxWorkspace } from "../workspace.js";
import type { prepareLocalSandboxWorkspace } from "./local-workspace.js";
import { acquireSandboxRuntimeUse } from "./registry-lifecycle.js";
import type { resolveSandboxSession } from "./session-selection.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";

const loadSyncWorkspaceSkills = createLazyRuntimeNamedExport(
  () => import("../../skills/loading/workspace-skill-sync.runtime.js"),
  "syncWorkspaceSkills",
);

export async function ensureSandboxWorkspaceLayout(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    skillsSnapshot?: SkillSnapshot;
    execOverrides?: ExecPolicyOverrides;
    assertCurrent?: () => void;
  },
  selected: NonNullable<Awaited<ReturnType<typeof resolveSandboxSession>>> & {
    localWorkspace?: Awaited<ReturnType<typeof prepareLocalSandboxWorkspace>>;
  },
  guard?: WorkspaceStateGuard,
  lifetime?: DisposableStack,
): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  skillsWorkspaceDir: string;
  skillsEligibility?: SkillEligibilityContext;
  skillUsagePaths?: SkillUsagePath[];
  workspaceDir: string;
}> {
  using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.layout.workspace");
  const { rawSessionKey, runtime, localWorkspace } = selected;
  const assertCurrent = localWorkspace?.assertCurrent ?? params.assertCurrent;
  const cfg = localWorkspace ? { ...selected.cfg, workspaceAccess: "rw" as const } : selected.cfg;
  const { agentWorkspaceDir, sandboxWorkspaceDir, scopeKey, skillsWorkspaceDir, workspaceDir } =
    resolveSandboxWorkspaceLayoutPaths({
      cfg,
      rawSessionKey,
      agentId: runtime.agentId,
      isolationSubject:
        localWorkspace && runtime.isolationSubject?.kind !== "session"
          ? { kind: "session", sessionKey: rawSessionKey }
          : runtime.isolationSubject,
      workspaceDir: localWorkspace?.workspaceDir ?? params.workspaceDir,
    });

  assertCurrent?.();
  if (lifetime) {
    if (localWorkspace) {
      await localWorkspace.protectRuntimeScope(scopeKey);
    } else {
      lifetime.use(await acquireSandboxRuntimeUse({ scopeKey }));
    }
    assertCurrent?.();
  }
  if (cfg.workspaceAccess !== "rw") {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
      params.config?.agents?.defaults?.skipOptionalBootstrapFiles,
      guard,
    );
  } else {
    await runWorkspaceFilesystemOperation({ kind: "mkdir", dir: workspaceDir }, guard);
  }
  assertCurrent?.();
  const targetWorkspaceDir =
    cfg.workspaceAccess === "rw" ? skillsWorkspaceDir : sandboxWorkspaceDir;
  const { config, execOverrides, skillsSnapshot } = params;
  const agentId = runtime.agentId;
  async function syncSandboxSkillsToWorkspace(): Promise<{
    eligibility?: SkillEligibilityContext;
    skillUsagePaths?: SkillUsagePath[];
  }> {
    try {
      phases.mark("attempt.setup.sandbox.layout.skills_import");
      const [
        syncWorkspaceSkills,
        { getRemoteSkillEligibility },
        { resolveNodeExecEligibilityAsync },
      ] = await Promise.all([
        loadSyncWorkspaceSkills(),
        import("../../skills/runtime/remote.js"),
        import("../exec-defaults.js"),
      ]);
      assertCurrent?.();
      phases.mark("attempt.setup.sandbox.layout.remote_skills");
      await prepareRemoteSkillConnections();
      assertCurrent?.();
      phases.mark("attempt.setup.sandbox.layout.skill_eligibility");
      const nodeSkills = await resolveNodeExecEligibilityAsync({
        cfg: config,
        sessionKey: rawSessionKey,
        agentId,
        execOverrides,
      });
      const eligibility: SkillEligibilityContext = {
        nodeSkills,
        remote: getRemoteSkillEligibility({
          advertiseExecNode: nodeSkills.canExec,
        }),
      };
      phases.mark("attempt.setup.sandbox.layout.skills_sync");
      const skillUsagePaths = await syncWorkspaceSkills({
        sourceWorkspaceDir: agentWorkspaceDir,
        targetWorkspaceDir,
        readOnlyTarget: cfg.backend === "docker" || cfg.backend === "podman",
        config,
        agentId,
        eligibility,
        skillsSnapshot,
        assertCurrent,
        stateOwnerPath: guard?.stateOwnerPath,
      });
      assertCurrent?.();
      return { eligibility, skillUsagePaths };
    } catch (error) {
      assertCurrent?.();
      if (hasErrnoCode(error, "GATEWAY_STATE_OWNER_REQUIRED")) {
        throw error;
      }
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
      if (skillsSnapshot?.librarySelections?.length) {
        throw error;
      }
      return {};
    }
  }
  const syncedSkills = await syncSandboxSkillsToWorkspace();
  phases.mark("attempt.setup.sandbox.layout.mount_sources");
  const createdSkillMountSources = await prepareSandboxMountSources(
    {
      workspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      workdir: cfg.docker.workdir,
      workspaceAccess: cfg.workspaceAccess,
    },
    assertCurrent,
    guard?.stateOwnerPath,
  );
  if (
    localWorkspace &&
    createdSkillMountSources.some((directory) => isPathInside(workspaceDir, directory))
  ) {
    phases.mark("attempt.setup.sandbox.layout.checkpoint");
    // Finish producer-created layout before first use, so source admission does
    // not mistake protected mount directories for unsaved guest work.
    await localWorkspace.checkpoint({ knownMutation: true });
    assertCurrent?.();
  }

  return {
    agentWorkspaceDir,
    scopeKey,
    skillsWorkspaceDir,
    ...(syncedSkills.eligibility ? { skillsEligibility: syncedSkills.eligibility } : {}),
    ...(syncedSkills.skillUsagePaths ? { skillUsagePaths: syncedSkills.skillUsagePaths } : {}),
    workspaceDir,
  };
}
