import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
} from "../../plugin-sdk/browser-control-auth.js";
import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  resolveBrowserConfig,
} from "../../plugin-sdk/browser-profiles.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyRuntimeNamedExport } from "../../shared/lazy-runtime.js";
import { prepareRemoteSkillConnections } from "../../skills/runtime/remote-skills.js";
import type { SkillEligibilityContext, SkillSnapshot, SkillUsagePath } from "../../skills/types.js";
import {
  readAdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { resolveAgentConfig } from "../agent-scope-config.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import {
  resolveSubagentSessionAttachmentRootDir,
  SANDBOX_SUBAGENT_ATTACHMENTS_MOUNT,
} from "../subagents/subagent-attachment-paths.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { ensureSandboxWorkspace } from "../workspace.js";
import {
  timeWorktreePreparationPhase,
  withWorktreePreparationTiming,
} from "../worktrees/preparation-timing.js";
import { createSandboxBackend, getSandboxBackendWorkdirResolver } from "./backend.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { SANDBOX_GITHUB_CONFIG_DIR } from "./constants.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { hashTextSha256 } from "./hash.js";
import { toSandboxProvisioningError } from "./provisioning-error.js";
import { readRegisteredSandboxRuntimeIds } from "./registry.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { assertSshSandboxSecretOwnerAvailable } from "./secret-owner.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";
import { captureSandboxStateOwner, SandboxStateOwnerRequiredError } from "./state-owner.js";
import type { SandboxContext, SandboxWorkspaceInfo } from "./types.js";

const sandboxLog = createSubsystemLogger("agent/sandbox");

const loadSyncWorkspaceSkills = createLazyRuntimeNamedExport(
  () => import("../../skills/loading/workspace-skill-sync.runtime.js"),
  "syncWorkspaceSkills",
);

async function syncSandboxSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  agentId: string;
  rawSessionKey: string;
  execOverrides?: ExecPolicyOverrides;
  skillsSnapshot?: SkillSnapshot;
  assertCurrent?: () => void;
}): Promise<{ eligibility?: SkillEligibilityContext; skillUsagePaths?: SkillUsagePath[] }> {
  try {
    const [syncWorkspaceSkills, { getRemoteSkillEligibility }, { resolveNodeExecEligibility }] =
      await Promise.all([
        loadSyncWorkspaceSkills(),
        import("../../skills/runtime/remote.js"),
        import("../exec-defaults.js"),
      ]);
    params.assertCurrent?.();
    await prepareRemoteSkillConnections();
    params.assertCurrent?.();
    const nodeSkills = resolveNodeExecEligibility({
      cfg: params.config,
      sessionKey: params.rawSessionKey,
      agentId: params.agentId,
      execOverrides: params.execOverrides,
    });
    const eligibility: SkillEligibilityContext = {
      nodeSkills,
      remote: getRemoteSkillEligibility({
        advertiseExecNode: nodeSkills.canExec,
      }),
    };
    const skillUsagePaths = await syncWorkspaceSkills({
      sourceWorkspaceDir: params.sourceWorkspaceDir,
      targetWorkspaceDir: params.targetWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility,
      skillsSnapshot: params.skillsSnapshot,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    return { eligibility, skillUsagePaths };
  } catch (error) {
    params.assertCurrent?.();
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
    if (params.skillsSnapshot?.librarySelections?.length) {
      throw error;
    }
    return {};
  }
}

async function ensureSandboxWorkspaceLayout(
  params: ResolveSandboxContextParams,
  selected: Awaited<ReturnType<typeof prepareSandboxWorkspaceSelection>>,
  guard?: WorkspaceStateGuard,
): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  skillsWorkspaceDir: string;
  skillsEligibility?: SkillEligibilityContext;
  skillUsagePaths?: SkillUsagePath[];
  workspaceDir: string;
}> {
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
  if (cfg.workspaceAccess !== "rw") {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
      params.config?.agents?.defaults?.skipOptionalBootstrapFiles,
      guard,
    );
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }
  assertCurrent?.();
  const syncedSkills = await syncSandboxSkillsToWorkspace({
    sourceWorkspaceDir: agentWorkspaceDir,
    targetWorkspaceDir: cfg.workspaceAccess === "rw" ? skillsWorkspaceDir : sandboxWorkspaceDir,
    config: params.config,
    agentId: runtime.agentId,
    rawSessionKey,
    execOverrides: params.execOverrides,
    skillsSnapshot: params.skillsSnapshot,
    assertCurrent,
  });

  return {
    agentWorkspaceDir,
    scopeKey,
    skillsWorkspaceDir,
    ...(syncedSkills.eligibility ? { skillsEligibility: syncedSkills.eligibility } : {}),
    ...(syncedSkills.skillUsagePaths ? { skillUsagePaths: syncedSkills.skillUsagePaths } : {}),
    workspaceDir,
  };
}

function resolveSandboxSession(params: {
  skillsSnapshot?: SkillSnapshot;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  preparedRuntimeStatus?: ReturnType<typeof resolveSandboxRuntimeStatus>;
}) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = params.preparedRuntimeStatus
    ? { ...params.preparedRuntimeStatus }
    : resolveSandboxRuntimeStatus({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: rawSessionKey,
      });
  if (!runtime.sandboxed) {
    return null;
  }

  const configured = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  const sessionAttachmentRoot = resolveSubagentSessionAttachmentRootDir({
    agentId: runtime.agentId,
    childSessionKey: rawSessionKey,
  });
  // An attachment grant is session-owned. Give the child a dedicated runtime
  // even when ordinary agent-scoped turns share one, so no sibling guest can
  // inherit this session's protected projection.
  try {
    if (fsSync.statSync(sessionAttachmentRoot).isDirectory()) {
      runtime.isolationSubject = { kind: "session", sessionKey: rawSessionKey };
    }
  } catch {
    // No attachment grant for this session.
  }
  const librarySelections = params.skillsSnapshot?.librarySelections;
  // Shared/agent sandboxes cannot expose one person's private bundles to another session,
  // or replace bytes under an active revision. Selection changes get a separate runtime.
  if (librarySelections?.length) {
    runtime.isolationSubject = {
      kind: "session",
      sessionKey: `${rawSessionKey}:skills:${hashTextSha256(JSON.stringify(librarySelections))}`,
    };
  }
  const configuredSandbox = librarySelections?.length
    ? { ...configured, scope: "agent" as const }
    : configured;
  if (!runtime.sandboxRequired) {
    return { rawSessionKey, runtime, cfg: configuredSandbox };
  }
  // Docker and browser backends replace shared scope keys with a literal name;
  // agent scope lets the prepared isolation subject own every sandbox resource.
  const cfg = {
    ...configuredSandbox,
    scope: "agent" as const,
    workspaceAccess: runtime.workspaceAccess,
  };
  return { rawSessionKey, runtime, cfg };
}

type ResolveSandboxContextParams = {
  config?: OpenClawConfig;
  agentId?: string;
  execOverrides?: ExecPolicyOverrides;
  requireCurrentConfig?: boolean;
  assertCurrent?: () => void;
  admittedRunContext?: AdmittedRunContext;
  sessionKey?: string;
  skillsSnapshot?: SkillSnapshot;
  workspaceDir?: string;
  /** Classification already prepared for this session's workspace setup. */
  preparedRuntimeStatus?: ReturnType<typeof resolveSandboxRuntimeStatus>;
};

type ResolvedSandboxSession = NonNullable<ReturnType<typeof resolveSandboxSession>>;

function assertSandboxSessionSecretOwnerAvailable(
  config: OpenClawConfig | undefined,
  resolved: ResolvedSandboxSession,
): void {
  if (resolved.cfg.backend !== "ssh") {
    return;
  }
  // Never let an unresolved inline SSH credential silently fall through to
  // ambient host SSH identities for this agent.
  assertSshSandboxSecretOwnerAvailable({
    config,
    scope: resolved.cfg.scope,
    agentId: resolved.runtime.agentId,
  });
}

async function prepareSandboxWorkspaceSelection(
  params: ResolveSandboxContextParams,
  resolved: ResolvedSandboxSession,
) {
  const { rawSessionKey, runtime } = resolved;
  const localWorkspace = params.config
    ? await (
        await import("./local-workspace.js")
      ).prepareLocalSandboxWorkspace({
        cfg: params.config,
        agentId: runtime.agentId,
        sessionKey: rawSessionKey,
        workspaceDir: params.workspaceDir,
        sandbox: resolved.cfg,
        signal: readAdmittedRunOperatorAuthority(params.admittedRunContext)?.signal,
        assertCurrent: params.assertCurrent,
      })
    : undefined;
  const cfg = localWorkspace
    ? {
        ...resolved.cfg,
        scope: "session" as const,
        workspaceAccess:
          resolveSandboxConfigForAgent(params.config, runtime.agentId).workspaceAccess === "ro"
            ? ("ro" as const)
            : ("rw" as const),
      }
    : resolved.cfg;

  if (
    !localWorkspace &&
    runtime.sandboxRequired &&
    resolveSandboxConfigForAgent(params.config, runtime.agentId).workspaceAccess === "rw"
  ) {
    sandboxLog.warn(
      'Configured sandbox workspaceAccess "rw" is capped to "ro" for a role-required session; guests cannot share the writable agent workspace.',
    );
  }
  return { rawSessionKey, runtime, cfg, localWorkspace };
}

async function resolveProvisionedSandboxContext(
  params: ResolveSandboxContextParams,
  resolved: ResolvedSandboxSession,
  guard?: WorkspaceStateGuard,
): Promise<SandboxContext> {
  const selected = await prepareSandboxWorkspaceSelection(params, resolved);
  params.assertCurrent?.();
  const { rawSessionKey, runtime, cfg, localWorkspace } = selected;
  const config = params.config;
  const allowGitHub =
    config && resolveAgentConfig(config, runtime.agentId)?.tools?.github?.allowInSandbox === true;
  if (allowGitHub && cfg.scope === "shared") {
    const message = `GitHub identity for agent "${runtime.agentId}" cannot enter a shared sandbox; use agent or session scope.`;
    sandboxLog.warn(message);
    throw new Error(message);
  }
  const githubIdentity = allowGitHub
    ? (await import("../github-tool-identity.js")).prepareGitHubToolEnvironment({
        config,
        agentId: runtime.agentId,
      })
    : undefined;
  const githubMount = githubIdentity
    ? await (async () => {
        const hostPath = githubIdentity.localIdentityEnv.GH_CONFIG_DIR;
        const stat = hostPath ? await fs.lstat(hostPath).catch(() => undefined) : undefined;
        if (!hostPath || !stat?.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(
            "Sandbox GitHub identity profile is unavailable; reconnect GitHub Identity.",
          );
        }
        return { hostPath: await fs.realpath(hostPath), containerPath: SANDBOX_GITHUB_CONFIG_DIR };
      })()
    : undefined;
  if (cfg.prune.idleHours !== 0 || cfg.prune.maxAgeDays !== 0) {
    await (
      await import("./prune.js")
    ).maybePruneSandboxes(undefined, params.assertCurrent, guard?.assertHost);
  }

  const {
    agentWorkspaceDir,
    scopeKey,
    skillsEligibility,
    skillUsagePaths,
    skillsWorkspaceDir,
    workspaceDir,
  } = await timeWorktreePreparationPhase("workspaceLayout", () =>
    ensureSandboxWorkspaceLayout(params, selected, guard),
  );
  localWorkspace?.assertCurrent();

  const docker = await resolveSandboxDockerUser({
    backend: cfg.backend,
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };
  const executionCfg = githubIdentity
    ? {
        ...resolvedCfg,
        docker: {
          ...docker,
          env: {
            ...docker.env,
            ...githubIdentity.credentialScrubEnv,
            ...githubIdentity.localIdentityEnv,
            GH_CONFIG_DIR: SANDBOX_GITHUB_CONFIG_DIR,
          },
        },
      }
    : resolvedCfg;
  let readOnlyResourceMounts =
    resolvedCfg.scope === "shared"
      ? undefined
      : await (async () => {
          const hostPath = resolveSubagentSessionAttachmentRootDir({
            agentId: runtime.agentId,
            childSessionKey: rawSessionKey,
          });
          try {
            if (!(await fs.stat(hostPath)).isDirectory()) {
              return undefined;
            }
            return [
              {
                hostPath: await fs.realpath(hostPath),
                containerPath: SANDBOX_SUBAGENT_ATTACHMENTS_MOUNT,
              },
            ];
          } catch {
            return undefined;
          }
        })();
  if (githubMount) {
    (readOnlyResourceMounts ??= []).push(githubMount);
  }

  const registeredRuntimeIds = await readRegisteredSandboxRuntimeIds({
    backendId: resolvedCfg.backend,
    scopeKey,
  });
  const provisionBackend = () => {
    params.assertCurrent?.();
    return createSandboxBackend(
      {
        sessionKey: rawSessionKey,
        scopeKey,
        ...(registeredRuntimeIds.length > 0 ? { registeredRuntimeIds } : {}),
        workspaceDir,
        ...(localWorkspace
          ? {
              workspaceSource: "managed-worktree" as const,
            }
          : {}),
        assertRuntimeCurrent: localWorkspace?.assertCurrent ?? params.assertCurrent,
        agentWorkspaceDir,
        skillsWorkspaceDir,
        readOnlyResourceMounts,
        cfg: executionCfg,
        ...(params.requireCurrentConfig !== undefined
          ? { requireCurrentConfig: params.requireCurrentConfig }
          : {}),
      },
      readAdmittedRunOperatorAuthority(params.admittedRunContext),
      githubIdentity,
      guard,
    );
  };

  const backend = await timeWorktreePreparationPhase("containerStart", () =>
    localWorkspace ? localWorkspace.provision(provisionBackend) : provisionBackend(),
  );
  params.assertCurrent?.();

  const resolvedBrowserConfig = resolvedCfg.browser.enabled
    ? resolveBrowserConfig(params.config?.browser, params.config)
    : undefined;
  const evaluateEnabled =
    resolvedBrowserConfig?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  const bridgeAuth = cfg.browser.enabled
    ? await (async () => {
        // Sandbox browser bridge server runs on a loopback TCP port; always wire up
        // the same auth that loopback browser clients will send (token/password).
        const cfgForAuth =
          params.config ?? (await import("../../config/config.js")).getRuntimeConfig();
        let browserAuth = resolveBrowserControlAuth(cfgForAuth);
        try {
          params.assertCurrent?.();
          const ensured = await ensureBrowserControlAuth({ cfg: cfgForAuth });
          params.assertCurrent?.();
          browserAuth = ensured.auth;
        } catch (error) {
          params.assertCurrent?.();
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
        }
        return browserAuth;
      })()
    : undefined;
  if (resolvedCfg.browser.enabled && backend.capabilities?.browser !== true) {
    throw new Error(`Sandbox backend "${backend.id}" does not support browser sandboxes yet.`);
  }
  const browser =
    resolvedCfg.browser.enabled && backend.capabilities?.browser === true
      ? await ensureSandboxBrowser({
          scopeKey,
          workspaceDir,
          agentWorkspaceDir,
          skillsWorkspaceDir,
          cfg: resolvedCfg,
          evaluateEnabled,
          bridgeAuth,
          ssrfPolicy: resolvedBrowserConfig?.ssrfPolicy,
          withWorkspace: localWorkspace?.provision,
          assertCurrent: localWorkspace?.assertCurrent ?? params.assertCurrent,
        })
      : null;

  const sandboxContext: SandboxContext & { backend: typeof backend } = {
    enabled: true,
    ...(runtime.sandboxRequired ? { required: true } : {}),
    ...(localWorkspace
      ? { workspaceSource: "managed-worktree" as const, workspaceCwd: localWorkspace.workspaceCwd }
      : {}),
    backendId: backend.id,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
    ...(skillsEligibility ? { skillsEligibility } : {}),
    ...(skillUsagePaths ? { skillUsagePaths } : {}),
    ...(readOnlyResourceMounts ? { readOnlyResourceMounts } : {}),
    workspaceAccess: resolvedCfg.workspaceAccess,
    runtimeId: backend.runtimeId,
    runtimeLabel: backend.runtimeLabel,
    containerName: backend.runtimeId,
    containerWorkdir: backend.workdir,
    docker: executionCfg.docker,
    tools: resolvedCfg.tools,
    browserAllowHostControl: resolvedCfg.browser.allowHostControl,
    browser: browser ?? undefined,
    backend,
  };

  sandboxContext.fsBridge =
    backend.createFsBridge?.({ sandbox: sandboxContext }) ??
    createSandboxFsBridge({ sandbox: sandboxContext });

  if (localWorkspace) {
    localWorkspace.assertCurrent();
    (await import("./local-workspace.js")).bindLocalSandboxWorkspace(
      sandboxContext,
      localWorkspace,
    );
  }
  return sandboxContext;
}

export async function resolveSandboxContext(
  params: ResolveSandboxContextParams,
): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const assertStateOwner = await captureSandboxStateOwner();
  const assertCallerCurrent = params.assertCurrent;
  const assertCurrent = () => {
    assertStateOwner();
    assertCallerCurrent?.();
    assertStateOwner();
  };
  const ownedParams = { ...params, assertCurrent };
  // Once a sandbox session is selected, every remaining step is local
  // provisioning. Preserve that owner boundary across backend, browser,
  // registry, and filesystem-bridge setup so model fallback never retries it.
  try {
    assertSandboxSessionSecretOwnerAvailable(params.config, resolved);
    const context = await withWorktreePreparationTiming("sandbox", () =>
      resolveProvisionedSandboxContext(ownedParams, resolved, {
        assertHost: assertStateOwner,
        beforeLegacyApply: assertCurrent,
      }),
    );
    assertStateOwner();
    return context;
  } catch (error) {
    if (error instanceof SandboxStateOwnerRequiredError) {
      throw error;
    }
    throw toSandboxProvisioningError(error, resolved.cfg.backend);
  }
}

export async function ensureSandboxWorkspaceForSession(params: {
  skillsSnapshot?: SkillSnapshot;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  assertSandboxSessionSecretOwnerAvailable(params.config, resolved);
  const selected = await prepareSandboxWorkspaceSelection(params, resolved);
  const { rawSessionKey, cfg } = selected;

  const { agentWorkspaceDir, scopeKey, workspaceDir, ...workspace } =
    await ensureSandboxWorkspaceLayout(params, selected);

  const containerWorkdir = getSandboxBackendWorkdirResolver(cfg.backend)?.({
    cfg,
    sessionKey: rawSessionKey,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir: workspace.skillsWorkspaceDir,
  });
  return {
    workspaceDir,
    ...(containerWorkdir ? { containerWorkdir } : {}),
    ...workspace,
    workspaceAccess: cfg.workspaceAccess,
  };
}
