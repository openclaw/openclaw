import type { ModelCompatConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { shouldSuppressManagedWebSearchTool } from "./codex-native-web-search.js";
import { filterLocalModelLeanTools } from "./local-model-lean.js";

export function applyModelProviderToolPolicy(
  toolsInput: AnyAgentTool[],
  params?: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    modelId?: string;
    agentId?: string;
    sessionKey?: string;
    agentDir?: string;
    modelCompat?: ModelCompatConfig;
    suppressManagedWebSearch?: boolean;
    runtimeToolAllowlist?: string[];
    localModelLeanPreserveToolNames?: string[];
  },
): AnyAgentTool[] {
  const tools = filterLocalModelLeanTools({
    tools: toolsInput,
    config: params?.config,
    agentId: params?.agentId,
    sessionKey: params?.sessionKey,
    preserveToolNames: params?.localModelLeanPreserveToolNames ?? params?.runtimeToolAllowlist,
  });

  if (
    params?.suppressManagedWebSearch !== false &&
    shouldSuppressManagedWebSearchTool({
      config: params?.config,
      modelProvider: params?.modelProvider,
      modelApi: params?.modelApi,
      modelId: params?.modelId,
      agentId: params?.agentId,
      sessionKey: params?.sessionKey,
      agentDir: params?.agentDir,
    })
  ) {
    return tools.filter((tool) => tool.name !== "web_search");
  }
  return tools;
}
