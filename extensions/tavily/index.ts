export { __testing, createTavilyWebSearchProvider } from "./src/tavily-web-search-provider.js";

import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import { createTavilyWebSearchProvider } from "./src/tavily-web-search-provider.js";

export const TavilyPlugin: OpenClawPluginDefinition = {
  id: "tavily",
  name: "Tavily Search",
  description: "Web search using Tavily API",
  version: "1.0.0",
  register: (api) => {
    api.registerWebSearchProvider(createTavilyWebSearchProvider());
  },
};

export default TavilyPlugin;
