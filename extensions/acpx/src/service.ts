import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/acpx";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import {
  resolveAcpxPluginConfig,
  type McpServerConfig,
  type ResolvedAcpxPluginConfig,
} from "./config.js";
import { ensureAcpx } from "./ensure.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";

const CHROME_DEVTOOLS_MCP_SERVER_NAME = "chrome-devtools";
const CHROME_DEVTOOLS_MCP_PINNED_VERSION = "0.20.0";
const CHROME_DEVTOOLS_MCP_PACKAGE = `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_PINNED_VERSION}`;

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
  const args: string[] = ["-y", CHROME_DEVTOOLS_MCP_PACKAGE, "--autoConnect"];
  const mode = params.browserMcp.mode ?? "full";
  if (mode === "slim") {
    args.push("--slim");
  }
  const channel = params.browserMcp.channel;
  if (channel && channel !== "stable") {
    args.push(`--channel=${channel}`);
  }
  return { command: "npx", args };
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

      // Inject chrome-devtools-mcp preset when browser.mcp is enabled in core config.
      // Use a fresh object to avoid mutating the shared mcpServers reference across restarts.
      const chromePreset = buildChromeDevToolsMcpPreset({
        browserMcp: ctx.config.browser?.mcp,
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
      } else if (
        ctx.config.browser?.mcp?.enabled &&
        pluginConfig.mcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME]
      ) {
        ctx.logger.info(
          "chrome-devtools-mcp preset skipped: existing mcpServers entry takes precedence",
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
