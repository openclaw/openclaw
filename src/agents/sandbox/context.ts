import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
} from "../../plugin-sdk/browser-control-auth.js";
import { DEFAULT_BROWSER_EVALUATE_ENABLED } from "../../plugin-sdk/browser-profiles.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { canExecRequestNode } from "../exec-defaults.js";
import { syncSkillsToWorkspace } from "../skills.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { requireSandboxBackendFactory } from "./backend.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { maybePruneSandboxes } from "./prune.js";
import { updateRegistry } from "./registry.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";
import type { SandboxContext, SandboxDockerConfig, SandboxWorkspaceInfo } from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

/**
 * Default timeout for sandbox initialization (Docker container start + browser
 * setup). 60 s is generous enough for a warm container start but short enough
 * to unblock the message pipeline when Docker is hung or unreachable.
 * Operators can override this per-agent via `agents.defaults.sandbox.initTimeoutMs`
 * (for example SSH/remote backends that need a larger budget).
 */
const DEFAULT_SANDBOX_INIT_TIMEOUT_MS = 60_000;

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  agentId: string;
  rawSessionKey: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  workspaceDir: string;
}> {
  const { cfg, rawSessionKey } = params;

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;

  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
    );
    if (cfg.workspaceAccess !== "rw") {
      try {
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

  return { agentWorkspaceDir, scopeKey, sandboxWorkspaceDir, workspaceDir };
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
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }

  // Wrap sandbox initialization in a timeout to prevent a hung Docker daemon
  // from blocking the entire message processing pipeline indefinitely.
  // An AbortController is used to signal cooperative cancellation into
  // resolveSandboxContextInner so that in-flight await points stop new work
  // when the timeout fires, preventing zombie Docker child processes.
  // The timer is cleared via .finally() so it cannot keep the event loop alive
  // after initialization succeeds. timer.unref() allows the process to exit
  // cleanly if the event loop is otherwise idle.
  const configuredInitTimeout = resolved.cfg.initTimeoutMs;
  const initTimeoutMs =
    typeof configuredInitTimeout === "number" && configuredInitTimeout > 0
      ? configuredInitTimeout
      : DEFAULT_SANDBOX_INIT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `Sandbox initialization timed out after ${initTimeoutMs / 1000}s (Docker may be unresponsive)`,
      );
      defaultRuntime.error?.(err.message);
      // Abort the inner work so pending await points exit early.
      // Reuse the same Error instance for both abort reason and rejection so
      // the aborted-check path (throw abortSignal.reason) and the race-winning
      // rejection surface the same Error identity.
      controller.abort(err);
      reject(err);
    }, initTimeoutMs);
    timer.unref?.();
  });

  return Promise.race([
    resolveSandboxContextInner(resolved, params, controller.signal),
    timeoutPromise,
  ]).finally(() => {
    // Only clear the timer — do NOT abort the controller here.
    // The signal is captured by onEnsureAttachTarget in ensureSandboxBrowser
    // for future attach/restart paths; aborting it on success would
    // permanently pre-abort those operations and break browser recovery.
    // The controller is only aborted by the timeout handler on failure.
    clearTimeout(timer);
  });
}

/** Race a promise against an AbortSignal — resolves/rejects with whichever wins first. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    const reason =
      signal.reason instanceof Error ? signal.reason : new Error("Sandbox init aborted");
    return Promise.reject(reason);
  }
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const r =
            signal.reason instanceof Error ? signal.reason : new Error("Sandbox init aborted");
          reject(r);
        },
        { once: true },
      );
    }),
  ]);
}

async function resolveSandboxContextInner(
  resolved: NonNullable<ReturnType<typeof resolveSandboxSession>>,
  params: { config?: OpenClawConfig; workspaceDir?: string },
  abortSignal?: AbortSignal,
): Promise<SandboxContext> {
  const { rawSessionKey, cfg, runtime } = resolved;

  // Check abort before each major async step to provide cooperative
  // cancellation and prevent zombie Docker child processes on timeout.
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error("Sandbox init aborted");
  }

  await raceAbort(maybePruneSandboxes(cfg), abortSignal);

  const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    agentId: runtime.agentId,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const docker = await resolveSandboxDockerUser({
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error("Sandbox init aborted");
  }

  const backendFactory = requireSandboxBackendFactory(resolvedCfg.backend);
  const backend = await backendFactory({
    sessionKey: rawSessionKey,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
    abortSignal,
  });
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

  // Abort before the browser setup phase — ensureSandboxBrowser involves
  // multiple Docker operations (inspect, network create, container start,
  // CDP wait loop) and is likely the longest remaining step.
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error("Sandbox init aborted");
  }

  const evaluateEnabled =
    params.config?.browser?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  const bridgeAuth = cfg.browser.enabled
    ? await (async () => {
        // Sandbox browser bridge server runs on a loopback TCP port; always wire up
        // the same auth that loopback browser clients will send (token/password).
        const cfgForAuth = params.config ?? loadConfig();
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
  if (abortSignal?.aborted) {
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error("Sandbox init aborted");
  }

  if (resolvedCfg.browser.enabled && backend.capabilities?.browser !== true) {
    throw new Error(
      `Sandbox backend "${resolvedCfg.backend}" does not support browser sandboxes yet.`,
    );
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
          abortSignal,
        })
      : null;

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
  };

  sandboxContext.fsBridge =
    backend.createFsBridge?.({ sandbox: sandboxContext }) ??
    createSandboxFsBridge({ sandbox: sandboxContext });

  return sandboxContext;
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
