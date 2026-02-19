import type { MoltbotConfig } from "../../../src/config/config.js";
import type { MoltbotPluginApi, MoltbotPluginToolContext } from "../../../src/plugins/types.js";
import { StateManager } from "./state.js";
import type { RoutingRule } from "./types.js";

const stateManager = new StateManager();

export const createSmartRouterTool = (api: MoltbotPluginApi) => {
  return {
    name: "smart_router",
    description:
      "Manage model routing, check usage, and switch models. Use this to optimize cost and performance.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "route", "reset_limit"],
          description: "Action to perform: check status, route to a model, or reset usage limits.",
        },
        taskType: {
          type: "string",
          description:
            "For 'route': The type of task to optimize for (e.g. 'coding', 'fast'). Customizable via config.",
        },
        forceModel: {
          type: "string",
          description:
            "For 'route': Explicitly switch to ANY model ID (e.g., 'openai/gpt-4o', 'custom/my-model').",
        },
        profileId: {
          type: "string",
          description:
            "For 'reset_limit': The profile ID to reset (optional, resets all if omitted).",
        },
      },
      required: ["action"],
    },
    func: async (args: {
      action: string;
      taskType?: string;
      forceModel?: string;
      profileId?: string;
    }) => {
      await stateManager.load();
      const config = (await api.runtime.config.loadConfig()) as MoltbotConfig;
      const extConfig = (config as any).extensions?.["smart-model-router"] || {};

      if (args.action === "status") {
        const currentModel = config.agents?.defaults?.model?.primary;
        const usage = stateManager["state"].dailyUsage; // Accessing private for dump
        const limits = extConfig.limits || {};
        const rules = extConfig.rules || [];

        return JSON.stringify(
          {
            currentModel,
            dailyUsage: usage,
            limits,
            customRules: rules.length,
            message: "Current status retrieved.",
          },
          null,
          2,
        );
      }

      if (args.action === "reset_limit") {
        await stateManager.resetUsage(args.profileId);
        return "Usage limits reset successfully.";
      }

      if (args.action === "route") {
        let targetModel = args.forceModel;

        // Routing logic
        if (!targetModel && args.taskType) {
          // 1. Try configurable rules from moltbot.json
          const rules = (extConfig.rules || []) as RoutingRule[];
          const customRule = rules.find((r) => r.type === "task" && r.condition === args.taskType);

          if (customRule) {
            targetModel = customRule.targetModel;
          } else {
            // No matching rule found.
            // Do NOT fallback to hardcoded defaults (e.g. openai/gpt-4o) to avoid assuming user credentials.
            return `Error: No routing rule configured for task type '${args.taskType}'. Please configure a rule in moltbot.json or specify 'forceModel'.`;
          }
        }

        if (!targetModel) {
          // If no taskType/forceModel, try default
          targetModel = extConfig.defaultModel;
        }

        if (!targetModel) {
          return "Error: Must specify 'forceModel' (any ID) or 'taskType' (with a matching rule) for routing, and no defaultModel is configured.";
        }

        // Check allowedModels whitelist
        const allowedModels = (extConfig.allowedModels as string[]) || [];
        const providers = (extConfig.providers as any[]) || [];

        // Collect models from providers config
        for (const p of providers) {
          if (p.provider && Array.isArray(p.models)) {
            for (const m of p.models) {
              // If model ID doesn't contain '/', prepend provider
              const fullId = m.includes("/") ? m : `${p.provider}/${m}`;
              allowedModels.push(fullId);
            }
          }
        }

        if (allowedModels && allowedModels.length > 0) {
          // If the list is configured, we strictly enforce it.
          // We also allow if the model matches an auth profile override (e.g. @google:free)
          // provided the base ID is in the list.
          const baseId = targetModel.split("@")[0];
          if (!allowedModels.includes(baseId)) {
            return `Error: Model '${baseId}' is not in the allowed models list. Please add it to your configuration (either in 'allowedModels' or under a provider's 'models' list).`;
          }
        }

        // Verify if provider is configured (basic check)
        const provider = targetModel.split("/")[0];
        // Check if we have any profile for this provider
        const hasProfile = config.auth?.profiles
          ? Object.values(config.auth.profiles).some((p) => p.provider === provider)
          : false;

        // Also check if we have an API key in the extension config (which syncs to profiles)
        const hasExtKey = providers.some((p: any) => p.provider === provider);

        // Note: This is a soft check. User might use env vars.
        // We warn but allow proceeding if we can't be 100% sure.
        if (!hasProfile && !hasExtKey) {
          // Check standard env vars via heuristics is too complex here,
          // but we can add a warning message to the output.
        }

        // Update Config
        const newConfig = { ...config };
        if (!newConfig.agents) newConfig.agents = {};
        if (!newConfig.agents.defaults) newConfig.agents.defaults = {};
        if (!newConfig.agents.defaults.model) newConfig.agents.defaults.model = {};

        const oldModel = newConfig.agents.defaults.model.primary;
        if (oldModel === targetModel) {
          return `Already using model ${targetModel}. No change needed.`;
        }

        newConfig.agents.defaults.model.primary = targetModel;

        // Write config
        await api.runtime.config.writeConfigFile(newConfig);

        // Track usage increment for the *new* model (assuming we are about to use it)
        // Note: Mapping model -> profile is complex without explicit config.
        // For now, we just track the model ID as a key.
        await stateManager.incrementUsage(targetModel);

        return `Configuration updated to use ${targetModel} (was ${oldModel}). \n\nIMPORTANT: You must now restart the gateway for this to take effect. \nRun: 'moltbot gateway restart' (if available) or restart the process manually.`;
      }

      return "Unknown action.";
    },
  };
};
