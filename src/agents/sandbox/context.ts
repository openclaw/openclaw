import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BROWSER_EVALUATE_ENABLED } from "../../browser/constants.js";
import { ensureBrowserControlAuth, resolveBrowserControlAuth } from "../../browser/control-auth.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig, STATE_DIR } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { syncSkillsToWorkspace } from "../skills.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { ensureSandboxContainer } from "./docker.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { maybePruneSandboxes } from "./prune.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { createSeatbeltFsBridge } from "./seatbelt-fs-bridge.js";
import { ensureSeatbeltDemoProfiles, SEATBELT_DEMO_PROFILE_NAMES } from "./seatbelt-profiles.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";
import type {
  SandboxContext,
  SandboxDockerConfig,
  SandboxSeatbeltContext,
  SandboxWorkspaceInfo,
} from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

const SEATBELT_PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]+(?:\.sb)?$/;

const RESERVED_SEATBELT_PARAM_KEYS = new Set([
  "PROJECT_DIR",
  "WORKSPACE_DIR",
  "STATE_DIR",
  "AGENT_ID",
  "SEATBELT_PROFILE_DIR",
  "WORKSPACE_ACCESS",
  "TMPDIR",
]);

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
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

async function resolveSeatbeltContextConfig(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  workspaceDir: string;
  agentWorkspaceDir: string;
  agentId: string;
}): Promise<SandboxSeatbeltContext | undefined> {
  if (params.cfg.backend !== "seatbelt") {
    return undefined;
  }
  const rawProfile = params.cfg.seatbelt.profile?.trim();
  if (!rawProfile) {
    return undefined;
  }
  if (
    rawProfile.includes("/") ||
    rawProfile.includes("\\") ||
    rawProfile.includes("..") ||
    !SEATBELT_PROFILE_NAME_PATTERN.test(rawProfile)
  ) {
    throw new Error(
      `Invalid seatbelt profile "${rawProfile}". Profile names must not contain path separators or ".." segments.`,
    );
  }
  const profile = rawProfile.endsWith(".sb") ? rawProfile.slice(0, -3) : rawProfile;
  const profileFile = `${profile}.sb`;
  const profilePath = path.join(params.cfg.seatbelt.profileDir, profileFile);

  const getProfileState = async (): Promise<"ok" | "missing" | "unreadable"> => {
    try {
      await fs.access(profilePath, fsConstants.R_OK);
      return "ok";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code === "ENOENT" ? "missing" : "unreadable";
    }
  };

  const unreadableMessage =
    `Seatbelt profile "${profile}" exists but is not readable at ${profilePath}. ` +
    "Check file ownership and permissions.";

  const initialState = await getProfileState();
  if (initialState !== "ok") {
    if (initialState === "unreadable") {
      throw new Error(unreadableMessage);
    }

    const isDemoProfile = SEATBELT_DEMO_PROFILE_NAMES.includes(
      profile as (typeof SEATBELT_DEMO_PROFILE_NAMES)[number],
    );
    let ensureError: unknown;

    if (isDemoProfile) {
      try {
        await ensureSeatbeltDemoProfiles({
          profileDir: params.cfg.seatbelt.profileDir,
        });
      } catch (error) {
        ensureError = error;
      }
    }

    const finalState = await getProfileState();
    if (finalState !== "ok") {
      if (finalState === "unreadable") {
        throw new Error(unreadableMessage);
      }

      const help =
        `Seatbelt profile "${profile}" not found at ${profilePath}. ` +
        "Set sandbox.seatbelt.profile/profileDir to an existing profile, or run `openclaw doctor`.";
      if (ensureError) {
        const message = ensureError instanceof Error ? ensureError.message : String(ensureError);
        const wrapped = new Error(help + ` Auto-install attempt failed: ${message}.`);
        (wrapped as Error & { cause?: unknown }).cause = ensureError;
        throw wrapped;
      }
      if (isDemoProfile) {
        throw new Error(help + " Demo profile auto-install was attempted but profile is still missing.");
      }
      throw new Error(help);
    }
  }

  const defaults = {
    PROJECT_DIR: params.workspaceDir,
    WORKSPACE_DIR: params.agentWorkspaceDir,
    STATE_DIR,
    AGENT_ID: params.agentId,
    SEATBELT_PROFILE_DIR: params.cfg.seatbelt.profileDir,
    WORKSPACE_ACCESS: params.cfg.workspaceAccess,
    TMPDIR: "/tmp",
  };

  const userParams = Object.fromEntries(
    Object.entries(params.cfg.seatbelt.params ?? {}).filter(
      ([key]) => !RESERVED_SEATBELT_PARAM_KEYS.has(key),
    ),
  );

  return {
    profileDir: params.cfg.seatbelt.profileDir,
    profile,
    profilePath,
    params: {
      ...userParams,
      ...defaults,
    },
  };
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
  const { rawSessionKey, cfg, runtime } = resolved;

  if (cfg.backend === "docker") {
    await maybePruneSandboxes(cfg);
  }

  const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const seatbelt = await resolveSeatbeltContextConfig({
    cfg,
    workspaceDir,
    agentWorkspaceDir,
    agentId: runtime.agentId,
  });

  if (cfg.backend === "seatbelt") {
    const sandboxContext: SandboxContext = {
      enabled: true,
      backend: "seatbelt",
      sessionKey: rawSessionKey,
      workspaceDir,
      agentWorkspaceDir,
      workspaceAccess: cfg.workspaceAccess,
      containerName: "",
      containerWorkdir: workspaceDir,
      docker: cfg.docker,
      seatbelt,
      tools: cfg.tools,
      browserAllowHostControl: cfg.browser.allowHostControl,
    };

    sandboxContext.fsBridge = createSeatbeltFsBridge({ sandbox: sandboxContext });

    return sandboxContext;
  }

  const docker = await resolveSandboxDockerUser({
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
  });

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
  const browser = await ensureSandboxBrowser({
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
    evaluateEnabled,
    bridgeAuth,
  });

  const sandboxContext: SandboxContext = {
    enabled: true,
    backend: "docker",
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    workspaceAccess: resolvedCfg.workspaceAccess,
    containerName,
    containerWorkdir: resolvedCfg.docker.workdir,
    docker: resolvedCfg.docker,
    seatbelt,
    tools: resolvedCfg.tools,
    browserAllowHostControl: resolvedCfg.browser.allowHostControl,
    browser: browser ?? undefined,
  };

  sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });

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
  const { rawSessionKey, cfg } = resolved;

  const { workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  return {
    backend: cfg.backend,
    workspaceDir,
    containerWorkdir: cfg.backend === "seatbelt" ? workspaceDir : cfg.docker.workdir,
  };
}
