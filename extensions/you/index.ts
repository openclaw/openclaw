import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { createWebContentsTool } from "./src/web-contents-tool.js";
import { createWebResearchTool } from "./src/web-research-tool.js";
import { createYouWebSearchProvider } from "./src/you-search-provider.js";

export default definePluginEntry({
  id: "you",
  name: "You.com Plugin",
  description: "Bundled You.com search, research, and contents plugin",
  register(api) {
    api.registerWebSearchProvider(createYouWebSearchProvider());
    api.registerTool(createWebResearchTool(api as OpenClawPluginApi) as AnyAgentTool);
    api.registerTool(createWebContentsTool(api as OpenClawPluginApi) as AnyAgentTool);
  },
});
