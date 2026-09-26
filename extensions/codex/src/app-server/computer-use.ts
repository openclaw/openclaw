/**
 * Computer Use plugin/MCP readiness checks and optional install flow for Codex
 * app-server sessions.
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { reconcileCodexComputerUseStartArtifacts } from "./auth-bridge.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { describeControlFailure } from "./capabilities.js";
import {
  isCodexAppServerConnectionClosedError,
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import { resolveClientManagedBundledMarketplacePath } from "./computer-use-marketplace.js";
import {
  createComputerUseRequest,
  runCodexComputerUseLiveTest,
  skippedLiveTestStatus,
  type CodexComputerUseLiveTestStatus,
  type CodexComputerUseRepairStatus,
  type CodexComputerUseRequest,
} from "./computer-use-readiness.js";
import { assertNotSymlink } from "./computer-use-service-path.js";
import {
  hasLegacyCodexComputerUseMcpPolicy,
  resolveManagedCodexComputerUseConfig,
} from "./computer-use-unified.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexComputerUseConfig,
  type ResolvedCodexComputerUseConfig,
} from "./config.js";
import {
  resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath,
  resolveMacOSDesktopCodexBundledMarketplaceCandidates,
} from "./desktop-app-paths.js";
import { isManagedCodexDesktopCommand } from "./managed-binary.js";
import { acquireCodexNativeConfigFence } from "./native-config-fence.js";
import type {
  CodexAppServerRequestResult,
  CodexConfigReadResponse,
  CodexListMcpServerStatusResponse,
  CodexMcpServerStatus,
  CodexPluginDetail,
  CodexPluginListResponse,
  CodexPluginReadResponse,
  CodexRequestObject,
  JsonValue,
} from "./protocol.js";
import { requestCodexAppServerClientJson } from "./request.js";
import {
  assertCodexAppServerClientStartSelectionCurrent,
  getLeasedSharedCodexAppServerClient,
  readCodexAppServerClientDesktopGeneration,
  readCodexAppServerClientProcessIdentity,
  releaseLeasedSharedCodexAppServerClient,
  resolveCodexNativeConfigFenceKey,
  waitForCodexAppServerClientDesktopGenerationDrain,
  withLeasedCodexAppServerClientStartSelectionRetry,
  type CodexAppServerClientLease,
} from "./shared-client.js";

type CodexComputerUseStatusReason =
  | "disabled"
  | "marketplace_missing"
  | "plugin_not_installed"
  | "plugin_disabled"
  | "mcp_missing"
  | "live_test_failed"
  | "ready"
  | "check_failed"
  | "auto_install_blocked";

type CodexComputerUseInstallationStatus =
  | "disabled"
  | "marketplace_missing"
  | "not_installed"
  | "installed_disabled"
  | "installed";

type CodexComputerUseExposureStatus = "skipped" | "missing" | "available";

type CodexComputerUseStatusSection = {
  status: string;
  ok: boolean;
  message: string;
};

/** Readiness status for Codex Computer Use plugin and MCP server wiring. */
export type CodexComputerUseStatus = {
  enabled: boolean;
  ready: boolean;
  reason: CodexComputerUseStatusReason;
  installed: boolean;
  pluginEnabled: boolean;
  mcpServerAvailable: boolean;
  pluginName: string;
  mcpServerName: string;
  marketplaceName?: string;
  marketplacePath?: string;
  tools: string[];
  installation: CodexComputerUseStatusSection & {
    status: CodexComputerUseInstallationStatus;
  };
  exposure: CodexComputerUseStatusSection & {
    status: CodexComputerUseExposureStatus;
  };
  liveTest: CodexComputerUseLiveTestStatus;
  repair?: CodexComputerUseRepairStatus;
  warnings: string[];
  message: string;
};

class CodexComputerUseSetupError extends Error {
  readonly status: CodexComputerUseStatus;

  constructor(status: CodexComputerUseStatus) {
    super(status.message);
    this.name = "CodexComputerUseSetupError";
    this.status = status;
  }
}

/** Inputs for checking, ensuring, or installing Codex Computer Use support. */
export type CodexComputerUseSetupParams = {
  pluginConfig?: unknown;
  config?: Parameters<typeof requestCodexAppServerClientJson>[0]["config"];
  agentDir?: string;
  overrides?: Partial<CodexComputerUseConfig>;
  /** Caller-owned injection seam for tests; production mutation safety requires `client`. */
  request?: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  forceEnable?: boolean;
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
  releaseNativeConfigFence?: () => void;
};

type CodexComputerUseInspectionParams = Omit<
  CodexComputerUseSetupParams,
  "overrides" | "forceEnable"
> & {
  computerUseConfig: ResolvedCodexComputerUseConfig;
  runLiveTest: boolean;
  installPlugin: boolean;
  explicitManagedInstall?: ExplicitManagedComputerUseInstallContext;
};

type ExplicitManagedComputerUseInstallContext = {
  client: CodexAppServerClient;
  agentDir: string;
  codexHome: string;
  command: string;
  desktopGeneration: NonNullable<ReturnType<typeof readCodexAppServerClientDesktopGeneration>>;
};

type MarketplaceRef =
  | {
      kind: "local";
      name?: string;
      path: string;
    }
  | {
      kind: "remote";
      name: string;
      remoteMarketplaceName: string;
      remotePluginId: string;
    };

type MarketplaceResolution = {
  marketplace?: MarketplaceRef;
  message?: string;
};

type PluginInspection =
  | {
      ok: true;
      plugin: CodexPluginDetail;
    }
  | {
      ok: false;
      status: CodexComputerUseStatus;
    };

const CURATED_MARKETPLACE_POLL_INTERVAL_MS = 2_000;
const BUNDLED_MARKETPLACE_NAME = "openai-bundled";
const COMPUTER_USE_MARKETPLACE_NAME_PRIORITY = [
  BUNDLED_MARKETPLACE_NAME,
  "openai-curated",
  "openai-api-curated",
  "openai-curated-remote",
  "local",
];
/** Reads Computer Use readiness without installing or mutating app-server state. */
export async function readCodexComputerUseStatus(
  params: CodexComputerUseSetupParams = {},
): Promise<CodexComputerUseStatus> {
  const config = resolveComputerUseConfig(params);
  if (!config.enabled) {
    return unavailableStatus(config, "disabled", "Computer Use is disabled.");
  }
  try {
    return await inspectCodexComputerUse({
      ...params,
      computerUseConfig: config,
      runLiveTest: true,
      installPlugin: false,
    });
  } catch (error) {
    return unavailableStatus(
      config,
      "check_failed",
      `Computer Use check failed: ${describeControlFailure(error)}`,
    );
  }
}

/**
 * Ensures installation and MCP exposure before a turn, optionally installing when
 * config allows safe auto-install. Only strict startup waits for a live probe.
 */
export async function ensureCodexComputerUse(
  params: CodexComputerUseSetupParams = {},
): Promise<CodexComputerUseStatus> {
  const config = resolveComputerUseConfig(params);
  if (!config.enabled) {
    return unavailableStatus(config, "disabled", "Computer Use is disabled.");
  }
  const status = await inspectCodexComputerUse({
    ...params,
    computerUseConfig: config,
    runLiveTest: config.strictReadiness,
    installPlugin: false,
  });
  if (status.ready) {
    return status;
  }
  if (config.autoInstall) {
    const blockedAutoInstallStatus = blockUnsafeAutoInstallStatus(config);
    if (blockedAutoInstallStatus) {
      throw new CodexComputerUseSetupError(blockedAutoInstallStatus);
    }
    const installedStatus = await inspectCodexComputerUse({
      ...params,
      computerUseConfig: config,
      runLiveTest: config.strictReadiness,
      installPlugin: true,
    });
    if (!installedStatus.ready) {
      throw new CodexComputerUseSetupError(installedStatus);
    }
    return installedStatus;
  }
  throw new CodexComputerUseSetupError(status);
}

/** Forces Computer Use plugin installation and returns the ready status. */
export async function installCodexComputerUse(
  params: CodexComputerUseSetupParams = {},
): Promise<CodexComputerUseStatus> {
  const config = resolveComputerUseConfig({
    ...params,
    forceEnable: true,
    overrides: { ...params.overrides, enabled: true, autoInstall: true },
  });
  const status = await inspectCodexComputerUse({
    ...params,
    computerUseConfig: config,
    runLiveTest: true,
    installPlugin: true,
  });
  if (!status.ready) {
    throw new CodexComputerUseSetupError(status);
  }
  return status;
}

async function inspectCodexComputerUse(
  params: CodexComputerUseInspectionParams,
): Promise<CodexComputerUseStatus> {
  const resolvedRuntime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
    managedCommandOrder: "desktop-first",
  });
  const operationTimeoutMs = params.timeoutMs ?? resolvedRuntime.requestTimeoutMs;
  const deadline = operationTimeoutMs > 0 ? Date.now() + operationTimeoutMs : undefined;
  const remainingTimeoutMs = () =>
    deadline === undefined ? operationTimeoutMs : Math.max(1, deadline - Date.now());
  const clientOptions = {
    startOptions: resolvedRuntime.start,
    pluginConfig: params.pluginConfig,
    config: params.config,
    agentDir: params.agentDir,
    abandonSignal: params.signal,
    assertCurrent: params.assertCurrent,
  };
  const lease: CodexAppServerClientLease = {};
  try {
    let client = params.client;
    if (!client && !params.request) {
      client = await getLeasedSharedCodexAppServerClient({
        ...clientOptions,
        timeoutMs: remainingTimeoutMs(),
      });
      lease.client = client;
    }
    if (!params.installPlugin) {
      if (!lease.client) {
        return await inspectCodexComputerUseWithoutFence(params);
      }
      return await withLeasedCodexAppServerClientStartSelectionRetry({
        lease,
        options: { ...clientOptions, timeoutMs: remainingTimeoutMs() },
        signal: params.signal,
        run: async (readClient, requestOptions) => {
          const { assertCurrent } = requestOptions();
          return await inspectCodexComputerUseWithoutFence({
            ...params,
            client: readClient,
            request: async <T>(
              method: string,
              requestParams?: unknown,
              options?: { timeoutMs?: number; signal?: AbortSignal },
            ) => {
              // Cleanup keeps its own deadline after the operation expires or is aborted.
              const scopedOptions =
                method === "thread/unsubscribe"
                  ? {
                      timeoutMs: options?.timeoutMs ?? operationTimeoutMs,
                      signal: options?.signal,
                      assertCurrent,
                    }
                  : requestOptions();
              return await requestCodexAppServerClientJson<T>({
                client: readClient,
                method,
                requestParams,
                config: params.config,
                timeoutMs: Math.min(
                  options?.timeoutMs ?? operationTimeoutMs,
                  scopedOptions.timeoutMs,
                ),
                signal: scopedOptions.signal,
                assertCurrent: scopedOptions.assertCurrent,
              });
            },
          });
        },
      });
    }
    const explicitManagedInstall =
      client && !resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig }).autoInstall
        ? await resolveExplicitManagedComputerUseInstallContext({ ...params, client })
        : undefined;
    if (explicitManagedInstall) {
      await waitForCodexAppServerClientDesktopGenerationDrain({
        client: explicitManagedInstall.client,
        timeoutMs: remainingTimeoutMs(),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      assertCodexAppServerClientStartSelectionCurrent({ client: explicitManagedInstall.client });
    }
    const inspectionParams: CodexComputerUseInspectionParams = {
      ...params,
      ...(client ? { client } : {}),
      timeoutMs: remainingTimeoutMs(),
      ...(explicitManagedInstall ? { explicitManagedInstall } : {}),
    };
    const fenceKey = resolveCodexNativeConfigFenceKey({
      client,
      startOptions: resolvedRuntime.start,
      agentDir: params.agentDir,
      config: params.config,
    });
    if (!fenceKey) {
      return await inspectCodexComputerUseWithoutFence(inspectionParams);
    }
    const release = await acquireCodexNativeConfigFence(fenceKey, {
      signal: params.signal,
      timeoutMs: remainingTimeoutMs(),
      timeoutMessage: "Codex Computer Use install timed out waiting for native config",
      abortMessage: "Codex Computer Use install aborted waiting for native config",
    });
    let releaseFenceOnReturn = true;
    try {
      try {
        return await inspectCodexComputerUseWithoutFence({
          ...inspectionParams,
          releaseNativeConfigFence: release,
        });
      } catch (error) {
        if (
          client &&
          (isCodexAppServerIndeterminateRequestCancellationError(error) ||
            isCodexAppServerIndeterminateTransportError(error) ||
            isCodexAppServerConnectionClosedError(error))
        ) {
          // Codex may still commit a config mutation after local cancellation.
          // Transfer fence ownership to physical process exit before surfacing it.
          releaseFenceOnReturn = false;
          await client.closeAndRunAfterExit(release, "Computer Use config mutation");
        }
        throw error;
      }
    } finally {
      if (releaseFenceOnReturn) {
        release();
      }
    }
  } finally {
    if (lease.client) {
      releaseLeasedSharedCodexAppServerClient(lease.client);
    }
  }
}

async function inspectCodexComputerUseWithoutFence(
  params: CodexComputerUseInspectionParams,
): Promise<CodexComputerUseStatus> {
  const request = createComputerUseRequest(params);
  if (params.installPlugin) {
    if (!resolveCodexComputerUseConfig({ pluginConfig: params.pluginConfig }).autoInstall) {
      await prepareExplicitManagedComputerUseInstall(params);
    }
    await request<JsonValue>("experimentalFeature/enablement/set", {
      enablement: { plugins: true },
    } satisfies CodexRequestObject);
  }

  const managedMarketplacePath = await resolveClientManagedBundledMarketplacePath(
    params.client?.getRuntimeIdentity()?.codexHome,
    params.agentDir,
  );
  const managedCodexHome = managedMarketplacePath
    ? params.client?.getRuntimeIdentity()?.codexHome
    : undefined;
  let computerUseConfig = await resolveManagedCodexComputerUseConfig(
    params.computerUseConfig,
    managedMarketplacePath,
  );
  if (computerUseConfig !== params.computerUseConfig) {
    const nativeConfig = await request<CodexConfigReadResponse>("config/read", {
      includeLayers: false,
    });
    if (hasLegacyCodexComputerUseMcpPolicy(nativeConfig.config)) {
      computerUseConfig = params.computerUseConfig;
    }
  }
  if (params.installPlugin && managedCodexHome) {
    await assertNotSymlink(path.join(managedCodexHome, "config.toml"), "Codex config");
  }
  const marketplace = await resolveMarketplaceRef({
    request,
    config: computerUseConfig,
    allowAdd: params.installPlugin,
    signal: params.signal,
    defaultBundledMarketplacePath: params.defaultBundledMarketplacePath ?? managedMarketplacePath,
    defaultBundledMarketplacePathCandidates: params.defaultBundledMarketplacePathCandidates,
    managedCodexHome,
  });
  if (!marketplace.marketplace) {
    return unavailableStatus(
      computerUseConfig,
      "marketplace_missing",
      marketplace.message ??
        `No Codex marketplace containing ${computerUseConfig.pluginName} is registered. Configure computerUse.marketplaceSource or computerUse.marketplacePath, then run /codex computer-use install.`,
    );
  }

  const pluginInspection = await ensureComputerUsePlugin({
    request,
    config: computerUseConfig,
    marketplace: marketplace.marketplace,
    installPlugin: params.installPlugin,
  });
  if (!pluginInspection.ok) {
    return pluginInspection.status;
  }

  return await readComputerUseTools({
    request,
    client: params.client,
    signal: params.signal,
    config: computerUseConfig,
    plugin: pluginInspection.plugin,
    runLiveTest: params.runLiveTest,
    installPlugin: params.installPlugin,
    releaseNativeConfigFence: params.releaseNativeConfigFence,
  });
}

async function prepareExplicitManagedComputerUseInstall(
  params: CodexComputerUseInspectionParams,
): Promise<void> {
  const context = params.explicitManagedInstall;
  if (!context) {
    return;
  }
  await reconcileCodexComputerUseStartArtifacts({
    startOptions: {
      transport: "stdio",
      command: context.command,
      commandSource: "resolved-managed",
      args: ["app-server"],
      headers: {},
      env: { CODEX_HOME: context.codexHome },
    },
    agentDir: context.agentDir,
    pluginConfig: { computerUse: { ...params.computerUseConfig, autoInstall: true } },
    ownsIsolatedCodexHome: true,
    desktopGeneration: context.desktopGeneration,
    forceCacheRefresh: true,
    assertCurrent: () => {
      params.assertCurrent?.();
      assertCodexAppServerClientStartSelectionCurrent({ client: context.client });
    },
  });
}

async function resolveExplicitManagedComputerUseInstallContext(
  params: CodexComputerUseInspectionParams & { client: CodexAppServerClient },
): Promise<ExplicitManagedComputerUseInstallContext | undefined> {
  if (!params.agentDir) {
    return undefined;
  }
  const codexHome = params.client.getRuntimeIdentity()?.codexHome;
  const processIdentity = readCodexAppServerClientProcessIdentity(params.client);
  const command =
    processIdentity?.nativeCommand ??
    (processIdentity && isManagedCodexDesktopCommand(processIdentity.command, "darwin")
      ? processIdentity.command
      : undefined);
  if (!codexHome || !command) {
    return undefined;
  }
  const desktopGeneration = readCodexAppServerClientDesktopGeneration(params.client);
  if (!desktopGeneration) {
    throw new Error(
      "Codex Computer Use install requires a desktop-generation-bound client; reconnect and retry.",
    );
  }
  const expectedHome = resolveCodexAppServerHomeDir(params.agentDir);
  const [actualRealHome, expectedRealHome] = await Promise.all([
    fs.realpath(codexHome).catch(() => undefined),
    fs.realpath(expectedHome).catch(() => undefined),
  ]);
  if (!actualRealHome || actualRealHome !== expectedRealHome) {
    return undefined;
  }
  return {
    client: params.client,
    agentDir: params.agentDir,
    codexHome,
    command,
    desktopGeneration,
  };
}

async function ensureComputerUsePlugin(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  marketplace: MarketplaceRef;
  installPlugin: boolean;
}): Promise<PluginInspection> {
  let plugin = await readComputerUsePlugin(
    params.request,
    params.marketplace,
    params.config.pluginName,
  );
  if (params.installPlugin && (!plugin.summary.installed || !plugin.summary.enabled)) {
    await params.request<JsonValue>(
      "plugin/install",
      pluginRequestParams(params.marketplace, params.config.pluginName),
    );
    await params.request("config/mcpServer/reload", undefined);
    plugin = await readComputerUsePlugin(
      params.request,
      params.marketplace,
      params.config.pluginName,
    );
  }
  if (!plugin.summary.installed || !plugin.summary.enabled) {
    return {
      ok: false,
      status: statusFromPlugin({
        config: params.config,
        plugin,
        tools: [],
        reason: pluginSetupReason(plugin),
        message: pluginSetupMessage(params.config, plugin),
      }),
    };
  }
  return { ok: true, plugin };
}

async function readComputerUseTools(params: {
  request: CodexComputerUseRequest;
  client?: CodexAppServerClient;
  signal?: AbortSignal;
  config: ResolvedCodexComputerUseConfig;
  plugin: CodexPluginDetail;
  runLiveTest: boolean;
  installPlugin: boolean;
  releaseNativeConfigFence?: () => void;
}): Promise<CodexComputerUseStatus> {
  let server = await readMcpServerStatus(params.request, params.config.mcpServerName);
  let tools = Object.keys(server?.tools ?? {}).toSorted();
  if ((!server || tools.length === 0) && params.installPlugin) {
    await params.request("config/mcpServer/reload", undefined);
    server = await readMcpServerStatus(params.request, params.config.mcpServerName);
    tools = Object.keys(server?.tools ?? {}).toSorted();
  }
  if (!server) {
    return statusFromPlugin({
      config: params.config,
      plugin: params.plugin,
      tools: [],
      reason: "mcp_missing",
      message: `Computer Use is installed, but the ${params.config.mcpServerName} MCP server is not available.`,
    });
  }
  if (tools.length === 0) {
    return statusFromPlugin({
      config: params.config,
      plugin: params.plugin,
      tools,
      reason: "mcp_missing",
      message: `Computer Use is installed, but the ${params.config.mcpServerName} MCP server exposes no tools.`,
    });
  }

  const status = statusFromPlugin({
    config: params.config,
    plugin: params.plugin,
    tools,
    reason: "ready",
    message: "Computer Use is ready.",
  });
  // Non-strict turns need installation and exposure, not a desktop round trip.
  // Explicit diagnostics and the client-owned health monitor still probe live use.
  if (!params.runLiveTest) {
    return status;
  }
  // The readiness thread reacquires this fence before loading native config.
  params.releaseNativeConfigFence?.();
  const { liveTest, repair } = await runCodexComputerUseLiveTest({
    request: params.request,
    client: params.client,
    signal: params.signal,
    config: params.config,
    tools,
  });
  const compatibilityStartupAllowed = !liveTest.ok && !params.config.strictReadiness;
  return {
    ...status,
    ready: liveTest.ok,
    reason: liveTest.ok ? "ready" : "live_test_failed",
    liveTest,
    ...(repair ? { repair } : {}),
    warnings: [
      ...status.warnings,
      ...(repair?.warnings ?? []),
      ...(compatibilityStartupAllowed
        ? [
            "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to fail closed.",
          ]
        : []),
    ],
    message: liveTest.ok
      ? "Computer Use is ready."
      : compatibilityStartupAllowed
        ? `${liveTest.message} Startup is allowed because computerUse.strictReadiness is false.`
        : liveTest.message,
  };
}

async function resolveMarketplaceRef(params: {
  request: CodexComputerUseRequest;
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
  signal?: AbortSignal;
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
  managedCodexHome?: string;
}): Promise<MarketplaceResolution> {
  let preferredMarketplaceName = params.config.marketplaceName;
  if (params.config.marketplaceSource && params.allowAdd) {
    const added = await params.request<{ marketplaceName?: string }>("marketplace/add", {
      source: params.config.marketplaceSource,
    } satisfies CodexRequestObject);
    preferredMarketplaceName ??= added.marketplaceName;
  }

  if (params.config.marketplacePath) {
    const marketplace: MarketplaceRef = preferredMarketplaceName
      ? { kind: "local", name: preferredMarketplaceName, path: params.config.marketplacePath }
      : { kind: "local", path: params.config.marketplacePath };
    return { marketplace };
  }

  let candidates = await listComputerUseMarketplaceCandidates(params.request, params.config);
  const bundledMarketplacePath = resolveBundledComputerUseMarketplacePath(params);
  if (
    candidates.length === 0 &&
    bundledMarketplacePath &&
    shouldAddBundledComputerUseMarketplace(params)
  ) {
    if (params.managedCodexHome) {
      await migrateLegacyBundledMarketplaceSource({
        request: params.request,
        bundledMarketplacePath,
        legacySources: params.defaultBundledMarketplacePathCandidates,
        userConfigPath: path.join(params.managedCodexHome, "config.toml"),
      });
    }
    const added = await params.request<{ marketplaceName?: string }>("marketplace/add", {
      source: bundledMarketplacePath,
    } satisfies CodexRequestObject);
    preferredMarketplaceName ??= added.marketplaceName;
    candidates = await listComputerUseMarketplaceCandidates(params.request, params.config);
  }

  const waitUntil = marketplaceDiscoveryWaitUntil(params);
  if (
    candidates.length === 0 &&
    waitUntil > Date.now() &&
    (await codexNativePluginsDisabled(params.request))
  ) {
    return {
      message:
        "Codex native plugin support is disabled (features.plugins = false). Enable it in the Codex config, then run /codex computer-use install.",
    };
  }
  while (candidates.length === 0) {
    if (Date.now() >= waitUntil) {
      break;
    }
    await delay(
      Math.min(CURATED_MARKETPLACE_POLL_INTERVAL_MS, waitUntil - Date.now()),
      params.signal,
    );
    candidates = await listComputerUseMarketplaceCandidates(params.request, params.config);
  }

  if (preferredMarketplaceName) {
    const preferred = candidates.find((candidate) => candidate.name === preferredMarketplaceName);
    if (preferred) {
      return { marketplace: preferred };
    }
    return {
      message: `Configured Codex marketplace ${preferredMarketplaceName} was not found or does not contain ${params.config.pluginName}. Run /codex computer-use install with a source or path to install from a new marketplace.`,
    };
  }
  if (candidates.length > 1) {
    const preferred = chooseKnownComputerUseMarketplace(candidates);
    if (preferred) {
      return { marketplace: preferred };
    }
    return {
      message: `Multiple Codex marketplaces contain ${params.config.pluginName}. Configure computerUse.marketplaceName or computerUse.marketplacePath to choose one.`,
    };
  }
  if (params.config.marketplaceSource && !params.allowAdd && candidates.length === 0) {
    return {
      message:
        "Computer Use marketplace source is configured but has not been registered. Run /codex computer-use install to register it.",
    };
  }
  const marketplace = candidates[0];
  return marketplace ? { marketplace } : {};
}

async function migrateLegacyBundledMarketplaceSource(params: {
  request: CodexComputerUseRequest;
  bundledMarketplacePath: string;
  legacySources?: readonly string[];
  userConfigPath: string;
}): Promise<void> {
  const response = await params.request<
    CodexConfigReadResponse & {
      config: { marketplaces?: Record<string, { source_type?: string; source?: string }> };
    }
  >("config/read", { includeLayers: false });
  const bundled = response.config.marketplaces?.[BUNDLED_MARKETPLACE_NAME];
  const sourceOrigin = response.origins[`marketplaces.${BUNDLED_MARKETPLACE_NAME}.source`];
  if (
    bundled?.source_type !== "local" ||
    !bundled.source ||
    sourceOrigin?.name.type !== "user" ||
    sourceOrigin.name.profile !== null ||
    path.resolve(sourceOrigin.name.file) !== path.resolve(params.userConfigPath)
  ) {
    return;
  }

  // Codex hides a reserved marketplace whose old direct source violates its
  // managed-root policy. Remove only sources OpenClaw previously provisioned.
  const configuredSource = path.resolve(bundled.source);
  if (configuredSource === path.resolve(params.bundledMarketplacePath)) {
    return;
  }
  const legacySources =
    params.legacySources ?? resolveMacOSDesktopCodexBundledMarketplaceCandidates();
  if (!legacySources.some((source) => path.resolve(source) === configuredSource)) {
    return;
  }
  await params.request("marketplace/remove", { marketplaceName: BUNDLED_MARKETPLACE_NAME });
}

async function listComputerUseMarketplaceCandidates(
  request: CodexComputerUseRequest,
  config: ResolvedCodexComputerUseConfig,
): Promise<MarketplaceRef[]> {
  const listed = await request<CodexPluginListResponse>("plugin/list", {
    cwds: [],
  } satisfies CodexRequestObject);
  return findComputerUseMarketplaces(listed, config.pluginName);
}

async function codexNativePluginsDisabled(request: CodexComputerUseRequest): Promise<boolean> {
  const response = await request<CodexAppServerRequestResult<"experimentalFeature/list">>(
    "experimentalFeature/list",
    {},
  );
  // Codex returns the full catalog when limit is omitted; absent plugins remains unknown so polling continues.
  return response.data.find(({ name }) => name === "plugins")?.enabled === false;
}

function blockUnsafeAutoInstallStatus(
  config: ResolvedCodexComputerUseConfig,
): CodexComputerUseStatus | undefined {
  if (!config.marketplaceSource) {
    return undefined;
  }
  return unavailableStatus(
    config,
    "auto_install_blocked",
    "Computer Use auto-install only uses marketplaces Codex app-server has already discovered. Run /codex computer-use install to install from a configured marketplace source.",
  );
}

function shouldAddBundledComputerUseMarketplace(params: {
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
}): boolean {
  return (
    params.allowAdd &&
    !params.config.marketplaceSource &&
    !params.config.marketplacePath &&
    !params.config.marketplaceName &&
    Boolean(resolveBundledComputerUseMarketplacePath(params))
  );
}

function resolveBundledComputerUseMarketplacePath(params: {
  defaultBundledMarketplacePath?: string;
  defaultBundledMarketplacePathCandidates?: readonly string[];
}): string | undefined {
  if (params.defaultBundledMarketplacePath) {
    return existsSync(params.defaultBundledMarketplacePath)
      ? params.defaultBundledMarketplacePath
      : undefined;
  }
  if (!params.defaultBundledMarketplacePathCandidates) {
    return undefined;
  }
  return resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath({
    candidates: params.defaultBundledMarketplacePathCandidates,
  });
}

function findComputerUseMarketplaces(
  listed: CodexPluginListResponse,
  pluginName: string,
): MarketplaceRef[] {
  return listed.marketplaces.flatMap((marketplace): MarketplaceRef[] => {
    const plugin = marketplace.plugins.find(
      (candidate) =>
        candidate.name === pluginName ||
        candidate.id === pluginName ||
        candidate.id === `${pluginName}@${marketplace.name}`,
    );
    if (!plugin) {
      return [];
    }
    if (marketplace.path) {
      return [{ kind: "local", name: marketplace.name, path: marketplace.path }];
    }
    const remotePluginId = plugin.remotePluginId?.trim();
    if (!remotePluginId) {
      // Remote plugin/read and plugin/install reject the human-readable slug.
      return [];
    }
    return [
      {
        kind: "remote",
        name: marketplace.name,
        remoteMarketplaceName: marketplace.name,
        remotePluginId,
      },
    ];
  });
}

function chooseKnownComputerUseMarketplace(
  candidates: MarketplaceRef[],
): MarketplaceRef | undefined {
  for (const marketplaceName of COMPUTER_USE_MARKETPLACE_NAME_PRIORITY) {
    const candidate = candidates.find((marketplace) => marketplace.name === marketplaceName);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function marketplaceDiscoveryWaitUntil(params: {
  config: ResolvedCodexComputerUseConfig;
  allowAdd: boolean;
}): number {
  if (
    params.allowAdd &&
    !params.config.marketplaceSource &&
    !params.config.marketplacePath &&
    !params.config.marketplaceName
  ) {
    return Date.now() + params.config.marketplaceDiscoveryTimeoutMs;
  }
  return 0;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw abortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("Computer Use setup was aborted.");
}

async function readComputerUsePlugin(
  request: CodexComputerUseRequest,
  marketplace: MarketplaceRef,
  pluginName: string,
): Promise<CodexPluginDetail> {
  const response = await request<CodexPluginReadResponse>(
    "plugin/read",
    pluginRequestParams(marketplace, pluginName),
  );
  return response.plugin;
}

async function readMcpServerStatus(
  request: CodexComputerUseRequest,
  serverName: string,
): Promise<CodexMcpServerStatus | undefined> {
  let cursor: string | null | undefined;
  do {
    const response = await request<CodexListMcpServerStatusResponse>("mcpServerStatus/list", {
      cursor,
      limit: 100,
      detail: "toolsAndAuthOnly",
    } satisfies CodexRequestObject);
    const found = response.data.find((server) => server.name === serverName);
    if (found) {
      return found;
    }
    cursor = response.nextCursor;
  } while (cursor);
  return undefined;
}

function pluginRequestParams(marketplace: MarketplaceRef, pluginName: string) {
  return marketplace.kind === "local"
    ? { marketplacePath: marketplace.path, pluginName }
    : {
        remoteMarketplaceName: marketplace.remoteMarketplaceName,
        pluginName: marketplace.remotePluginId,
      };
}

function pluginSetupReason(plugin: CodexPluginDetail): CodexComputerUseStatusReason {
  return plugin.summary.installed ? "plugin_disabled" : "plugin_not_installed";
}

function pluginSetupMessage(
  config: ResolvedCodexComputerUseConfig,
  plugin: CodexPluginDetail,
): string {
  if (!plugin.summary.installed) {
    return "Computer Use is available but not installed. Run /codex computer-use install or enable computerUse.autoInstall.";
  }
  return `Computer Use is installed, but the ${config.pluginName} plugin is disabled. Run /codex computer-use install or enable computerUse.autoInstall to re-enable it.`;
}

function statusFromPlugin(params: {
  config: ResolvedCodexComputerUseConfig;
  plugin: CodexPluginDetail;
  tools: string[];
  reason: CodexComputerUseStatusReason;
  message: string;
}): CodexComputerUseStatus {
  return {
    enabled: true,
    ready:
      params.plugin.summary.installed && params.plugin.summary.enabled && params.tools.length > 0,
    reason: params.reason,
    installed: params.plugin.summary.installed,
    pluginEnabled: params.plugin.summary.enabled,
    mcpServerAvailable: params.tools.length > 0,
    pluginName: params.config.pluginName,
    mcpServerName: params.config.mcpServerName,
    marketplaceName: params.plugin.marketplaceName,
    ...(params.plugin.marketplacePath ? { marketplacePath: params.plugin.marketplacePath } : {}),
    tools: params.tools,
    installation: installationStatusFromPlugin(params.plugin, params.message),
    exposure: exposureStatusFromTools(params.config, params.tools),
    liveTest: skippedLiveTestStatus(params.config, "Computer Use live test was not run."),
    warnings: pluginWarnings(params.plugin),
    message: params.message,
  };
}

function unavailableStatus(
  config: ResolvedCodexComputerUseConfig,
  reason: CodexComputerUseStatusReason,
  message: string,
): CodexComputerUseStatus {
  const disabled = reason === "disabled";
  return {
    enabled: !disabled,
    ready: false,
    reason,
    installed: false,
    pluginEnabled: false,
    mcpServerAvailable: false,
    pluginName: config.pluginName,
    mcpServerName: config.mcpServerName,
    ...(!disabled && config.marketplaceName ? { marketplaceName: config.marketplaceName } : {}),
    ...(!disabled && config.marketplacePath ? { marketplacePath: config.marketplacePath } : {}),
    tools: [],
    installation: {
      status: disabled
        ? "disabled"
        : reason === "marketplace_missing"
          ? "marketplace_missing"
          : "not_installed",
      ok: false,
      message,
    },
    exposure: {
      status: "skipped",
      ok: false,
      message: disabled
        ? "MCP exposure was not checked because Computer Use is disabled."
        : "MCP exposure was not checked because Computer Use installation is not ready.",
    },
    liveTest: skippedLiveTestStatus(
      config,
      disabled
        ? "Computer Use live test was not run because Computer Use is disabled."
        : "Computer Use live test was not run because installation is not ready.",
    ),
    warnings: [],
    message,
  };
}

function installationStatusFromPlugin(
  plugin: CodexPluginDetail,
  message: string,
): CodexComputerUseStatus["installation"] {
  const installed = plugin.summary.installed && plugin.summary.enabled;
  return {
    status: !plugin.summary.installed
      ? "not_installed"
      : installed
        ? "installed"
        : "installed_disabled",
    ok: installed,
    message: installed ? "Computer Use plugin is installed and enabled." : message,
  };
}

function exposureStatusFromTools(
  config: ResolvedCodexComputerUseConfig,
  tools: string[],
): CodexComputerUseStatus["exposure"] {
  const available = tools.length > 0;
  return {
    status: available ? "available" : "missing",
    ok: available,
    message: available
      ? `Computer Use MCP server ${config.mcpServerName} exposes ${tools.length} tools.`
      : `Computer Use MCP server ${config.mcpServerName} is not exposed.`,
  };
}

function pluginWarnings(plugin: CodexPluginDetail): string[] {
  const warnings: string[] = [];
  const source = plugin.summary.source;
  if (source && typeof source === "object" && "type" in source && source.type === "remote") {
    warnings.push(
      "Computer Use plugin is resolved from a remote marketplace; live local bundles are preferred.",
    );
  }
  return warnings;
}

function resolveComputerUseConfig(
  params: Pick<CodexComputerUseSetupParams, "pluginConfig" | "overrides" | "forceEnable">,
): ResolvedCodexComputerUseConfig {
  const overrides = params.forceEnable ? { ...params.overrides, enabled: true } : params.overrides;
  return resolveCodexComputerUseConfig({
    pluginConfig: params.pluginConfig,
    overrides,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
