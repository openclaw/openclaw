import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createLogAgentRunTool } from "./src/agent-run-tools.js";
import { createGetIdeasTool, createSaveIdeaTool, createUpdateIdeaStatusTool } from "./src/idea-tools.js";
import { createGetProductSpecsTool, createSaveProductSpecTool, createUpdateSpecStatusTool } from "./src/spec-tools.js";
import { createGetEngineeringTasksTool, createSaveEngineeringTaskTool, createUpdateTaskStatusTool } from "./src/task-tools.js";
import { createGetTrendsTool, createSaveTrendTool, createUpdateTrendStatusTool } from "./src/trend-tools.js";

type PluginConfig = {
  databaseUrl?: string;
  maxPoolSize?: number;
};

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  const dbConfig = {
    databaseUrl: pluginConfig.databaseUrl,
    maxPoolSize: pluginConfig.maxPoolSize,
  };

  api.registerTool(createSaveTrendTool(dbConfig), { optional: true });
  api.registerTool(createGetTrendsTool(dbConfig), { optional: true });
  api.registerTool(createUpdateTrendStatusTool(dbConfig), { optional: true });

  api.registerTool(createSaveIdeaTool(dbConfig), { optional: true });
  api.registerTool(createGetIdeasTool(dbConfig), { optional: true });
  api.registerTool(createUpdateIdeaStatusTool(dbConfig), { optional: true });

  api.registerTool(createSaveProductSpecTool(dbConfig), { optional: true });
  api.registerTool(createGetProductSpecsTool(dbConfig), { optional: true });
  api.registerTool(createUpdateSpecStatusTool(dbConfig), { optional: true });

  api.registerTool(createSaveEngineeringTaskTool(dbConfig), { optional: true });
  api.registerTool(createGetEngineeringTasksTool(dbConfig), { optional: true });
  api.registerTool(createUpdateTaskStatusTool(dbConfig), { optional: true });

  api.registerTool(createLogAgentRunTool(dbConfig), { optional: true });
}
