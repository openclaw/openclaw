import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { genparkPlugin } from "./src/channel.ts";
import { setGenParkRuntime } from "./src/runtime.ts";

// Re‑export public API for consumers
export { genparkPlugin, getGenParkClient } from "./src/channel.ts";
export { setGenParkRuntime } from "./src/runtime.ts";
export { GenParkClient, GenParkApiError } from "./src/api-client.ts";
export {
  marketplaceToolDefinition,
  handleMarketplaceSearch,
} from "./src/marketplace.ts";

export { AgentMode, UNDERCOVER_PROMPT, STANDARD_PROMPT, PROACTIVE_PROMPT } from "./src/modes.ts";
export { DynamicPromptBuilder, type BuildPromptOptions } from "./src/prompt-engine.ts";

export default defineChannelPluginEntry({
  id: "genpark",
  name: "GenPark",
  description:
    "GenPark Circle channel integration and Skill Marketplace search tool",
  plugin: genparkPlugin as ChannelPlugin,
  setRuntime: setGenParkRuntime,
});
