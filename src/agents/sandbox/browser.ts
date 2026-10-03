import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { deriveDefaultBrowserCdpPortRange } from "../../config/port-defaults.js";
import { withContainerEnvFile } from "../../infra/container-env-file.js";
import { isSameSsrFPolicy, type SsrFPolicy } from "../../infra/net/ssrf.js";
import {
  type BrowserBridge,
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
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { defaultRuntime } from "../../runtime.js";
import {
  BROWSER_BRIDGES,
  stopCachedBrowserBridge,
  stopCachedBrowserBridgesForContainer,
} from "./browser-bridges.js";
import { computeSandboxBrowserConfigHash } from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig } from "./config.js";
import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  SANDBOX_BROWSER_IMAGE_CONTRACT_EPOCH,
  SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
  SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
} from "./constants.js";
import { DOCKER_SANDBOX_ENGINE } from "./container-engine.js";
import {
  assertChangedSandboxConfigAllowed,
  handleHotSandboxConfigMismatch,
} from "./current-config.js";
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
import { prepareSandboxMountPlan, sandboxMountPlanMatchesContainer } from "./mount-plan.js";
import {
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  generateNoVncPassword,
  isNoVncEnabled,
  NOVNC_PASSWORD_ENV_KEY,
  issueNoVncObserverToken,
} from "./novnc-auth.js";
import { readBrowserRegistry, updateBrowserRegistry } from "./registry.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";
import { isToolAllowed } from "./tool-policy.js";
import type { SandboxBrowserContext, SandboxConfig } from "./types.js";
import { validateNetworkMode } from "./validate-sandbox-security.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

const HOT_BROWSER_WINDOW_MS = 5 * 60 * 1000;
const CDP_SOURCE_RANGE_ENV_KEY = "OPENCLAW_BROWSER_CDP_SOURCE_RANGE";
const CDP_AUTH_TOKEN_ENV_KEY = "OPENCLAW_BROWSER_CDP_AUTH_TOKEN";
const SANDBOX_BROWSER_IMAGE_CONTRACT_LABEL = "org.openclaw.sandbox-browser.contract";
const browserContainerLifecycleQueue = new KeyedAsyncQueue();
const browserNetworkLifecycleQueue = new KeyedAsyncQueue();

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
      // Keep a stalled request inside the outer browser startup deadline.
      const requestTimeoutMs = Math.max(1, Math.min(1000, deadline - Date.now()));
      const ctrl = new AbortController();
      const t = setTimeout(ctrl.abort.bind(ctrl), requestTimeoutMs);
      try {
        const res = await fetch(url, {
          headers: { Authorization: buildSandboxCdpAuthHeader(params.authToken) },
          signal: ctrl.signal,
        });
        await res.body?.cancel().catch(() => undefined);
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
  opts?: { allowContainerNamespaceJoin?: boolean; assertCurrent?: () => void },
) {
  validateNetworkMode(network, {
    allowContainerNamespaceJoin: opts?.allowContainerNamespaceJoin === true,
  });
  const normalized = normalizeOptionalLowercaseString(network) ?? "";
  if (!normalized || normalized === "bridge" || normalized === "none") {
    return;
  }
  await browserNetworkLifecycleQueue.enqueue(normalized, async () => {
    const inspect = await execDocker(["network", "inspect", network], { allowFailure: true });
    if (inspect.code === 0) {
      return;
    }
    opts?.assertCurrent?.();
    await execDocker(["network", "create", "--driver", "bridge", network]);
  });
}

type EnsureSandboxBrowserParams = {
  assertCurrent?: () => void;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  cfg: SandboxConfig;
  evaluateEnabled?: boolean;
  bridgeAuth?: { token?: string; password?: string };
  ssrfPolicy?: SsrFPolicy;
  /** Joins managed workspace custody for late browser starts as well as allocation. */
  withWorkspace?: <T>(operation: () => Promise<T>) => Promise<T>;
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
  if (normalizeOptionalLowercaseString(params.cfg.browser.network) === "none") {
    throw new Error(
      'Sandbox browser network mode "none" is unsupported because browser control requires a host-reachable published CDP port. Use "bridge", a custom bridge network, or disable the sandbox browser.',
    );
  }

  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  const containerName = buildSandboxContainerName(params.cfg.browser.containerPrefix, slug);

  // Independent agent runs can converge on one Docker resource. Serialize the
  // full lifecycle so followers re-read container and bridge state after the
  // preceding create, start, or replacement has settled.
  let provisioning = true;
  const withWorkspace = params.withWorkspace;
  const provision = () =>
    browserContainerLifecycleQueue.enqueue(
      containerName,
      async () =>
        await ensureSandboxBrowserContainer(
          {
            ...params,
            // Initial bridge warmup already owns the lease. Later attach requests
            // rejoin it before starting a stopped writer.
            withWorkspace: withWorkspace
              ? (operation) => (provisioning ? operation() : withWorkspace(operation))
              : undefined,
          },
          containerName,
        ),
    );
  try {
    return await (withWorkspace ? withWorkspace(provision) : provision());
  } finally {
    provisioning = false;
  }
}

async function ensureSandboxBrowserContainer(
  params: EnsureSandboxBrowserParams,
  containerName: string,
): Promise<SandboxBrowserContext> {
  let existing = BROWSER_BRIDGES.get(params.scopeKey);
  const stopExistingForContainer = async () => {
    await stopCachedBrowserBridgesForContainer(containerName, params.assertCurrent);
    existing = BROWSER_BRIDGES.get(params.scopeKey);
  };
  const state = await dockerContainerState(containerName);
  params.assertCurrent?.();
  const browserImage = params.cfg.browser.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE;
  const cdpSourceRange = normalizeOptionalString(params.cfg.browser.cdpSourceRange);
  const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
    docker: params.cfg.docker,
    browser: { ...params.cfg.browser, image: browserImage },
  });
  const mountPlan = await prepareSandboxMountPlan({
    engine: DOCKER_SANDBOX_ENGINE,
    workspaceDir: params.workspaceDir,
    ...(params.withWorkspace ? { workspaceSource: "managed-worktree" as const } : {}),
    assertCurrent: params.assertCurrent,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    workdir: params.cfg.docker.workdir,
    workspaceAccess: params.cfg.workspaceAccess,
    binds: browserDockerCfg.binds,
    tmpfs: browserDockerCfg.tmpfs,
  });
  params.assertCurrent?.();
  const expectedHash = computeSandboxBrowserConfigHash({
    docker: browserDockerCfg,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(browserDockerCfg.env),
    browser: {
      cdpPort: params.cfg.browser.cdpPort,
      vncPort: params.cfg.browser.vncPort,
      noVncPort: params.cfg.browser.noVncPort,
      headless: params.cfg.browser.headless,
      noVncEnabled: params.cfg.browser.noVncEnabled,
      autoStartTimeoutMs: params.cfg.browser.autoStartTimeoutMs,
      cdpSourceRange,
    },
    securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    managedMounts: mountPlan.binds,
  });

  // Creation and changed-config reuse judge binds against the same roots.
  const bindSourceRoots = [params.workspaceDir, params.agentWorkspaceDir];
  const now = Date.now();
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  const noVncEnabled = isNoVncEnabled(params.cfg.browser);
  let noVncPassword: string | undefined;
  let cdpAuthToken: string | undefined;

  if (hasContainer) {
    if (noVncEnabled) {
      noVncPassword =
        (await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined;
      params.assertCurrent?.();
    }
    cdpAuthToken =
      (await readDockerContainerEnvVar(containerName, CDP_AUTH_TOKEN_ENV_KEY)) ?? undefined;
    params.assertCurrent?.();
    // A container without the CDP relay token is removed under that auth contract before the
    // changed-config security check; every container this code creates carries the token.
    if (!cdpAuthToken) {
      defaultRuntime.log(
        `Removing stale sandbox browser container ${containerName} because it lacks the current CDP relay auth contract; it will be recreated.`,
      );
      await stopExistingForContainer();
      params.assertCurrent?.();
      await execDocker(["rm", "-f", containerName], { allowFailure: true });
      hasContainer = false;
      running = false;
    }
  }

  if (hasContainer) {
    const registry = await readBrowserRegistry();
    params.assertCurrent?.();
    const registryEntry = registry.entries.find((entry) => entry.containerName === containerName);
    currentHash = await readDockerContainerLabel(containerName, "openclaw.configHash");
    params.assertCurrent?.();
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
    }
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (hashMismatch) {
      assertChangedSandboxConfigAllowed({
        containerName,
        cfg: browserDockerCfg,
        bindSourceRoots,
        browser: true,
        scope: params.cfg.scope,
        sessionKey: params.scopeKey,
      });
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_BROWSER_WINDOW_MS);
      if (isHot) {
        const mountsMatch = await sandboxMountPlanMatchesContainer({
          engine: DOCKER_SANDBOX_ENGINE,
          containerName,
          plan: mountPlan,
        });
        params.assertCurrent?.();
        handleHotSandboxConfigMismatch({
          containerName,
          scope: params.cfg.scope,
          sessionKey: params.scopeKey,
          browser: true,
          mountsChanged: !mountsMatch,
        });
      } else {
        await stopExistingForContainer();
        params.assertCurrent?.();
        await execDocker(["rm", "-f", containerName], { allowFailure: true });
        hasContainer = false;
        running = false;
      }
    }
  }

  const registryEntry = {
    containerName,
    sessionKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: browserImage,
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
  };
  if (params.withWorkspace) {
    // Reserve the mount before allocation; a bridge/port failure must not hide
    // an already-running writer from reconciliation or lifecycle cleanup.
    params.assertCurrent?.();
    await updateBrowserRegistry({ ...registryEntry, cdpPort: 0 }, params.assertCurrent);
    params.assertCurrent?.();
  }

  if (!hasContainer) {
    if (noVncEnabled) {
      noVncPassword = generateNoVncPassword();
    }
    cdpAuthToken = crypto.randomBytes(24).toString("hex");
    await ensureDockerNetwork(browserDockerCfg.network, {
      assertCurrent: params.assertCurrent,
      allowContainerNamespaceJoin: browserDockerCfg.dangerouslyAllowContainerNamespaceJoin === true,
    });
    await ensureSandboxBrowserImage(browserImage);
    params.assertCurrent?.();
    const { argv: args, env } = buildSandboxCreateArgs({
      name: containerName,
      cfg: browserDockerCfg,
      scopeKey: params.scopeKey,
      labels: {
        "openclaw.sandboxBrowser": "1",
        "openclaw.browserConfigEpoch": SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
      },
      configHash: expectedHash,
      includeBinds: false,
      bindSourceRoots,
    });
    for (const bind of mountPlan.skippedBinds) {
      defaultRuntime.log(
        `sandbox browser: skipping user bind "${bind}" — container path conflicts with a protected read-only skill mount`,
      );
    }
    for (const bind of mountPlan.binds) {
      args.push("-v", bind);
    }
    args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
    if (noVncEnabled) {
      args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
    }
    Object.assign(env, {
      OPENCLAW_BROWSER_HEADLESS: params.cfg.browser.headless ? "1" : "0",
      OPENCLAW_BROWSER_ENABLE_NOVNC: params.cfg.browser.noVncEnabled ? "1" : "0",
      OPENCLAW_BROWSER_CDP_PORT: String(params.cfg.browser.cdpPort),
      [CDP_AUTH_TOKEN_ENV_KEY]: cdpAuthToken,
      OPENCLAW_BROWSER_AUTO_START_TIMEOUT_MS: String(params.cfg.browser.autoStartTimeoutMs),
      OPENCLAW_BROWSER_VNC_PORT: String(params.cfg.browser.vncPort),
      OPENCLAW_BROWSER_NOVNC_PORT: String(params.cfg.browser.noVncPort),
      OPENCLAW_BROWSER_NO_SANDBOX: "1",
    });
    if (cdpSourceRange) {
      env[CDP_SOURCE_RANGE_ENV_KEY] = cdpSourceRange;
    }
    if (noVncEnabled && noVncPassword) {
      env[NOVNC_PASSWORD_ENV_KEY] = noVncPassword;
    }
    params.assertCurrent?.();
    await withContainerEnvFile(env, async (envFile) => {
      args.push("--env-file", envFile, browserImage);
      params.assertCurrent?.();
      await execDocker(args);
    });
    params.assertCurrent?.();
    await execDocker(["start", containerName]);
  } else if (!running) {
    params.assertCurrent?.();
    await execDocker(["start", containerName]);
  }

  const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort);
  params.assertCurrent?.();
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
  params.assertCurrent?.();
  if (noVncEnabled && !noVncPassword) {
    noVncPassword =
      (await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined;
    params.assertCurrent?.();
  }

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

  const canReuse = Boolean(
    // Guarded restart callbacks retain one admitted turn, not a later turn's authority.
    !params.withWorkspace &&
    !params.assertCurrent &&
    existing &&
    existing.bridge.server.listening &&
    existing.containerName === containerName &&
    existingProfile?.cdpPort === mappedCdp &&
    existingProfile?.cdpUrl === cdpUrl &&
    isSameSsrFPolicy(existing.bridge.state.resolved.ssrfPolicy, params.ssrfPolicy) &&
    existing.authToken === desiredAuthToken &&
    existing.authPassword === desiredAuthPassword &&
    existing.bridge.state.resolved.evaluateEnabled === desiredEvaluateEnabled,
  );
  if (existing && !canReuse) {
    await stopCachedBrowserBridge(params.scopeKey, existing, params.assertCurrent);
  }

  let bridge = canReuse ? (existing?.bridge ?? null) : null;
  let createdBridge: BrowserBridge | undefined;
  try {
    if (!bridge) {
      const startTarget = async () => {
        const currentState = await dockerContainerState(containerName);
        params.assertCurrent?.();
        if (currentState.exists && !currentState.running) {
          params.assertCurrent?.();
          await execDocker(["start", containerName]);
        }
        const ok = await waitForSandboxCdp({
          cdpPort: mappedCdp,
          authToken: cdpAuthToken,
          timeoutMs: params.cfg.browser.autoStartTimeoutMs,
        });
        params.assertCurrent?.();
        if (!ok) {
          await execDocker(["rm", "-f", containerName], { allowFailure: true });
          throw new Error(
            `Sandbox browser CDP did not become reachable on 127.0.0.1:${mappedCdp} within ${params.cfg.browser.autoStartTimeoutMs}ms. The hung container has been forcefully removed.`,
          );
        }
      };
      const onEnsureAttachTarget = params.cfg.browser.autoStart
        ? () => (params.withWorkspace ? params.withWorkspace(startTarget) : startTarget())
        : undefined;

      params.assertCurrent?.();
      bridge = await startBrowserBridgeServer({
        resolved: buildSandboxBrowserResolvedConfig({
          controlPort: 0,
          cdpPort: mappedCdp,
          cdpAuthToken,
          headless: params.cfg.browser.headless,
          evaluateEnabled: desiredEvaluateEnabled,
          ssrfPolicy: params.ssrfPolicy,
        }),
        authToken: desiredAuthToken,
        authPassword: desiredAuthPassword,
        onEnsureAttachTarget,
        resolveSandboxNoVncToken: consumeNoVncObserverToken,
      });
      createdBridge = bridge;
      params.assertCurrent?.();
      BROWSER_BRIDGES.set(params.scopeKey, {
        bridge,
        containerName,
        authToken: desiredAuthToken,
        authPassword: desiredAuthPassword,
      });
    }

    params.assertCurrent?.();
    await updateBrowserRegistry(
      {
        ...registryEntry,
        cdpPort: mappedCdp,
        noVncPort: mappedNoVnc ?? undefined,
      },
      params.assertCurrent,
    );
    params.assertCurrent?.();

    const noVncUrl =
      mappedNoVnc && noVncEnabled
        ? buildNoVncObserverTokenUrl(
            bridge.baseUrl,
            issueNoVncObserverToken({
              noVncPort: mappedNoVnc,
              password: noVncPassword,
            }),
          )
        : undefined;

    return {
      bridgeUrl: bridge.baseUrl,
      noVncUrl,
      containerName,
    };
  } catch (error) {
    // Roll back this attempt's bridge even after custody closes; never retire a reused bridge.
    if (createdBridge) {
      try {
        await stopBrowserBridgeServer(createdBridge.server);
        if (BROWSER_BRIDGES.get(params.scopeKey)?.bridge === createdBridge) {
          BROWSER_BRIDGES.delete(params.scopeKey);
        }
      } catch (cleanupError) {
        defaultRuntime.error?.(`Sandbox browser bridge cleanup failed: ${String(cleanupError)}`);
      }
    }
    throw error;
  }
}
