import fs from "node:fs";
import path from "node:path";
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
  ACPX_PLUGIN_ROOT,
} from "./config.js";
import { ensureAcpx } from "./ensure.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";

const CHROME_DEVTOOLS_MCP_SERVER_NAME = "chrome-devtools";
const CHROME_DEVTOOLS_MCP_VERSION = "0.20.0";
const CHROME_MCP_BIN_NAME =
  process.platform === "win32" ? "chrome-devtools-mcp.cmd" : "chrome-devtools-mcp";
const CHROME_DEVTOOLS_MCP_BUNDLED_BIN = path.join(
  ACPX_PLUGIN_ROOT,
  "node_modules",
  ".bin",
  CHROME_MCP_BIN_NAME,
);

function getChromeMcpCommand(): string {
  try {
    if (fs.existsSync(CHROME_DEVTOOLS_MCP_BUNDLED_BIN)) {
      return CHROME_DEVTOOLS_MCP_BUNDLED_BIN;
    }
  } catch {
    // Fall through to npx fallback
  }
  return "npx";
}

/**
 * BrowserMcpConfig type for the Chrome DevTools MCP preset.
 * Must be kept in sync with src/config/types.browser.ts::BrowserMcpConfig
 */
export type BrowserMcpConfig = {
  enabled?: boolean;
  mode?: "full" | "slim";
  channel?: "stable" | "beta" | "canary" | "dev";
};

export function buildChromeDevToolsMcpPreset(params: {
  browserMcp?: BrowserMcpConfig;
  existingMcpServers: Record<string, McpServerConfig>;
}): McpServerConfig | undefined {
  if (!params.browserMcp?.enabled) {
    return undefined;
  }

  if (params.existingMcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME]) {
    return undefined;
  }

  const command = getChromeMcpCommand();
  const useBundled = command === CHROME_DEVTOOLS_MCP_BUNDLED_BIN;
  const args: string[] = useBundled
    ? ["--autoConnect"]
    : ["-y", `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`, "--autoConnect"];

  const mode = params.browserMcp.mode ?? "full";
  if (mode === "slim") {
    args.push("--slim");
  }

  const channel = params.browserMcp.channel;
  if (channel && channel !== "stable") {
    args.push(`--channel=${channel}`);
  }

  return { command, args };
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
