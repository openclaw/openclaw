import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { acquireChatgptAppsSidecarSession } from "./app-server-supervisor.js";
import { resolveChatgptAppsConfig } from "./config.js";

export function createChatgptAppsService(
  api: Pick<OpenClawPluginApi, "pluginConfig" | "logger">,
): OpenClawPluginService | null {
  const config = resolveChatgptAppsConfig(api.pluginConfig);
  if (!config.enabled) {
    return null;
  }

  let release: (() => Promise<void>) | null = null;

  return {
    id: "openai-chatgpt-apps",
    start: async (ctx: OpenClawPluginServiceContext) => {
      const lease = await acquireChatgptAppsSidecarSession({
        stateDir: ctx.stateDir,
        workspaceDir: ctx.workspaceDir,
        config,
        openclawConfig: ctx.config,
        logger: api.logger,
      });
      release = lease.release;

      try {
        await lease.session.warm();
        const snapshot = lease.session.snapshot();
        ctx.logger.info(
          `openai chatgpt-apps: ready (${snapshot.inventory?.apps.length ?? 0} apps in ${snapshot.layout.sandboxDir})`,
        );
      } catch (error) {
        ctx.logger.warn(
          `openai chatgpt-apps: warm-up failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    stop: async () => {
      const currentRelease = release;
      release = null;
      if (currentRelease) {
        await currentRelease();
      }
    },
  };
}
