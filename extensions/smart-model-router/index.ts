import { upsertAuthProfile } from "../../src/agents/auth-profiles.js";
import type { MoltbotConfig } from "../../src/config/config.js";
import type { MoltbotPluginApi } from "../../src/plugins/types.js";
import { StateManager } from "./src/state.js";
import { createSmartRouterTool } from "./src/tool.js";

const plugin = {
  id: "smart-model-router",
  name: "Smart Model Router",
  description: "Multi-model routing and usage tracking",
  configSchema: {
    type: "object",
    properties: {
      limits: {
        type: "object",
        description: "Daily limits per model/profile",
      },
      providers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            provider: { type: "string" },
            profileId: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
  register(api: MoltbotPluginApi) {
    // Sync API Keys from extension config to Auth Profiles
    const syncAuthKeys = async () => {
      try {
        const config = (await api.runtime.config.loadConfig()) as MoltbotConfig;
        const extConfig = (config as any).extensions?.["smart-model-router"] || {};
        const providers = extConfig.providers || [];

        let configChanged = false;
        let nextConfig = { ...config };

        for (const p of providers) {
          if (!p.apiKey || !p.provider) continue;

          const profileId = p.profileId || `${p.provider}:default`;

          // 1. Write credential
          upsertAuthProfile({
            profileId,
            credential: {
              type: "api_key",
              provider: p.provider,
              key: p.apiKey,
            },
          });

          // 2. Register profile in moltbot.json if missing
          if (!nextConfig.auth) nextConfig.auth = {};
          if (!nextConfig.auth.profiles) nextConfig.auth.profiles = {};

          if (!nextConfig.auth.profiles[profileId]) {
            nextConfig.auth.profiles[profileId] = {
              provider: p.provider,
              mode: "api_key",
            };
            configChanged = true;
          }
        }

        if (configChanged) {
          await api.runtime.config.writeConfigFile(nextConfig);
        }
      } catch (err) {
        // Silent fail or log if possible. Extension activation shouldn't crash app.
        // console.error("Failed to sync auth keys:", err);
      }
    };

    // Run sync on startup (or when tools are registered)
    syncAuthKeys();

    // Register the router tool
    api.registerTool(
      (ctx) => {
        return createSmartRouterTool(api);
      },
      { optional: true },
    );

    // Register a CLI command to check status easily
    api.registerCli(
      ({ program, logger }) => {
        const cmd = program.command("router").description("Smart Model Router management");

        cmd
          .command("status")
          .description("Show current routing status and usage")
          .action(async () => {
            const stateManager = new StateManager();
            await stateManager.load();
            const config = (await api.runtime.config.loadConfig()) as MoltbotConfig;
            const currentModel = config.agents?.defaults?.model?.primary || "unknown";
            const usage = stateManager["state"].dailyUsage;

            logger.info(`Current Primary Model: ${currentModel}`);
            logger.info("Daily Usage:");
            if (Object.keys(usage).length === 0) {
              logger.info("  (No usage recorded today)");
            } else {
              for (const [key, count] of Object.entries(usage)) {
                logger.info(`  - ${key}: ${count} requests`);
              }
            }
          });

        cmd
          .command("switch <modelId>")
          .description("Switch the primary model (requires restart)")
          .action(async (modelId) => {
            const config = (await api.runtime.config.loadConfig()) as MoltbotConfig;
            const oldModel = config.agents?.defaults?.model?.primary;

            if (oldModel === modelId) {
              logger.info(`Already using model ${modelId}.`);
              return;
            }

            const newConfig = { ...config };
            if (!newConfig.agents) newConfig.agents = {};
            if (!newConfig.agents.defaults) newConfig.agents.defaults = {};
            if (!newConfig.agents.defaults.model) newConfig.agents.defaults.model = {};

            newConfig.agents.defaults.model.primary = modelId;

            await api.runtime.config.writeConfigFile(newConfig);
            logger.info(`Switched primary model from ${oldModel} to ${modelId}.`);
            logger.warn("IMPORTANT: You must restart the gateway for this to take effect.");
            logger.info("Run 'moltbot gateway restart' or restart the app.");
          });

        cmd
          .command("reset")
          .description("Reset daily usage limits")
          .action(async () => {
            const stateManager = new StateManager();
            await stateManager.load();
            await stateManager.resetUsage();
            logger.info("Daily usage limits have been reset.");
          });
      },
      { commands: ["router"] },
    );
  },
};

export default plugin;
