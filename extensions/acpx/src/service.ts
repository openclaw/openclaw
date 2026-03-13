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

export function buildChromeDevtoolsMcpPreset(): McpServerConfig {
  return {
    command: "npx",
    args: ["-y", CHROME_DEVTOOLS_MCP_PACKAGE, "--autoConnect", "--experimental-page-id-routing"],
  };
}

function resolveChromeDevtoolsPresetAction(params: {
  config: OpenClawPluginServiceContext["config"];
  pluginConfig: ResolvedAcpxPluginConfig;
}):
  | { kind: "disabled" }
  | { kind: "override" }
  | { kind: "blocked" }
  | { kind: "inject"; preset: McpServerConfig } {
  if (!params.pluginConfig.chromeDevtoolsMcp.enabled) {
    return { kind: "disabled" };
  }
  if (params.pluginConfig.mcpServers[CHROME_DEVTOOLS_MCP_SERVER_NAME]) {
    return { kind: "override" };
  }
  if (params.config.browser?.evaluateEnabled === false) {
    return { kind: "blocked" };
  }
  return { kind: "inject", preset: buildChromeDevtoolsMcpPreset() };
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
      const chromeDevtoolsPresetAction = resolveChromeDevtoolsPresetAction({
        config: ctx.config,
        pluginConfig,
      });
      if (chromeDevtoolsPresetAction.kind === "inject") {
        pluginConfig = {
          ...pluginConfig,
          // Keep user-supplied plugin config immutable across service restarts.
          mcpServers: {
            ...pluginConfig.mcpServers,
            [CHROME_DEVTOOLS_MCP_SERVER_NAME]: chromeDevtoolsPresetAction.preset,
          },
        };
        ctx.logger.info("chrome-devtools-mcp preset injected from acpx plugin config");
      } else if (chromeDevtoolsPresetAction.kind === "override") {
        ctx.logger.info(
          "chrome-devtools-mcp preset skipped: existing mcpServers entry takes precedence",
        );
      } else if (chromeDevtoolsPresetAction.kind === "blocked") {
        ctx.logger.warn(
          "chrome-devtools-mcp preset blocked: browser.evaluateEnabled=false disables the built-in ACPX preset",
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
