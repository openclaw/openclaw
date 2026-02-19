import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createDiscordSemanticSearchTool } from "./src/tool.js";
import { DiscordSemanticSearch } from "./src/semantic-search.js";

let searchInstance: DiscordSemanticSearch | null = null;

export default function register(api: OpenClawPluginApi) {
  const config = api.getPluginConfig?.("discord-semantic-search") ?? {};

  if (!config.enabled) {
    api.log?.("discord-semantic-search: disabled (set enabled: true to activate)");
    return;
  }

  // Initialize search instance
  searchInstance = new DiscordSemanticSearch({
    embeddingModel: config.embeddingModel,
  });

  // Register the search tool
  api.registerTool(
    createDiscordSemanticSearchTool(searchInstance) as unknown as AnyAgentTool,
    { optional: true }
  );

  api.log?.("discord-semantic-search: registered");
}

export { DiscordSemanticSearch };
