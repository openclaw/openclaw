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
const CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp@latest";

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
      const pluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });

      // Inject chrome-devtools-mcp preset when browser.mcp is enabled in core config.
      const chromePreset = buildChromeDevToolsMcpPreset({
        browserMcp: ctx.config.browser?.mcp,
        existingMcpServers: pluginConfig.mcpServers,
      });
      if (chromePreset) {
        pluginConfig.mcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME] = chromePreset;
        ctx.logger.info("chrome-devtools-mcp preset injected from browser.mcp config");
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
      const mcpServerCount = Object.keys(pluginConfig.mcpServers).length;
      ctx.logger.info(
        `acpx runtime backend registered (command: ${pluginConfig.command}, expectedVersion: ${expectedVersionLabel}, pluginLocalInstall: ${installLabel}${mcpServerCount > 0 ? `, mcpServers: ${mcpServerCount}` : ""})`,
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
