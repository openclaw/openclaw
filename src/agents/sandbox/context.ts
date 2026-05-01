import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
} from "../../plugin-sdk/browser-control-auth.js";
import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  resolveBrowserConfig,
} from "../../plugin-sdk/browser-profiles.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { requireSandboxBackendFactory } from "./backend.js";
import { ensureSandboxBrowser, resolveSandboxBrowserContainerName } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { updateRegistry } from "./registry.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir, slugifySessionKey } from "./shared.js";
import type { SandboxContext, SandboxDockerConfig, SandboxWorkspaceInfo } from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveEphemeralScopeKey(params: { scopeKey: string; runId?: string }): string {
  const runId = params.runId?.trim();
  if (!runId) {
    return params.scopeKey;
  }
  return `${params.scopeKey}:run:${slugifySessionKey(runId)}`;
}

async function removeEphemeralWorkspace(params: {
  workspaceRoot: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
}) {
  const workspaceRoot = path.resolve(params.workspaceRoot);
  const workspaceDir = path.resolve(params.workspaceDir);
  const agentWorkspaceDir = path.resolve(params.agentWorkspaceDir);
  if (
    workspaceDir === workspaceRoot ||
    workspaceDir === agentWorkspaceDir ||
    !isPathWithinRoot(workspaceRoot, workspaceDir)
  ) {
    defaultRuntime.error?.(
      `Refusing to remove unsafe ephemeral sandbox workspace: ${workspaceDir}`,
    );
    return;
  }
  await fs.rm(workspaceDir, { recursive: true, force: true });
}

function createEphemeralSandboxCleanup(params: {
  backendId: string;
  runtimeId: string;
  scopeKey: string;
  browserContainerName?: string;
  workspaceRoot: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
}): () => Promise<void> {
  let cleaned = false;
  return async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    const errors: string[] = [];
    try {
      const { removeSandboxBrowserContainer, removeSandboxContainer } = await import("./manage.js");
      if (params.browserContainerName) {
        await removeSandboxBrowserContainer(params.browserContainerName, {
          forceUnregistered: true,
          sessionKey: params.scopeKey,
        });
      }
      await removeSandboxContainer(params.runtimeId, {
        fallbackBackendId: params.backendId,
        forceUnregistered: true,
        sessionKey: params.scopeKey,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await removeEphemeralWorkspace(params);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (errors.length > 0) {
      defaultRuntime.error?.(`Ephemeral sandbox cleanup failed: ${errors.join("; ")}`);
    }
  };
}

type SandboxWorkspaceLayout = {
  agentWorkspaceDir: string;
  ephemeral: boolean;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  workspaceRoot: string;
  workspaceDir: string;
};

function resolveSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  rawSessionKey: string;
  workspaceDir?: string;
  runId?: string;
}): SandboxWorkspaceLayout {
  const { cfg, rawSessionKey } = params;

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const baseScopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const ephemeral = cfg.workspaceLifecycle === "ephemeral" && Boolean(params.runId?.trim());
  const scopeKey = ephemeral
    ? resolveEphemeralScopeKey({ scopeKey: baseScopeKey, runId: params.runId })
    : baseScopeKey;
  const sandboxWorkspaceDir =
    cfg.scope === "shared" && !ephemeral
      ? workspaceRoot
      : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir =
    cfg.workspaceAccess === "rw" && !ephemeral ? agentWorkspaceDir : sandboxWorkspaceDir;

  return {
    agentWorkspaceDir,
    ephemeral,
    scopeKey,
    sandboxWorkspaceDir,
    workspaceRoot,
    workspaceDir,
  };
}

async function prepareSandboxWorkspaceLayout(
  layout: SandboxWorkspaceLayout,
  params: {
    cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
    agentId: string;
    rawSessionKey: string;
    config?: OpenClawConfig;
  },
) {
  const { cfg, rawSessionKey } = params;
  const { agentWorkspaceDir, sandboxWorkspaceDir, workspaceDir } = layout;

  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
      params.config?.agents?.defaults?.skipOptionalBootstrapFiles,
    );
    if (cfg.workspaceAccess !== "rw") {
      try {
        const [{ getRemoteSkillEligibility }, { canExecRequestNode }, { syncSkillsToWorkspace }] =
          await Promise.all([
            import("../../infra/skills-remote.js"),
            import("../exec-defaults.js"),
            import("../skills.js"),
          ]);
        await syncSkillsToWorkspace({
          sourceWorkspaceDir: agentWorkspaceDir,
          targetWorkspaceDir: sandboxWorkspaceDir,
          config: params.config,
          agentId: params.agentId,
          eligibility: {
            remote: getRemoteSkillEligibility({
              advertiseExecNode: canExecRequestNode({
                cfg: params.config,
                sessionKey: rawSessionKey,
                agentId: params.agentId,
              }),
            }),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
      }
    }
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }
}

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  agentId: string;
  rawSessionKey: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  runId?: string;
}): Promise<SandboxWorkspaceLayout> {
  const layout = resolveSandboxWorkspaceLayout(params);
  await prepareSandboxWorkspaceLayout(layout, params);
  return layout;
}

export async function resolveSandboxDockerUser(params: {
  docker: SandboxDockerConfig;
  workspaceDir: string;
  stat?: (workspaceDir: string) => Promise<{ uid: number; gid: number }>;
}): Promise<SandboxDockerConfig> {
  const configuredUser = params.docker.user?.trim();
  if (configuredUser) {
    return params.docker;
  }
  const stat = params.stat ?? ((workspaceDir: string) => fs.stat(workspaceDir));
  try {
    const workspaceStat = await stat(params.workspaceDir);
    const uid = Number.isInteger(workspaceStat.uid) ? workspaceStat.uid : null;
    const gid = Number.isInteger(workspaceStat.gid) ? workspaceStat.gid : null;
    if (uid === null || gid === null || uid < 0 || gid < 0) {
      return params.docker;
    }
    return { ...params.docker, user: `${uid}:${gid}` };
  } catch {
    return params.docker;
  }
}

function resolveSandboxSession(params: { config?: OpenClawConfig; sessionKey?: string }) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: rawSessionKey,
  });
  if (!runtime.sandboxed) {
    return null;
  }

  const cfg = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  return { rawSessionKey, runtime, cfg };
}

export async function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  runId?: string;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg, runtime } = resolved;

  if (cfg.prune.idleHours !== 0 || cfg.prune.maxAgeDays !== 0) {
    await (await import("./prune.js")).maybePruneSandboxes(cfg);
  }

  const layout = resolveSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    runId: params.runId,
    workspaceDir: params.workspaceDir,
  });
  const { agentWorkspaceDir, ephemeral, scopeKey, workspaceDir, workspaceRoot } = layout;

  let ephemeralCleanup: (() => Promise<void>) | undefined;
  try {
    await prepareSandboxWorkspaceLayout(layout, {
      cfg,
      agentId: runtime.agentId,
      rawSessionKey,
      config: params.config,
    });

    const docker = await resolveSandboxDockerUser({
      docker: cfg.docker,
      workspaceDir,
    });
    const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

    const backendFactory = requireSandboxBackendFactory(resolvedCfg.backend);
    const backend = await backendFactory({
      sessionKey: rawSessionKey,
      scopeKey,
      workspaceDir,
      agentWorkspaceDir,
      cfg: resolvedCfg,
    });
    if (ephemeral) {
      ephemeralCleanup = createEphemeralSandboxCleanup({
        backendId: backend.id,
        runtimeId: backend.runtimeId,
        scopeKey,
        workspaceRoot,
        workspaceDir,
        agentWorkspaceDir,
      });
    }
    await updateRegistry({
      containerName: backend.runtimeId,
      backendId: backend.id,
      runtimeLabel: backend.runtimeLabel,
      sessionKey: scopeKey,
      createdAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
      image: backend.configLabel ?? resolvedCfg.docker.image,
      configLabelKind: backend.configLabelKind ?? "Image",
    });

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
            const ensured = await ensureBrowserControlAuth({ cfg: cfgForAuth });
            browserAuth = ensured.auth;
          } catch (error) {
            const message = error instanceof Error ? error.message : JSON.stringify(error);
            defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
          }
          return browserAuth;
        })()
      : undefined;
    if (resolvedCfg.browser.enabled && backend.capabilities?.browser !== true) {
      throw new Error(
        `Sandbox backend "${resolvedCfg.backend}" does not support browser sandboxes yet.`,
      );
    }
    const browserContainerName =
      resolvedCfg.browser.enabled && backend.capabilities?.browser === true
        ? resolveSandboxBrowserContainerName({ scopeKey, cfg: resolvedCfg })
        : undefined;
    if (ephemeral) {
      ephemeralCleanup = createEphemeralSandboxCleanup({
        backendId: backend.id,
        runtimeId: backend.runtimeId,
        scopeKey,
        browserContainerName,
        workspaceRoot,
        workspaceDir,
        agentWorkspaceDir,
      });
    }
    const browser =
      resolvedCfg.browser.enabled && backend.capabilities?.browser === true
        ? await ensureSandboxBrowser({
            scopeKey,
            workspaceDir,
            agentWorkspaceDir,
            cfg: resolvedCfg,
            evaluateEnabled,
            bridgeAuth,
            ssrfPolicy: resolvedBrowserConfig?.ssrfPolicy,
          })
        : null;
    if (ephemeral) {
      ephemeralCleanup = createEphemeralSandboxCleanup({
        backendId: backend.id,
        runtimeId: backend.runtimeId,
        scopeKey,
        browserContainerName: browser?.containerName,
        workspaceRoot,
        workspaceDir,
        agentWorkspaceDir,
      });
    }

    const sandboxContext: SandboxContext = {
      enabled: true,
      backendId: backend.id,
      sessionKey: rawSessionKey,
      workspaceDir,
      agentWorkspaceDir,
      workspaceAccess: resolvedCfg.workspaceAccess,
      runtimeId: backend.runtimeId,
      runtimeLabel: backend.runtimeLabel,
      containerName: backend.runtimeId,
      containerWorkdir: backend.workdir,
      docker: resolvedCfg.docker,
      tools: resolvedCfg.tools,
      browserAllowHostControl: resolvedCfg.browser.allowHostControl,
      browser: browser ?? undefined,
      backend,
      cleanup: ephemeralCleanup,
    };

    sandboxContext.fsBridge =
      backend.createFsBridge?.({ sandbox: sandboxContext }) ??
      createSandboxFsBridge({ sandbox: sandboxContext });

    return sandboxContext;
  } catch (error) {
    if (ephemeralCleanup) {
      await ephemeralCleanup();
    } else if (ephemeral) {
      await removeEphemeralWorkspace({ workspaceRoot, workspaceDir, agentWorkspaceDir }).catch(
        (cleanupError) => {
          const message =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          defaultRuntime.error?.(`Ephemeral sandbox workspace cleanup failed: ${message}`);
        },
      );
    }
    throw error;
  }
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg, runtime } = resolved;

  const { workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    agentId: runtime.agentId,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  return {
    workspaceDir,
    containerWorkdir: cfg.docker.workdir,
  };
}
