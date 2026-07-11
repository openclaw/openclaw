/**
 * Sandbox browser container lifecycle.
 *
 * Starts or reuses Chrome/noVNC containers, exposes authenticated CDP/observer URLs, and tracks browser registry state.
 */
import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { deriveDefaultBrowserCdpPortRange } from "../../config/port-defaults.js";
import { isSameSsrFPolicy, type SsrFPolicy } from "../../infra/net/ssrf.js";
import {
  startBrowserBridgeServer,
  stopBrowserBridgeServer,
} from "../../plugin-sdk/browser-bridge.js";
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  resolveProfile,
  type ResolvedBrowserConfig,
} from "../../plugin-sdk/browser-profiles.js";
import { defaultRuntime } from "../../runtime.js";
import {
  acquireSandboxActivity,
  type SandboxActivityLease,
  tryAcquireSandboxActivity,
  withSandboxIdleMutation,
} from "./activity.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { computeSandboxBrowserConfigHash } from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig } from "./config.js";
import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
  SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
  SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
} from "./constants.js";
import {
  buildSandboxCreateArgs,
  dockerContainerState,
  execDocker,
  formatDockerDaemonUnavailableError,
  isDockerDaemonUnavailable,
  readDockerContainerEnvVar,
  readDockerContainerLabel,
  readDockerPort,
  resolveDockerEnvPolicyEpoch,
} from "./docker.js";
import {
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  generateNoVncPassword,
  isNoVncEnabled,
  NOVNC_PASSWORD_ENV_KEY,
  issueNoVncObserverToken,
} from "./novnc-auth.js";
import { readBrowserRegistry, updateBrowserRegistry } from "./registry.js";
import { slugifySessionKey } from "./shared.js";
import { isToolAllowed } from "./tool-policy.js";
import type { SandboxBrowserContext, SandboxConfig } from "./types.js";
import { validateNetworkMode } from "./validate-sandbox-security.js";
import {
  appendReadOnlyWorkspaceSkillMountArgs,
  appendWorkspaceMountArgs,
  formatReadOnlyWorkspaceSkillMountHashState,
  resolveReadOnlyWorkspaceSkillMounts,
  SANDBOX_MOUNT_FORMAT_VERSION,
} from "./workspace-mounts.js";

const CDP_SOURCE_RANGE_ENV_KEY = "OPENCLAW_BROWSER_CDP_SOURCE_RANGE";
const CDP_AUTH_TOKEN_ENV_KEY = "OPENCLAW_BROWSER_CDP_AUTH_TOKEN";
const SANDBOX_BROWSER_IMAGE_CONTRACT_LABEL = "org.openclaw.sandbox-browser.contract";

function buildSandboxCdpAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`openclaw:${token}`).toString("base64")}`;
}

function buildSandboxCdpUrl(params: { cdpPort: number; authToken: string }): string {
  const url = new URL(`http://127.0.0.1:${params.cdpPort}`);
  url.username = "openclaw";
  url.password = params.authToken;
  return url.toString().replace(/\/$/, "");
}

async function waitForSandboxCdp(params: {
  cdpPort: number;
  authToken: string;
  timeoutMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  const url = `http://127.0.0.1:${params.cdpPort}/json/version`;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(ctrl.abort.bind(ctrl), 1000);
      try {
        const res = await fetch(url, {
          headers: { Authorization: buildSandboxCdpAuthHeader(params.authToken) },
          signal: ctrl.signal,
        });
        if (res.ok) {
          return true;
        }
      } finally {
        clearTimeout(t);
      }
    } catch {
      // ignore
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await new Promise((r) => {
      setTimeout(r, Math.min(150, remainingMs));
    });
  }
  return false;
}

function buildSandboxBrowserResolvedConfig(params: {
  controlPort: number;
  cdpPort: number;
  cdpAuthToken: string;
  headless: boolean;
  evaluateEnabled: boolean;
  ssrfPolicy?: SsrFPolicy;
}): ResolvedBrowserConfig {
  const cdpHost = "127.0.0.1";
  const cdpPortRange = deriveDefaultBrowserCdpPortRange(params.controlPort);
  return {
    enabled: true,
    evaluateEnabled: params.evaluateEnabled,
    controlPort: params.controlPort,
    cdpProtocol: "http",
    cdpHost,
    cdpIsLoopback: true,
    cdpPortRangeStart: cdpPortRange.start,
    cdpPortRangeEnd: cdpPortRange.end,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    localLaunchTimeoutMs: 15_000,
    localCdpReadyTimeoutMs: 8_000,
    actionTimeoutMs: DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    color: DEFAULT_OPENCLAW_BROWSER_COLOR,
    executablePath: undefined,
    headless: params.headless,
    noSandbox: false,
    attachOnly: true,
    defaultProfile: DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
    extraArgs: [],
    tabCleanup: {
      enabled: true,
      idleMinutes: 120,
      maxTabsPerSession: 8,
      sweepMinutes: 5,
    },
    profiles: {
      [DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]: {
        cdpPort: params.cdpPort,
        cdpUrl: buildSandboxCdpUrl({
          cdpPort: params.cdpPort,
          authToken: params.cdpAuthToken,
        }),
        color: DEFAULT_OPENCLAW_BROWSER_COLOR,
      },
    },
    ssrfPolicy: params.ssrfPolicy,
  };
}

async function ensureSandboxBrowserImage(image: string) {
  const result = await execDocker(
    [
      "image",
      "inspect",
      "-f",
      `{{ index .Config.Labels "${SANDBOX_BROWSER_IMAGE_CONTRACT_LABEL}" }}`,
      image,
    ],
    { allowFailure: true },
  );
  if (result.code === 0) {
    const contract = result.stdout.trim();
    if (contract === SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH) {
      return;
    }
    const actual = contract && contract !== "<no value>" ? contract : "missing";
    throw new Error(
      `Sandbox browser image ${image} is stale or incompatible (contract=${actual}, expected=${SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH}). Rebuild it with scripts/sandbox-browser-setup.sh.`,
    );
  }
  const stderr = result.stderr.trim();
  if (isDockerDaemonUnavailable(stderr)) {
    throw new Error(formatDockerDaemonUnavailableError(stderr));
  }
  throw new Error(
    `Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`,
  );
}

async function ensureDockerNetwork(
  network: string,
  opts?: { allowContainerNamespaceJoin?: boolean },
) {
  validateNetworkMode(network, {
    allowContainerNamespaceJoin: opts?.allowContainerNamespaceJoin === true,
  });
  const normalized = normalizeOptionalLowercaseString(network) ?? "";
  if (!normalized || normalized === "bridge" || normalized === "none") {
    return;
  }
  const inspect = await execDocker(["network", "inspect", network], { allowFailure: true });
  if (inspect.code === 0) {
    return;
  }
  await execDocker(["network", "create", "--driver", "bridge", network]);
}

type EnsureSandboxBrowserParams = {
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  cfg: SandboxConfig;
  evaluateEnabled?: boolean;
  bridgeAuth?: { token?: string; password?: string };
  ssrfPolicy?: SsrFPolicy;
};

export async function ensureSandboxBrowser(
  params: EnsureSandboxBrowserParams,
): Promise<SandboxBrowserContext | null> {
  if (!params.cfg.browser.enabled) {
    return null;
  }
  if (!isToolAllowed(params.cfg.tools, "browser")) {
    return null;
  }

  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  const name = `${params.cfg.browser.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);
  const activity = await acquireSandboxActivity(containerName);
  try {
    return await ensureSandboxBrowserWithActivity(params, containerName, activity);
  } finally {
    activity.release();
  }
}

async function ensureSandboxBrowserWithActivity(
  params: EnsureSandboxBrowserParams,
  containerName: string,
  activity: SandboxActivityLease,
): Promise<SandboxBrowserContext> {
  const browserImage = params.cfg.browser.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE;
  const cdpSourceRange = normalizeOptionalString(params.cfg.browser.cdpSourceRange);
  const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
    docker: params.cfg.docker,
    browser: { ...params.cfg.browser, image: browserImage },
  });
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
  });
  const expectedHash = computeSandboxBrowserConfigHash({
    docker: browserDockerCfg,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(browserDockerCfg.env),
    browser: {
      cdpPort: params.cfg.browser.cdpPort,
      vncPort: params.cfg.browser.vncPort,
      noVncPort: params.cfg.browser.noVncPort,
      headless: params.cfg.browser.headless,
      enableNoVnc: params.cfg.browser.enableNoVnc,
      autoStartTimeoutMs: params.cfg.browser.autoStartTimeoutMs,
      cdpSourceRange,
    },
    securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    readOnlyWorkspaceSkillMounts: formatReadOnlyWorkspaceSkillMountHashState(
      readOnlyWorkspaceSkillMounts,
    ),
  });

  const noVncEnabled = isNoVncEnabled(params.cfg.browser);
  const inspect = async () => {
    const state = await dockerContainerState(containerName);
    if (!state.exists) {
      return { ...state, configHash: null, cdpAuthToken: undefined, noVncPassword: undefined };
    }
    const noVncPassword = noVncEnabled
      ? ((await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined)
      : undefined;
    const cdpAuthToken =
      (await readDockerContainerEnvVar(containerName, CDP_AUTH_TOKEN_ENV_KEY)) ?? undefined;
    const registry = await readBrowserRegistry();
    const registryEntry = registry.entries.find((entry) => entry.containerName === containerName);
    const labelHash = await readDockerContainerLabel(containerName, "openclaw.configHash");
    return {
      ...state,
      configHash: labelHash || registryEntry?.configHash || null,
      cdpAuthToken,
      noVncPassword,
    };
  };

  let runtime = await inspect();
  const needsMutation =
    !runtime.exists ||
    !runtime.running ||
    !runtime.cdpAuthToken ||
    runtime.configHash !== expectedHash;
  if (needsMutation) {
    await activity.upgradeToMutation();
    // Recheck after active browser requests drain; another ensure may have repaired it.
    runtime = await inspect();
    const stale = runtime.exists && (!runtime.cdpAuthToken || runtime.configHash !== expectedHash);
    if (stale) {
      if (!runtime.cdpAuthToken) {
        defaultRuntime.log(
          `Removing stale sandbox browser container ${containerName} because it lacks the current CDP relay auth contract; it will be recreated.`,
        );
      }
      await execDocker(["rm", "-f", containerName], { allowFailure: true });
      runtime = { ...runtime, exists: false, running: false };
    }
  }

  let noVncPassword = runtime.noVncPassword;
  let cdpAuthToken = runtime.cdpAuthToken;
  if (!runtime.exists) {
    noVncPassword = noVncEnabled ? generateNoVncPassword() : undefined;
    cdpAuthToken = crypto.randomBytes(24).toString("hex");
    await ensureDockerNetwork(browserDockerCfg.network, {
      allowContainerNamespaceJoin: browserDockerCfg.dangerouslyAllowContainerNamespaceJoin === true,
    });
    await ensureSandboxBrowserImage(browserImage);
    const args = buildSandboxCreateArgs({
      name: containerName,
      cfg: browserDockerCfg,
      scopeKey: params.scopeKey,
      labels: {
        "openclaw.sandboxBrowser": "1",
        "openclaw.browserConfigEpoch": SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
      },
      configHash: expectedHash,
      includeBinds: false,
      bindSourceRoots: [params.workspaceDir, params.agentWorkspaceDir],
    });
    appendWorkspaceMountArgs({
      args,
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      workdir: params.cfg.docker.workdir,
      workspaceAccess: params.cfg.workspaceAccess,
      readOnlyWorkspaceSkillMounts,
      includeReadOnlyWorkspaceSkillMounts: false,
    });
    if (browserDockerCfg.binds?.length) {
      for (const bind of browserDockerCfg.binds) {
        args.push("-v", bind);
      }
    }
    appendReadOnlyWorkspaceSkillMountArgs({
      args,
      readOnlyWorkspaceSkillMounts,
    });
    args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
    if (noVncEnabled) {
      args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
    }
    args.push("-e", `OPENCLAW_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`);
    args.push("-e", `OPENCLAW_BROWSER_ENABLE_NOVNC=${params.cfg.browser.enableNoVnc ? "1" : "0"}`);
    args.push("-e", `OPENCLAW_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
    args.push("-e", `${CDP_AUTH_TOKEN_ENV_KEY}=${cdpAuthToken}`);
    args.push(
      "-e",
      `OPENCLAW_BROWSER_AUTO_START_TIMEOUT_MS=${params.cfg.browser.autoStartTimeoutMs}`,
    );
    if (cdpSourceRange) {
      args.push("-e", `${CDP_SOURCE_RANGE_ENV_KEY}=${cdpSourceRange}`);
    }
    args.push("-e", `OPENCLAW_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
    args.push("-e", `OPENCLAW_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`);
    args.push("-e", "OPENCLAW_BROWSER_NO_SANDBOX=1");
    if (noVncEnabled && noVncPassword) {
      args.push("-e", `${NOVNC_PASSWORD_ENV_KEY}=${noVncPassword}`);
    }
    args.push(browserImage);
    await execDocker(args);
    await execDocker(["start", containerName]);
  } else if (!runtime.running) {
    await execDocker(["start", containerName]);
  }

  const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort);
  if (!mappedCdp) {
    throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
  }
  if (!cdpAuthToken) {
    throw new Error(`Failed to resolve CDP relay auth for ${containerName}.`);
  }
  const cdpUrl = buildSandboxCdpUrl({ cdpPort: mappedCdp, authToken: cdpAuthToken });

  const mappedNoVnc = noVncEnabled
    ? await readDockerPort(containerName, params.cfg.browser.noVncPort)
    : null;
  if (noVncEnabled && !noVncPassword) {
    noVncPassword =
      (await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined;
  }

  const existing = BROWSER_BRIDGES.get(params.scopeKey);
  const existingProfile = existing
    ? resolveProfile(existing.bridge.state.resolved, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME)
    : null;
  const desiredEvaluateEnabled = params.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  let desiredAuthToken = normalizeOptionalString(params.bridgeAuth?.token);
  let desiredAuthPassword = normalizeOptionalString(params.bridgeAuth?.password);
  if (!desiredAuthToken && !desiredAuthPassword) {
    desiredAuthToken = existing?.authToken;
    desiredAuthPassword = existing?.authPassword;
    if (!desiredAuthToken && !desiredAuthPassword) {
      desiredAuthToken = crypto.randomBytes(24).toString("hex");
    }
  }

  const shouldReuse =
    existing &&
    existing.containerName === containerName &&
    existingProfile?.cdpPort === mappedCdp &&
    existingProfile?.cdpUrl === cdpUrl;
  const policyMatches =
    !existing || isSameSsrFPolicy(existing.bridge.state.resolved.ssrfPolicy, params.ssrfPolicy);
  const authMatches =
    !existing ||
    (existing.authToken === desiredAuthToken && existing.authPassword === desiredAuthPassword);
  const evaluateMatches =
    !existing || existing.bridge.state.resolved.evaluateEnabled === desiredEvaluateEnabled;
  if (existing && !shouldReuse) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(() => undefined);
    BROWSER_BRIDGES.delete(params.scopeKey);
  }
  if (existing && shouldReuse && (!policyMatches || !authMatches || !evaluateMatches)) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(() => undefined);
    BROWSER_BRIDGES.delete(params.scopeKey);
  }

  const bridge = (() => {
    if (shouldReuse && policyMatches && authMatches && evaluateMatches && existing) {
      return existing.bridge;
    }
    return null;
  })();

  const ensureBridge = async () => {
    if (bridge) {
      return bridge;
    }

    const onEnsureAttachTarget = params.cfg.browser.autoStart
      ? async () => {
          const currentState = await dockerContainerState(containerName);
          if (currentState.exists && !currentState.running) {
            await execDocker(["start", containerName]);
          }
          const ok = await waitForSandboxCdp({
            cdpPort: mappedCdp,
            authToken: cdpAuthToken,
            timeoutMs: params.cfg.browser.autoStartTimeoutMs,
          });
          if (!ok) {
            // This callback runs inside a browser request reader. Queue cleanup
            // behind all readers; awaiting a reader-to-writer upgrade would deadlock.
            void withSandboxIdleMutation(containerName, async () => {
              const cleanupState = await dockerContainerState(containerName);
              if (!cleanupState.exists) {
                return;
              }
              const currentAuthToken = await readDockerContainerEnvVar(
                containerName,
                CDP_AUTH_TOKEN_ENV_KEY,
              );
              if (currentAuthToken !== cdpAuthToken) {
                return;
              }
              const recovered =
                cleanupState.running &&
                (await waitForSandboxCdp({
                  cdpPort: mappedCdp,
                  authToken: cdpAuthToken,
                  timeoutMs: Math.min(params.cfg.browser.autoStartTimeoutMs, 1_000),
                }));
              if (!recovered) {
                await execDocker(["rm", "-f", containerName], { allowFailure: true });
              }
            }).catch((error: unknown) => {
              defaultRuntime.log(
                `Failed to remove hung sandbox browser container ${containerName}: ${String(error)}`,
              );
            });
            throw new Error(
              `Sandbox browser CDP did not become reachable on 127.0.0.1:${mappedCdp} within ${params.cfg.browser.autoStartTimeoutMs}ms. The hung container will be removed after active browser requests finish; retry the browser tool. If it remains unavailable, run openclaw sandbox recreate --browser --session ${params.scopeKey}.`,
            );
          }
        }
      : undefined;

    return await startBrowserBridgeServer({
      resolved: buildSandboxBrowserResolvedConfig({
        controlPort: 0,
        cdpPort: mappedCdp,
        cdpAuthToken,
        headless: params.cfg.browser.headless,
        evaluateEnabled: desiredEvaluateEnabled,
        ssrfPolicy: params.ssrfPolicy,
      }),
      port: existing?.bridge.port,
      authToken: desiredAuthToken,
      authPassword: desiredAuthPassword,
      onEnsureAttachTarget,
      resolveSandboxNoVncToken: consumeNoVncObserverToken,
      tryAcquireActivityLease: () => tryAcquireSandboxActivity(containerName),
    });
  };

  const resolvedBridge = await ensureBridge();
  if (!shouldReuse || !policyMatches || !authMatches || !evaluateMatches) {
    BROWSER_BRIDGES.set(params.scopeKey, {
      bridge: resolvedBridge,
      containerName,
      authToken: desiredAuthToken,
      authPassword: desiredAuthPassword,
    });
  }

  const now = Date.now();
  await updateBrowserRegistry({
    containerName,
    sessionKey: params.scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: browserImage,
    configHash: expectedHash,
    cdpPort: mappedCdp,
    noVncPort: mappedNoVnc ?? undefined,
  });

  const noVncUrl =
    mappedNoVnc && noVncEnabled
      ? (() => {
          const token = issueNoVncObserverToken({
            noVncPort: mappedNoVnc,
            password: noVncPassword,
          });
          return buildNoVncObserverTokenUrl(resolvedBridge.baseUrl, token);
        })()
      : undefined;

  return {
    bridgeUrl: resolvedBridge.baseUrl,
    noVncUrl,
    containerName,
  };
}
