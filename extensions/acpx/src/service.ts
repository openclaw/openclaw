import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/acpx";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import {
  CHROME_DEVTOOLS_MCP_BUNDLED_BIN,
  resolveAcpxPluginConfig,
  type McpServerConfig,
  type ResolvedAcpxPluginConfig,
} from "./config.js";
import { ensureAcpx, ensureChromeDevToolsMcp } from "./ensure.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";

const CHROME_DEVTOOLS_MCP_SERVER_NAME = "chrome-devtools";
const CHROME_DEVTOOLS_MCP_PAGE_ID_ROUTING_FLAG = "--experimental-page-id-routing";
export const CHROME_DEVTOOLS_MCP_BIN = CHROME_DEVTOOLS_MCP_BUNDLED_BIN;

/**
 * Build the chrome-devtools-mcp server config from core browser.mcp settings.
 * Returns undefined when the preset is not enabled or is already overridden by
 * an explicit mcpServers entry with the same name.
 */
export function buildChromeDevToolsMcpPreset(params: {
  browserMcp?: {
    enabled?: boolean;
    mode?: "full" | "slim";
    channel?: "stable" | "beta" | "canary" | "dev";
  };
  existingMcpServers: Record<string, McpServerConfig>;
}): McpServerConfig | undefined {
  if (!params.browserMcp?.enabled) {
    return undefined;
  }
  // Don't override an explicit user-defined entry.
  if (params.existingMcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME]) {
    return undefined;
  }
  const args: string[] = ["--autoConnect", CHROME_DEVTOOLS_MCP_PAGE_ID_ROUTING_FLAG];
  const mode = params.browserMcp.mode ?? "full";
  if (mode === "slim") {
    args.push("--slim");
  }
  const channel = params.browserMcp.channel;
  if (channel && channel !== "stable") {
    args.push(`--channel=${channel}`);
  }
  return { command: CHROME_DEVTOOLS_MCP_BIN, args };
}

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  queueOwnerTtlSeconds: number;
  logger?: PluginLogger;
};

type CreateAcpxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike;
};

function hasRestrictedBrowserSsrFPolicy(
  browserConfig: OpenClawPluginServiceContext["config"]["browser"] | undefined,
): boolean {
  const ssrfPolicy = browserConfig?.ssrfPolicy;
  if (!ssrfPolicy) {
    return false;
  }
  const hasExplicitPrivateNetworkSetting =
    ssrfPolicy.dangerouslyAllowPrivateNetwork !== undefined ||
    ssrfPolicy.allowPrivateNetwork !== undefined;
  const allowsPrivateNetwork =
    ssrfPolicy.dangerouslyAllowPrivateNetwork === true ||
    ssrfPolicy.allowPrivateNetwork === true ||
    !hasExplicitPrivateNetworkSetting;
  const hasHostnameRestrictions =
    ssrfPolicy.allowedHostnames?.some((pattern) => pattern.trim() !== "") ||
    ssrfPolicy.hostnameAllowlist?.some((pattern) => pattern.trim() !== "") ||
    false;
  return !allowsPrivateNetwork || hasHostnameRestrictions;
}

function removeChromeDevToolsServer(
  pluginConfig: ResolvedAcpxPluginConfig,
  logger: PluginLogger | undefined,
  reason: string,
): ResolvedAcpxPluginConfig {
  const { [CHROME_DEVTOOLS_MCP_SERVER_NAME]: _removed, ...remainingMcpServers } =
    pluginConfig.mcpServers;
  logger?.info(reason);
  return {
    ...pluginConfig,
    mcpServers: remainingMcpServers,
  };
}

function createDefaultRuntime(params: AcpxRuntimeFactoryParams): AcpxRuntimeLike {
  return new AcpxRuntime(params.pluginConfig, {
    logger: params.logger,
    queueOwnerTtlSeconds: params.queueOwnerTtlSeconds,
  });
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: AcpxRuntimeLike | null = null;
  let lifecycleRevision = 0;

  return {
    id: "acpx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      let pluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });

      const browserEnabled = ctx.config.browser?.enabled !== false;
      const browserMcpEnabled = ctx.config.browser?.mcp?.enabled === true;
      const browserEvaluateEnabled = ctx.config.browser?.evaluateEnabled !== false;
      const browserSsrFRestricted = hasRestrictedBrowserSsrFPolicy(ctx.config.browser);
      const existingChromeDevToolsServer =
        pluginConfig.mcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME] !== undefined;

      if (existingChromeDevToolsServer && !browserEnabled) {
        pluginConfig = removeChromeDevToolsServer(
          pluginConfig,
          ctx.logger,
          "chrome-devtools MCP server removed: browser.enabled=false disables chrome-devtools access",
        );
      } else if (existingChromeDevToolsServer && !browserEvaluateEnabled) {
        pluginConfig = removeChromeDevToolsServer(
          pluginConfig,
          ctx.logger,
          "chrome-devtools MCP server removed: browser.evaluateEnabled=false disables chrome-devtools access",
        );
      } else if (existingChromeDevToolsServer && browserSsrFRestricted) {
        pluginConfig = removeChromeDevToolsServer(
          pluginConfig,
          ctx.logger,
          "chrome-devtools MCP server removed: browser.ssrfPolicy restrictions disable chrome-devtools access",
        );
      }

      // Inject chrome-devtools-mcp preset when browser.mcp is enabled in core config.
      // Use a fresh object to avoid mutating the shared mcpServers reference across restarts.
      // Chrome DevTools MCP access respects browser.enabled/browser.evaluateEnabled and
      // browser.ssrfPolicy restrictions, even for explicit overrides.
      const chromePreset = buildChromeDevToolsMcpPreset({
        browserMcp:
          browserEnabled && browserMcpEnabled && browserEvaluateEnabled && !browserSsrFRestricted
            ? ctx.config.browser?.mcp
            : undefined,
        existingMcpServers: pluginConfig.mcpServers,
      });
      if (chromePreset) {
        pluginConfig = {
          ...pluginConfig,
          mcpServers: {
            ...pluginConfig.mcpServers,
            [CHROME_DEVTOOLS_MCP_SERVER_NAME]: chromePreset,
          },
        };
        ctx.logger.info("chrome-devtools-mcp preset injected from browser.mcp config");
      } else if (browserMcpEnabled && pluginConfig.mcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME]) {
        ctx.logger.info(
          "chrome-devtools-mcp preset skipped: existing mcpServers entry takes precedence",
        );
      } else if (browserMcpEnabled && !browserEnabled) {
        ctx.logger.info(
          "chrome-devtools-mcp preset skipped: browser.enabled=false disables browser.mcp preset injection",
        );
      } else if (browserMcpEnabled && !browserEvaluateEnabled) {
        ctx.logger.info(
          "chrome-devtools-mcp preset skipped: browser.evaluateEnabled=false disables chrome-devtools access",
        );
      } else if (browserMcpEnabled && browserSsrFRestricted) {
        ctx.logger.info(
          "chrome-devtools-mcp preset skipped: browser.ssrfPolicy restrictions disable chrome-devtools access",
        );
      }

      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        queueOwnerTtlSeconds: pluginConfig.queueOwnerTtlSeconds,
        logger: ctx.logger,
      });

      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime,
        healthy: () => runtime?.isHealthy() ?? false,
      });
      const expectedVersionLabel = pluginConfig.expectedVersion ?? "any";
      const installLabel = pluginConfig.allowPluginLocalInstall ? "enabled" : "disabled";
      ctx.logger.info(
        `acpx runtime backend registered (command: ${pluginConfig.command}, expectedVersion: ${expectedVersionLabel}, pluginLocalInstall: ${installLabel})`,
      );

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await ensureAcpx({
            command: pluginConfig.command,
            logger: ctx.logger,
            expectedVersion: pluginConfig.expectedVersion,
            allowInstall: pluginConfig.allowPluginLocalInstall,
            stripProviderAuthEnvVars: pluginConfig.stripProviderAuthEnvVars,
            spawnOptions: {
              strictWindowsCmdWrapper: pluginConfig.strictWindowsCmdWrapper,
            },
          });
          const chromeDevToolsServer = pluginConfig.mcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME];
          if (chromeDevToolsServer?.command === CHROME_DEVTOOLS_MCP_BUNDLED_BIN) {
            await ensureChromeDevToolsMcp({
              command: chromeDevToolsServer.command,
              logger: ctx.logger,
              stripProviderAuthEnvVars: pluginConfig.stripProviderAuthEnvVars,
              spawnOptions: {
                strictWindowsCmdWrapper: pluginConfig.strictWindowsCmdWrapper,
              },
            });
          }
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          await runtime?.probeAvailability();
          if (runtime?.isHealthy()) {
            ctx.logger.info("acpx runtime backend ready");
          } else {
            ctx.logger.warn("acpx runtime backend probe failed after local install");
          }
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          ctx.logger.warn(
            `acpx runtime setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      runtime = null;
    },
  };
}
